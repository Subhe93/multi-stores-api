import { promises as dns } from 'dns';
import * as https from 'https';
import { isIP } from 'net';
import type { AdapterFetcher } from '../adapters/source-adapter';
import { isDisallowedAddress } from './ip-policy';

/**
 * SSRF-safe GET for importer media and REST calls (M4.4 §7):
 *  1. https only (http is upgraded for the allowed host), no userinfo, port 443;
 *  2. alias hosts are rewritten; the host must equal the source's site host;
 *     media paths must stay under the uploads base path;
 *  3. every DNS answer is vetted (any private/reserved address rejects);
 *  4. the connection is pinned to the vetted address (custom `lookup`, SNI =
 *     host, normal TLS verification);
 *  5. redirects are followed manually (≤ 3), re-running 1–4 on every hop;
 *  6. timeouts: connect 10 s, headers 15 s, idle 15 s, total 60 s;
 *  7. `Content-Length` and the streamed size are capped by `maxBytes`;
 *  8. no cookies; auth headers only for `purpose: 'rest'`;
 *  9. User-Agent `MultiStoresImporter/1.0`;
 * 10. `IMPORTER_ALLOW_PRIVATE_HOSTS=1` lifts the address check outside production.
 */

export type SafeFetchErrorCode =
  | 'IMPORT_MEDIA_HOST_NOT_ALLOWED'
  | 'IMPORT_MEDIA_PRIVATE_ADDRESS'
  | 'IMPORT_MEDIA_TOO_LARGE'
  | 'IMPORT_MEDIA_TYPE'
  | 'IMPORT_MEDIA_FETCH_FAILED';

export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

export interface FetchPolicy {
  /** Lower-case site host (ImportSource.site_host). */
  siteHost: string;
  /** Hosts rewritten to `siteHost` (D10). */
  aliases: string[];
  /** Media path prefix, default `/wp-content/uploads/`. */
  uploadsPath?: string;
}

export interface SafeFetchOptions {
  maxBytes: number;
  accept?: string;
  purpose: 'media' | 'rest';
  auth?: { user: string; pass: string };
  /** e.g. `bytes=0-15` (dry-run media verification). */
  range?: string;
  /**
   * Return only the first `maxBytes` bytes instead of failing when the body
   * is larger (servers that ignore `range`). Used for magic-byte probes only;
   * the body of such a response is a prefix, never a whole file.
   */
  truncate?: boolean;
}

export interface SafeFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  /** Final URL after redirects. */
  url: string;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type DnsLookup = (host: string) => Promise<ResolvedAddress[]>;

export interface TransportTimeouts {
  connectMs: number;
  headersMs: number;
  idleMs: number;
}

export interface TransportRequest {
  url: URL;
  address: string;
  family: number;
  headers: Record<string, string>;
  signal: AbortSignal;
  timeouts: TransportTimeouts;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Buffer | string>;
  destroy(): void;
}

export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export interface SafeFetcherDeps {
  lookup?: DnsLookup;
  transport?: Transport;
  /** Total time budget per request (default 60 s). */
  totalTimeoutMs?: number;
  timeouts?: Partial<TransportTimeouts>;
  /** Default: `IMPORTER_ALLOW_PRIVATE_HOSTS=1` and `NODE_ENV !== 'production'`. */
  allowPrivate?: boolean;
}

export const SAFE_FETCH_USER_AGENT = 'MultiStoresImporter/1.0';
export const SAFE_FETCH_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_UPLOADS_PATH = '/wp-content/uploads/';

const defaultLookup: DnsLookup = async (host) =>
  (await dns.lookup(host, { all: true, verbatim: true })).map((a) => ({
    address: a.address,
    family: a.family,
  }));

/** `https.request` pinned to the vetted address (no agent reuse, no cookies). */
export const httpsTransport: Transport = (req) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const { url, address, family, headers, signal, timeouts } = req;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(headersTimer);
      reject(err);
    };
    const r = https.request({
      protocol: 'https:',
      host: url.hostname,
      servername: url.hostname,
      port: 443,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers,
      agent: false,
      signal,
      lookup: ((
        _host: string,
        opts: { all?: boolean },
        cb: (...args: unknown[]) => void,
      ) => {
        if (opts?.all) cb(null, [{ address, family }]);
        else cb(null, address, family);
      }) as never,
    });
    const connectTimer = setTimeout(
      () => r.destroy(new Error('connect timeout')),
      timeouts.connectMs,
    );
    const headersTimer = setTimeout(
      () => r.destroy(new Error('headers timeout')),
      timeouts.headersMs,
    );
    r.on('socket', (socket) => {
      socket.once('secureConnect', () => clearTimeout(connectTimer));
    });
    r.setTimeout(timeouts.idleMs, () => r.destroy(new Error('idle timeout')));
    r.on('error', fail);
    r.on('response', (res) => {
      clearTimeout(connectTimer);
      clearTimeout(headersTimer);
      if (settled) {
        res.destroy();
        return;
      }
      settled = true;
      res.setTimeout(timeouts.idleMs, () =>
        res.destroy(new Error('idle timeout')),
      );
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: res,
        destroy: () => res.destroy(),
      });
    });
    r.end();
  });

/** Rejects as soon as `signal` aborts (the total timeout), whatever the transport does. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('total timeout'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('total timeout'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function allowPrivateDefault(): boolean {
  return (
    process.env.IMPORTER_ALLOW_PRIVATE_HOSTS === '1' &&
    process.env.NODE_ENV !== 'production'
  );
}

export class SafeFetcher implements AdapterFetcher {
  private readonly lookup: DnsLookup;
  private readonly transport: Transport;
  private readonly totalTimeoutMs: number;
  private readonly timeouts: TransportTimeouts;
  private readonly allowPrivate: boolean;
  private readonly siteHost: string;
  private readonly aliases: Set<string>;
  private readonly uploadsPath: string;

  constructor(policy: FetchPolicy, deps: SafeFetcherDeps = {}) {
    this.siteHost = policy.siteHost.toLowerCase();
    this.aliases = new Set(policy.aliases.map((a) => a.toLowerCase()));
    const up = policy.uploadsPath || DEFAULT_UPLOADS_PATH;
    this.uploadsPath = (up.startsWith('/') ? up : `/${up}`).replace(
      /\/?$/,
      '/',
    );
    this.lookup = deps.lookup ?? defaultLookup;
    this.transport = deps.transport ?? httpsTransport;
    this.totalTimeoutMs = deps.totalTimeoutMs ?? 60_000;
    this.timeouts = {
      connectMs: deps.timeouts?.connectMs ?? 10_000,
      headersMs: deps.timeouts?.headersMs ?? 15_000,
      idleMs: deps.timeouts?.idleMs ?? 15_000,
    };
    this.allowPrivate = deps.allowPrivate ?? allowPrivateDefault();
  }

  /** Steps 1–2: the URL this fetcher may request, or a coded error. */
  vetUrl(raw: string, purpose: 'media' | 'rest'): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new SafeFetchError('IMPORT_MEDIA_HOST_NOT_ALLOWED', 'Invalid URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new SafeFetchError(
        'IMPORT_MEDIA_HOST_NOT_ALLOWED',
        `Scheme not allowed: ${url.protocol}`,
      );
    }
    if (url.username || url.password) {
      throw new SafeFetchError(
        'IMPORT_MEDIA_HOST_NOT_ALLOWED',
        'Credentials in URLs are not allowed',
      );
    }
    const defaultPort = url.protocol === 'https:' ? '443' : '80';
    if (url.port && url.port !== defaultPort && url.port !== '443') {
      throw new SafeFetchError(
        'IMPORT_MEDIA_HOST_NOT_ALLOWED',
        `Port not allowed: ${url.port}`,
      );
    }
    let host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (this.aliases.has(host)) host = this.siteHost;
    if (host !== this.siteHost) {
      throw new SafeFetchError(
        'IMPORT_MEDIA_HOST_NOT_ALLOWED',
        `Host not allowed: ${url.hostname}`,
      );
    }
    const out = new URL(`https://${host}${url.pathname}${url.search}`);
    if (purpose === 'media') {
      let decoded: string;
      try {
        decoded = decodeURIComponent(out.pathname);
      } catch {
        throw new SafeFetchError(
          'IMPORT_MEDIA_HOST_NOT_ALLOWED',
          'Invalid path encoding',
        );
      }
      if (
        !out.pathname.startsWith(this.uploadsPath) ||
        decoded.includes('..') ||
        decoded.includes('\\')
      ) {
        throw new SafeFetchError(
          'IMPORT_MEDIA_HOST_NOT_ALLOWED',
          `Path outside the uploads folder: ${out.pathname}`,
        );
      }
    }
    return out;
  }

  /** Step 3: resolved addresses, all of them allowed. */
  async resolve(host: string): Promise<ResolvedAddress[]> {
    const literal = host.replace(/^\[|\]$/g, '');
    let addrs: ResolvedAddress[];
    if (isIP(literal)) addrs = [{ address: literal, family: isIP(literal) }];
    else {
      try {
        addrs = await this.lookup(host);
      } catch (e) {
        throw new SafeFetchError(
          'IMPORT_MEDIA_FETCH_FAILED',
          `DNS lookup failed: ${(e as Error).message}`,
        );
      }
    }
    if (!addrs.length) {
      throw new SafeFetchError('IMPORT_MEDIA_FETCH_FAILED', 'No DNS answer');
    }
    if (
      !this.allowPrivate &&
      addrs.some((a) => isDisallowedAddress(a.address))
    ) {
      throw new SafeFetchError(
        'IMPORT_MEDIA_PRIVATE_ADDRESS',
        `Host resolves to a disallowed address: ${host}`,
      );
    }
    return addrs;
  }

  async get(
    rawUrl: string,
    opts: SafeFetchOptions,
  ): Promise<SafeFetchResponse> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('total timeout')),
      this.totalTimeoutMs,
    );
    try {
      return await this.run(rawUrl, opts, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private async run(
    rawUrl: string,
    opts: SafeFetchOptions,
    signal: AbortSignal,
  ): Promise<SafeFetchResponse> {
    let current = rawUrl;
    for (let hop = 0; ; hop++) {
      const url = this.vetUrl(current, opts.purpose);
      const [addr] = await this.resolve(url.hostname);
      const headers: Record<string, string> = {
        'User-Agent': SAFE_FETCH_USER_AGENT,
        Accept: opts.accept ?? '*/*',
        'Accept-Encoding': 'identity',
      };
      if (opts.range) headers.Range = opts.range;
      if (opts.purpose === 'rest' && opts.auth) {
        headers.Authorization = `Basic ${Buffer.from(
          `${opts.auth.user}:${opts.auth.pass}`,
        ).toString('base64')}`;
      }
      let res: TransportResponse;
      try {
        res = await abortable(
          this.transport({
            url,
            address: addr.address,
            family: addr.family,
            headers,
            signal,
            timeouts: this.timeouts,
          }),
          signal,
        );
      } catch (e) {
        throw new SafeFetchError(
          'IMPORT_MEDIA_FETCH_FAILED',
          `Request failed: ${(e as Error).message}`,
        );
      }
      const location = headerValue(res.headers.location);
      if (REDIRECT_STATUSES.has(res.status) && location) {
        res.destroy();
        if (hop >= SAFE_FETCH_MAX_REDIRECTS) {
          throw new SafeFetchError(
            'IMPORT_MEDIA_FETCH_FAILED',
            'Too many redirects',
          );
        }
        current = new URL(location, url).toString();
        continue;
      }
      const declared = Number(headerValue(res.headers['content-length']));
      if (
        !opts.truncate &&
        Number.isFinite(declared) &&
        declared > opts.maxBytes
      ) {
        res.destroy();
        throw new SafeFetchError(
          'IMPORT_MEDIA_TOO_LARGE',
          `Content-Length ${declared} exceeds ${opts.maxBytes}`,
        );
      }
      const chunks: Buffer[] = [];
      let total = 0;
      try {
        for await (const chunk of res.body) {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          total += buf.length;
          if (total > opts.maxBytes && opts.truncate) {
            const keep = buf.length - (total - opts.maxBytes);
            if (keep > 0) chunks.push(buf.subarray(0, keep));
            res.destroy();
            break;
          }
          if (total > opts.maxBytes) {
            res.destroy();
            throw new SafeFetchError(
              'IMPORT_MEDIA_TOO_LARGE',
              `Body exceeds ${opts.maxBytes} bytes`,
            );
          }
          chunks.push(buf);
        }
      } catch (e) {
        if (e instanceof SafeFetchError) throw e;
        throw new SafeFetchError(
          'IMPORT_MEDIA_FETCH_FAILED',
          `Read failed: ${(e as Error).message}`,
        );
      }
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        const s = headerValue(v);
        if (s !== undefined) flat[k.toLowerCase()] = s;
      }
      return {
        status: res.status,
        headers: flat,
        body: Buffer.concat(chunks),
        url: url.toString(),
      };
    }
  }
}

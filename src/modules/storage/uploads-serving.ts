/**
 * `/uploads/*` in s3 mode: an Express handler (mounted by main.ts outside the
 * `/api` prefix, in place of `useStaticAssets`) that streams the object from
 * `PublicStorage.getForServing` with the same headers the static handler
 * sends today, so browsers and Cloudflare keep caching:
 *
 * - `Cache-Control: public, max-age=31536000, immutable` (uuid file names);
 *   `customer-previews/` → `public, max-age=86400` + `X-Robots-Tag: noindex`;
 * - `.svg` → `Content-Disposition: attachment` (never rendered as a document
 *   on this origin);
 * - `ETag` / `Last-Modified` (+ `If-None-Match` / `If-Modified-Since` → 304),
 *   `Content-Length`, `X-Content-Type-Options: nosniff`, `Accept-Ranges: bytes`;
 * - byte ranges (product videos: iOS Safari only plays MP4 over 206, and
 *   seeking needs it): ONE range `bytes=a-b` / `bytes=a-` / `bytes=-n` →
 *   206 + `Content-Range: bytes a-b/size` from a single ranged S3 read
 *   (never the whole object); a range past the end → 416 +
 *   `Content-Range: bytes * /size` (no space) and `Cache-Control: no-store`.
 *   A multi-range, a non-`bytes` unit or a malformed header is ignored and
 *   the full object is sent with 200 (RFC 9110 §14.2 allows ignoring Range;
 *   players only ever send one range). `If-Range` that does not match the
 *   ETag / Last-Modified also yields the full 200. Conditional headers are
 *   evaluated first: a fresh `If-None-Match` answers 304 even with a Range;
 * - `HEAD` answers headers only (HeadObject, no body read), ranges included;
 *   other methods fall through (404);
 * - only `uploads/<folder>/<file>` (or one extra segment) is looked up: `..`,
 *   backslashes, encoded slashes and anything else answer 404 without a read;
 * - a client that disconnects (seeking aborts the previous request) destroys
 *   the storage stream, also when it left before the S3 read resolved; a
 *   storage error after the headers went out drops the connection instead
 *   of throwing.
 */
import type { NextFunction, Request, Response } from 'express';
import type { Readable } from 'stream';
import { isPublicMediaKey, publicObjectHeaders } from './public-storage';
import type { PublicStorage } from './public-storage';
import { contentTypeFor } from './local-object-storage';
import {
  RangeNotSatisfiableError,
  resolveByteRange,
  type ByteRangeSpec,
  type ObjectBody,
  type ObjectHead,
  type ResolvedByteRange,
} from './object-storage';

export type UploadsRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => void;

/** `/<folder>/<file>` (the path under `/uploads`) → object key, or null. */
export function uploadsPathToKey(urlPath: string): string | null {
  const raw = urlPath.split(/[?#]/, 1)[0];
  if (!raw || raw.includes('\\') || /%2f|%5c|%00/i.test(raw)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  const key = `uploads/${decoded.replace(/^\/+/, '')}`;
  return isPublicMediaKey(key) ? key : null;
}

/** Offsets longer than this are not parsed (beyond any object we store). */
const MAX_OFFSET_DIGITS = 15;

function toOffset(digits: string): number | null {
  if (digits.length > MAX_OFFSET_DIGITS) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * A single-range `Range` header → spec, or null when the header must be
 * ignored (absent, another unit, several ranges, malformed, `b < a`).
 */
export function parseRangeHeader(
  header: string | string[] | undefined,
): ByteRangeSpec | null {
  if (typeof header !== 'string') return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (a === '') {
    const suffix = toOffset(b);
    return suffix === null ? null : { suffix };
  }
  const start = toOffset(a);
  if (start === null) return null;
  if (b === '') return { start };
  const end = toOffset(b);
  if (end === null || end < start) return null;
  return { start, end };
}

function freshByEtag(req: Request, etag: string | null): boolean {
  const inm = req.headers['if-none-match'];
  if (!etag || !inm) return false;
  const tags = (Array.isArray(inm) ? inm.join(',') : inm)
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''));
  return tags.includes('*') || tags.includes(etag.replace(/^W\//, ''));
}

function freshByDate(req: Request, lastModified: Date | null): boolean {
  const ims = req.headers['if-modified-since'];
  if (!lastModified || !ims || Array.isArray(ims)) return false;
  const since = Date.parse(ims);
  if (Number.isNaN(since)) return false;
  // HTTP dates have second precision.
  return Math.floor(lastModified.getTime() / 1000) * 1000 <= since;
}

/**
 * `If-Range` (RFC 9110 §13.1.5): absent → the range applies; an entity tag
 * must match strongly (a weak tag never does); a date must equal
 * Last-Modified (second precision).
 */
function ifRangeMatches(req: Request, meta: ObjectHead): boolean {
  const raw = req.headers['if-range'];
  if (raw === undefined) return true;
  if (Array.isArray(raw)) return false;
  const value = raw.trim();
  if (value.startsWith('"') || value.startsWith('W/')) {
    return (
      !!meta.etag &&
      !meta.etag.startsWith('W/') &&
      !value.startsWith('W/') &&
      value === meta.etag
    );
  }
  const date = Date.parse(value);
  if (Number.isNaN(date) || !meta.lastModified) return false;
  return Math.floor(meta.lastModified.getTime() / 1000) * 1000 === date;
}

/** Storage failed: 502 when nothing went out yet, else drop the connection. */
function fail(res: Response): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  // The object headers may already be set: a CDN must never keep a 502
  // under the immutable year-long rule.
  for (const h of [
    'Content-Length',
    'Content-Range',
    'Content-Disposition',
    'ETag',
    'Last-Modified',
  ]) {
    res.removeHeader(h);
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(502).end();
}

export function createUploadsServingHandler(
  storage: PublicStorage,
): UploadsRequestHandler {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const key = uploadsPathToKey(req.path ?? req.url ?? '');
    if (!key) {
      res.status(404).end();
      return;
    }

    // The storage stream of this request (if any) dies with the connection,
    // also when the client left before the read resolved.
    let closed = false;
    let active: Readable | null = null;
    res.on('close', () => {
      closed = true;
      if (active && !active.destroyed) active.destroy();
    });
    const adopt = (body: ObjectBody | null): boolean => {
      if (!body) return true;
      active = body.stream;
      if (closed || res.destroyed) {
        body.stream.destroy();
        return false;
      }
      return true;
    };

    void serve(storage, key, req, res, adopt).catch(() => {
      if (active && !active.destroyed) active.destroy();
      if (!closed) fail(res);
    });
  };
}

async function serve(
  storage: PublicStorage,
  key: string,
  req: Request,
  res: Response,
  adopt: (body: ObjectBody | null) => boolean,
): Promise<void> {
  const isHead = req.method === 'HEAD';
  let range = parseRangeHeader(req.headers.range);
  let body: ObjectBody | null = null;
  let meta: ObjectHead | null;
  let unsatisfiable = false;

  if (isHead) {
    meta = await storage.headForServing(key);
  } else {
    try {
      body = await storage.getForServing(key, range ? { range } : undefined);
      if (!adopt(body)) return;
      meta = body;
    } catch (e) {
      if (!(e instanceof RangeNotSatisfiableError)) throw e;
      meta = e.head;
      unsatisfiable = true;
    }
  }
  if (!meta) {
    res.status(404).end();
    return;
  }

  // `If-Range` mismatch: the range is dropped and the full object is sent.
  if (range && !ifRangeMatches(req, meta)) {
    range = null;
    unsatisfiable = false;
    if (!isHead && (!body || body.range)) {
      body?.stream.destroy();
      body = await storage.getForServing(key);
      if (!adopt(body)) return;
      if (!body) {
        res.status(404).end();
        return;
      }
      meta = body;
    }
  }

  let slice: ResolvedByteRange | null = null;
  if (range && !unsatisfiable) {
    if (isHead) {
      slice = resolveByteRange(range, meta.size);
      if (!slice) unsatisfiable = true;
    } else {
      // The driver may answer the whole object (no Content-Range): 200.
      slice = body?.range ?? null;
    }
  }

  const rules = publicObjectHeaders(key);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', rules.cacheControl);
  if (rules.contentDisposition) {
    res.setHeader('Content-Disposition', rules.contentDisposition);
  }
  if (rules.robots) res.setHeader('X-Robots-Tag', rules.robots);
  res.setHeader('Content-Type', meta.contentType || contentTypeFor(key));
  res.setHeader('Accept-Ranges', 'bytes');
  if (meta.etag) res.setHeader('ETag', meta.etag);
  if (meta.lastModified) {
    res.setHeader('Last-Modified', meta.lastModified.toUTCString());
  }

  // Conditional requests: ETag wins when the client sent one. Evaluated
  // before the range (RFC 9110 §13.2.2).
  const inm = req.headers['if-none-match'];
  const fresh = inm
    ? freshByEtag(req, meta.etag)
    : freshByDate(req, meta.lastModified);
  if (fresh) {
    body?.stream.destroy();
    res.status(304).end();
    return;
  }

  if (unsatisfiable) {
    body?.stream.destroy();
    // A cache keyed on the URL alone must never keep this answer.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Range', `bytes */${meta.size}`);
    res.setHeader('Content-Length', '0');
    res.status(416).end();
    return;
  }

  if (slice) {
    res.setHeader(
      'Content-Range',
      `bytes ${slice.start}-${slice.end}/${meta.size}`,
    );
    res.setHeader('Content-Length', String(slice.end - slice.start + 1));
    res.status(206);
  } else {
    res.setHeader('Content-Length', String(meta.size));
    res.status(200);
  }

  if (isHead || !body) {
    body?.stream.destroy();
    res.end();
    return;
  }

  const stream = body.stream;
  stream.on('error', () => fail(res));
  stream.pipe(res);
}

/**
 * Post-migration spot check (plans/s3-storage/SPEC.md "Migration tooling"):
 * samples N local files per scope (reservoir sampling over a streamed walk,
 * so memory stays flat), downloads each object (GetObject) and compares the
 * sha256 with the local file; with --http it also fetches the public media
 * URL through the API (`<base>/uploads/<folder>/<file>`) and compares bytes
 * and the headers the storefront relies on (Cache-Control, Content-Type,
 * SVG Content-Disposition). Prints a pass/fail table (counts per scope and
 * check; failing keys listed) and exits 1 on any failure.
 *
 *   --scope media|private|invoices|all   (default all)
 *   --sample 50                          keys per scope
 *   --http https://ms-api.example.com    also exercise the /uploads route (media)
 *   --seed 1234                          deterministic sample
 *   --concurrency 4
 *
 * Read-only on S3, on disk and on the API. No DB access.
 *
 * Run with:  npx ts-node prisma/scripts/storage-verify.ts --scope media --sample 100 --http https://ms-api.example.com
 */
import 'dotenv/config';
import { createHash } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import * as path from 'path';
import {
  SCOPES,
  bucketRole,
  cacheControlFor,
  contentDispositionFor,
  contentTypeFor,
  isSkippedFileName,
  keyFor,
  type Scope,
} from './storage-migrate.planner';
import { createS3, readS3Env, type S3Ops } from './storage-migrate.s3';

interface Options {
  scopes: Scope[];
  sample: number;
  http: string | null;
  seed: number;
  concurrency: number;
}

export function parseArgs(argv: string[]): Options {
  const out: Options = {
    scopes: [...SCOPES],
    sample: 50,
    http: null,
    seed: Date.now() % 1_000_000,
    concurrency: 4,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (flag: string): string => {
      if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    const int = (flag: string, min: number): number => {
      const n = Number(value(flag));
      if (!Number.isInteger(n) || n < min)
        throw new Error(`${flag} must be an integer >= ${min}`);
      return n;
    };
    if (a === '--scope' || a.startsWith('--scope=')) {
      const v = value('--scope').trim();
      if (v === 'all') out.scopes = [...SCOPES];
      else {
        const list = v.split(',').map((s) => s.trim()) as Scope[];
        for (const s of list)
          if (!SCOPES.includes(s))
            throw new Error(`--scope: unknown scope ${s}`);
        out.scopes = [...new Set(list)];
      }
    } else if (a === '--sample' || a.startsWith('--sample='))
      out.sample = int('--sample', 1);
    else if (a === '--seed' || a.startsWith('--seed='))
      out.seed = int('--seed', 0);
    else if (a === '--concurrency' || a.startsWith('--concurrency='))
      out.concurrency = int('--concurrency', 1);
    else if (a === '--http' || a.startsWith('--http=')) {
      out.http = value('--http').trim().replace(/\/+$/, '');
      if (!/^https?:\/\/[^/\s]+$/.test(out.http))
        throw new Error(
          '--http must be an origin like https://ms-api.example.com',
        );
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

// ── Roots (same rules as storage-migrate) ───────────────────────────────────

interface ScopeRoot {
  scope: Scope;
  root: string;
  bucket: string;
  exclude: string[];
}

function envTrim(name: string): string {
  return (process.env[name] ?? '').trim();
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolveRoots(scopes: Scope[]): ScopeRoot[] {
  const mediaRoot = path.resolve(process.cwd(), 'uploads');
  const privateRoot = path.resolve(
    envTrim('PRIVATE_STORAGE_DIR') || path.join(process.cwd(), 'storage'),
  );
  const invoiceRoot = path.resolve(
    envTrim('INVOICE_STORAGE_DIR') ||
      path.join(process.cwd(), 'storage', 'invoices'),
  );
  return scopes.map((scope) => {
    const bucket =
      bucketRole(scope) === 'media'
        ? envTrim('S3_MEDIA_BUCKET')
        : envTrim('S3_PRIVATE_BUCKET');
    if (!bucket)
      throw new Error(
        `${bucketRole(scope) === 'media' ? 'S3_MEDIA_BUCKET' : 'S3_PRIVATE_BUCKET'} is not set`,
      );
    if (scope === 'media')
      return { scope, root: mediaRoot, bucket, exclude: [] };
    if (scope === 'invoices')
      return { scope, root: invoiceRoot, bucket, exclude: [] };
    return {
      scope,
      root: privateRoot,
      bucket,
      exclude: isInside(invoiceRoot, privateRoot) ? [invoiceRoot] : [],
    };
  });
}

// ── Reservoir sample over a streamed walk ───────────────────────────────────

interface LocalFile {
  key: string;
  abs: string;
  size: number;
}

/** Small deterministic PRNG (mulberry32) so a failing sample can be re-run with --seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Classic reservoir sampling: keeps `n` items of a stream with uniform probability. */
export function reservoir<T>(n: number, random: () => number) {
  const picked: T[] = [];
  let seen = 0;
  return {
    offer(item: T) {
      seen++;
      if (picked.length < n) picked.push(item);
      else {
        const j = Math.floor(random() * seen);
        if (j < n) picked[j] = item;
      }
    },
    get items() {
      return picked;
    },
    get seen() {
      return seen;
    },
  };
}

async function sampleScope(
  sr: ScopeRoot,
  n: number,
  random: () => number,
): Promise<{ items: LocalFile[]; seen: number }> {
  const res = reservoir<LocalFile>(n, random);
  const stack = [sr.root];
  try {
    await fs.access(sr.root);
  } catch {
    return { items: [], seen: 0 };
  }
  while (stack.length) {
    const dir = stack.pop()!;
    if (sr.exclude.some((ex) => ex === dir || isInside(dir, ex))) continue;
    let handle;
    try {
      handle = await fs.opendir(dir);
    } catch {
      continue;
    }
    for await (const ent of handle) {
      if (ent.isSymbolicLink()) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!ent.isFile() || isSkippedFileName(ent.name)) continue;
      const st = await fs.stat(abs).catch(() => null);
      if (!st || st.size === 0) continue;
      res.offer({
        key: keyFor(sr.scope, path.relative(sr.root, abs)),
        abs,
        size: st.size,
      });
    }
  }
  return { items: res.items, seen: res.seen };
}

async function sha256File(abs: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(abs, {
    highWaterMark: 1024 * 1024,
  }))
    h.update(chunk as Buffer);
  return h.digest('hex');
}

// ── Checks ──────────────────────────────────────────────────────────────────

interface CheckResult {
  key: string;
  s3: string | null; // null = pass
  http: string | null | undefined; // undefined = not run
}

/** Header comparison for the API /uploads route (null = pass). */
export function compareHttp(
  scope: Scope,
  key: string,
  res: {
    status: number;
    cacheControl: string | null;
    contentType: string | null;
    contentDisposition: string | null;
    sha256: string;
    size: number;
  },
  local: { sha256: string; size: number },
): string | null {
  const problems: string[] = [];
  if (res.status !== 200) return `HTTP ${res.status}`;
  if (res.size !== local.size)
    problems.push(`size ${res.size} != ${local.size}`);
  if (res.sha256 !== local.sha256) problems.push('bytes differ');
  const wantCache = cacheControlFor(scope, key);
  if (
    wantCache &&
    normalizeHeader(res.cacheControl) !== normalizeHeader(wantCache)
  ) {
    problems.push(
      `cache-control "${res.cacheControl ?? ''}" != "${wantCache}"`,
    );
  }
  const wantType = contentTypeFor(key).split(';')[0].trim();
  const gotType = (res.contentType ?? '').split(';')[0].trim().toLowerCase();
  if (wantType !== 'application/octet-stream' && gotType !== wantType) {
    problems.push(`content-type "${res.contentType ?? ''}" != "${wantType}"`);
  }
  const wantDisp = contentDispositionFor(scope, key);
  if (
    wantDisp &&
    !(res.contentDisposition ?? '').toLowerCase().startsWith('attachment')
  ) {
    problems.push(
      `content-disposition "${res.contentDisposition ?? ''}" != attachment`,
    );
  }
  return problems.length ? problems.join('; ') : null;
}

function normalizeHeader(v: string | null | undefined): string {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(', ');
}

async function fetchDigest(url: string): Promise<{
  status: number;
  cacheControl: string | null;
  contentType: string | null;
  contentDisposition: string | null;
  sha256: string;
  size: number;
}> {
  const res = await fetch(url, {
    redirect: 'manual',
    headers: { 'user-agent': 'storage-verify/1' },
  });
  const h = createHash('sha256');
  let size = 0;
  if (res.body) {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      h.update(chunk);
      size += chunk.length;
    }
  }
  return {
    status: res.status,
    cacheControl: res.headers.get('cache-control'),
    contentType: res.headers.get('content-type'),
    contentDisposition: res.headers.get('content-disposition'),
    sha256: h.digest('hex'),
    size,
  };
}

async function checkOne(
  sr: ScopeRoot,
  f: LocalFile,
  s3: S3Ops,
  http: string | null,
): Promise<CheckResult> {
  const local = await sha256File(f.abs);
  let s3Problem: string | null = null;
  try {
    const got = await s3.getDigest(sr.bucket, f.key);
    if (!got) s3Problem = 'missing';
    else if (got.size !== f.size) s3Problem = `size ${got.size} != ${f.size}`;
    else if (got.sha256 !== local) s3Problem = 'sha256 differs';
    else if (got.head.sha256 && got.head.sha256 !== local)
      s3Problem = 'sha256 metadata differs';
  } catch (err) {
    s3Problem = (err as Error).name ?? 'error';
  }
  let httpProblem: string | null | undefined = undefined;
  if (http && sr.scope === 'media') {
    try {
      const url = `${http}/${f.key.split('/').map(encodeURIComponent).join('/')}`;
      httpProblem = compareHttp(sr.scope, f.key, await fetchDigest(url), {
        sha256: local,
        size: f.size,
      });
    } catch (err) {
      httpProblem = (err as Error).message;
    }
  }
  return { key: f.key, s3: s3Problem, http: httpProblem };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const roots = resolveRoots(opts.scopes);
  const s3 = createS3(readS3Env());
  const random = rng(opts.seed);
  console.log(
    `storage-verify sample=${opts.sample} seed=${opts.seed}${opts.http ? ` http=${opts.http}` : ''}`,
  );
  let failed = 0;
  const rows: string[] = [];
  rows.push(
    `${'scope'.padEnd(9)} ${'files'.padStart(7)} ${'sampled'.padStart(8)} ${'s3 ok'.padStart(6)} ${'s3 fail'.padStart(8)} ${'http ok'.padStart(8)} ${'http fail'.padStart(10)}`,
  );
  const failing: string[] = [];
  for (const sr of roots) {
    const { items, seen } = await sampleScope(sr, opts.sample, random);
    const results: CheckResult[] = [];
    let i = 0;
    const workers = Array.from(
      { length: Math.min(opts.concurrency, items.length) },
      async () => {
        while (i < items.length) {
          const f = items[i++];
          results.push(await checkOne(sr, f, s3, opts.http));
        }
      },
    );
    await Promise.all(workers);
    const s3ok = results.filter((r) => r.s3 === null).length;
    const s3fail = results.length - s3ok;
    const httpRan = results.filter((r) => r.http !== undefined);
    const httpok = httpRan.filter((r) => r.http === null).length;
    const httpfail = httpRan.length - httpok;
    failed += s3fail + httpfail;
    rows.push(
      `${sr.scope.padEnd(9)} ${String(seen).padStart(7)} ${String(results.length).padStart(8)} ${String(s3ok).padStart(6)} ${String(s3fail).padStart(8)} ${(httpRan.length ? String(httpok) : '-').padStart(8)} ${(httpRan.length ? String(httpfail) : '-').padStart(10)}`,
    );
    for (const r of results) {
      if (r.s3) failing.push(`  ${sr.scope} s3    ${r.key}: ${r.s3}`);
      if (r.http) failing.push(`  ${sr.scope} http  ${r.key}: ${r.http}`);
    }
  }
  console.log('');
  console.log(rows.join('\n'));
  if (failing.length) {
    console.log('\nfailures:');
    console.log(failing.join('\n'));
  }
  console.log(
    `\n${failed === 0 ? 'PASS' : 'FAIL'} (${failed} failing check(s))`,
  );
  return failed === 0 ? 0 : 1;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}

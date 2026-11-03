/**
 * Pure half of `storage-migrate.ts` (no fs / Prisma / S3 imports): key
 * mapping, object metadata rules, classification, fingerprint, orphan diff,
 * aggregation and the masked report. Shared with `storage-verify.ts`.
 */
import { createHash } from 'crypto';

export type Scope = 'media' | 'private' | 'invoices';
export const SCOPES: readonly Scope[] = ['media', 'private', 'invoices'];

export type Action = 'copy' | 'identical' | 'mismatch';

export interface RemoteState {
  size: number;
  sha256: string | null;
  etag: string | null;
  /** HeadObject was refused: only the listing (size, etag) is known. */
  sizeOnly?: boolean;
}

export interface PlanEntry {
  scope: Scope;
  key: string;
  /** Aggregation bucket (never a file name): media folder, private namespace, `invoices`. */
  folder: string;
  size: number;
  /** Local sha256; null only on the --resume fast path (remote trusted). */
  sha256: string | null;
  md5: string | null;
  action: Action;
  remote: RemoteState | null;
}

// ── Keys ────────────────────────────────────────────────────────────────────

/** Object key for a file at `relPath` (posix, relative to the scope root). */
export function keyFor(scope: Scope, relPath: string): string {
  const rel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  switch (scope) {
    case 'media':
      return `uploads/${rel}`;
    case 'private':
      return rel;
    case 'invoices':
      return `invoices/${rel}`;
  }
}

/** Bucket role per scope. */
export function bucketRole(scope: Scope): 'media' | 'private' {
  return scope === 'media' ? 'media' : 'private';
}

/** Aggregation folder of a key (media `uploads/<folder>/…` → folder). */
export function folderOf(scope: Scope, key: string): string {
  const parts = key.split('/');
  if (scope === 'media') return parts[1] ?? '(root)';
  if (scope === 'invoices') return 'invoices';
  return parts.length > 1 ? parts[0] : '(root)';
}

/** True for files that must never be copied (temp files of atomic writes, OS cruft). */
export function isSkippedFileName(name: string): boolean {
  return (
    name.startsWith('.') ||
    name.endsWith('.tmp') ||
    name === 'Thumbs.db' ||
    name === 'desktop.ini'
  );
}

// ── Object metadata (must match the API's serving headers, SPEC.md) ─────────

const CONTENT_TYPES: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.ai': 'application/postscript',
  '.json': 'application/json',
  '.gz': 'application/gzip',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export function extensionOf(key: string): string {
  const base = key.slice(key.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot).toLowerCase();
}

export function contentTypeFor(key: string): string {
  return CONTENT_TYPES[extensionOf(key)] ?? 'application/octet-stream';
}

export const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
export const CACHE_PREVIEW = 'public, max-age=86400';

/** Cache-Control as the API sends it today (main.ts); private objects get none. */
export function cacheControlFor(scope: Scope, key: string): string | undefined {
  if (scope !== 'media') return undefined;
  return key.startsWith('uploads/customer-previews/')
    ? CACHE_PREVIEW
    : CACHE_IMMUTABLE;
}

/** SVG is served as a download (main.ts) so a stored script cannot run on our origin. */
export function contentDispositionFor(
  scope: Scope,
  key: string,
): string | undefined {
  return scope === 'media' && extensionOf(key) === '.svg'
    ? 'attachment'
    : undefined;
}

/**
 * SSE per scope: private/invoices with KMS when a key id is configured;
 * otherwise `s3`, which the uploader maps to "no header" (bucket default).
 */
export function sseFor(
  scope: Scope,
  kmsKeyId: string | undefined,
): 'kms' | 's3' {
  return scope !== 'media' && kmsKeyId ? 'kms' : 's3';
}

// ── Classification ──────────────────────────────────────────────────────────

/**
 * `copy` when the object is missing; `identical` when size and sha256
 * metadata match; otherwise `mismatch` (different bytes, or an object written
 * by something else without our sha256 metadata). When the key may not call
 * HeadObject (`remote.sizeOnly`, listing only) a matching size counts as
 * identical: `storage-verify` (GetObject + sha256) is the real check then.
 */
export function classify(
  local: { size: number; sha256: string | null },
  remote: RemoteState | null,
): Action {
  if (!remote) return 'copy';
  if (remote.size !== local.size) return 'mismatch';
  if (remote.sizeOnly) return 'identical';
  if (!remote.sha256) return 'mismatch';
  if (local.sha256 === null) return 'identical'; // --resume fast path (size matched, metadata present)
  return remote.sha256 === local.sha256 ? 'identical' : 'mismatch';
}

/** Entries --apply uploads: every `copy`, plus `mismatch` with --overwrite. */
export function isActionable(e: PlanEntry, overwrite: boolean): boolean {
  return e.action === 'copy' || (e.action === 'mismatch' && overwrite);
}

/**
 * Post-upload check: size + sha256 metadata must match; for single-part
 * SSE-S3 objects the ETag is the MD5 and is checked too (SSE-KMS and
 * multipart ETags are not MD5s). With a listing-only remote (`sizeOnly`)
 * the sha256 metadata is unknown and only size (+ ETag) is compared.
 */
export function verifyUploaded(
  local: { size: number; sha256: string; md5: string | null },
  remote: RemoteState & { sse: string | null },
): string | null {
  if (remote.size !== local.size) return `size ${remote.size} != ${local.size}`;
  if (!remote.sizeOnly && remote.sha256 !== local.sha256)
    return `sha256 metadata ${remote.sha256 ?? 'missing'} != ${local.sha256}`;
  if (
    local.md5 &&
    remote.etag &&
    !remote.etag.includes('-') &&
    remote.sse !== 'aws:kms' &&
    remote.etag.toLowerCase() !== local.md5.toLowerCase()
  ) {
    return `etag ${remote.etag} != md5 ${local.md5}`;
  }
  return null;
}

// ── Fingerprint ─────────────────────────────────────────────────────────────

/**
 * sha256 over the sorted actionable set (`scope|key|size|sha256|action`) plus
 * the --overwrite flag; 16 hex chars. --apply re-plans and refuses when the
 * local tree or the buckets changed since the dry run.
 */
export function fingerprint(
  entries: readonly PlanEntry[],
  overwrite: boolean,
): string {
  const lines = entries
    .filter((e) => isActionable(e, overwrite))
    .map(
      (e) =>
        `${e.scope}|${e.key}|${e.size}|${e.sha256 ?? e.remote?.sha256 ?? ''}|${e.action}`,
    )
    .sort();
  return createHash('sha256')
    .update(JSON.stringify({ overwrite, lines }))
    .digest('hex')
    .slice(0, 16);
}

// ── Aggregation ─────────────────────────────────────────────────────────────

export interface Tally {
  files: number;
  bytes: number;
}
export type ActionTally = Record<Action, Tally>;

export function emptyActionTally(): ActionTally {
  return {
    copy: { files: 0, bytes: 0 },
    identical: { files: 0, bytes: 0 },
    mismatch: { files: 0, bytes: 0 },
  };
}

/** Per scope → folder → action counts and bytes. */
export function aggregate(
  entries: readonly PlanEntry[],
): Record<string, Record<string, ActionTally>> {
  const out: Record<string, Record<string, ActionTally>> = {};
  for (const e of entries) {
    const byFolder = (out[e.scope] ??= {});
    const t = (byFolder[e.folder] ??= emptyActionTally());
    t[e.action].files++;
    t[e.action].bytes += e.size;
  }
  return out;
}

// ── Orphans ─────────────────────────────────────────────────────────────────

export interface OrphanReport {
  /** DB points at a key that is not in the local tree: these matter. */
  referenced_missing: string[];
  /** Local files no DB row references, per folder (count + bytes only). */
  unreferenced: Record<string, Tally>;
  referenced_total: number;
  unreferenced_total: Tally;
}

export function diffOrphans(
  scope: Scope,
  local: Iterable<{ key: string; size: number }>,
  referenced: ReadonlySet<string>,
): OrphanReport {
  const localKeys = new Set<string>();
  const unreferenced: Record<string, Tally> = {};
  const total: Tally = { files: 0, bytes: 0 };
  for (const f of local) {
    localKeys.add(f.key);
    if (!referenced.has(f.key)) {
      const t = (unreferenced[folderOf(scope, f.key)] ??= {
        files: 0,
        bytes: 0,
      });
      t.files++;
      t.bytes += f.size;
      total.files++;
      total.bytes += f.size;
    }
  }
  const referenced_missing = [...referenced]
    .filter((k) => !localKeys.has(k))
    .sort();
  return {
    referenced_missing,
    unreferenced,
    referenced_total: referenced.size,
    unreferenced_total: total,
  };
}

// ── Report rendering (masked: folders, counts, bytes) ───────────────────────

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function renderAggregate(
  agg: Record<string, Record<string, ActionTally>>,
): string {
  const L: string[] = [];
  for (const scope of Object.keys(agg)) {
    L.push(`[${scope}]`);
    const folders = Object.keys(agg[scope]).sort();
    const w = Math.max(6, ...folders.map((f) => f.length));
    L.push(
      `  ${'folder'.padEnd(w)}  ${'copy'.padStart(7)} ${'bytes'.padStart(10)}  ${'identical'.padStart(9)} ${'bytes'.padStart(10)}  ${'mismatch'.padStart(8)} ${'bytes'.padStart(10)}`,
    );
    const sum = emptyActionTally();
    for (const f of folders) {
      const t = agg[scope][f];
      for (const a of ['copy', 'identical', 'mismatch'] as Action[]) {
        sum[a].files += t[a].files;
        sum[a].bytes += t[a].bytes;
      }
      L.push(
        `  ${f.padEnd(w)}  ${String(t.copy.files).padStart(7)} ${formatBytes(t.copy.bytes).padStart(10)}  ${String(t.identical.files).padStart(9)} ${formatBytes(t.identical.bytes).padStart(10)}  ${String(t.mismatch.files).padStart(8)} ${formatBytes(t.mismatch.bytes).padStart(10)}`,
      );
    }
    L.push(
      `  ${'TOTAL'.padEnd(w)}  ${String(sum.copy.files).padStart(7)} ${formatBytes(sum.copy.bytes).padStart(10)}  ${String(sum.identical.files).padStart(9)} ${formatBytes(sum.identical.bytes).padStart(10)}  ${String(sum.mismatch.files).padStart(8)} ${formatBytes(sum.mismatch.bytes).padStart(10)}`,
    );
  }
  return L.join('\n');
}

export function renderOrphans(
  scope: Scope,
  o: OrphanReport,
  maxListed = 200,
): string {
  const L: string[] = [];
  L.push(
    `[${scope}] orphan report: ${o.referenced_total} key(s) referenced by the DB`,
  );
  if (o.referenced_missing.length === 0) {
    L.push('  referenced-missing: 0 (every DB reference has a local file)');
  } else {
    L.push(
      `  referenced-missing: ${o.referenced_missing.length}  <-- DB rows point at files that do NOT exist locally`,
    );
    for (const k of o.referenced_missing.slice(0, maxListed))
      L.push(`    ${k}`);
    if (o.referenced_missing.length > maxListed) {
      L.push(
        `    ... ${o.referenced_missing.length - maxListed} more in the JSON report`,
      );
    }
  }
  L.push(
    `  unreferenced (copied anyway, cleanup later): ${o.unreferenced_total.files} file(s), ${formatBytes(o.unreferenced_total.bytes)}`,
  );
  for (const f of Object.keys(o.unreferenced).sort()) {
    const t = o.unreferenced[f];
    L.push(
      `    ${f.padEnd(24)} ${String(t.files).padStart(7)}  ${formatBytes(t.bytes).padStart(10)}`,
    );
  }
  return L.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export interface Options {
  scopes: Scope[];
  mode: 'dry-run' | 'apply';
  fingerprint: string | null;
  concurrency: number;
  resume: boolean;
  overwrite: boolean;
  /** Skip HeadObject (offline sizing: everything classifies as copy). */
  skipHead: boolean;
  /** Skip the DB orphan report. */
  noDb: boolean;
  /** Stop after this many files per scope (rehearsal). */
  limit: number | null;
}

export function parseArgs(argv: string[]): Options {
  const out: Options = {
    scopes: [...SCOPES],
    mode: 'dry-run',
    fingerprint: null,
    concurrency: 8,
    resume: false,
    overwrite: false,
    skipHead: false,
    noDb: false,
    limit: null,
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
    if (a === '--dry-run') out.mode = 'dry-run';
    else if (a === '--apply') out.mode = 'apply';
    else if (a === '--resume') out.resume = true;
    else if (a === '--overwrite') out.overwrite = true;
    else if (a === '--skip-head') out.skipHead = true;
    else if (a === '--no-db') out.noDb = true;
    else if (a === '--scope' || a.startsWith('--scope=')) {
      const v = value('--scope').trim();
      if (v === 'all') out.scopes = [...SCOPES];
      else {
        const list = v.split(',').map((s) => s.trim()) as Scope[];
        for (const s of list)
          if (!SCOPES.includes(s))
            throw new Error(`--scope: unknown scope ${s}`);
        out.scopes = [...new Set(list)];
      }
    } else if (a === '--fingerprint' || a.startsWith('--fingerprint='))
      out.fingerprint = value('--fingerprint').trim().toLowerCase();
    else if (a === '--concurrency' || a.startsWith('--concurrency='))
      out.concurrency = int('--concurrency', 1);
    else if (a === '--limit' || a.startsWith('--limit='))
      out.limit = int('--limit', 1);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (out.mode === 'apply' && !out.fingerprint) {
    throw new Error(
      '--apply requires --fingerprint=<hash printed by the dry run>',
    );
  }
  if (out.mode === 'apply' && out.skipHead)
    throw new Error('--skip-head is for dry runs only');
  return out;
}

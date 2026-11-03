/**
 * Local disk → S3 copy of every stored file (plans/s3-storage/SPEC.md
 * "Migration tooling"). Copies only; NEVER deletes or moves a local file.
 *
 * Scopes and keys (meaning never changes; `<p>` = the role's key prefix,
 * S3_MEDIA_PREFIX / S3_PRIVATE_PREFIX, default `media/` / `private/`, so the
 * roles may share one bucket):
 *   media     <cwd>/uploads/<folder>/<file>   → S3_MEDIA_BUCKET    <p>uploads/<folder>/<file>
 *   private   PRIVATE_STORAGE_DIR/<key>       → S3_PRIVATE_BUCKET  <p><key>
 *   invoices  INVOICE_STORAGE_DIR/<key>       → S3_PRIVATE_BUCKET  <p>invoices/<key>
 *
 * Plan: stream the directory walk (no file list in memory until classified,
 * never file contents), sha256 (+ md5) per file, HeadObject (size +
 * x-amz-meta-sha256) → copy | identical | mismatch. Dry run prints counts and
 * bytes per folder (never a customer file name) plus the DB orphan report.
 * --apply uploads `copy` (+ `mismatch` with --overwrite) through the SDK
 * (streamed; multipart >= 5 MB; SSE-KMS for private/invoices when
 * S3_KMS_KEY_ID is set, else no encryption header = bucket default;
 * Content-Type, Cache-Control and SVG Content-Disposition as the API serves
 * them), then verifies size + sha256 metadata (+ ETag = MD5 for single-part
 * SSE-S3). Needs ListBucket + GetObject + PutObject only: a refused
 * HeadBucket/HeadObject falls back to listing (existence + size).
 *
 * Modes / flags:
 *   --scope media|private|invoices|all   (default all; comma list allowed)
 *   --dry-run (default)                  plan + orphan report + fingerprint
 *   --apply --fingerprint=<hash>         re-plan, refuse when the actionable
 *                                        set changed, upload, verify, report
 *   --concurrency 8                      parallel hash/head/upload workers
 *   --resume                             trust objects whose size matches and
 *                                        that carry sha256 metadata (skips the
 *                                        local hash: fast re-run after a stop)
 *   --overwrite                          also upload `mismatch` objects
 *   --skip-head                          dry run without S3 (offline sizing)
 *   --no-db                              skip the orphan report
 *   --limit N                            first N files per scope (rehearsal)
 *
 * Report: BACKUP_DIR/storage-migrate-<ts>.json (counts, bytes, orphans,
 * per-key failures, fingerprint). Exit codes: 0 ok, 1 usage/env/bucket
 * error, 2 fingerprint mismatch (nothing uploaded), 3 some uploads or
 * verifications failed (see report; re-run with --resume).
 *
 * Run with:  npx ts-node prisma/scripts/storage-migrate.ts --scope media --dry-run
 *            npx ts-node prisma/scripts/storage-migrate.ts --scope media --apply --fingerprint=<hash>
 * Runbook:   plans/s3-storage/MIGRATION-RUNBOOK.md
 */
import 'dotenv/config';
import { createHash } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import {
  SCOPES,
  aggregate,
  bucketRole,
  cacheControlFor,
  classify,
  contentDispositionFor,
  contentTypeFor,
  diffOrphans,
  fingerprint,
  folderOf,
  formatBytes,
  isActionable,
  isSkippedFileName,
  keyFor,
  parseArgs,
  renderAggregate,
  renderOrphans,
  sseFor,
  verifyUploaded,
  type Action,
  type Options,
  type OrphanReport,
  type PlanEntry,
  type Scope,
} from './storage-migrate.planner';
import {
  createS3,
  readS3Env,
  rolePrefixes,
  type S3Env,
  type S3Ops,
} from './storage-migrate.s3';
import {
  PRIVATE_KEY_COLUMNS,
  UPLOAD_REF_COLUMNS,
  referencedMediaKeys,
  referencedPrivateKeys,
} from './uploads-url-normalize.planner';
import { streamRows } from './uploads-url-normalize';

// ── Environment ─────────────────────────────────────────────────────────────

interface ScopeRoot {
  scope: Scope;
  root: string;
  bucket: string;
  /** Key prefix of the role inside the bucket ('' or `<x>/`). */
  prefix: string;
  /** Subtrees under `root` that belong to another scope (invoices inside private). */
  exclude: string[];
}

function envTrim(name: string): string {
  return (process.env[name] ?? '').trim();
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
  const media = envTrim('S3_MEDIA_BUCKET');
  const priv = envTrim('S3_PRIVATE_BUCKET');
  const prefixes = rolePrefixes();
  if (media && media === priv && prefixes.media === prefixes.private)
    throw new Error(
      'S3_MEDIA_BUCKET and S3_PRIVATE_BUCKET are the same bucket with the same key prefix; set S3_MEDIA_PREFIX / S3_PRIVATE_PREFIX apart',
    );
  const out: ScopeRoot[] = [];
  for (const scope of scopes) {
    const role = bucketRole(scope);
    const bucket = role === 'media' ? media : priv;
    const prefix = prefixes[role];
    if (!bucket)
      throw new Error(
        `${role === 'media' ? 'S3_MEDIA_BUCKET' : 'S3_PRIVATE_BUCKET'} is not set`,
      );
    if (scope === 'media')
      out.push({ scope, root: mediaRoot, bucket, prefix, exclude: [] });
    else if (scope === 'invoices')
      out.push({ scope, root: invoiceRoot, bucket, prefix, exclude: [] });
    else {
      const exclude = isInside(invoiceRoot, privateRoot) ? [invoiceRoot] : [];
      out.push({ scope, root: privateRoot, bucket, prefix, exclude });
    }
  }
  return out;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ── Streamed directory walk ─────────────────────────────────────────────────

interface LocalFile {
  scope: Scope;
  key: string;
  abs: string;
  size: number;
}

async function* walk(sr: ScopeRoot): AsyncGenerator<LocalFile> {
  const stack: string[] = [sr.root];
  try {
    await fs.access(sr.root);
  } catch {
    return; // missing root = empty scope (e.g. no invoices yet)
  }
  while (stack.length) {
    const dir = stack.pop()!;
    if (sr.exclude.some((ex) => ex === dir || isInside(dir, ex))) continue;
    let handle;
    try {
      handle = await fs.opendir(dir);
    } catch (err) {
      console.error(
        `  ! cannot open ${path.relative(sr.root, dir) || '.'}: ${(err as Error).message}`,
      );
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
      let st;
      try {
        st = await fs.stat(abs);
      } catch {
        continue;
      }
      if (st.size === 0) continue; // empty files are never valid uploads
      yield {
        scope: sr.scope,
        key: keyFor(sr.scope, path.relative(sr.root, abs)),
        abs,
        size: st.size,
      };
    }
  }
}

async function digestFile(
  abs: string,
): Promise<{ sha256: string; md5: string; size: number }> {
  const sha = createHash('sha256');
  const md5 = createHash('md5');
  let size = 0;
  for await (const chunk of createReadStream(abs, {
    highWaterMark: 1024 * 1024,
  })) {
    sha.update(chunk as Buffer);
    md5.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: sha.digest('hex'), md5: md5.digest('hex'), size };
}

/** Runs `fn` over an async iterable with at most `n` in flight. */
async function pool<T>(
  source: AsyncIterable<T>,
  n: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const running = new Set<Promise<void>>();
  let failure: unknown = null;
  for await (const item of source) {
    if (failure) break;
    const p = fn(item)
      .catch((err) => {
        failure = err;
      })
      .finally(() => running.delete(p));
    running.add(p);
    if (running.size >= n) await Promise.race(running);
  }
  await Promise.all(running);
  if (failure) throw failure;
}

async function* take<T>(
  source: AsyncIterable<T>,
  limit: number | null,
): AsyncGenerator<T> {
  let n = 0;
  for await (const item of source) {
    if (limit !== null && n >= limit) return;
    n++;
    yield item;
  }
}

// ── Planning ────────────────────────────────────────────────────────────────

interface Planned extends PlanEntry {
  abs: string;
}

async function planScope(
  sr: ScopeRoot,
  opts: Options,
  s3: S3Ops | null,
): Promise<Planned[]> {
  const entries: Planned[] = [];
  let seen = 0;
  let bytes = 0;
  const tick = () => {
    seen++;
    if (seen % 2000 === 0)
      process.stderr.write(
        `  [${sr.scope}] ${seen} files, ${formatBytes(bytes)}\r`,
      );
  };
  await pool(take(walk(sr), opts.limit), opts.concurrency, async (f) => {
    bytes += f.size;
    tick();
    const remote = s3 ? await s3.head(sr.bucket, sr.prefix + f.key) : null;
    let sha256: string | null = null;
    let md5: string | null = null;
    const fastPath =
      opts.resume && remote && remote.size === f.size && remote.sha256;
    if (!fastPath) {
      const d = await digestFile(f.abs);
      sha256 = d.sha256;
      md5 = d.md5;
      if (d.size !== f.size)
        throw new Error(
          `${f.key}: size changed while reading (${f.size} -> ${d.size})`,
        );
    }
    const action: Action = classify({ size: f.size, sha256 }, remote);
    entries.push({
      scope: sr.scope,
      key: f.key,
      folder: folderOf(sr.scope, f.key),
      size: f.size,
      sha256,
      md5,
      action,
      remote: remote
        ? {
            size: remote.size,
            sha256: remote.sha256,
            etag: remote.etag,
            ...(remote.sizeOnly ? { sizeOnly: true } : {}),
          }
        : null,
      abs: f.abs,
    });
  });
  process.stderr.write(
    `  [${sr.scope}] ${seen} files, ${formatBytes(bytes)} planned\n`,
  );
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return entries;
}

// ── Orphan report (read-only DB) ────────────────────────────────────────────

async function loadReferencedKeys(
  prisma: PrismaClient,
  scope: Scope,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (scope === 'media') {
    for (const c of UPLOAD_REF_COLUMNS) {
      for await (const row of streamRows(prisma, c, 1000)) {
        for (const k of referencedMediaKeys(c, row.value)) out.add(k);
      }
    }
    return out;
  }
  for (const c of PRIVATE_KEY_COLUMNS.filter((c) => c.scope === scope)) {
    for await (const row of streamRows(prisma, c, 1000)) {
      for (const k of referencedPrivateKeys(c, row.value))
        out.add(scope === 'invoices' ? `invoices/${k}` : k);
    }
  }
  return out;
}

// ── Upload ──────────────────────────────────────────────────────────────────

interface Failure {
  scope: Scope;
  key: string;
  stage: 'upload' | 'verify';
  error: string;
}

async function uploadEntries(
  sr: ScopeRoot,
  entries: Planned[],
  opts: Options,
  s3: S3Ops,
  env: S3Env,
): Promise<{ uploaded: number; bytes: number; failures: Failure[] }> {
  const todo = entries.filter((e) => isActionable(e, opts.overwrite));
  const failures: Failure[] = [];
  let uploaded = 0;
  let bytes = 0;
  let done = 0;
  async function* src() {
    for (const e of todo) yield e;
  }
  await pool(src(), opts.concurrency, async (e) => {
    try {
      if (!e.sha256) {
        const d = await digestFile(e.abs);
        e.sha256 = d.sha256;
        e.md5 = d.md5;
      }
      await s3.put({
        bucket: sr.bucket,
        key: sr.prefix + e.key,
        body: createReadStream(e.abs, { highWaterMark: 1024 * 1024 }),
        size: e.size,
        contentType: contentTypeFor(e.key),
        cacheControl: cacheControlFor(sr.scope, e.key),
        contentDisposition: contentDispositionFor(sr.scope, e.key),
        sha256: e.sha256,
        sse: sseFor(sr.scope, env.kmsKeyId),
        kmsKeyId: env.kmsKeyId,
      });
    } catch (err) {
      failures.push({
        scope: sr.scope,
        key: e.key,
        stage: 'upload',
        error: (err as Error).message,
      });
      return;
    }
    const head = await s3.head(sr.bucket, sr.prefix + e.key);
    const problem = head
      ? verifyUploaded({ size: e.size, sha256: e.sha256!, md5: e.md5 }, head)
      : 'object missing after upload';
    if (problem) {
      failures.push({
        scope: sr.scope,
        key: e.key,
        stage: 'verify',
        error: problem,
      });
      return;
    }
    uploaded++;
    bytes += e.size;
    done++;
    if (done % 500 === 0)
      process.stderr.write(`  [${sr.scope}] uploaded ${done}/${todo.length}\r`);
  });
  process.stderr.write(
    `  [${sr.scope}] uploaded ${uploaded}/${todo.length}, ${failures.length} failure(s)\n`,
  );
  return { uploaded, bytes, failures };
}

// ── Report ──────────────────────────────────────────────────────────────────

async function writeReport(report: Record<string, unknown>): Promise<string> {
  const dir = envTrim('BACKUP_DIR') || path.join(process.cwd(), 'backups');
  await fs.mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `storage-migrate-${ts}.json`);
  await fs.writeFile(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  return file;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const roots = resolveRoots(opts.scopes);
  const started = new Date();
  console.log(
    `storage-migrate (${opts.mode}) scopes=${opts.scopes.join(',')} concurrency=${opts.concurrency}${opts.resume ? ' resume' : ''}${opts.overwrite ? ' overwrite' : ''}`,
  );
  for (const r of roots)
    console.log(
      `  ${r.scope.padEnd(8)} ${r.root}  ->  s3://${r.bucket}/${r.prefix}${r.scope === 'media' ? 'uploads/' : r.scope === 'invoices' ? 'invoices/' : ''}`,
    );

  let s3: S3Ops | null = null;
  let env: S3Env | null = null;
  if (!opts.skipHead) {
    env = readS3Env();
    s3 = createS3(env);
    console.log(
      `  region=${env.region} kms=${env.kmsKeyId ? 'yes' : 'no'}${env.endpoint ? ' endpoint=custom' : ''}`,
    );
    const probed = new Set<string>();
    for (const r of roots) {
      const loc = `${r.bucket}/${r.prefix}`;
      if (probed.has(loc)) continue;
      probed.add(loc);
      try {
        const how = await s3.probeBucket(r.bucket, r.prefix);
        console.log(`  s3://${loc} reachable (${how})`);
      } catch (err) {
        console.error(
          `bucket probe s3://${loc} failed: ${(err as Error).name ?? 'error'} (check bucket name, region, credentials and ListBucket)`,
        );
        return 1;
      }
    }
  } else {
    console.log('  --skip-head: no S3 access; everything classifies as copy');
  }

  // Plan.
  const planned = new Map<Scope, Planned[]>();
  for (const sr of roots) planned.set(sr.scope, await planScope(sr, opts, s3));
  const all = [...planned.values()].flat();
  const agg = aggregate(all);
  console.log('');
  console.log(renderAggregate(agg));
  const fp = fingerprint(all, opts.overwrite);
  const actionable = all.filter((e) => isActionable(e, opts.overwrite));
  const actionableBytes = actionable.reduce((n, e) => n + e.size, 0);
  const mismatches = all.filter((e) => e.action === 'mismatch').length;
  console.log(
    `\nactionable: ${actionable.length} file(s), ${formatBytes(actionableBytes)}${mismatches && !opts.overwrite ? `   (${mismatches} mismatch skipped; add --overwrite to replace them)` : ''}`,
  );

  const report: Record<string, unknown> = {
    started_at: started.toISOString(),
    mode: opts.mode,
    options: { ...opts },
    roots: roots.map((r) => ({
      scope: r.scope,
      root: r.root,
      bucket: r.bucket,
      prefix: r.prefix,
    })),
    summary: agg,
    actionable: { files: actionable.length, bytes: actionableBytes },
    fingerprint: fp,
  };

  // Orphan report (dry run only; read-only).
  if (opts.mode === 'dry-run' && !opts.noDb) {
    const prisma = new PrismaClient();
    const orphans: Record<string, OrphanReport> = {};
    try {
      for (const sr of roots) {
        const referenced = await loadReferencedKeys(prisma, sr.scope);
        const o = diffOrphans(sr.scope, planned.get(sr.scope)!, referenced);
        orphans[sr.scope] = o;
        console.log('');
        console.log(renderOrphans(sr.scope, o));
      }
      report.orphans = orphans;
    } catch (err) {
      console.error(
        `\norphan report skipped: ${(err as Error).message} (use --no-db to silence)`,
      );
      report.orphans_error = (err as Error).message;
    } finally {
      await prisma.$disconnect();
    }
  }

  if (opts.mode === 'dry-run') {
    report.finished_at = new Date().toISOString();
    const file = await writeReport(report);
    console.log(`\nfingerprint: ${fp}`);
    console.log(`report: ${file}`);
    if (actionable.length === 0) console.log('Nothing to copy.');
    else
      console.log(
        `Re-run with --apply --fingerprint=${fp} (same --scope/--overwrite flags) to copy.`,
      );
    return 0;
  }

  // Apply.
  if (fp !== opts.fingerprint) {
    console.error(
      `\nREFUSED: fingerprint ${fp} differs from --fingerprint=${opts.fingerprint}; the local tree or the buckets changed since the dry run. Re-run the dry run.`,
    );
    report.refused = 'fingerprint mismatch';
    report.finished_at = new Date().toISOString();
    console.log(`report: ${await writeReport(report)}`);
    return 2;
  }
  const failures: Failure[] = [];
  const uploads: Record<string, { uploaded: number; bytes: number }> = {};
  for (const sr of roots) {
    const r = await uploadEntries(sr, planned.get(sr.scope)!, opts, s3!, env!);
    uploads[sr.scope] = { uploaded: r.uploaded, bytes: r.bytes };
    failures.push(...r.failures);
  }
  report.uploads = uploads;
  report.failures = failures;
  report.finished_at = new Date().toISOString();
  const file = await writeReport(report);
  console.log('');
  for (const [scope, u] of Object.entries(uploads))
    console.log(
      `  ${scope.padEnd(8)} uploaded ${u.uploaded} file(s), ${formatBytes(u.bytes)}`,
    );
  if (failures.length) {
    const byFolder: Record<string, number> = {};
    for (const f of failures) {
      const k = `${f.scope}/${folderOf(f.scope, f.key)}/${f.stage}`;
      byFolder[k] = (byFolder[k] ?? 0) + 1;
    }
    console.error(
      `\n${failures.length} failure(s) (per folder/stage): ${Object.entries(
        byFolder,
      )
        .map(([k, n]) => `${k}=${n}`)
        .join(', ')}`,
    );
    console.error(
      `keys are listed in the report; re-run the same command with --resume after fixing the cause.`,
    );
  }
  console.log(`report: ${file}`);
  return failures.length ? 3 : 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}

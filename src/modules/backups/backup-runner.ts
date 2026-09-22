import { spawn } from 'child_process';
import { promises as fs } from 'fs';

/**
 * Process-level helpers for the backups module: thin wrappers around
 * `pg_dump`, `pg_restore` and `tar`, plus a few pure utilities that are unit
 * tested on their own. Every external tool is started with
 * `child_process.spawn` and an argument array — never through a shell — so a
 * password inside DATABASE_URL or a note typed by an admin can never be
 * interpreted as shell syntax.
 */

/** Longest stderr excerpt kept on a Backup row / in an error message. */
export const STDERR_TAIL_BYTES = 2048;

export interface ToolResult {
  /** Exit code; null when the process was killed (timeout / signal). */
  code: number | null;
  /** Signal that ended the process, if any. */
  signal: NodeJS.Signals | null;
  /** Last `STDERR_TAIL_BYTES` of stderr (UTF-8, trimmed). */
  stderrTail: string;
  /** True when the process was killed because it exceeded `timeoutMs`. */
  timedOut: boolean;
}

export class ToolError extends Error {
  constructor(
    readonly tool: string,
    readonly result: ToolResult,
  ) {
    super(describeFailure(tool, result));
  }
}

/** Thrown when the executable cannot be started at all (ENOENT & co). */
export class ToolMissingError extends Error {
  constructor(readonly tool: string) {
    super(`${tool} is not installed or not on PATH`);
  }
}

export interface RunOptions {
  cwd?: string;
  /** Kill the process (SIGKILL) after this many milliseconds. 0 = never. */
  timeoutMs?: number;
  /** Extra environment variables for the child; process.env is inherited. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Run `command args...` without a shell and resolve with its exit status and
 * a bounded stderr tail. Rejects with `ToolMissingError` when the binary is
 * absent and with `ToolError` on a non-zero exit or a timeout, so callers can
 * `await` and treat every failure uniformly.
 */
export function runTool(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['ignore', 'ignore', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (err) {
      reject(toMissingOrError(command, err));
      return;
    }

    const tail = new StderrTail(STDERR_TAIL_BYTES);
    child.stderr?.on('data', (chunk: Buffer) => tail.push(chunk));

    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, options.timeoutMs);
    }

    let settled = false;
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(toMissingOrError(command, err));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const result: ToolResult = {
        code,
        signal,
        stderrTail: tail.toString(),
        timedOut,
      };
      if (code === 0 && !timedOut) resolve(result);
      else reject(new ToolError(command, result));
    });
  });
}

function toMissingOrError(command: string, err: unknown): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'EACCES')
    return new ToolMissingError(command);
  return err instanceof Error ? err : new Error(String(err));
}

/** Human readable one-liner for a failed tool run (bounded by the tail size). */
export function describeFailure(tool: string, result: ToolResult): string {
  const why = result.timedOut
    ? 'timed out'
    : result.code !== null
      ? `exited with code ${result.code}`
      : `was killed by ${result.signal ?? 'a signal'}`;
  return result.stderrTail
    ? `${tool} ${why}: ${result.stderrTail}`
    : `${tool} ${why}`;
}

/** Rolling buffer that keeps only the last N bytes written to it. */
class StderrTail {
  private chunks: Buffer[] = [];
  private length = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer) {
    this.chunks.push(chunk);
    this.length += chunk.length;
    while (this.length > this.limit && this.chunks.length > 1) {
      const first = this.chunks[0];
      if (this.length - first.length >= this.limit) {
        this.chunks.shift();
        this.length -= first.length;
      } else {
        break;
      }
    }
  }

  toString(): string {
    const all = Buffer.concat(this.chunks);
    const slice = all.length > this.limit ? all.subarray(-this.limit) : all;
    return slice.toString('utf8').trim();
  }
}

// ── Tools ────────────────────────────────────────────────────────────────────

/**
 * `pg_dump -Fc --no-owner --no-privileges -f <file> <url>` — custom-format
 * archive that `pg_restore` can replay selectively.
 */
export function pgDump(
  databaseUrl: string,
  file: string,
  options: RunOptions = {},
): Promise<ToolResult> {
  return runTool(
    'pg_dump',
    ['-Fc', '--no-owner', '--no-privileges', '-f', file, databaseUrl],
    options,
  );
}

/**
 * `pg_restore --clean --if-exists --no-owner --no-privileges -d <url> <file>`
 * — replaces the current objects with the archive's content.
 */
export function pgRestore(
  databaseUrl: string,
  file: string,
  options: RunOptions = {},
): Promise<ToolResult> {
  return runTool(
    'pg_restore',
    [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      '-d',
      databaseUrl,
      file,
    ],
    options,
  );
}

/** `tar -czf <file> -C <cwd> <dir>` — gzip archive of one directory. */
export function tarCreate(
  file: string,
  cwd: string,
  dir: string,
  options: RunOptions = {},
): Promise<ToolResult> {
  return runTool('tar', ['-czf', file, '-C', cwd, dir], options);
}

/**
 * `tar -xzf <file> -C <cwd> <dir>` — extracts only entries under `dir`
 * (e.g. `uploads`) so an archive can never write outside that folder.
 */
export function tarExtract(
  file: string,
  cwd: string,
  dir: string,
  options: RunOptions = {},
): Promise<ToolResult> {
  return runTool('tar', ['-xzf', file, '-C', cwd, dir], options);
}

/**
 * Whether `<tool> --version` can be started and exits 0. Used for the
 * settings badges and for failing a backup with a clear code instead of an
 * ENOENT stack trace.
 */
export async function toolAvailable(tool: string): Promise<boolean> {
  try {
    await runTool(tool, ['--version'], { timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Free bytes available to this process on the volume holding `dir`. */
export async function freeDiskBytes(dir: string): Promise<number> {
  const stats = await fs.statfs(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Turn Prisma's DATABASE_URL into one libpq accepts: Prisma's own `schema`
 * query parameter is dropped (libpq rejects unknown URI parameters), every
 * other parameter (sslmode, connect_timeout, …) is kept as-is.
 */
export function parseDatabaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) throw new Error('DATABASE_URL is empty');
  const qIndex = trimmed.indexOf('?');
  if (qIndex === -1) return trimmed;
  const base = trimmed.slice(0, qIndex);
  const params = trimmed
    .slice(qIndex + 1)
    .split('&')
    .filter((pair) => pair !== '' && !/^schema(=|$)/i.test(pair));
  return params.length ? `${base}?${params.join('&')}` : base;
}

/** `1536` → `1.5 KB`; `null` → `—`. Used for log lines only. */
export function formatBytes(bytes: number | bigint | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  let value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(value) : value.toFixed(1);
  return `${rounded.replace(/\.0$/, '')} ${units[unit]}`;
}

/** `YYYYMMDD-HHmmss` in server local time, for backup file names. */
export function fileTimestamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

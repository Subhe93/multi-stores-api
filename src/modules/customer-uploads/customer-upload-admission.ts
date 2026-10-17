import {
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { UploadQuotaStore } from '../ops/upload-quota-store';

/**
 * Disk-exhaustion guards of `POST /uploads/customer` (M4.0, public endpoint):
 *
 * - a per-IP daily byte budget shared by every API instance (Postgres table
 *   `UploadQuotaWindow`, UTC day; M5 W1-C) with an in-memory fallback for
 *   the instance when the DB is unreachable (warned, never blocks uploads).
 *   `CUSTOMER_UPLOAD_DAILY_BYTES_PER_IP` (default 500 MB, 0 = off).
 *   Exceeding it → 429 `CUSTOMER_UPLOAD_QUOTA`. The client IP is `req.ip`,
 *   which is only the real client behind a proxy when `TRUST_PROXY` is set.
 * - a free-space floor on the disks that receive the original and the
 *   preview: `CUSTOMER_UPLOAD_MIN_FREE_MB` (default 1024, 0 = off). Below it
 *   → 503 `CUSTOMER_UPLOAD_STORAGE_FULL`.
 */

export const CUSTOMER_UPLOAD_DAILY_BYTES_ENV =
  'CUSTOMER_UPLOAD_DAILY_BYTES_PER_IP';
export const CUSTOMER_UPLOAD_DAILY_BYTES_DEFAULT = 500 * 1024 * 1024;
export const CUSTOMER_UPLOAD_MIN_FREE_MB_ENV = 'CUSTOMER_UPLOAD_MIN_FREE_MB';
export const CUSTOMER_UPLOAD_MIN_FREE_MB_DEFAULT = 1024;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Tracked IPs before old windows are swept (memory bound). */
const MAX_TRACKED_IPS = 50_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function quotaExceeded(limit: number): HttpException {
  return new HttpException(
    {
      code: 'CUSTOMER_UPLOAD_QUOTA',
      message: 'Upload limit reached for today. Please try again tomorrow.',
      params: { max_mb: Math.floor(limit / (1024 * 1024)) },
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

export function storageFull(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'CUSTOMER_UPLOAD_STORAGE_FULL',
    message: 'Uploads are temporarily unavailable. Please try again later.',
  });
}

/**
 * Per-IP daily bytes. With a `store` (Postgres `UploadQuotaWindow`, shared
 * by all instances) the check is one indexed read and the charge one atomic
 * upsert; the in-memory rolling 24 h window (from the first upload) is kept
 * in step and used alone when the store is unavailable.
 */
export class CustomerUploadByteBudget {
  private readonly used = new Map<string, { since: number; bytes: number }>();

  constructor(
    private readonly store?: UploadQuotaStore,
    private readonly now: () => number = Date.now,
  ) {}

  limit(): number {
    return envInt(
      CUSTOMER_UPLOAD_DAILY_BYTES_ENV,
      CUSTOMER_UPLOAD_DAILY_BYTES_DEFAULT,
    );
  }

  private entry(ip: string): { since: number; bytes: number } | undefined {
    const e = this.used.get(ip);
    if (e && this.now() - e.since >= DAY_MS) {
      this.used.delete(ip);
      return undefined;
    }
    return e;
  }

  /** Throws 429 when `ip` cannot upload `bytes` more today (0 = any byte). */
  async assertAllowed(ip: string | undefined, bytes = 0): Promise<void> {
    const limit = this.limit();
    if (!limit || !ip) return;
    let used: number | null = null;
    if (this.store?.available()) {
      used = await this.store.used('customer.ip', ip, this.now());
    }
    if (used === null) used = this.entry(ip)?.bytes ?? 0;
    if (used >= limit || used + bytes > limit) throw quotaExceeded(limit);
  }

  /** Records a stored upload (shared store first, local window always). */
  async consume(ip: string | undefined, bytes: number): Promise<void> {
    if (!this.limit() || !ip) return;
    this.consumeLocal(ip, bytes);
    if (this.store?.available()) {
      await this.store.add('customer.ip', ip, bytes, this.now());
    }
  }

  private consumeLocal(ip: string, bytes: number): void {
    const e = this.entry(ip);
    if (e) {
      e.bytes += bytes;
      return;
    }
    if (this.used.size >= MAX_TRACKED_IPS) this.sweep();
    this.used.set(ip, { since: this.now(), bytes });
  }

  private sweep(): void {
    const now = this.now();
    for (const [ip, e] of this.used) {
      if (now - e.since >= DAY_MS) this.used.delete(ip);
    }
    // Still full: forget the oldest windows (Map keeps insertion order).
    while (this.used.size >= MAX_TRACKED_IPS) {
      const first = this.used.keys().next();
      if (first.done) break;
      this.used.delete(first.value);
    }
  }
}

/** Free bytes for unprivileged users on the disk holding `dir` (or its nearest existing parent). */
export async function freeBytes(dir: string): Promise<number | null> {
  let current = dir;
  for (let i = 0; i < 32; i++) {
    try {
      const st = await fs.statfs(current);
      return Number(st.bavail) * Number(st.bsize);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
  return null;
}

/**
 * Throws 503 when any of `dirs` sits on a disk with less free space than
 * `CUSTOMER_UPLOAD_MIN_FREE_MB` (+ `incomingBytes`). An unreadable disk is not
 * treated as full.
 */
export async function assertFreeDisk(
  dirs: readonly string[],
  incomingBytes = 0,
): Promise<void> {
  const minMb = envInt(
    CUSTOMER_UPLOAD_MIN_FREE_MB_ENV,
    CUSTOMER_UPLOAD_MIN_FREE_MB_DEFAULT,
  );
  if (!minMb) return;
  const need = minMb * 1024 * 1024 + incomingBytes;
  for (const dir of dirs) {
    const free = await freeBytes(dir);
    if (free !== null && free < need) throw storageFull();
  }
}

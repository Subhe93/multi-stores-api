import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { CspViolationSummary } from './csp-report.parser';

interface Bucket {
  directive: string;
  blocked: string;
  document: string;
  disposition: string;
  count: number;
  blockedSample: string | null;
  sourceSample: string | null;
}

/** Distinct (directive, blocked, document, disposition) keys kept per window. */
export const MAX_BUCKETS = 500;

/** Flush interval from CSP_REPORT_FLUSH_MINUTES (default 10, 1..1440). */
export function flushIntervalMs(raw: string | undefined): number {
  const n = Number(raw);
  const minutes = Number.isFinite(n) && n >= 1 && n <= 1440 ? n : 10;
  return Math.round(minutes * 60_000);
}

/**
 * Aggregates CSP violation reports in memory and writes one deduplicated
 * line per (directive, blocked host, document host, disposition) to the
 * `CspReport` logger every flush window. No database table: the logs are the
 * store (`pm2 logs api | grep CspReport`). Each PM2 instance aggregates its
 * own share of the traffic.
 */
@Injectable()
export class CspReportService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('CspReport');
  private buckets = new Map<string, Bucket>();
  /** Reports dropped because MAX_BUCKETS distinct keys were already held. */
  private overflow = 0;
  private timer: NodeJS.Timeout | null = null;

  onModuleInit(): void {
    this.timer = setInterval(
      () => this.flush(),
      flushIntervalMs(process.env.CSP_REPORT_FLUSH_MINUTES),
    );
    // Never keep the process alive (tests, shutdown) just for the flush.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }

  record(reports: readonly CspViolationSummary[]): void {
    for (const r of reports) {
      const key = `${r.directive}|${r.blocked}|${r.document}|${r.disposition}`;
      const existing = this.buckets.get(key);
      if (existing) {
        existing.count += 1;
        existing.blockedSample ??= r.blockedSample;
        existing.sourceSample ??= r.sourceSample;
        continue;
      }
      if (this.buckets.size >= MAX_BUCKETS) {
        this.overflow += 1;
        continue;
      }
      this.buckets.set(key, { ...r, count: 1 });
    }
  }

  /** Number of distinct keys waiting for the next flush (tests, ops). */
  pendingKeys(): number {
    return this.buckets.size;
  }

  /** Write the window's summary lines and reset the counters. */
  flush(): void {
    if (this.buckets.size === 0 && this.overflow === 0) return;
    const rows = [...this.buckets.values()].sort((a, b) => b.count - a.count);
    const overflow = this.overflow;
    this.buckets = new Map();
    this.overflow = 0;
    for (const row of rows) {
      this.logger.warn(
        JSON.stringify({
          directive: row.directive,
          blocked: row.blocked,
          document: row.document,
          disposition: row.disposition,
          count: row.count,
          blockedSample: row.blockedSample,
          sourceSample: row.sourceSample,
        }),
      );
    }
    if (overflow > 0) {
      this.logger.warn(
        JSON.stringify({ overflow, note: `more than ${MAX_BUCKETS} keys` }),
      );
    }
  }
}

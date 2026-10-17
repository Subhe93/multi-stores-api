import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JobTickRecord, setJobTickSink } from '../../common/ops/job-log';
import { productionEnvViolations } from '../../common/ops/startup-guards';
import { RetentionService } from '../retention/retention.service';
import type {
  RetentionRunOptions,
  RetentionTaskResult,
} from '../retention/retention.types';

/** Quota windows older than this are purged (`ops.quota-windows`). */
export const QUOTA_WINDOW_KEEP_MS = 2 * 24 * 60 * 60 * 1000;
/** Job ticks older than this are purged (`ops.job-ticks`): instances that are gone. */
export const JOB_TICK_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** Idle ticks of one (job, instance) are written at most this often. */
export const TICK_WRITE_MIN_MS = 30_000;

/**
 * Boot-time wiring of the ops module (M5 W1-C):
 * - item 7: ERROR log for dev-only switches set in production (no exit);
 * - item 3: the `logJobTick()` sink that upserts `OpsJobTick` (throttled:
 *   idle/skipped ticks at most every 30 s per job, `ran`/`error` always);
 * - item 2: the retention tasks `ops.quota-windows` and `ops.job-ticks`.
 */
@Injectable()
export class OpsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OpsService.name);
  private readonly lastWrite = new Map<
    string,
    { at: number; outcome: string }
  >();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly retention?: RetentionService,
  ) {}

  onModuleInit(): void {
    for (const violation of productionEnvViolations()) {
      this.logger.error(violation);
    }
    setJobTickSink((record) => this.persistTick(record));
    this.retention?.registerTask({
      key: 'ops.quota-windows',
      run: (now, opts) =>
        this.purge(
          'UploadQuotaWindow',
          'window_start',
          new Date(now.getTime() - QUOTA_WINDOW_KEEP_MS),
          opts,
        ),
    });
    this.retention?.registerTask({
      key: 'ops.job-ticks',
      run: (now, opts) =>
        this.purge(
          'OpsJobTick',
          'ticked_at',
          new Date(now.getTime() - JOB_TICK_KEEP_MS),
          opts,
        ),
    });
  }

  onModuleDestroy(): void {
    setJobTickSink(null);
  }

  /** Fire-and-forget upsert of one tick; throttled for idle/skipped outcomes. */
  persistTick(record: JobTickRecord): void {
    const key = `${record.job}\u0000${record.instance}`;
    const outcome = record.fields.outcome;
    const prev = this.lastWrite.get(key);
    const quiet = outcome === 'idle' || outcome === 'skipped';
    if (
      quiet &&
      prev &&
      prev.outcome === outcome &&
      record.at.getTime() - prev.at < TICK_WRITE_MIN_MS
    ) {
      return;
    }
    this.lastWrite.set(key, { at: record.at.getTime(), outcome });
    const payload = JSON.stringify(record.fields);
    const ran = outcome === 'ran';
    void this.prisma.$executeRaw`
        INSERT INTO "OpsJobTick" ("job", "instance", "ticked_at", "outcome", "payload", "ran_at", "ran_payload")
        VALUES (${record.job}, ${record.instance}, ${record.at}, ${outcome}, ${payload}::jsonb,
                ${ran ? record.at : null}, ${ran ? payload : null}::jsonb)
        ON CONFLICT ("job", "instance") DO UPDATE SET
          "ticked_at" = EXCLUDED."ticked_at",
          "outcome" = EXCLUDED."outcome",
          "payload" = EXCLUDED."payload",
          "ran_at" = COALESCE(EXCLUDED."ran_at", "OpsJobTick"."ran_at"),
          "ran_payload" = COALESCE(EXCLUDED."ran_payload", "OpsJobTick"."ran_payload")`.catch(
      (err: unknown) => {
        this.logger.debug(
          `OpsJobTick write failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
  }

  /** Deletes up to `opts.limit` rows of `table` older than `cutoff` (count only in dry run). */
  private async purge(
    table: 'UploadQuotaWindow' | 'OpsJobTick',
    column: 'window_start' | 'ticked_at',
    cutoff: Date,
    opts: RetentionRunOptions,
  ): Promise<RetentionTaskResult> {
    // Identifiers come from the two literal unions above, never from input.
    const t = `"${table}"`;
    const c = `"${column}"`;
    if (opts.dryRun) {
      const rows = await this.prisma.$queryRawUnsafe<{ n: bigint | number }[]>(
        `SELECT count(*) AS n FROM ${t} WHERE ${c} < $1`,
        cutoff,
      );
      return { purged: Number(rows[0]?.n ?? 0), skipped: 0, errors: 0 };
    }
    const purged = await this.prisma.$executeRawUnsafe(
      `DELETE FROM ${t} WHERE ctid IN (SELECT ctid FROM ${t} WHERE ${c} < $1 LIMIT $2)`,
      cutoff,
      opts.limit,
    );
    return { purged, skipped: 0, errors: 0 };
  }
}

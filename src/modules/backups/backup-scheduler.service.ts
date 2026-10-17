import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { BackupKind } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { logJobTick } from '../../common/ops/job-log';
import { BackupsService } from './backups.service';
import { isSlotDue, SlotConfig } from './backup-schedule';

export {
  computeLastSlotAt,
  computeNextRunAt,
  isSlotDue,
  parseTime,
} from './backup-schedule';
export type { SlotConfig } from './backup-schedule';

/** How often the scheduler looks at the clock. */
const TICK_MS = 60 * 1000;
/** Advisory lock name: `SELECT pg_try_advisory_xact_lock(hashtext('backups'))`. */
export const BACKUP_LOCK_NAME = 'backups';
/** Upper bound of the claim transaction (re-read + mark; the dump runs outside). */
const CLAIM_TIMEOUT_MS = 15_000;

/**
 * Scheduled backups without `@nestjs/schedule`: a 60 s `setInterval` that
 * reads the PlatformConfig backup fields, runs a SCHEDULED backup when the
 * configured slot has passed since `backup_last_run_at`, then applies the
 * retention count. `BACKUP_SCHEDULER=off` disables it (dev / tests). A tick
 * that finds the previous one still working just returns.
 *
 * Multi-instance (M5 W1-C, F11): the slot is CLAIMED under
 * `pg_try_advisory_xact_lock(hashtext('backups'))` — the same primitive as
 * the retention job — in a short transaction that re-reads the schedule and
 * writes `backup_last_run_at`. Two instances that both see the slot due
 * therefore never both claim it: the loser either fails the try-lock
 * (skipped, debug log) or re-reads a `backup_last_run_at` that is no longer
 * due. The dump itself runs outside the transaction, so no connection is
 * held for the duration of pg_dump; a concurrent manual backup is still
 * refused by `isBusy()` (409) as before.
 */
@Injectable()
export class BackupSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackupSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  /** In-memory guard so overlapping ticks never start two runs. */
  private ticking = false;

  constructor(
    private readonly backups: BackupsService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    if ((process.env.BACKUP_SCHEDULER ?? '').toLowerCase() === 'off') {
      this.logger.log('Backup scheduler disabled (BACKUP_SCHEDULER=off)');
      return;
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // Never keep the event loop alive just for the scheduler.
    this.timer.unref();
    this.logger.log(`Backup scheduler armed (every ${TICK_MS / 1000}s)`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One scheduler pass; public so it can be driven from tests. */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const cfg = await this.backups.readSchedule();
      if (!cfg.backup_enabled) {
        logJobTick('backup', { outcome: 'idle', reason: 'disabled' });
        return;
      }
      if (!isSlotDue(slotOf(cfg), now, cfg.backup_last_run_at)) {
        logJobTick('backup', { outcome: 'idle' });
        return;
      }

      const claim = await this.claimSlot(now);
      if (claim !== 'claimed') {
        if (claim === 'busy') {
          this.logger.warn(
            'Scheduled backup skipped: another backup is running',
          );
        } else {
          this.logger.debug(`Scheduled backup tick skipped: ${claim}`);
        }
        logJobTick('backup', { outcome: 'skipped', reason: claim });
        return;
      }

      this.logger.log('Scheduled backup starting');
      const result = await this.backups.createAndWait(BackupKind.SCHEDULED, {
        includeUploads: cfg.backup_include_uploads,
      });
      if (result.status !== 'COMPLETED') {
        this.logger.error(
          `Scheduled backup ${result.id} failed: ${result.error ?? ''}`,
        );
      }
      const removed = await this.backups.applyRetention(cfg.backup_retention);
      if (removed > 0) {
        this.logger.log(`Retention removed ${removed} old scheduled backup(s)`);
      }
      logJobTick('backup', {
        outcome: result.status === 'COMPLETED' ? 'ran' : 'error',
        backup_id: result.id,
        status: result.status,
        removed,
      });
    } catch (err) {
      // Disk-full / already-running are thrown as HttpExceptions by the
      // engine; the scheduler just logs and waits for the next slot.
      this.logger.error(`Scheduled backup tick failed: ${errorText(err)}`);
      logJobTick('backup', { outcome: 'error', error: errorText(err) });
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Claims the due slot under the advisory lock. Claimed = this instance
   * marked `backup_last_run_at` and must run the dump. The transaction holds
   * nothing but the lock and the one-row update; a failure below is not
   * retried every minute because the slot is already marked.
   */
  private async claimSlot(
    now: Date,
  ): Promise<'claimed' | 'lock-held' | 'not-due' | 'busy'> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtext(${BACKUP_LOCK_NAME})) AS locked`;
        if (!rows[0]?.locked) return 'lock-held';
        // Re-read under the lock: another instance may have just claimed it.
        const cfg = await this.backups.readSchedule();
        if (
          !cfg.backup_enabled ||
          !isSlotDue(slotOf(cfg), now, cfg.backup_last_run_at)
        ) {
          return 'not-due';
        }
        if (await this.backups.isBusy()) return 'busy';
        await this.backups.markScheduledRun(now);
        return 'claimed';
      },
      { maxWait: 5_000, timeout: CLAIM_TIMEOUT_MS },
    );
  }
}

function slotOf(cfg: {
  backup_frequency: string;
  backup_time: string;
  backup_weekday: number;
}): SlotConfig {
  return {
    frequency: cfg.backup_frequency === 'WEEKLY' ? 'WEEKLY' : 'DAILY',
    time: cfg.backup_time,
    weekday: cfg.backup_weekday,
  };
}

function errorText(err: unknown): string {
  if (err && typeof err === 'object' && 'getResponse' in err) {
    const body = (err as { getResponse(): unknown }).getResponse();
    if (body && typeof body === 'object') {
      const { code, message } = body as { code?: string; message?: string };
      return [code, message].filter(Boolean).join(': ');
    }
  }
  return err instanceof Error ? err.message : String(err);
}

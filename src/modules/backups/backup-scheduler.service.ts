import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { BackupKind } from '@prisma/client';
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

/**
 * Scheduled backups without `@nestjs/schedule`: a 60 s `setInterval` that
 * reads the PlatformConfig backup fields, runs a SCHEDULED backup when the
 * configured slot has passed since `backup_last_run_at`, then applies the
 * retention count. `BACKUP_SCHEDULER=off` disables it (dev / tests). A tick
 * that finds the previous one still working just returns.
 */
@Injectable()
export class BackupSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackupSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  /** In-memory guard so overlapping ticks never start two runs. */
  private ticking = false;

  constructor(private readonly backups: BackupsService) {}

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
      if (!cfg.backup_enabled) return;
      const slot: SlotConfig = {
        frequency: cfg.backup_frequency === 'WEEKLY' ? 'WEEKLY' : 'DAILY',
        time: cfg.backup_time,
        weekday: cfg.backup_weekday,
      };
      if (!isSlotDue(slot, now, cfg.backup_last_run_at)) return;
      if (await this.backups.isBusy()) {
        this.logger.warn('Scheduled backup skipped: another backup is running');
        return;
      }

      // Claim the slot first so a failure below is not retried every minute.
      await this.backups.markScheduledRun(now);
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
    } catch (err) {
      // Disk-full / already-running are thrown as HttpExceptions by the
      // engine; the scheduler just logs and waits for the next slot.
      this.logger.error(`Scheduled backup tick failed: ${errorText(err)}`);
    } finally {
      this.ticking = false;
    }
  }
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

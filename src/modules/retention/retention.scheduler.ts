import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { RetentionService } from './retention.service';
import {
  RETENTION_INTERVAL_MS,
  RETENTION_SCHEDULER_ENV,
} from './retention.types';

/**
 * Hourly retention tick without `@nestjs/schedule` (same pattern as the
 * backup scheduler): `setInterval(...).unref()`, an in-memory `ticking`
 * guard, and the DB lock inside `RetentionService.run` so only one API
 * instance purges. `RETENTION_SCHEDULER=off` disables it; the admin endpoint
 * keeps working.
 */
@Injectable()
export class RetentionScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly retention: RetentionService) {}

  onModuleInit() {
    if ((process.env[RETENTION_SCHEDULER_ENV] ?? '').toLowerCase() === 'off') {
      this.logger.log(
        `Retention scheduler disabled (${RETENTION_SCHEDULER_ENV}=off)`,
      );
      return;
    }
    this.timer = setInterval(() => void this.tick(), RETENTION_INTERVAL_MS);
    // Never keep the event loop alive just for the scheduler.
    this.timer.unref();
    this.logger.log(
      `Retention scheduler armed (every ${RETENTION_INTERVAL_MS / 60000} min)`,
    );
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
      await this.retention.run(now);
    } catch (err) {
      this.logger.error(
        `Retention tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.ticking = false;
    }
  }
}

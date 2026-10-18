import {
  Injectable,
  Logger,
  Optional,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { RetentionService } from '../retention/retention.service';
import type {
  RetentionRunOptions,
  RetentionTaskResult,
} from '../retention/retention.types';
import { StoreAppsService } from '../store-apps/store-apps.service';
import {
  normalizeProductionSettings,
  type ProductionSettings,
} from './production-settings';

/** EmailLog / template event of the "new order to produce" email. */
export const PRODUCTION_NEW_ORDER_EVENT = 'production_new_order';
/** EmailLog event of the daily digest (bundled template only). */
export const PRODUCTION_DIGEST_EVENT = 'production_daily_digest';
/** Retention task key of the digest (`POST /admin/retention/run?task=`). */
export const PRODUCTION_DIGEST_TASK = 'production.daily-digest';

/** Local hour (store time) at which the digest goes out. */
export const PRODUCTION_DIGEST_HOUR = 7;
/** A digest sent within this window counts as today's (the job runs hourly). */
const DIGEST_DEDUPE_MS = 20 * 60 * 60 * 1000;
const DIGEST_ORDER_LIMIT = 200;
const DEFAULT_TIMEZONE = 'Europe/Stockholm';

/** Order statuses whose checklist is read-only; never listed in the digest. */
const CLOSED_STATUSES = ['CANCELLED', 'REFUNDED', 'RETURNED'];

export interface ProductionDigestRow {
  order_id: string;
  order_number: string;
  status: string;
  created_at: Date;
  total: number;
  done: number;
  state: string;
}

/**
 * Staff notifications of the production app (M5.4): the opt-in "new order
 * to produce" email (one per order, EmailLog as the rate limit) and the
 * opt-in daily digest of open orders, a task of the generic hourly
 * RetentionService that sends once per store per day at 07:00 store time.
 * Every send goes through MailService (store sender, templates, EmailLog).
 */
@Injectable()
export class ProductionNotificationsService implements OnModuleInit {
  private readonly logger = new Logger(ProductionNotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storeApps: StoreAppsService,
    private readonly mail: MailService,
    @Optional() private readonly retention?: RetentionService,
  ) {}

  onModuleInit(): void {
    this.retention?.registerTask({
      key: PRODUCTION_DIGEST_TASK,
      run: (now, opts) => this.runDigest(now, opts),
    });
  }

  /** Effective settings of a store with the app on (null when off). */
  private async settingsOf(
    storeId: string,
  ): Promise<ProductionSettings | null> {
    const raw = await this.storeApps.getSettings(storeId, 'production');
    return raw === null ? null : normalizeProductionSettings(raw);
  }

  /**
   * `notify_email`, else the store's notifications address, else the
   * creator's login email (the same chain as the new-order owner email).
   */
  async recipientOf(
    storeId: string,
    settings: Pick<ProductionSettings, 'notify_email'>,
  ): Promise<string | null> {
    if (settings.notify_email) return settings.notify_email;
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: {
        notification_email: true,
        creator: { select: { user: { select: { email: true } } } },
      },
    });
    return (
      store?.notification_email?.trim() || store?.creator?.user?.email || null
    );
  }

  /**
   * "New order to produce: #… (n items, m checks)", once per order: a
   * second call (replayed webhook, backfill) finds the EmailLog row and
   * stops. Called after the checklist sync, so the counts are real.
   */
  async notifyNewOrder(orderId: string, storeId: string): Promise<boolean> {
    const settings = await this.settingsOf(storeId);
    if (!settings?.notify_new_order) return false;
    const already = await this.prisma.emailLog.findFirst({
      where: { order_id: orderId, event: PRODUCTION_NEW_ORDER_EVENT },
      select: { id: true },
    });
    if (already) return false;
    const to = await this.recipientOf(storeId, settings);
    if (!to) return false;
    const [itemsCount, summary] = await Promise.all([
      this.prisma.orderItem.count({ where: { order_id: orderId } }),
      this.prisma.orderProductionSummary.findUnique({
        where: { order_id: orderId },
        select: { total: true },
      }),
    ]);
    const result = await this.mail.sendProductionNewOrder(orderId, to, {
      itemsCount,
      checksCount: summary?.total ?? 0,
    });
    return result.sent;
  }

  /**
   * The `production.daily-digest` task: for every store with the app on and
   * `notify_daily_digest`, when it is the digest hour in the store's time
   * zone and no digest went out in the last 20 hours, email the orders
   * whose checklist is NOT_STARTED / IN_PROGRESS (nothing when none).
   */
  async runDigest(
    now: Date,
    opts: Partial<RetentionRunOptions> = {},
  ): Promise<RetentionTaskResult> {
    const result: RetentionTaskResult = {
      purged: 0,
      skipped: 0,
      errors: 0,
      details: { sent: 0, notDue: 0, alreadySent: 0, empty: 0 },
    };
    const bump = (key: string) => {
      result.details![key] = (result.details![key] ?? 0) + 1;
    };
    const rows = await this.prisma.storeApp.findMany({
      where: { app_key: 'production', available: true, enabled: true },
      select: { store_id: true, settings: true },
    });
    for (const row of rows) {
      if (opts.deadline !== undefined && Date.now() >= opts.deadline) break;
      const settings = normalizeProductionSettings(row.settings);
      if (!settings.notify_daily_digest) continue;
      try {
        const sent = await this.digestFor(row.store_id, settings, now, {
          dryRun: opts.dryRun === true,
          bump,
        });
        if (sent) result.purged++;
        else result.skipped++;
      } catch (err) {
        result.errors++;
        this.logger.warn(
          `Production digest failed for store ${row.store_id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return result;
  }

  private async digestFor(
    storeId: string,
    settings: ProductionSettings,
    now: Date,
    run: { dryRun: boolean; bump: (key: string) => void },
  ): Promise<boolean> {
    const timezone = await this.timezoneOf(storeId);
    if (localHour(now, timezone) !== PRODUCTION_DIGEST_HOUR) {
      run.bump('notDue');
      return false;
    }
    const recent = await this.prisma.emailLog.findFirst({
      where: {
        store_id: storeId,
        event: PRODUCTION_DIGEST_EVENT,
        created_at: { gte: new Date(now.getTime() - DIGEST_DEDUPE_MS) },
      },
      select: { id: true },
    });
    if (recent) {
      run.bump('alreadySent');
      return false;
    }
    const orders = await this.openOrders(storeId);
    if (orders.length === 0) {
      run.bump('empty');
      return false;
    }
    const to = await this.recipientOf(storeId, settings);
    if (!to) return false;
    if (run.dryRun) {
      run.bump('sent');
      return true;
    }
    const { sent } = await this.mail.sendProductionDigest(storeId, to, {
      orders,
      timezone,
    });
    if (sent) run.bump('sent');
    return sent;
  }

  /** Orders of the store whose checklist is still open, oldest first. */
  async openOrders(storeId: string): Promise<ProductionDigestRow[]> {
    const rows = await this.prisma.orderProductionSummary.findMany({
      where: {
        store_id: storeId,
        state: { in: ['NOT_STARTED', 'IN_PROGRESS'] },
        order: { status: { notIn: CLOSED_STATUSES as never[] } },
      },
      select: {
        order_id: true,
        total: true,
        done: true,
        state: true,
        order: {
          select: { order_number: true, status: true, created_at: true },
        },
      },
      orderBy: { order: { created_at: 'asc' } },
      take: DIGEST_ORDER_LIMIT,
    });
    return rows.map((r) => ({
      order_id: r.order_id,
      order_number: r.order.order_number,
      status: r.order.status,
      created_at: r.order.created_at,
      total: r.total,
      done: r.done,
      state: r.state,
    }));
  }

  /** The store's time zone (legal profile), Europe/Stockholm when unset. */
  private async timezoneOf(storeId: string): Promise<string> {
    const profile = await this.prisma.storeLegalProfile.findFirst({
      where: { store_id: storeId, key: 'default' },
      select: { timezone: true },
    });
    return profile?.timezone?.trim() || DEFAULT_TIMEZONE;
  }
}

/** Hour of `now` in `timezone` (0-23); an unknown zone falls back to UTC. */
export function localHour(now: Date, timezone: string): number {
  try {
    const text = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(now);
    const hour = Number.parseInt(text, 10);
    return Number.isFinite(hour) ? hour : now.getUTCHours();
  } catch {
    return now.getUTCHours();
  }
}

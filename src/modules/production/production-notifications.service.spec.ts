import {
  PRODUCTION_DIGEST_EVENT,
  PRODUCTION_NEW_ORDER_EVENT,
  ProductionNotificationsService,
  localHour,
} from './production-notifications.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { MailService } from '../mail/mail.service';
import type { RetentionService } from '../retention/retention.service';

// Staff notifications of the production app (M5.4): the transport is the
// mocked MailService (nothing is ever sent); EmailLog rows written by the
// fake `send` are the rate limit of both emails.

type Row = Record<string, unknown>;

function build(input: {
  settings: Row | null;
  store?: Row | null;
  summaries?: Row[];
  profile?: Row | null;
}) {
  const emailLog: Row[] = [];
  const prisma = {
    emailLog: {
      findFirst: jest.fn((q: { where: Row }) =>
        Promise.resolve(
          emailLog.find(
            (r) =>
              (!q.where.order_id || r.order_id === q.where.order_id) &&
              (!q.where.store_id || r.store_id === q.where.store_id) &&
              r.event === q.where.event &&
              (!q.where.created_at ||
                (r.created_at as Date) >=
                  (q.where.created_at as { gte: Date }).gte),
          ) ?? null,
        ),
      ),
    },
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve(
          input.store === undefined
            ? {
                notification_email: 'shop@example.com',
                creator: { user: { email: 'owner@example.com' } },
              }
            : input.store,
        ),
      ),
    },
    orderItem: { count: jest.fn(() => Promise.resolve(2)) },
    orderProductionSummary: {
      findUnique: jest.fn(() => Promise.resolve({ total: 5 })),
      findMany: jest.fn(() => Promise.resolve(input.summaries ?? [])),
    },
    storeApp: {
      findMany: jest.fn(() =>
        Promise.resolve(
          input.settings === null
            ? []
            : [{ store_id: 's1', settings: input.settings }],
        ),
      ),
    },
    storeLegalProfile: {
      findFirst: jest.fn(() =>
        Promise.resolve(
          input.profile === undefined ? { timezone: 'UTC' } : input.profile,
        ),
      ),
    },
  };
  const storeApps = {
    getSettings: jest.fn(() => Promise.resolve(input.settings)),
  };
  const log = (event: string, extra: Row) => {
    emailLog.push({ event, created_at: new Date(), ...extra });
    return Promise.resolve({ sent: true });
  };
  const mail = {
    sendProductionNewOrder: jest.fn((orderId: string) =>
      log(PRODUCTION_NEW_ORDER_EVENT, { order_id: orderId, store_id: 's1' }),
    ),
    sendProductionDigest: jest.fn((storeId: string) =>
      log(PRODUCTION_DIGEST_EVENT, { store_id: storeId }),
    ),
  };
  const retention = { registerTask: jest.fn() };
  const service = new ProductionNotificationsService(
    prisma as unknown as PrismaService,
    storeApps as unknown as StoreAppsService,
    mail as unknown as MailService,
    retention as unknown as RetentionService,
  );
  return { service, prisma, mail, retention, emailLog };
}

const OPEN = [
  {
    order_id: 'o1',
    total: 3,
    done: 1,
    state: 'IN_PROGRESS',
    order: {
      order_number: 'MS-1',
      status: 'MANUFACTURING',
      created_at: new Date('2026-10-17T10:00:00Z'),
    },
  },
];

describe('ProductionNotificationsService (M5.4)', () => {
  it('registers the digest task on init', () => {
    const b = build({ settings: {} });
    b.service.onModuleInit();
    expect(b.retention.registerTask).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'production.daily-digest' }),
    );
  });

  it('G0: app off or default settings → no email', async () => {
    const off = build({ settings: null });
    expect(await off.service.notifyNewOrder('o1', 's1')).toBe(false);
    expect(off.mail.sendProductionNewOrder).not.toHaveBeenCalled();
    const defaults = build({ settings: {} });
    expect(await defaults.service.notifyNewOrder('o1', 's1')).toBe(false);
    expect(defaults.mail.sendProductionNewOrder).not.toHaveBeenCalled();
    expect(await defaults.service.runDigest(new Date())).toMatchObject({
      purged: 0,
      errors: 0,
    });
    expect(defaults.mail.sendProductionDigest).not.toHaveBeenCalled();
  });

  it('new order: one email per order to notify_email, with the item / check counts', async () => {
    const b = build({
      settings: { notify_new_order: true, notify_email: 'staff@example.com' },
    });
    expect(await b.service.notifyNewOrder('o1', 's1')).toBe(true);
    expect(b.mail.sendProductionNewOrder).toHaveBeenCalledWith(
      'o1',
      'staff@example.com',
      { itemsCount: 2, checksCount: 5 },
    );
    // A replay (webhook, backfill) finds the EmailLog row and stops.
    expect(await b.service.notifyNewOrder('o1', 's1')).toBe(false);
    expect(b.mail.sendProductionNewOrder).toHaveBeenCalledTimes(1);
  });

  it('recipient chain: notify_email, else the store notification address, else the owner login', async () => {
    const shop = build({ settings: { notify_new_order: true } });
    await shop.service.notifyNewOrder('o1', 's1');
    expect(shop.mail.sendProductionNewOrder).toHaveBeenCalledWith(
      'o1',
      'shop@example.com',
      expect.anything(),
    );
    const owner = build({
      settings: { notify_new_order: true },
      store: {
        notification_email: ' ',
        creator: { user: { email: 'owner@example.com' } },
      },
    });
    await owner.service.notifyNewOrder('o1', 's1');
    expect(owner.mail.sendProductionNewOrder).toHaveBeenCalledWith(
      'o1',
      'owner@example.com',
      expect.anything(),
    );
    const nobody = build({ settings: { notify_new_order: true }, store: null });
    expect(await nobody.service.notifyNewOrder('o1', 's1')).toBe(false);
    expect(nobody.mail.sendProductionNewOrder).not.toHaveBeenCalled();
  });

  it('daily digest: at 07:00 store time, once a day, only when orders are open', async () => {
    const b = build({
      settings: { notify_daily_digest: true },
      summaries: OPEN,
    });
    // 06:30 UTC (the store profile says UTC): not due.
    const early = await b.service.runDigest(new Date('2026-10-18T06:30:00Z'));
    expect(early.details).toMatchObject({ notDue: 1, sent: 0 });
    expect(b.mail.sendProductionDigest).not.toHaveBeenCalled();
    // 07:10: sent, with the open orders.
    const due = await b.service.runDigest(new Date('2026-10-18T07:10:00Z'));
    expect(due).toMatchObject({ purged: 1, errors: 0 });
    expect(b.mail.sendProductionDigest).toHaveBeenCalledWith(
      's1',
      'shop@example.com',
      expect.objectContaining({
        timezone: 'UTC',
        orders: [expect.objectContaining({ order_number: 'MS-1', done: 1 })],
      }),
    );
    // A second tick of the same hour: already sent today.
    const again = await b.service.runDigest(new Date('2026-10-18T07:50:00Z'));
    expect(again.details).toMatchObject({ alreadySent: 1 });
    expect(b.mail.sendProductionDigest).toHaveBeenCalledTimes(1);
    // Nothing open: skipped without an email.
    const empty = build({ settings: { notify_daily_digest: true } });
    const none = await empty.service.runDigest(
      new Date('2026-10-18T07:10:00Z'),
    );
    expect(none.details).toMatchObject({ empty: 1 });
    expect(empty.mail.sendProductionDigest).not.toHaveBeenCalled();
    // dryRun counts the send without sending.
    const dry = build({
      settings: { notify_daily_digest: true },
      summaries: OPEN,
    });
    const d = await dry.service.runDigest(new Date('2026-10-18T07:10:00Z'), {
      dryRun: true,
    });
    expect(d.details).toMatchObject({ sent: 1 });
    expect(dry.mail.sendProductionDigest).not.toHaveBeenCalled();
  });

  it('store time: the legal profile time zone, Europe/Stockholm when unset', async () => {
    expect(
      localHour(new Date('2026-10-18T05:30:00Z'), 'Europe/Stockholm'),
    ).toBe(7);
    expect(localHour(new Date('2026-10-18T05:30:00Z'), 'UTC')).toBe(5);
    expect(localHour(new Date('2026-10-18T05:30:00Z'), 'Not/AZone')).toBe(5);
    const b = build({
      settings: { notify_daily_digest: true },
      summaries: OPEN,
      profile: null,
    });
    const r = await b.service.runDigest(new Date('2026-10-18T05:30:00Z'));
    expect(r.purged).toBe(1);
    expect(b.mail.sendProductionDigest).toHaveBeenCalledWith(
      's1',
      'shop@example.com',
      expect.objectContaining({ timezone: 'Europe/Stockholm' }),
    );
  });

  it('a failing store never stops the others', async () => {
    const b = build({
      settings: { notify_daily_digest: true },
      summaries: OPEN,
    });
    b.prisma.orderProductionSummary.findMany.mockRejectedValueOnce(
      new Error('db down'),
    );
    const r = await b.service.runDigest(new Date('2026-10-18T07:10:00Z'));
    expect(r.errors).toBe(1);
  });
});

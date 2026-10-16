import { ProductionChecklistService } from './production-checklist.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import {
  CREATOR_ID,
  OTHER_STORE_ID,
  STORE_ID,
  USER_ID,
  makeFakePrisma,
  valueRow,
  type FakeOrder,
} from './fake-production-prisma.mockspec';

const ACTOR = { id: USER_ID, name: 'Anna Creator' };

function order(over: Partial<FakeOrder> = {}): FakeOrder {
  return {
    id: 'o1',
    store_id: STORE_ID,
    status: 'CONFIRMED',
    items: [
      {
        id: 'i1',
        order_id: 'o1',
        fulfiller_type: 'CREATOR',
        fulfiller_id: CREATOR_ID,
        variant: { options: { Färg: 'Röd' } },
        custom_field_values: [
          valueRow('v1', { value: 'ANNA', field_label: { sv: 'Namn' } }),
          valueRow('v2', {
            value: 'KLASS 3B',
            field_label: { sv: 'Klass' },
            // Field deleted after the order: only the snapshot remains.
            custom_field_id: null,
          }),
        ],
      },
      {
        id: 'i2',
        order_id: 'o1',
        fulfiller_type: 'PROVIDER',
        fulfiller_id: 'prov1',
        variant: { options: { Size: 'L' } },
        custom_field_values: [valueRow('v9', { value: 'PROVIDER TEXT' })],
      },
    ],
    ...over,
  };
}

function build(
  orders: FakeOrder[] = [order()],
  settings: Record<string, unknown> = {},
) {
  const { prisma, db } = makeFakePrisma({ orders });
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(true)),
    getSettings: jest.fn(() => Promise.resolve(settings)),
  };
  const service = new ProductionChecklistService(
    prisma,
    storeApps as unknown as StoreAppsService,
  );
  return { service, db, storeApps };
}

const keys = (db: { checks: Record<string, unknown>[] }) =>
  db.checks
    .map((c) => `${String(c.order_item_id)}:${String(c.source_key)}`)
    .sort();

async function codeOf(p: Promise<unknown>): Promise<[number, string]> {
  try {
    await p;
  } catch (err) {
    const e = err as { getStatus(): number; getResponse(): { code: string } };
    return [e.getStatus(), e.getResponse().code];
  }
  throw new Error('expected an error');
}

describe('ProductionChecklistService (M4.3 §3.4)', () => {
  describe('syncOrder', () => {
    it('generates one check per value + variant attribute on own lines only (provider lines excluded)', async () => {
      const { service, db } = build();
      await service.syncOrder('o1', STORE_ID);
      expect(keys(db)).toEqual(['i1:fv:v1', 'i1:fv:v2', 'i1:opt:Färg']);
      expect(db.checks.find((c) => c.source_key === 'fv:v2')).toMatchObject({
        label: 'Klass',
        value: 'KLASS 3B',
        store_id: STORE_ID,
      });
      expect(db.summaries).toEqual([
        expect.objectContaining({
          order_id: 'o1',
          total: 3,
          done: 0,
          state: 'NOT_STARTED',
        }),
      ]);
    });

    it('is idempotent: a second run writes nothing', async () => {
      const { service, db } = build();
      await service.syncOrder('o1', STORE_ID);
      const writes = db.writes;
      await service.syncOrder('o1', STORE_ID);
      expect(db.writes).toBe(writes);
      expect(db.checks).toHaveLength(3);
    });

    it('concurrent syncs never duplicate a check (unique order_item_id + source_key)', async () => {
      const { service, db } = build();
      await Promise.all([
        service.syncOrder('o1', STORE_ID),
        service.syncOrder('o1', STORE_ID),
      ]);
      expect(keys(db)).toEqual(['i1:fv:v1', 'i1:fv:v2', 'i1:opt:Färg']);
    });

    it('a changed value resets its check and logs VALUE_CHANGED', async () => {
      const o = order();
      const { service, db } = build([o]);
      await service.syncOrder('o1', STORE_ID);
      const v1 = db.checks.find((c) => c.source_key === 'fv:v1')!;
      await service.setDone(STORE_ID, v1.id as string, true, ACTOR);
      o.items[0].custom_field_values![0].value = 'ANNE';
      await service.syncOrder('o1', STORE_ID);
      expect(v1).toMatchObject({ value: 'ANNE', done: false, stale: false });
      expect(db.events.map((e) => e.action)).toContain('VALUE_CHANGED');
    });

    it('a vanished source goes stale (kept, not counted); custom items never do', async () => {
      const o = order();
      const { service, db } = build([o]);
      await service.syncOrder('o1', STORE_ID);
      await service.addCustom(STORE_ID, 'o1', 'i1', 'Packed', ACTOR);
      o.items[0].variant = null;
      await service.syncOrder('o1', STORE_ID);
      const opt = db.checks.find((c) => c.source_key === 'opt:Färg')!;
      expect(opt.stale).toBe(true);
      expect(db.checks.find((c) => c.source === 'CUSTOM')!.stale).toBe(false);
      expect(db.events.map((e) => e.action)).toContain('STALE');
      expect(db.summaries[0]).toMatchObject({ total: 3, done: 0 });
    });

    it('settings exclusions and default items apply', async () => {
      const { service, db } = build([order()], {
        include_variant_options: false,
        default_custom_items: ['Packed'],
      });
      await service.syncOrder('o1', STORE_ID);
      expect(keys(db)).toEqual([
        'i1:custom:default:packed',
        'i1:fv:v1',
        'i1:fv:v2',
      ]);
    });

    it('closed orders are read-only (no writes)', async () => {
      const { service, db } = build([order({ status: 'CANCELLED' })]);
      await service.syncOrder('o1', STORE_ID);
      expect(db.writes).toBe(0);
    });

    it("another store's order is a 404", async () => {
      const { service } = build();
      expect(await codeOf(service.syncOrder('o1', OTHER_STORE_ID))).toEqual([
        404,
        'PRODUCTION_ORDER_NOT_FOUND',
      ]);
    });

    it('registered providers add their checks (designer seam)', async () => {
      const { service, db } = build();
      service.registerProvider({
        key: 'designer',
        sources: (item) =>
          Promise.resolve([
            {
              order_item_id: item.id,
              source: 'DESIGN',
              source_key: 'design:d1',
              label: 'Print file',
              value: null,
              group_index: null,
              file_url: null,
              sort_order: 0,
            },
          ]),
      });
      await service.syncOrder('o1', STORE_ID);
      expect(keys(db)).toContain('i1:design:d1');
    });
  });

  describe('state transitions', () => {
    it('NOT_STARTED → IN_PROGRESS → READY, started and completed fire exactly once', async () => {
      const { service, db } = build();
      await service.syncOrder('o1', STORE_ID);
      const [a, b, c] = db.checks.map((x) => x.id as string);

      const r1 = await service.setDone(STORE_ID, a, true, ACTOR);
      expect(r1).toMatchObject({
        started: true,
        completed: false,
        changed: true,
        summary: { total: 3, done: 1, state: 'IN_PROGRESS' },
      });
      expect(r1.check).toMatchObject({ done: true, done_by: USER_ID });

      // Set semantics: same request again is a no-op without an event.
      const events = db.events.length;
      const again = await service.setDone(STORE_ID, a, true, ACTOR);
      expect(again).toMatchObject({ changed: false, started: false });
      expect(db.events.length).toBe(events);

      await service.setDone(STORE_ID, b, true, ACTOR);
      const r3 = await service.setDone(STORE_ID, c, true, ACTOR);
      expect(r3).toMatchObject({
        completed: true,
        summary: { done: 3, state: 'READY' },
      });
      expect(db.events.filter((e) => e.action === 'COMPLETED')).toHaveLength(1);
      expect(db.timeline).toEqual([
        expect.objectContaining({ status: 'PRODUCTION_COMPLETED' }),
      ]);

      // Uncheck → back to IN_PROGRESS; recheck completes again (once).
      const r4 = await service.setDone(STORE_ID, c, false, ACTOR);
      expect(r4.summary.state).toBe('IN_PROGRESS');
      expect(r4.completed).toBe(false);
      const r5 = await service.setDone(STORE_ID, c, true, ACTOR);
      expect(r5.completed).toBe(true);
    });

    it('bulk on one line / the order, and NONE without checks', async () => {
      const { service, db } = build();
      await service.syncOrder('o1', STORE_ID);
      const r = await service.bulkSet(STORE_ID, 'o1', 'i1', true, ACTOR);
      expect(r).toMatchObject({
        started: true,
        completed: true,
        summary: { state: 'READY', done: 3 },
      });
      expect(db.events.filter((e) => e.action === 'BULK')).toHaveLength(1);
      const off = await service.bulkSet(STORE_ID, 'o1', null, false, ACTOR);
      expect(off.summary).toMatchObject({ done: 0, state: 'NOT_STARTED' });

      const empty = build([
        order({
          items: [
            {
              id: 'i1',
              order_id: 'o1',
              fulfiller_type: 'CREATOR',
              fulfiller_id: CREATOR_ID,
              custom_field_values: [],
            },
          ],
        }),
      ]);
      await empty.service.syncOrder('o1', STORE_ID);
      expect(empty.db.summaries[0].state).toBe('NONE');
    });

    it('completion guard: only one of two concurrent completing writes fires COMPLETED', async () => {
      const { service, db } = build();
      await service.syncOrder('o1', STORE_ID);
      const ids = db.checks.map((x) => x.id as string);
      await service.setDone(STORE_ID, ids[0], true, ACTOR);
      const [x, y] = await Promise.all([
        service.setDone(STORE_ID, ids[1], true, ACTOR),
        service.setDone(STORE_ID, ids[2], true, ACTOR),
      ]);
      expect([x.completed, y.completed].filter(Boolean)).toHaveLength(1);
      expect(db.events.filter((e) => e.action === 'COMPLETED')).toHaveLength(1);
    });

    it('every checklist write takes the per-order advisory lock first', async () => {
      // Without it two concurrent "last check" writes (READ COMMITTED) would
      // each see the other's check as open and READY would be missed.
      const { service, db } = build();
      await service.syncOrder('o1', STORE_ID);
      const ids = db.checks.map((x) => x.id as string);
      await service.setDone(STORE_ID, ids[0], true, ACTOR);
      await service.bulkSet(STORE_ID, 'o1', null, true, ACTOR);
      const custom = await service.addCustom(STORE_ID, 'o1', 'i1', 'X', ACTOR);
      await service.removeCustom(STORE_ID, custom.id, ACTOR);
      expect(db.locks).toEqual(Array(5).fill('production:o1'));
    });
  });

  describe('custom items and authorization', () => {
    it('adds and removes a custom item; generated checks cannot be removed', async () => {
      const { service, db } = build();
      await service.syncOrder('o1', STORE_ID);
      const custom = await service.addCustom(
        STORE_ID,
        'o1',
        'i1',
        '  Packed  ',
        ACTOR,
      );
      expect(custom).toMatchObject({ label: 'Packed', source: 'CUSTOM' });
      expect(db.summaries[0].total).toBe(4);
      const generated = db.checks.find((c) => c.source === 'FIELD_VALUE')!;
      expect(
        await codeOf(
          service.removeCustom(STORE_ID, generated.id as string, ACTOR),
        ),
      ).toEqual([400, 'PRODUCTION_CUSTOM_ONLY']);
      await service.removeCustom(STORE_ID, custom.id, ACTOR);
      expect(db.checks.find((c) => c.id === custom.id)).toBeUndefined();
      expect(db.summaries[0].total).toBe(3);
      expect(db.events.map((e) => e.action)).toEqual(
        expect.arrayContaining(['ADD', 'REMOVE']),
      );
    });

    it('rejects an empty label and caps checks per line', async () => {
      const { service, db } = build();
      expect(
        await codeOf(service.addCustom(STORE_ID, 'o1', 'i1', '   ', ACTOR)),
      ).toEqual([400, 'PRODUCTION_LABEL_INVALID']);
      for (let i = 0; i < 200; i++) {
        db.checks.push({
          id: `x${i}`,
          order_item_id: 'i1',
          order_id: 'o1',
          source_key: `custom:${i}`,
        });
      }
      expect(
        await codeOf(
          service.addCustom(STORE_ID, 'o1', 'i1', 'One more', ACTOR),
        ),
      ).toEqual([400, 'PRODUCTION_TOO_MANY_CHECKS']);
    });

    it('a provider line is read-only for the store owner (403)', async () => {
      const { service } = build();
      expect(
        await codeOf(service.addCustom(STORE_ID, 'o1', 'i2', 'x', ACTOR)),
      ).toEqual([403, 'PRODUCTION_LINE_NOT_OWNED']);
      expect(
        await codeOf(service.bulkSet(STORE_ID, 'o1', 'i2', true, ACTOR)),
      ).toEqual([403, 'PRODUCTION_LINE_NOT_OWNED']);
    });

    it("another store's order or check is a 404", async () => {
      const { service, db } = build();
      await service.syncOrder('o1', STORE_ID);
      const id = db.checks[0].id as string;
      expect(
        await codeOf(service.setDone(OTHER_STORE_ID, id, true, ACTOR)),
      ).toEqual([404, 'PRODUCTION_CHECK_NOT_FOUND']);
      expect(
        await codeOf(service.bulkSet(OTHER_STORE_ID, 'o1', null, true, ACTOR)),
      ).toEqual([404, 'PRODUCTION_ORDER_NOT_FOUND']);
      expect(await codeOf(service.events(OTHER_STORE_ID, 'o1'))).toEqual([
        404,
        'PRODUCTION_ORDER_NOT_FOUND',
      ]);
      expect(await service.summaries(OTHER_STORE_ID, ['o1'])).toEqual({});
    });

    it('closed orders reject writes with 409', async () => {
      const o = order();
      const { service, db } = build([o]);
      await service.syncOrder('o1', STORE_ID);
      o.status = 'REFUNDED';
      expect(
        await codeOf(
          service.setDone(STORE_ID, db.checks[0].id as string, true, ACTOR),
        ),
      ).toEqual([409, 'PRODUCTION_ORDER_CLOSED']);
    });

    it('contextOf resolves the creator store; a non-creator is a 404', async () => {
      const { service } = build();
      await expect(service.contextOf(USER_ID)).resolves.toMatchObject({
        storeId: STORE_ID,
        creatorId: CREATOR_ID,
        actor: { id: USER_ID, name: 'Anna Creator' },
      });
      expect(await codeOf(service.contextOf('stranger'))).toEqual([
        404,
        'PRODUCTION_ORDER_NOT_FOUND',
      ]);
    });
  });

  describe('summaries and backfill', () => {
    it('summaries materialize missing ones for the store', async () => {
      const { service } = build();
      await expect(service.summaries(STORE_ID, ['o1'])).resolves.toEqual({
        o1: { total: 3, done: 0, state: 'NOT_STARTED' },
      });
    });

    it('backfill syncs open orders only', async () => {
      const { service, db } = build([
        order(),
        order({ id: 'o2', status: 'DELIVERED', items: [] }),
      ]);
      await expect(service.backfill(STORE_ID)).resolves.toEqual({ synced: 1 });
      expect(db.summaries.map((s) => s.order_id)).toEqual(['o1']);
    });
  });
});

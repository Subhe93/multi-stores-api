import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import {
  BACKFILL_BATCH,
  BACKFILL_LIMIT,
  ProductionChecklistService,
} from './production-checklist.service';
import {
  DESIGN_CHECK_LABEL,
  DesignProductionProvider,
} from './production-design.provider';
import {
  CREATOR_ID,
  OTHER_STORE_ID,
  STORE_ID,
  USER_ID,
  makeFakePrisma,
  valueRow,
  type FakeDesign,
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
        variant_options_snapshot: { Färg: 'Röd' },
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
  designs: FakeDesign[] = [],
) {
  const { prisma, db } = makeFakePrisma({ orders, designs });
  const storeApps = {
    isEnabled: jest.fn((_storeId: string, _app: string) =>
      Promise.resolve(true),
    ),
    getSettings: jest.fn(() => Promise.resolve(settings)),
  };
  const service = new ProductionChecklistService(
    prisma,
    storeApps as unknown as StoreAppsService,
  );
  return { service, db, storeApps, prisma };
}

const byAction = (db: { events: Record<string, unknown>[] }, action: string) =>
  db.events.filter((e) => e.action === action);

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
      // The value row is gone (e.g. a repaired order line).
      o.items[0].custom_field_values!.splice(1, 1);
      await service.syncOrder('o1', STORE_ID);
      const v2 = db.checks.find((c) => c.source_key === 'fv:v2')!;
      expect(v2.stale).toBe(true);
      expect(db.checks.find((c) => c.source === 'CUSTOM')!.stale).toBe(false);
      expect(db.events.map((e) => e.action)).toContain('STALE');
      expect(db.summaries[0]).toMatchObject({ total: 3, done: 0 });
    });

    it('a changed label (field renamed / store locale switched) relabels without resetting done or logging VALUE_CHANGED', async () => {
      const o = order();
      const { service, db } = build([o]);
      await service.syncOrder('o1', STORE_ID);
      const v1 = db.checks.find((c) => c.source_key === 'fv:v1')!;
      await service.setDone(STORE_ID, v1.id as string, true, ACTOR);
      const hash = v1.source_hash;
      o.items[0].custom_field_values![0].field_label = { sv: 'Förnamn' };
      await service.syncOrder('o1', STORE_ID);
      expect(v1).toMatchObject({
        label: 'Förnamn',
        value: 'ANNA',
        done: true,
        source_hash: hash,
      });
      expect(byAction(db, 'VALUE_CHANGED')).toHaveLength(0);
      expect(db.summaries[0]).toMatchObject({ done: 1, state: 'IN_PROGRESS' });
    });

    it('variant option checks follow the order-time snapshot, not the live variant', async () => {
      const o = order();
      const { service, db } = build([o]);
      await service.syncOrder('o1', STORE_ID);
      const opt = db.checks.find((c) => c.source_key === 'opt:Färg')!;
      await service.setDone(STORE_ID, opt.id as string, true, ACTOR);

      // The creator renames the colour value on the live variant.
      o.items[0].variant = { options: { Färg: 'Mörkröd' } };
      await service.syncOrder('o1', STORE_ID);
      expect(opt).toMatchObject({ value: 'Röd', done: true, stale: false });
      expect(byAction(db, 'VALUE_CHANGED')).toHaveLength(0);

      // Then deletes the variant: no stale flip, nothing reaches READY.
      await service.setDone(STORE_ID, opt.id as string, false, ACTOR);
      await service.bulkSet(STORE_ID, 'o1', null, true, ACTOR);
      await service.setDone(STORE_ID, opt.id as string, false, ACTOR);
      expect(db.summaries[0]).toMatchObject({ done: 2, state: 'IN_PROGRESS' });
      o.items[0].variant = null;
      await service.syncOrder('o1', STORE_ID);
      expect(opt.stale).toBe(false);
      expect(byAction(db, 'STALE')).toHaveLength(0);
      expect(db.summaries[0]).toMatchObject({
        total: 3,
        done: 2,
        state: 'IN_PROGRESS',
      });
    });

    it('a pre-snapshot line keeps its VARIANT_OPTION checks as inserted (never reset, never stale)', async () => {
      const o = order();
      o.items[0].variant_options_snapshot = null;
      const { service, db } = build([o]);
      await service.syncOrder('o1', STORE_ID);
      const opt = db.checks.find((c) => c.source_key === 'opt:Färg')!;
      expect(opt).toMatchObject({ value: 'Röd', source: 'VARIANT_OPTION' });
      await service.setDone(STORE_ID, opt.id as string, true, ACTOR);
      const writes = db.writes;

      o.items[0].variant = { options: { Färg: 'Blå' } };
      await service.syncOrder('o1', STORE_ID);
      expect(opt).toMatchObject({ value: 'Röd', done: true, stale: false });
      o.items[0].variant = null;
      await service.syncOrder('o1', STORE_ID);
      expect(opt).toMatchObject({ done: true, stale: false });
      expect(db.writes).toBe(writes);
      expect(byAction(db, 'STALE')).toHaveLength(0);
      expect(byAction(db, 'VALUE_CHANGED')).toHaveLength(0);
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

    it('the designer provider (C27) adds a design:<id> "Print file" check and the print files when READY, app-off guarded', async () => {
      const design: FakeDesign = {
        id: 'd1',
        order_id: 'o1',
        order_item_id: 'i1',
        store_id: STORE_ID,
        print_status: 'PENDING',
        files_purged_at: null,
        created_at: new Date(),
      };
      const { service, db, prisma, storeApps } = build([order()], {}, [design]);
      const provider = new DesignProductionProvider(
        prisma as unknown as PrismaService,
        storeApps as unknown as StoreAppsService,
      );
      service.registerProvider(provider);
      service.registerProvider(provider); // once
      await service.syncOrder('o1', STORE_ID);
      expect(keys(db)).toContain('i1:design:d1');
      expect(db.checks.find((c) => c.source_key === 'design:d1')).toMatchObject(
        {
          source: 'DESIGN',
          label: DESIGN_CHECK_LABEL,
        },
      );
      expect(storeApps.isEnabled).toHaveBeenCalledWith(STORE_ID, 'designer');

      // No print file until the render is READY.
      expect(await service.printFiles('o1')).toEqual([]);
      design.print_status = 'READY';
      expect(await service.printFiles('o1')).toEqual([
        {
          order_item_id: 'i1',
          url: '/api/designer/my/orders/o1/items/i1/print',
          label: `${DESIGN_CHECK_LABEL} 1`,
        },
      ]);

      // Designer app off: no check, no files, and the existing check is
      // left to the normal stale rule like any vanished source.
      storeApps.isEnabled.mockImplementation((_s: string, app: string) =>
        Promise.resolve(app !== 'designer'),
      );
      expect(await service.printFiles('o1')).toEqual([]);
      const fresh = build([order()], {}, [design]);
      fresh.storeApps.isEnabled.mockImplementation((_s: string, app: string) =>
        Promise.resolve(app !== 'designer'),
      );
      fresh.service.registerProvider(
        new DesignProductionProvider(
          fresh.prisma as unknown as PrismaService,
          fresh.storeApps as unknown as StoreAppsService,
        ),
      );
      await fresh.service.syncOrder('o1', STORE_ID);
      expect(keys(fresh.db)).not.toContain('i1:design:d1');
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

    it('two concurrent setDone on the last two checks: exactly one COMPLETED (serialized by the order lock)', async () => {
      const { service, db } = build();
      await service.syncOrder('o1', STORE_ID);
      const ids = db.checks.map((x) => x.id as string);
      await service.setDone(STORE_ID, ids[0], true, ACTOR);
      const [x, y] = await Promise.all([
        service.setDone(STORE_ID, ids[1], true, ACTOR),
        service.setDone(STORE_ID, ids[2], true, ACTOR),
      ]);
      expect([x.completed, y.completed].filter(Boolean)).toHaveLength(1);
      expect(byAction(db, 'COMPLETED')).toHaveLength(1);
      expect(db.timeline).toHaveLength(1);
      expect(db.summaries[0]).toMatchObject({ done: 3, state: 'READY' });
      // The second writer saw the first one's commit (READ COMMITTED + lock).
      expect([x.summary.done, y.summary.done].sort()).toEqual([2, 3]);
    });

    it('the lock double is real: without it the same two writes lose the completion', async () => {
      // Two transactions that skip pg_advisory_xact_lock: each reads the
      // other's check as still open and stores IN_PROGRESS (lost update).
      const { prisma, db, service } = build();
      await service.syncOrder('o1', STORE_ID);
      const ids = db.checks.map((x) => x.id as string);
      await service.setDone(STORE_ID, ids[0], true, ACTOR);
      const unlocked = async (id: string) =>
        (prisma as unknown as PrismaService).$transaction(async (tx) => {
          await tx.orderProductionCheck.updateMany({
            where: { id, done: false },
            data: { done: true },
          });
          const all = await tx.orderProductionCheck.findMany({
            where: { order_id: 'o1' },
          });
          const done = all.filter((c) => c.done).length;
          return tx.orderProductionSummary.updateMany({
            where: { order_id: 'o1', state: { not: 'READY' } },
            data: {
              done,
              state: done === all.length ? 'READY' : 'IN_PROGRESS',
            },
          });
        });
      await Promise.all([unlocked(ids[1]), unlocked(ids[2])]);
      expect(db.checks.filter((c) => c.done)).toHaveLength(3);
      expect(db.summaries[0]).toMatchObject({ done: 2, state: 'IN_PROGRESS' });
    });

    it('a sync-driven READY (stale flip) takes the completion path once: one COMPLETED, one timeline row, no repeat on re-sync', async () => {
      const o = order();
      const { service, db } = build([o], {
        on_complete: 'auto',
        complete_target: 'QUALITY_CHECK',
      });
      await service.syncOrder('o1', STORE_ID);
      const [a, b] = ['fv:v1', 'opt:Färg'].map(
        (k) => db.checks.find((c) => c.source_key === k)!.id as string,
      );
      await service.setDone(STORE_ID, a, true, ACTOR);
      await service.setDone(STORE_ID, b, true, ACTOR);
      expect(db.summaries[0]).toMatchObject({ done: 2, state: 'IN_PROGRESS' });

      // The remaining open value row vanishes: the sync completes the order.
      o.items[0].custom_field_values!.splice(1, 1);
      await service.syncOrder('o1', STORE_ID);
      expect(db.summaries[0]).toMatchObject({
        total: 2,
        done: 2,
        state: 'READY',
        auto_advance_pending: true,
      });
      expect(db.summaries[0].completed_at).toBeInstanceOf(Date);
      expect(byAction(db, 'COMPLETED')).toEqual([
        expect.objectContaining({ actor_id: null }),
      ]);
      expect(db.timeline).toEqual([
        expect.objectContaining({ status: 'PRODUCTION_COMPLETED' }),
      ]);

      await service.syncOrder('o1', STORE_ID);
      await service.syncOrder('o1', STORE_ID);
      expect(byAction(db, 'COMPLETED')).toHaveLength(1);
      expect(db.timeline).toHaveLength(1);

      // The pending flag is a cycle flag: read while READY, cleared by hand.
      expect(await service.isAutoAdvancePending('o1')).toBe(true);
      await service.setAutoAdvancePending('o1', false);
      expect(await service.isAutoAdvancePending('o1')).toBe(false);
    });

    it('a sync-driven READY with on_complete suggest / none owes no auto-advance', async () => {
      const o = order();
      const { service, db } = build([o], { on_complete: 'suggest' });
      await service.syncOrder('o1', STORE_ID);
      const [a, b] = ['fv:v1', 'opt:Färg'].map(
        (k) => db.checks.find((c) => c.source_key === k)!.id as string,
      );
      await service.setDone(STORE_ID, a, true, ACTOR);
      await service.setDone(STORE_ID, b, true, ACTOR);
      o.items[0].custom_field_values!.splice(1, 1);
      await service.syncOrder('o1', STORE_ID);
      expect(db.summaries[0]).toMatchObject({
        state: 'READY',
        auto_advance_pending: false,
      });
      expect(byAction(db, 'COMPLETED')).toHaveLength(1);
    });

    it('setDone refuses a stale check (no write, changed false), like bulkSet', async () => {
      const o = order();
      const { service, db } = build([o]);
      await service.syncOrder('o1', STORE_ID);
      o.items[0].custom_field_values!.splice(1, 1);
      await service.syncOrder('o1', STORE_ID);
      const stale = db.checks.find((c) => c.source_key === 'fv:v2')!;
      expect(stale.stale).toBe(true);
      const writes = db.writes;
      const r = await service.setDone(
        STORE_ID,
        stale.id as string,
        true,
        ACTOR,
      );
      expect(r).toMatchObject({ changed: false, started: false });
      expect(r.check).toMatchObject({ done: false, stale: true });
      expect(db.writes).toBe(writes);
      expect(byAction(db, 'CHECK')).toHaveLength(0);
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
      await expect(service.backfill(STORE_ID)).resolves.toEqual({
        synced: 1,
        failed: 0,
        remaining: 0,
      });
      expect(db.summaries.map((s) => s.order_id)).toEqual(['o1']);
    });

    it('backfill runs in batches with a yield between them and caps one request', async () => {
      const many = (n: number) =>
        Array.from({ length: n }, (_, i) => order({ id: `b${i}`, items: [] }));
      const { service, db } = build(many(2 * BACKFILL_BATCH + 1));
      const yields = jest
        .spyOn(
          service as unknown as { yieldBetweenBatches(): Promise<void> },
          'yieldBetweenBatches',
        )
        .mockResolvedValue(undefined);
      await expect(service.backfill(STORE_ID)).resolves.toEqual({
        synced: 2 * BACKFILL_BATCH + 1,
        failed: 0,
        remaining: 0,
      });
      expect(yields).toHaveBeenCalledTimes(2);
      expect(db.summaries).toHaveLength(2 * BACKFILL_BATCH + 1);

      const capped = build(many(BACKFILL_LIMIT + 3));
      jest
        .spyOn(
          capped.service as unknown as { yieldBetweenBatches(): Promise<void> },
          'yieldBetweenBatches',
        )
        .mockResolvedValue(undefined);
      await expect(capped.service.backfill(STORE_ID)).resolves.toEqual({
        synced: BACKFILL_LIMIT,
        failed: 0,
        remaining: 3,
      });
    });

    it('events are paged newest first (limit capped at 200)', async () => {
      const { service, db } = build();
      await service.syncOrder('o1', STORE_ID);
      const ids = db.checks.map((x) => x.id as string);
      for (const id of ids) await service.setDone(STORE_ID, id, true, ACTOR);
      // CHECK ×3 + COMPLETED, newest first.
      const all = await service.events(STORE_ID, 'o1');
      expect(all.map((e) => e.action)).toEqual([
        'COMPLETED',
        'CHECK',
        'CHECK',
        'CHECK',
      ]);
      const p1 = await service.events(STORE_ID, 'o1', { page: 1, limit: 3 });
      const p2 = await service.events(STORE_ID, 'o1', { page: 2, limit: 3 });
      expect(p1.map((e) => e.id)).toEqual(all.slice(0, 3).map((e) => e.id));
      expect(p2.map((e) => e.id)).toEqual(all.slice(3).map((e) => e.id));
      expect(await service.events(STORE_ID, 'o1', { page: 9 })).toEqual([]);
      for (let i = 0; i < 300; i++) {
        db.events.push({
          id: `e${i}`,
          order_id: 'o1',
          action: 'BULK',
          created_at: new Date(0),
        });
      }
      expect(
        await service.events(STORE_ID, 'o1', { limit: 1000 }),
      ).toHaveLength(200);
    });
  });
});

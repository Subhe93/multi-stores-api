import { OrderStatus, UserRole } from '@prisma/client';
import { ProductionAutomationService } from './production-automation.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { OrdersService } from '../orders/orders.service';
import type { ProductionChecklistService } from './production-checklist.service';
import type { ProductionSummaryView } from './production.types';

const CTX = {
  storeId: 's1',
  creatorId: 'cr1',
  actor: { id: 'u1', name: 'Anna' },
};
const READY: ProductionSummaryView = {
  total: 2,
  done: 2,
  state: 'READY',
  completed_at: new Date(),
};
const PROGRESS: ProductionSummaryView = {
  total: 2,
  done: 1,
  state: 'IN_PROGRESS',
  completed_at: null,
};

function build(
  settings: Record<string, unknown>,
  status: OrderStatus,
  itemStatuses: string[] = ['MANUFACTURING'],
  designs: string[] = ['READY'],
) {
  const state = { status };
  const events: Record<string, unknown>[] = [];
  const prisma = {
    order: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          status: state.status,
          items: itemStatuses.map((s) => ({ fulfillment_status: s })),
        }),
      ),
    },
    orderItemDesign: {
      findMany: jest.fn(() =>
        Promise.resolve(designs.map((print_status) => ({ print_status }))),
      ),
    },
    orderProductionEvent: {
      // The M5.4 idempotency read: `payload.reason = print_ready`.
      findFirst: jest.fn((q: { where: { payload?: { equals?: string } } }) =>
        Promise.resolve(
          events.find((e) => e.reason === q.where.payload?.equals) ?? null,
        ),
      ),
    },
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          creator: { id: 'cr1', user_id: 'u1', display_name: 'Anna' },
        }),
      ),
    },
  };
  const orders = {
    updateStatus: jest.fn((_id: string, dto: { status: OrderStatus }) => {
      state.status = dto.status;
      return Promise.resolve({});
    }),
  };
  const pending = { value: false };
  const checklist = {
    logAutoAdvance: jest.fn(
      (_id: string, _actor: unknown, payload: Record<string, unknown>) => {
        events.push(payload);
        return Promise.resolve();
      },
    ),
    isAutoAdvancePending: jest.fn(() => Promise.resolve(pending.value)),
    setAutoAdvancePending: jest.fn((_id: string, v: boolean) => {
      pending.value = v;
      return Promise.resolve();
    }),
  };
  const storeApps = { getSettings: jest.fn(() => Promise.resolve(settings)) };
  const service = new ProductionAutomationService(
    prisma as unknown as PrismaService,
    storeApps as unknown as StoreAppsService,
    orders as unknown as OrdersService,
    checklist as unknown as ProductionChecklistService,
  );
  return { service, orders, checklist, state, pending, prisma };
}

const done = (summary = READY) => ({
  started: false,
  completed: true,
  summary,
});

describe('ProductionAutomationService (M4.3 §3.6)', () => {
  it('none: no suggestion, no status change', async () => {
    const { service, orders } = build(
      { on_complete: 'none' },
      OrderStatus.MANUFACTURING,
    );
    const r = await service.afterWrite(CTX, 'o1', done());
    expect(r.suggestion).toBeNull();
    expect(orders.updateStatus).not.toHaveBeenCalled();
  });

  it('suggest: proposes the target while the order is behind it', async () => {
    const { service, orders } = build(
      {
        on_complete: 'suggest',
        complete_target: 'SHIPPED',
        use_quality_check: false,
      },
      OrderStatus.MANUFACTURING,
    );
    const r = await service.afterWrite(CTX, 'o1', done());
    expect(r.suggestion).toEqual({
      next_status: 'SHIPPED',
      ask_tracking: true,
      requires_tracking: false,
    });
    expect(r.order_status).toBe(OrderStatus.MANUFACTURING);
    expect(orders.updateStatus).not.toHaveBeenCalled();
    // Not READY or already at/after the target → nothing.
    expect(
      (
        await service.afterWrite(CTX, 'o1', {
          started: false,
          completed: false,
          summary: PROGRESS,
        })
      ).suggestion,
    ).toBeNull();
    const shipped = build(
      {
        on_complete: 'suggest',
        complete_target: 'SHIPPED',
        use_quality_check: false,
      },
      OrderStatus.SHIPPED,
    );
    expect(
      (await shipped.service.afterWrite(CTX, 'o1', done())).suggestion,
    ).toBeNull();
  });

  it('auto (QC): moves the creator lines through updateStatus as CREATOR, once', async () => {
    const { service, orders, checklist } = build(
      { on_complete: 'auto', complete_target: 'QUALITY_CHECK' },
      OrderStatus.MANUFACTURING,
    );
    const r = await service.afterWrite(CTX, 'o1', done());
    expect(orders.updateStatus).toHaveBeenCalledWith(
      'o1',
      {
        status: OrderStatus.QUALITY_CHECK,
        note: 'Production checklist completed',
      },
      'u1',
      UserRole.CREATOR,
    );
    expect(checklist.logAutoAdvance).toHaveBeenCalledWith('o1', CTX.actor, {
      from: OrderStatus.MANUFACTURING,
      to: OrderStatus.QUALITY_CHECK,
    });
    expect(r.auto_advanced_to).toBe(OrderStatus.QUALITY_CHECK);
    expect(r.suggestion).toBeNull();
    // A write that did not complete the checklist never advances.
    orders.updateStatus.mockClear();
    await service.afterWrite(CTX, 'o1', {
      started: false,
      completed: false,
      summary: READY,
    });
    expect(orders.updateStatus).not.toHaveBeenCalled();
  });

  it('auto is forward-only: never regresses an order or a line already at/after QC', async () => {
    const shipped = build(
      { on_complete: 'auto', complete_target: 'QUALITY_CHECK' },
      OrderStatus.SHIPPED,
    );
    await shipped.service.afterWrite(CTX, 'o1', done());
    expect(shipped.orders.updateStatus).not.toHaveBeenCalled();
    const lineAhead = build(
      { on_complete: 'auto', complete_target: 'QUALITY_CHECK' },
      OrderStatus.MANUFACTURING,
      ['SHIPPED'],
    );
    await lineAhead.service.afterWrite(CTX, 'o1', done());
    expect(lineAhead.orders.updateStatus).not.toHaveBeenCalled();
  });

  it('auto + SHIPPED stored by hand is read as suggest (never auto-ship)', async () => {
    const { service, orders } = build(
      { on_complete: 'auto', complete_target: 'SHIPPED' },
      OrderStatus.MANUFACTURING,
    );
    const r = await service.afterWrite(CTX, 'o1', done());
    expect(orders.updateStatus).not.toHaveBeenCalled();
    expect(r.suggestion).toMatchObject({ next_status: 'SHIPPED' });
  });

  it('start_on_first_check: CONFIRMED → MANUFACTURING on the starting write only', async () => {
    const { service, orders } = build(
      { start_on_first_check: true, on_complete: 'none' },
      OrderStatus.CONFIRMED,
      ['PROCESSING'],
    );
    const r = await service.afterWrite(CTX, 'o1', {
      started: true,
      completed: false,
      summary: PROGRESS,
    });
    expect(orders.updateStatus).toHaveBeenCalledWith(
      'o1',
      { status: OrderStatus.MANUFACTURING, note: 'Production started' },
      'u1',
      UserRole.CREATOR,
    );
    expect(r.auto_advanced_to).toBe(OrderStatus.MANUFACTURING);
    orders.updateStatus.mockClear();
    await service.afterWrite(CTX, 'o1', {
      started: false,
      completed: false,
      summary: PROGRESS,
    });
    expect(orders.updateStatus).not.toHaveBeenCalled();
  });

  it('a failing updateStatus never breaks the checklist write', async () => {
    const { service, orders } = build(
      { on_complete: 'auto', complete_target: 'QUALITY_CHECK' },
      OrderStatus.MANUFACTURING,
    );
    orders.updateStatus.mockRejectedValueOnce(
      new Error('ORDER_NO_OWNED_ITEMS'),
    );
    const r = await service.afterWrite(CTX, 'o1', done());
    expect(r.auto_advanced_to).toBeUndefined();
    expect(r.suggestion).toEqual({
      next_status: 'QUALITY_CHECK',
      ask_tracking: false,
      requires_tracking: false,
    });
  });

  it('a failed auto-advance is recorded and retried by the next write of the order', async () => {
    const { service, orders, checklist, pending } = build(
      { on_complete: 'auto', complete_target: 'QUALITY_CHECK' },
      OrderStatus.MANUFACTURING,
    );
    orders.updateStatus.mockRejectedValueOnce(new Error('db down'));
    await service.afterWrite(CTX, 'o1', done());
    expect(checklist.setAutoAdvancePending).toHaveBeenLastCalledWith(
      'o1',
      true,
    );
    expect(pending.value).toBe(true);

    // The next (non-completing) write of the READY order retries and clears.
    const r = await service.afterWrite(CTX, 'o1', {
      started: false,
      completed: false,
      summary: READY,
    });
    expect(orders.updateStatus).toHaveBeenCalledTimes(2);
    expect(r.auto_advanced_to).toBe(OrderStatus.QUALITY_CHECK);
    expect(checklist.setAutoAdvancePending).toHaveBeenLastCalledWith(
      'o1',
      false,
    );
    expect(pending.value).toBe(false);

    // Nothing owed any more: a further write does not touch the order.
    orders.updateStatus.mockClear();
    await service.afterWrite(CTX, 'o1', {
      started: false,
      completed: false,
      summary: READY,
    });
    expect(orders.updateStatus).not.toHaveBeenCalled();
  });

  // ── M5.4: ship prompt flags and the print-ready step ────────────────────

  it('ship_prompt drives the SHIPPED suggestion flags; other targets never ask', async () => {
    const required = build(
      {
        on_complete: 'suggest',
        complete_target: 'SHIPPED',
        use_quality_check: false,
        ship_prompt: 'tracking_required',
      },
      OrderStatus.MANUFACTURING,
    );
    expect(
      (await required.service.afterWrite(CTX, 'o1', done())).suggestion,
    ).toEqual({
      next_status: 'SHIPPED',
      ask_tracking: true,
      requires_tracking: true,
    });
    const none = build(
      {
        on_complete: 'suggest',
        complete_target: 'SHIPPED',
        use_quality_check: false,
        ship_prompt: 'none',
      },
      OrderStatus.MANUFACTURING,
    );
    expect(
      (await none.service.afterWrite(CTX, 'o1', done())).suggestion,
    ).toEqual({
      next_status: 'SHIPPED',
      ask_tracking: false,
      requires_tracking: false,
    });
  });

  it('on_print_ready default (none): a READY print file changes nothing (G0)', async () => {
    const { service, orders } = build({}, OrderStatus.CONFIRMED, [
      'PROCESSING',
    ]);
    expect(await service.onPrintReady('o1', 's1')).toBeUndefined();
    expect(orders.updateStatus).not.toHaveBeenCalled();
  });

  it('on_print_ready: moves CONFIRMED → MANUFACTURING once, logged with reason print_ready', async () => {
    const { service, orders, checklist, state } = build(
      { on_print_ready: 'MANUFACTURING' },
      OrderStatus.CONFIRMED,
      ['PROCESSING'],
    );
    expect(await service.onPrintReady('o1', 's1')).toBe(
      OrderStatus.MANUFACTURING,
    );
    expect(orders.updateStatus).toHaveBeenCalledWith(
      'o1',
      { status: OrderStatus.MANUFACTURING, note: 'Print files ready' },
      'u1',
      UserRole.CREATOR,
    );
    expect(checklist.logAutoAdvance).toHaveBeenCalledWith(
      'o1',
      { id: 'u1', name: 'Anna' },
      {
        from: OrderStatus.CONFIRMED,
        to: OrderStatus.MANUFACTURING,
        reason: 'print_ready',
      },
    );
    // A second READY file of the same order (or a replay) is a no-op.
    state.status = OrderStatus.CONFIRMED;
    orders.updateStatus.mockClear();
    expect(await service.onPrintReady('o1', 's1')).toBeUndefined();
    expect(orders.updateStatus).not.toHaveBeenCalled();
  });

  it('on_print_ready waits for every live design of the order to be READY', async () => {
    const { service, orders } = build(
      { on_print_ready: 'PROCESSING' },
      OrderStatus.CONFIRMED,
      ['PROCESSING'],
      ['READY', 'RENDERING'],
    );
    expect(await service.onPrintReady('o1', 's1')).toBeUndefined();
    expect(orders.updateStatus).not.toHaveBeenCalled();
    // An order without designs never moves on this hook either.
    const noDesigns = build(
      { on_print_ready: 'PROCESSING' },
      OrderStatus.CONFIRMED,
      ['PROCESSING'],
      [],
    );
    expect(await noDesigns.service.onPrintReady('o1', 's1')).toBeUndefined();
    expect(noDesigns.orders.updateStatus).not.toHaveBeenCalled();
  });

  it('on_print_ready is forward-only: never past the current status, never SHIPPED', async () => {
    // Already MANUFACTURING: PROCESSING would be a step back.
    const ahead = build(
      { on_print_ready: 'PROCESSING' },
      OrderStatus.MANUFACTURING,
      ['MANUFACTURING'],
    );
    expect(await ahead.service.onPrintReady('o1', 's1')).toBeUndefined();
    expect(ahead.orders.updateStatus).not.toHaveBeenCalled();
    // A line already at the target: nothing to move.
    const lineAhead = build(
      { on_print_ready: 'MANUFACTURING' },
      OrderStatus.PROCESSING,
      ['MANUFACTURING'],
    );
    expect(await lineAhead.service.onPrintReady('o1', 's1')).toBeUndefined();
    // SHIPPED is not an accepted value: read as the default (none).
    const shipped = build(
      { on_print_ready: 'SHIPPED' },
      OrderStatus.CONFIRMED,
      ['PROCESSING'],
    );
    expect(await shipped.service.onPrintReady('o1', 's1')).toBeUndefined();
    expect(shipped.orders.updateStatus).not.toHaveBeenCalled();
  });

  it('a failing updateStatus in the print-ready step is swallowed (retried on the next READY file)', async () => {
    const { service, orders } = build(
      { on_print_ready: 'MANUFACTURING' },
      OrderStatus.CONFIRMED,
      ['PROCESSING'],
    );
    orders.updateStatus.mockRejectedValueOnce(new Error('db down'));
    expect(await service.onPrintReady('o1', 's1')).toBeUndefined();
    expect(await service.onPrintReady('o1', 's1')).toBe(
      OrderStatus.MANUFACTURING,
    );
  });

  it('retryPending (workspace read) runs an owed advance, e.g. after a sync-driven READY', async () => {
    const { service, orders, pending } = build(
      { on_complete: 'auto', complete_target: 'QUALITY_CHECK' },
      OrderStatus.MANUFACTURING,
    );
    expect(await service.retryPending(CTX, 'o1')).toBeUndefined();
    expect(orders.updateStatus).not.toHaveBeenCalled();
    pending.value = true;
    expect(await service.retryPending(CTX, 'o1')).toBe(
      OrderStatus.QUALITY_CHECK,
    );
    expect(orders.updateStatus).toHaveBeenCalledTimes(1);
    expect(pending.value).toBe(false);

    // Order already past the target: the owed advance is dropped, not stuck.
    const shipped = build(
      { on_complete: 'auto', complete_target: 'QUALITY_CHECK' },
      OrderStatus.SHIPPED,
    );
    shipped.pending.value = true;
    expect(await shipped.service.retryPending(CTX, 'o1')).toBeUndefined();
    expect(shipped.pending.value).toBe(false);
    expect(shipped.orders.updateStatus).not.toHaveBeenCalled();
  });
});

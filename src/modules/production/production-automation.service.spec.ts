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
) {
  const state = { status };
  const prisma = {
    order: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          status: state.status,
          items: itemStatuses.map((s) => ({ fulfillment_status: s })),
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
    logAutoAdvance: jest.fn(() => Promise.resolve()),
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
  return { service, orders, checklist, state, pending };
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
    expect(r.suggestion).toEqual({ next_status: 'SHIPPED' });
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
    expect(r.suggestion).toEqual({ next_status: 'SHIPPED' });
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
    expect(r.suggestion).toEqual({ next_status: 'QUALITY_CHECK' });
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

import { DesignerTriggersService } from './designer-triggers.service';

function build(enabled: boolean, hasDesigns = false) {
  const storeApps = { isEnabled: jest.fn(() => Promise.resolve(enabled)) };
  const queue = {
    enqueueOrder: jest.fn(() => Promise.resolve(1)),
    reviveOrder: jest.fn(() => Promise.resolve(0)),
    cancelOrder: jest.fn(() => Promise.resolve(1)),
    markShipped: jest.fn(() => Promise.resolve(1)),
    markPaymentFailed: jest.fn(() => Promise.resolve({ rows: 1, released: 1 })),
    storeHasDesigns: jest.fn(() => Promise.resolve(hasDesigns)),
  };
  const triggers = new DesignerTriggersService(
    storeApps as never,
    queue as never,
  );
  return { triggers, storeApps, queue };
}

const order = { id: 'o1', store_id: 's1' };

describe('DesignerTriggersService', () => {
  it('app off, store never had designs: no queue work (cached isEnabled + cached probe)', async () => {
    const b = build(false, false);
    await b.triggers.onOrderPaid(order);
    await b.triggers.onCodOrderCreated(order);
    await b.triggers.onStatusChanged(order, 'PAID', 'CANCELLED');
    await b.triggers.onShipped(order);
    await b.triggers.onPaymentFailed(order);
    expect(b.storeApps.isEnabled).toHaveBeenCalledWith('s1', 'designer');
    // The "has designs" probe is cached per store.
    expect(b.queue.storeHasDesigns).toHaveBeenCalledTimes(1);
    expect(b.queue.enqueueOrder).not.toHaveBeenCalled();
    expect(b.queue.cancelOrder).not.toHaveBeenCalled();
    expect(b.queue.markShipped).not.toHaveBeenCalled();
    expect(b.queue.markPaymentFailed).not.toHaveBeenCalled();
  });

  it('app off but the store has designs: bookkeeping still runs (claims stay gated in the worker)', async () => {
    const b = build(false, true);
    await b.triggers.onStatusChanged(order, 'PAID', 'SHIPPED');
    await b.triggers.onStatusChanged(order, 'PAID', 'CANCELLED');
    await b.triggers.onOrderPaid(order);
    await b.triggers.onPaymentFailed(order);
    expect(b.queue.markShipped).toHaveBeenCalledWith('o1');
    expect(b.queue.cancelOrder).toHaveBeenCalledWith('o1');
    expect(b.queue.enqueueOrder).toHaveBeenCalledWith('o1');
    expect(b.queue.markPaymentFailed).toHaveBeenCalledWith('o1');
  });

  it('app on: no probe query', async () => {
    const b = build(true);
    await b.triggers.onOrderPaid(order);
    expect(b.queue.storeHasDesigns).not.toHaveBeenCalled();
  });

  it('no store: returns without reading the app state', async () => {
    const b = build(true);
    await b.triggers.onOrderPaid({ id: 'o1', store_id: null });
    expect(b.storeApps.isEnabled).not.toHaveBeenCalled();
    expect(b.queue.enqueueOrder).not.toHaveBeenCalled();
  });

  it('paid → revive (late payment of a failed order) then enqueue; COD → enqueue', async () => {
    const b = build(true);
    await b.triggers.onOrderPaid(order);
    await b.triggers.onCodOrderCreated(order);
    expect(b.queue.reviveOrder).toHaveBeenCalledTimes(1);
    expect(b.queue.enqueueOrder).toHaveBeenCalledTimes(2);
    expect(b.queue.enqueueOrder).toHaveBeenCalledWith('o1');
  });

  it('status changes: CANCELLED/REFUNDED cancel, SHIPPED/DELIVERED mark shipped, same status ignored', async () => {
    const b = build(true);
    await b.triggers.onStatusChanged(order, 'PAID', 'CANCELLED');
    await b.triggers.onStatusChanged(order, 'PAID', 'REFUNDED');
    await b.triggers.onStatusChanged(order, 'PAID', 'SHIPPED');
    await b.triggers.onStatusChanged(order, 'SHIPPED', 'DELIVERED');
    await b.triggers.onStatusChanged(order, 'PAID', 'PAID');
    await b.triggers.onStatusChanged(order, 'PENDING', 'PROCESSING');
    expect(b.queue.cancelOrder).toHaveBeenCalledTimes(2);
    expect(b.queue.markShipped).toHaveBeenCalledTimes(2);
    expect(b.queue.enqueueOrder).not.toHaveBeenCalled();
  });

  it('un-cancel: CANCELLED/REFUNDED → live status revives the rows and re-requests a paid / COD order', async () => {
    const b = build(true);
    await b.triggers.onStatusChanged(
      { ...order, payment_status: 'paid' },
      'CANCELLED',
      'PROCESSING',
    );
    await b.triggers.onStatusChanged(
      { ...order, payment_method: 'COD' },
      'REFUNDED',
      'CONFIRMED',
    );
    expect(b.queue.reviveOrder).toHaveBeenCalledTimes(2);
    expect(b.queue.enqueueOrder).toHaveBeenCalledTimes(2);
    expect(b.queue.enqueueOrder).toHaveBeenCalledWith('o1');
    expect(b.queue.cancelOrder).not.toHaveBeenCalled();
    // Un-cancelled straight to SHIPPED: revived and shipped_at set.
    await b.triggers.onStatusChanged(
      { ...order, payment_status: 'paid' },
      'CANCELLED',
      'SHIPPED',
    );
    expect(b.queue.reviveOrder).toHaveBeenCalledTimes(3);
    expect(b.queue.markShipped).toHaveBeenCalledTimes(1);
  });

  it('un-cancel of an unpaid (non-COD) order revives but does not request a print; CANCELLED → REFUNDED/RETURNED is not an un-cancel', async () => {
    const b = build(true);
    await b.triggers.onStatusChanged(
      { ...order, payment_status: 'pending', payment_method: 'STRIPE' },
      'CANCELLED',
      'PENDING',
    );
    expect(b.queue.reviveOrder).toHaveBeenCalledTimes(1);
    expect(b.queue.enqueueOrder).not.toHaveBeenCalled();
    await b.triggers.onStatusChanged(order, 'CANCELLED', 'REFUNDED');
    await b.triggers.onStatusChanged(order, 'REFUNDED', 'RETURNED');
    expect(b.queue.reviveOrder).toHaveBeenCalledTimes(1);
    expect(b.queue.cancelOrder).toHaveBeenCalledTimes(1);
  });

  it('never throws', async () => {
    const b = build(true);
    b.queue.enqueueOrder.mockRejectedValue(new Error('db down'));
    b.storeApps.isEnabled.mockRejectedValueOnce(new Error('cache miss'));
    await expect(b.triggers.onOrderPaid(order)).resolves.toBeUndefined();
    await expect(b.triggers.onOrderPaid(order)).resolves.toBeUndefined();
  });
});

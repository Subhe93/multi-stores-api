import { ProductionTriggersService } from './production-triggers.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { ProductionChecklistService } from './production-checklist.service';
import type { ProductionNotificationsService } from './production-notifications.service';

// The order / print-queue hooks of the production app (C28, M5.4): one
// cached isEnabled for stores without the app, then nothing; a failure in
// the checklist or the notification never reaches the caller.

function build(enabled: boolean) {
  const storeApps = { isEnabled: jest.fn(() => Promise.resolve(enabled)) };
  const checklist = { syncOrder: jest.fn(() => Promise.resolve()) };
  const notifications = {
    notifyNewOrder: jest.fn(() => Promise.resolve(true)),
  };
  const service = new ProductionTriggersService(
    storeApps as unknown as StoreAppsService,
    checklist as unknown as ProductionChecklistService,
    notifications as unknown as ProductionNotificationsService,
  );
  return { service, storeApps, checklist, notifications };
}

describe('ProductionTriggersService', () => {
  it('store without the app (G0): one cached isEnabled, no sync, no email, no print-ready step', async () => {
    const b = build(false);
    const handler = jest.fn(() => Promise.resolve());
    b.service.registerPrintReadyHandler(handler);
    await b.service.onOrderCreated('o1', 's1');
    await b.service.onPrintReady('o1', 's1');
    expect(b.storeApps.isEnabled).toHaveBeenCalledTimes(2);
    expect(b.checklist.syncOrder).not.toHaveBeenCalled();
    expect(b.notifications.notifyNewOrder).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    // No store: nothing is read at all.
    await b.service.onOrderCreated('o1', null);
    await b.service.onPrintReady('o1', null);
    expect(b.storeApps.isEnabled).toHaveBeenCalledTimes(2);
  });

  it('app on: checklist sync, then the notification; a failing sync skips the email', async () => {
    const b = build(true);
    await b.service.onOrderCreated('o1', 's1');
    expect(b.checklist.syncOrder).toHaveBeenCalledWith('o1', 's1');
    expect(b.notifications.notifyNewOrder).toHaveBeenCalledWith('o1', 's1');
    b.checklist.syncOrder.mockRejectedValueOnce(new Error('db down'));
    b.notifications.notifyNewOrder.mockClear();
    await expect(b.service.onOrderCreated('o2', 's1')).resolves.toBeUndefined();
    expect(b.notifications.notifyNewOrder).not.toHaveBeenCalled();
    // A failing notification never reaches the order flow.
    b.notifications.notifyNewOrder.mockRejectedValueOnce(new Error('smtp'));
    await expect(b.service.onOrderCreated('o3', 's1')).resolves.toBeUndefined();
  });

  it('print-ready: runs the registered handler only, swallowing its errors', async () => {
    const b = build(true);
    await b.service.onPrintReady('o1', 's1');
    const handler = jest.fn(() => Promise.reject(new Error('boom')));
    b.service.registerPrintReadyHandler(handler);
    await expect(b.service.onPrintReady('o1', 's1')).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledWith('o1', 's1');
  });
});

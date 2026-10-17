import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { REQUIRE_APP_KEY, ROLES_KEY } from '../../common/decorators';
import { RequireAppGuard } from '../../common/guards/require-app.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ProductionController } from './production.controller';
import type { ProductionChecklistService } from './production-checklist.service';
import type { ProductionAutomationService } from './production-automation.service';
import type { OrdersService } from '../orders/orders.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';

// Authorization of the production routes: creators only (RolesGuard), the
// app must be in effect (RequireAppGuard → 403 STORE_APP_NOT_ENABLED), and
// the store always comes from the JWT (never from a param).

describe('ProductionController (M4.3 §3.7)', () => {
  it('is creator-only and gated by the production app', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      ProductionController,
    ) as unknown[];
    expect(guards).toEqual(
      expect.arrayContaining([RolesGuard, RequireAppGuard]),
    );
    expect(Reflect.getMetadata(ROLES_KEY, ProductionController)).toEqual([
      UserRole.CREATOR,
    ]);
    expect(Reflect.getMetadata(REQUIRE_APP_KEY, ProductionController)).toBe(
      'production',
    );
  });

  it('the app gate answers 403 STORE_APP_NOT_ENABLED when the app is off', async () => {
    const storeApps = {
      isEnabled: jest.fn(() => Promise.resolve(false)),
      storeIdByUser: jest.fn(() => Promise.resolve('s1')),
    };
    const guard = new RequireAppGuard(
      new Reflector(),
      storeApps as unknown as StoreAppsService,
    );
    const ctx = {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      getHandler: () => ProductionController.prototype.workspace,
      getClass: () => ProductionController,
      switchToHttp: () => ({
        getRequest: () => ({
          params: { orderId: 'o1' },
          user: { id: 'u1', role: 'CREATOR' },
        }),
      }),
    };
    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(storeApps.isEnabled).toHaveBeenCalledWith('s1', 'production');
  });

  it('writes use the caller store and return check, summary and automation result', async () => {
    const ctx = {
      storeId: 's1',
      creatorId: 'cr1',
      primaryLocale: 'sv',
      actor: { id: 'u1', name: 'Anna' },
    };
    const check = {
      id: 'c1',
      order_id: 'o1',
      order_item_id: 'i1',
      source: 'FIELD_VALUE',
      source_key: 'fv:v1',
      label: 'Namn',
      value: 'ANNA',
      group_index: null,
      file_url: null,
      sort_order: 100,
      done: true,
      done_at: new Date(),
      done_by: 'u1',
      done_by_name: 'Anna',
      stale: false,
    };
    const summary = { total: 1, done: 1, state: 'READY', completed_at: null };
    const checklist = {
      contextOf: jest.fn(() => Promise.resolve(ctx)),
      setDone: jest.fn(() =>
        Promise.resolve({
          check,
          summary,
          started: true,
          completed: true,
          changed: true,
        }),
      ),
    };
    const automation = {
      afterWrite: jest.fn(() =>
        Promise.resolve({
          suggestion: { next_status: 'SHIPPED' },
          order_status: 'MANUFACTURING',
        }),
      ),
    };
    const controller = new ProductionController(
      checklist as unknown as ProductionChecklistService,
      automation as unknown as ProductionAutomationService,
      {} as OrdersService,
    );
    const res = await controller.setCheck('u1', 'c1', { done: true });
    expect(checklist.setDone).toHaveBeenCalledWith('s1', 'c1', true, ctx.actor);
    expect(automation.afterWrite).toHaveBeenCalledWith(
      ctx,
      'o1',
      expect.objectContaining({ completed: true }),
    );
    expect(res).toMatchObject({
      check: { id: 'c1', done: true, custom: false, upload_id: null },
      summary,
      changed: true,
      suggestion: { next_status: 'SHIPPED' },
      order_status: 'MANUFACTURING',
    });
  });

  it('events are paged (page, limit) and the workspace read retries an owed auto-advance', async () => {
    const ctx = {
      storeId: 's1',
      creatorId: 'cr1',
      primaryLocale: 'sv',
      actor: { id: 'u1', name: 'Anna' },
    };
    const calls: string[] = [];
    const checklist = {
      contextOf: jest.fn(() => Promise.resolve(ctx)),
      events: jest.fn(() => Promise.resolve([])),
      syncOrder: jest.fn(() => {
        calls.push('sync');
        return Promise.resolve();
      }),
      orderState: jest.fn(() =>
        Promise.resolve({
          checks: [],
          summary: { total: 0, done: 0, state: 'NONE', completed_at: null },
        }),
      ),
      printFiles: jest.fn(() => Promise.resolve([])),
    };
    const automation = {
      retryPending: jest.fn(() => {
        calls.push('retry');
        return Promise.resolve(undefined);
      }),
      settingsOf: jest.fn(() => Promise.resolve({ on_complete: 'none' })),
      suggestionFor: jest.fn(() => null),
    };
    const orders = {
      findById: jest.fn(() => {
        calls.push('read');
        return Promise.resolve({
          id: 'o1',
          order_number: '1001',
          status: 'MANUFACTURING',
          created_at: new Date(),
          items: [],
        });
      }),
    };
    const controller = new ProductionController(
      checklist as unknown as ProductionChecklistService,
      automation as unknown as ProductionAutomationService,
      orders as unknown as OrdersService,
    );
    await controller.events('u1', 'o1', { page: 3, limit: 20 });
    expect(checklist.events).toHaveBeenCalledWith('s1', 'o1', {
      page: 3,
      limit: 20,
    });
    await controller.workspace('u1', 'o1');
    expect(automation.retryPending).toHaveBeenCalledWith(ctx, 'o1');
    // Sync, then the owed advance, then the order is read (fresh status).
    expect(calls).toEqual(['sync', 'retry', 'read']);
  });
});

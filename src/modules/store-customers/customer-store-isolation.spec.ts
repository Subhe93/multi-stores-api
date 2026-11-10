/*
 * Per-store customer accounts: cross-store denial (403
 * CUSTOMER_STORE_MISMATCH) on every customer-facing endpoint that names a
 * store, plus the route metadata of the Customers API.
 */
import { ForbiddenException } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import {
  CUSTOMER_STORE_MISMATCH,
  assertCustomerStore,
  customerMayUseStore,
} from '../../common/customers/customer-store';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { OrdersService } from '../orders/orders.service';
import { CartService } from '../cart/cart.service';
import { KustomCheckoutService } from '../payments/kustom/kustom-checkout.service';
import { DesignsController } from '../designer/designs.controller';
import { InvoicesService } from '../invoices/invoices.service';
import { StoreCustomersController } from './store-customers.controller';
import { AdminCustomersController } from './admin-customers.controller';

const customerA = { role: UserRole.CUSTOMER, store_id: 'store-a' };

async function expectMismatch(p: Promise<unknown>) {
  await expect(p).rejects.toBeInstanceOf(ForbiddenException);
  await p.catch((e: ForbiddenException) =>
    expect(e.getResponse()).toMatchObject({ code: CUSTOMER_STORE_MISMATCH }),
  );
}

describe('customer-store helper', () => {
  it('customers only in their own store; staff and guests always', () => {
    expect(customerMayUseStore(customerA, 'store-a')).toBe(true);
    expect(customerMayUseStore(customerA, 'store-b')).toBe(false);
    expect(customerMayUseStore(customerA, null)).toBe(false);
    expect(
      customerMayUseStore({ role: UserRole.CUSTOMER, store_id: null }, 'x'),
    ).toBe(false);
    // RequestUser shape (storeId).
    expect(
      customerMayUseStore({ role: UserRole.CUSTOMER, storeId: 'x' }, 'x'),
    ).toBe(true);
    expect(customerMayUseStore({ role: UserRole.CREATOR }, 'x')).toBe(true);
    expect(customerMayUseStore(null, 'x')).toBe(true);
    expect(() => assertCustomerStore(customerA, 'store-b')).toThrow(
      ForbiddenException,
    );
  });
});

describe('orders', () => {
  function orders(prisma: Record<string, unknown>) {
    const svc = Object.create(OrdersService.prototype) as OrdersService;
    Object.assign(svc, { prisma });
    return svc;
  }

  it('create: 403 when dto.store_id is not the customer store', async () => {
    const prisma = {
      customer: {
        findUnique: jest.fn(() =>
          Promise.resolve({ id: 'cu1', user: customerA }),
        ),
      },
      cart: { findUnique: jest.fn() },
    };
    await expectMismatch(
      orders(prisma).create(
        'u1',
        { store_id: 'store-b' } as never,
        { lines: [{ product_id: 'p', quantity: 1 }] } as never,
      ),
    );
    expect(prisma.cart.findUnique).not.toHaveBeenCalled();
  });

  it('quote: 403 for a customer token of another store', async () => {
    const prisma = {
      customer: {
        findUnique: jest.fn(() => Promise.resolve({ user: customerA })),
      },
    };
    await expectMismatch(
      orders(prisma).quote('u1', {
        store_id: 'store-b',
        lines: [{ product_id: 'p', quantity: 1 }] as never,
      }),
    );
  });

  it('GET /orders/my: own customer id and own store (or legacy null)', async () => {
    const prisma = {
      customer: {
        findUnique: jest.fn(() =>
          Promise.resolve({ id: 'cu1', user: { store_id: 'store-a' } }),
        ),
      },
      order: {
        findMany: jest.fn(() => Promise.resolve([])),
        count: jest.fn(() => Promise.resolve(0)),
      },
    };
    const r = await orders(prisma).findByCustomer('u1', 1, 20);
    const where = {
      customer_id: 'cu1',
      deleted_at: null,
      OR: [{ store_id: 'store-a' }, { store_id: null }],
    };
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where }),
    );
    expect(prisma.order.count).toHaveBeenCalledWith({ where });
    expect(r.meta).toEqual({ total: 0, page: 1, limit: 20, totalPages: 0 });
  });
});

describe('cart', () => {
  function cart(productStore: string) {
    const prisma = {
      customer: {
        findUnique: jest.fn(() =>
          Promise.resolve({ id: 'cu1', user: { store_id: 'store-a' } }),
        ),
      },
      cart: {
        findUnique: jest.fn(() =>
          Promise.resolve({ id: 'cart1', customer_id: 'cu1', store_id: null }),
        ),
        update: jest.fn(() =>
          Promise.resolve({
            id: 'cart1',
            customer_id: 'cu1',
            store_id: 'store-a',
          }),
        ),
        create: jest.fn(),
      },
      cartItem: {
        findFirst: jest.fn(() =>
          Promise.resolve({
            id: 'i1',
            product_id: 'p1',
            custom_product_id: null,
          }),
        ),
        create: jest.fn(),
        update: jest.fn(),
      },
      product: {
        findUnique: jest.fn(() => Promise.resolve({ creator_id: 'cr' })),
      },
      customProduct: { findUnique: jest.fn() },
      store: {
        findUnique: jest.fn(() => Promise.resolve({ id: productStore })),
      },
    };
    const core = { loadContexts: jest.fn(() => Promise.resolve([{}])) };
    const svc = Object.create(CartService.prototype) as CartService;
    Object.assign(svc, { prisma, core });
    return { svc, prisma };
  }

  it('add: 403 for a product of another store; cart gets its store', async () => {
    const { svc, prisma } = cart('store-b');
    await expectMismatch(
      svc.addItem('u1', { product_id: 'p1', quantity: 1 } as never),
    );
    expect(prisma.cart.update).toHaveBeenCalledWith({
      where: { id: 'cart1' },
      data: { store_id: 'store-a' },
    });
    expect(prisma.cartItem.create).not.toHaveBeenCalled();
  });

  it('update: 403 for a legacy line of another store', async () => {
    const { svc, prisma } = cart('store-b');
    await expectMismatch(svc.updateItem('u1', 'i1', { quantity: 2 } as never));
    expect(prisma.cartItem.update).not.toHaveBeenCalled();
  });

  it('a new cart is created with the customer store', async () => {
    const { svc, prisma } = cart('store-b');
    prisma.cart.findUnique.mockResolvedValueOnce(null as never);
    prisma.cart.create.mockResolvedValueOnce({
      id: 'cart1',
      customer_id: 'cu1',
      store_id: 'store-a',
    } as never);
    await expectMismatch(
      svc.addItem('u1', { product_id: 'p1', quantity: 1 } as never),
    );
    expect(prisma.cart.create).toHaveBeenCalledWith({
      data: { customer_id: 'cu1', store_id: 'store-a' },
    });
  });
});

describe('Kustom checkout session', () => {
  it('403 for a logged-in customer of another store', async () => {
    const prisma = {
      customer: {
        findUnique: jest.fn(() =>
          Promise.resolve({ id: 'cu1', user: customerA }),
        ),
      },
      cart: { findUnique: jest.fn() },
    };
    const svc = Object.create(
      KustomCheckoutService.prototype,
    ) as KustomCheckoutService;
    Object.assign(svc, {
      prisma,
      kustom: {
        loadStoreContextBySlug: jest.fn(() =>
          Promise.resolve({ id: 'store-b', slug: 'b', is_active: true }),
        ),
        requirePublicUrls: jest.fn(() => ({})),
      },
      markets: { resolve: jest.fn(() => Promise.resolve(null)) },
      clientFor: jest.fn(() => Promise.resolve({})),
      purgeStaleSessions: jest.fn(),
    });
    await expectMismatch(svc.createSession('u1', { store_slug: 'b' } as never));
    expect(prisma.cart.findUnique).not.toHaveBeenCalled();
  });
});

describe('designer /designer/s/:slug', () => {
  it('403 for a customer token of another store; guests and own store pass', async () => {
    const designs = {
      customerIdOf: jest.fn(() => Promise.resolve('cu1')),
      get: jest.fn(() => Promise.resolve({ ok: true })),
    };
    const ctl = new DesignsController(designs as never);
    const req = { appStoreId: 'store-b' } as never;
    const foreign = {
      id: 'u1',
      email: 'a@x',
      role: UserRole.CUSTOMER,
      status: 'ACTIVE',
      storeId: 'store-a',
    } as never;
    await expectMismatch(ctl.get(req, 'd1', undefined, foreign));
    expect(designs.get).not.toHaveBeenCalled();

    await ctl.get(req, 'd1', 'tok', undefined);
    expect(designs.get).toHaveBeenLastCalledWith(
      'store-b',
      'd1',
      expect.objectContaining({ customerId: null, token: 'tok' }),
    );
    const own = {
      ...(foreign as object),
      storeId: 'store-b',
    } as never;
    await ctl.get(req, 'd1', undefined, own);
    expect(designs.get).toHaveBeenLastCalledWith(
      'store-b',
      'd1',
      expect.objectContaining({ customerId: 'cu1' }),
    );
  });
});

describe('invoices read access', () => {
  it('a customer reads invoices of its own order in its own store only', async () => {
    const svc = Object.create(InvoicesService.prototype) as InvoicesService;
    const canRead = (
      svc as unknown as {
        canRead: (o: unknown, u: unknown) => Promise<boolean>;
      }
    ).canRead.bind(svc);
    const order = (store: string) => ({
      store_id: store,
      customer: { user_id: 'u1' },
      items: [],
    });
    const user = { id: 'u1', role: UserRole.CUSTOMER, storeId: 'store-a' };
    await expect(canRead(order('store-a'), user)).resolves.toBe(true);
    await expect(canRead(order('store-b'), user)).resolves.toBe(false);
    await expect(
      canRead(order('store-a'), { ...user, id: 'u2' }),
    ).resolves.toBe(false);
  });
});

describe('Customers API routes', () => {
  const route = (ctl: object, name: string) => {
    const fn = (ctl as Record<string, unknown>)[name] as () => void;
    return {
      path: Reflect.getMetadata(PATH_METADATA, fn) as string,
      method: Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod,
    };
  };

  it('creator routes: CREATOR only, static paths before :id', () => {
    expect(Reflect.getMetadata(PATH_METADATA, StoreCustomersController)).toBe(
      'stores/my/customers',
    );
    expect(Reflect.getMetadata(ROLES_KEY, StoreCustomersController)).toEqual([
      UserRole.CREATOR,
    ]);
    const proto = StoreCustomersController.prototype;
    const names = Object.getOwnPropertyNames(proto).filter(
      (n) => n !== 'constructor',
    );
    const paths = names.map((n) => ({ n, ...route(proto, n) }));
    const idx = (n: string) => names.indexOf(n);
    // Express matches in declaration order: export.csv / bulk must come
    // before the :id routes of the same method.
    expect(idx('exportCsv')).toBeLessThan(idx('detail'));
    expect(idx('bulk')).toBeLessThan(idx('sendLoginLink'));
    expect(paths.find((p) => p.n === 'exportCsv')).toMatchObject({
      path: 'export.csv',
      method: RequestMethod.GET,
    });
    expect(paths.find((p) => p.n === 'setStatus')).toMatchObject({
      path: ':id/status',
      method: RequestMethod.PATCH,
    });
  });

  it('admin routes: ADMIN only', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminCustomersController)).toBe(
      'admin/customers',
    );
    expect(Reflect.getMetadata(ROLES_KEY, AdminCustomersController)).toEqual([
      UserRole.ADMIN,
    ]);
  });
});

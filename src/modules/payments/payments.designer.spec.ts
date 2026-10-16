import type { ConfigService } from '@nestjs/config';
import { PaymentsService } from './payments.service';
import { KustomService } from './kustom/kustom.service';
import type { KustomClient } from './kustom/kustom.client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CryptoService } from '../../common/crypto/crypto.service';
import type { OrdersService } from '../orders/orders.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { MailService } from '../mail/mail.service';
import type { MarketsContextService } from '../markets/markets-context.service';
import type { RevalidationService } from '../../common/revalidation/revalidation.service';
import type { TaxService } from '../taxes/tax.service';
import type { B2bService } from '../b2b/b2b.service';
import type { InvoiceTriggersService } from '../invoices/invoice-triggers.service';
import { DesignerTriggersService } from '../designer/designer-triggers.service';
import { DesignerPrintQueueService } from '../designer/designer-print-queue.service';

// Designer app call sites (M4.2 WP5): a confirmed payment (Stripe
// payment_intent.succeeded, Kustom authorization) enqueues the order's print
// renders, after the invoice trigger; replays call it again (the queue is
// idempotent); without the injected service the flow is unchanged.

type Internals = Record<string, (...args: unknown[]) => Promise<unknown>>;
const first = (fn: { mock: { invocationCallOrder: number[] } }) =>
  fn.mock.invocationCallOrder[0];

function stripe(opts: { changed: boolean; designer?: boolean }) {
  const prisma = {
    order: {
      findUnique: jest.fn(() =>
        Promise.resolve({ stripe_account_id: null, store_id: 's1' }),
      ),
    },
  };
  const orders = {
    markOrderPaid: jest.fn(() =>
      Promise.resolve({
        changed: opts.changed,
        order: { customer: { user_id: 'u1' }, order_number: 'MS-1' },
      }),
    ),
  };
  const invoices = { onOrderPaid: jest.fn(() => Promise.resolve()) };
  const designer = opts.designer
    ? { onOrderPaid: jest.fn(() => Promise.resolve()) }
    : undefined;
  const service = new PaymentsService(
    {} as ConfigService,
    prisma as unknown as PrismaService,
    {} as CryptoService,
    orders as unknown as OrdersService,
    {
      create: jest.fn(() => Promise.resolve()),
    } as unknown as NotificationsService,
    {
      dispatchOrderEmail: jest.fn(() => Promise.resolve()),
    } as unknown as MailService,
    {} as MarketsContextService,
    invoices as unknown as InvoiceTriggersService,
    designer as unknown as DesignerTriggersService | undefined,
  );
  const internals = service as unknown as Internals;
  jest.spyOn(internals, 'requireStripe').mockResolvedValue({
    paymentIntents: {
      retrieve: jest.fn(() =>
        Promise.resolve({
          id: 'pi_1',
          status: 'succeeded',
          metadata: { order_id: 'o1' },
          latest_charge: 'ch_1',
        }),
      ),
    },
  });
  jest.spyOn(internals, 'captureChargeDetails').mockResolvedValue(undefined);
  const transfers = jest
    .spyOn(internals, 'issueOrderTransfers')
    .mockResolvedValue(undefined);
  return { internals, invoices, designer, transfers };
}

function kustom(opts: { changed: boolean; designer?: boolean }) {
  const prisma = {
    order: {
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      findUnique: jest.fn(() => Promise.resolve(null)),
    },
    kustomCheckoutSession: { findFirst: jest.fn(() => Promise.resolve(null)) },
  };
  const orders = {
    registerShippedHook: jest.fn(),
    markOrderPaid: jest.fn(() =>
      Promise.resolve({
        changed: opts.changed,
        order: {
          id: 'o1',
          order_number: 'MS-1',
          store_id: 's1',
          payment_method: 'KUSTOM',
          payment_status: 'awaiting_payment',
          customer: { user_id: 'u1' },
        },
      }),
    ),
  };
  const invoices = { onOrderPaid: jest.fn(() => Promise.resolve()) };
  const designer = opts.designer
    ? { onOrderPaid: jest.fn(() => Promise.resolve()) }
    : undefined;
  const service = new KustomService(
    {} as ConfigService,
    prisma as unknown as PrismaService,
    {} as CryptoService,
    orders as unknown as OrdersService,
    {
      create: jest.fn(() => Promise.resolve()),
    } as unknown as NotificationsService,
    {
      dispatchOrderEmail: jest.fn(() => Promise.resolve()),
    } as unknown as MailService,
    {} as RevalidationService,
    {} as TaxService,
    {} as MarketsContextService,
    {} as B2bService,
    invoices as unknown as InvoiceTriggersService,
    designer as unknown as DesignerTriggersService | undefined,
  );
  jest
    .spyOn(service as unknown as Internals, 'syncShippingAddress')
    .mockResolvedValue(undefined);
  const client = {
    getOrder: jest.fn(() =>
      Promise.resolve({
        order_id: 'k-1',
        status: 'AUTHORIZED',
        order_amount: 29900,
        purchase_currency: 'SEK',
        merchant_reference1: 'o1',
        customer: { type: 'person' },
        billing_address: {},
      }),
    ),
    acknowledge: jest.fn(() => Promise.resolve()),
  } as unknown as KustomClient;
  return { service, client, invoices, designer };
}

const kOrder = {
  id: 'o1',
  order_number: 'MS-1',
  total: 299,
  currency: 'SEK',
  kustom_order_id: 'k-1',
};

describe('Designer call sites: Stripe payment succeeded', () => {
  it('enqueues once with the store id, after the invoice trigger and before transfers', async () => {
    const b = stripe({ changed: true, designer: true });
    await b.internals.onPaymentSucceeded({
      id: 'pi_1',
      metadata: { order_id: 'o1' },
    });
    expect(b.designer!.onOrderPaid).toHaveBeenCalledTimes(1);
    expect(b.designer!.onOrderPaid).toHaveBeenCalledWith({
      id: 'o1',
      store_id: 's1',
      payment_status: 'paid',
    });
    expect(first(b.invoices.onOrderPaid)).toBeLessThan(
      first(b.designer!.onOrderPaid),
    );
    expect(first(b.designer!.onOrderPaid)).toBeLessThan(first(b.transfers));
  });

  it('a replayed event calls it again (the queue is idempotent)', async () => {
    const b = stripe({ changed: false, designer: true });
    await b.internals.onPaymentSucceeded({
      id: 'pi_1',
      metadata: { order_id: 'o1' },
    });
    expect(b.designer!.onOrderPaid).toHaveBeenCalledTimes(1);
  });

  it('without the service the paid path is unchanged', async () => {
    const b = stripe({ changed: true });
    await expect(
      b.internals.onPaymentSucceeded({
        id: 'pi_1',
        metadata: { order_id: 'o1' },
      }),
    ).resolves.toBeUndefined();
    expect(b.transfers).toHaveBeenCalled();
  });
});

describe('Designer call sites: Kustom authorization', () => {
  it('enqueues with the store id after the invoice trigger', async () => {
    const b = kustom({ changed: true, designer: true });
    await b.service.processCompletedCheckout(kOrder, b.client, 'k-1');
    expect(b.designer!.onOrderPaid).toHaveBeenCalledTimes(1);
    expect(b.designer!.onOrderPaid).toHaveBeenCalledWith({
      id: 'o1',
      store_id: 's1',
      payment_method: 'KUSTOM',
      payment_status: 'paid',
    });
    expect(first(b.invoices.onOrderPaid)).toBeLessThan(
      first(b.designer!.onOrderPaid),
    );
  });

  it('without the service the flow is unchanged', async () => {
    const b = kustom({ changed: true });
    const res = await b.service.processCompletedCheckout(
      kOrder,
      b.client,
      'k-1',
    );
    expect(res.paid).toBe(true);
  });
});

describe('Designer triggers end to end (real triggers + queue, fake DB)', () => {
  function real(opts: { enabled: boolean; designRows: number }) {
    const prisma = {
      orderItemDesign: {
        updateMany: jest.fn(() => Promise.resolve({ count: opts.designRows })),
        // reviveOrder: no terminal rows to revive.
        findMany: jest.fn(() => Promise.resolve([])),
      },
    };
    const queue = new DesignerPrintQueueService(
      prisma as never,
      {} as never,
      {} as never,
    );
    const nudge = jest.spyOn(queue, 'nudge').mockImplementation(() => {});
    const triggers = new DesignerTriggersService(
      { isEnabled: jest.fn(() => Promise.resolve(opts.enabled)) } as never,
      queue,
    );
    return { prisma, triggers, nudge };
  }

  it('an order with designs is queued and the worker nudged', async () => {
    const b = real({ enabled: true, designRows: 2 });
    await b.triggers.onOrderPaid({ id: 'o1', store_id: 's1' });
    expect(b.prisma.orderItemDesign.updateMany).toHaveBeenCalledTimes(1);
    expect(b.nudge).toHaveBeenCalledTimes(1);
  });

  it('an order without designs: one no-op UPDATE, no nudge, no render', async () => {
    const b = real({ enabled: true, designRows: 0 });
    await b.triggers.onOrderPaid({ id: 'o1', store_id: 's1' });
    expect(b.nudge).not.toHaveBeenCalled();
  });

  it('app off: no DB work at all', async () => {
    const b = real({ enabled: false, designRows: 2 });
    await b.triggers.onOrderPaid({ id: 'o1', store_id: 's1' });
    expect(b.prisma.orderItemDesign.updateMany).not.toHaveBeenCalled();
    expect(b.nudge).not.toHaveBeenCalled();
  });
});

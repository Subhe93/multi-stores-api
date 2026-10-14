import { KustomService } from './kustom.service';
import type { KustomClient } from './kustom.client';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { CryptoService } from '../../../common/crypto/crypto.service';
import type { OrdersService } from '../../orders/orders.service';
import type { NotificationsService } from '../../notifications/notifications.service';
import type { MailService } from '../../mail/mail.service';
import type { RevalidationService } from '../../../common/revalidation/revalidation.service';
import type { TaxService } from '../../taxes/tax.service';
import type { MarketsContextService } from '../../markets/markets-context.service';
import type { B2bService } from '../../b2b/b2b.service';
import type { InvoiceTriggersService } from '../../invoices/invoice-triggers.service';

// Invoices app call sites in the Kustom flow (M3 §3.4, watch list 1): the
// address sync and the organisation fill now run right after markOrderPaid,
// then onOrderPaid, and only then the notification and the confirmation
// email (which can attach the invoice). Partial refunds pass the running
// total Kustom holds.

type Internals = Record<string, (...args: unknown[]) => Promise<unknown>>;

const order = {
  id: 'o1',
  order_number: 'MS-1',
  total: 299,
  currency: 'SEK',
  kustom_order_id: 'k-1',
};

function build(opts: { changed: boolean; invoices?: boolean }) {
  const prisma = {
    order: {
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      findUnique: jest.fn(() => Promise.resolve(null)),
    },
    kustomCheckoutSession: {
      findFirst: jest.fn(() => Promise.resolve(null)),
    },
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
    recordPartialRefund: jest.fn(() => Promise.resolve({ changed: true })),
    markOrderRefunded: jest.fn(() => Promise.resolve({ changed: true })),
  };
  const notifications = { create: jest.fn(() => Promise.resolve()) };
  const mail = { dispatchOrderEmail: jest.fn(() => Promise.resolve()) };
  const invoices = opts.invoices
    ? { onOrderPaid: jest.fn(() => Promise.resolve()) }
    : undefined;
  const service = new KustomService(
    {} as ConfigService,
    prisma as unknown as PrismaService,
    {} as CryptoService,
    orders as unknown as OrdersService,
    notifications as unknown as NotificationsService,
    mail as unknown as MailService,
    {} as RevalidationService,
    {} as TaxService,
    {} as MarketsContextService,
    {} as B2bService,
    invoices as unknown as InvoiceTriggersService | undefined,
  );
  const internals = service as unknown as Internals;
  const syncAddress = jest
    .spyOn(internals, 'syncShippingAddress')
    .mockResolvedValue(undefined);
  const client = {
    getOrder: jest.fn(() =>
      Promise.resolve({
        order_id: 'k-1',
        status: 'AUTHORIZED',
        order_amount: 29900,
        purchase_currency: 'SEK',
        merchant_reference1: 'o1',
        customer: {
          type: 'organization',
          organization_registration_id: '556036-0793',
        },
        billing_address: { organization_name: 'Kustom Org AB' },
      }),
    ),
    acknowledge: jest.fn(() => Promise.resolve()),
  } as unknown as KustomClient;
  return {
    service,
    internals,
    prisma,
    orders,
    notifications,
    mail,
    invoices,
    syncAddress,
    client,
  };
}

const first = (fn: { mock: { invocationCallOrder: number[] } }) =>
  fn.mock.invocationCallOrder[0];

/** Call order of the company-snapshot write (updateMany with customer_type). */
function companyWriteOrder(updateMany: jest.Mock): number {
  const i = updateMany.mock.calls.findIndex(
    (c) => 'customer_type' in ((c as [{ data: object }])[0].data ?? {}),
  );
  expect(i).toBeGreaterThanOrEqual(0);
  return updateMany.mock.invocationCallOrder[i];
}

describe('KustomService invoices call sites', () => {
  it('processCompletedCheckout: address + company before onOrderPaid, emails last', async () => {
    const b = build({ changed: true, invoices: true });
    const res = await b.service.processCompletedCheckout(
      order,
      b.client,
      'k-1',
    );
    expect(res).toEqual({ paid: true, changed: true });

    const paid = first(b.orders.markOrderPaid);
    const address = first(b.syncAddress);
    const company = companyWriteOrder(b.prisma.order.updateMany);
    const invoice = first(b.invoices!.onOrderPaid);
    const confirmation = first(b.mail.dispatchOrderEmail);

    expect(paid).toBeLessThan(address);
    expect(address).toBeLessThan(company);
    expect(company).toBeLessThan(invoice);
    expect(invoice).toBeLessThan(first(b.notifications.create));
    expect(invoice).toBeLessThan(confirmation);
    expect(b.mail.dispatchOrderEmail.mock.calls[0]).toEqual([
      'o1',
      'order_confirmation',
    ]);
    expect(b.invoices!.onOrderPaid).toHaveBeenCalledWith({
      id: 'o1',
      store_id: 's1',
      payment_method: 'KUSTOM',
      payment_status: 'paid',
    });
  });

  it('a replayed push (changed=false) still syncs and calls onOrderPaid, sends no email', async () => {
    const b = build({ changed: false, invoices: true });
    await b.service.processCompletedCheckout(order, b.client, 'k-1');
    expect(b.syncAddress).toHaveBeenCalledTimes(1);
    expect(b.invoices!.onOrderPaid).toHaveBeenCalledTimes(1);
    expect(b.mail.dispatchOrderEmail).not.toHaveBeenCalled();
  });

  it('without the injected service the flow is unchanged (address + company still before the email)', async () => {
    const b = build({ changed: true });
    const res = await b.service.processCompletedCheckout(
      order,
      b.client,
      'k-1',
    );
    expect(res.paid).toBe(true);
    expect(first(b.syncAddress)).toBeLessThan(first(b.mail.dispatchOrderEmail));
    expect(companyWriteOrder(b.prisma.order.updateMany)).toBeLessThan(
      first(b.mail.dispatchOrderEmail),
    );
  });

  it('partial refund: the cumulative refunded amount (Kustom before + this one)', async () => {
    const b = build({ changed: false });
    jest.spyOn(b.internals, 'loadManagedOrder').mockResolvedValue({
      id: 'o1',
      order_number: 'MS-1',
      total: 100,
      currency: 'SEK',
      payment_status: 'paid',
      store_id: 's1',
      kustom_order_id: 'k-1',
      kustom_captured_at: new Date(),
    });
    const client = {
      getOrder: jest.fn(() =>
        Promise.resolve({
          captured_amount: 10000,
          refunded_amount: 3000,
          refunds: [{}],
        }),
      ),
      refund: jest.fn(() => Promise.resolve()),
    };
    jest.spyOn(b.internals, 'clientForStore').mockResolvedValue({ client });
    await b.service.refundOrder('o1', 20, {
      userId: 'admin',
      role: 'ADMIN',
    } as never);
    expect(b.orders.recordPartialRefund).toHaveBeenCalledWith(
      'o1',
      20,
      'SEK',
      'Kustom',
      { cumulativeRefunded: 50, storeId: 's1' },
    );
  });
});

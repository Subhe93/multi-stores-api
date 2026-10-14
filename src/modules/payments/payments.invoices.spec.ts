import type { ConfigService } from '@nestjs/config';
import { PaymentsService } from './payments.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CryptoService } from '../../common/crypto/crypto.service';
import type { OrdersService } from '../orders/orders.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { MailService } from '../mail/mail.service';
import type { MarketsContextService } from '../markets/markets-context.service';
import type { InvoiceTriggersService } from '../invoices/invoice-triggers.service';

// Invoices app call sites in the Stripe flow (M3 §3.4): the verified
// payment_intent.succeeded issues the invoice after the card details are
// captured and before transfers and the confirmation email; a partial
// refund passes Stripe's cumulative amount_refunded.

type Internals = Record<string, (...args: unknown[]) => Promise<unknown>>;

function build(opts: { changed: boolean; invoices?: boolean }) {
  const prisma = {
    order: {
      findUnique: jest.fn(
        (): Promise<unknown> =>
          Promise.resolve({ stripe_account_id: null, store_id: 's1' }),
      ),
      findFirst: jest.fn((): Promise<unknown> => Promise.resolve(null)),
    },
  };
  const orders = {
    markOrderPaid: jest.fn(() =>
      Promise.resolve({
        changed: opts.changed,
        order: { customer: { user_id: 'u1' }, order_number: 'MS-1' },
      }),
    ),
    recordPartialRefund: jest.fn(() => Promise.resolve({ changed: false })),
    markOrderRefunded: jest.fn(() => Promise.resolve({ changed: false })),
  };
  const notifications = { create: jest.fn(() => Promise.resolve()) };
  const mail = { dispatchOrderEmail: jest.fn(() => Promise.resolve()) };
  const invoices = opts.invoices
    ? { onOrderPaid: jest.fn(() => Promise.resolve()) }
    : undefined;
  const stripe = {
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
    charges: {
      retrieve: jest.fn(() =>
        Promise.resolve({
          id: 'ch_1',
          refunded: false,
          amount_refunded: 5000,
          currency: 'sek',
        }),
      ),
    },
  };
  const service = new PaymentsService(
    {} as ConfigService,
    prisma as unknown as PrismaService,
    {} as CryptoService,
    orders as unknown as OrdersService,
    notifications as unknown as NotificationsService,
    mail as unknown as MailService,
    {} as MarketsContextService,
    invoices as unknown as InvoiceTriggersService | undefined,
  );
  const internals = service as unknown as Internals;
  jest.spyOn(internals, 'requireStripe').mockResolvedValue(stripe);
  const capture = jest
    .spyOn(internals, 'captureChargeDetails')
    .mockResolvedValue(undefined);
  const transfers = jest
    .spyOn(internals, 'issueOrderTransfers')
    .mockResolvedValue(undefined);
  return {
    service: internals,
    prisma,
    orders,
    mail,
    invoices,
    capture,
    transfers,
  };
}

const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
  fn.mock.invocationCallOrder[0];

const pi = { id: 'pi_1', metadata: { order_id: 'o1' } };

describe('PaymentsService invoices call sites (Stripe)', () => {
  it('payment succeeded: onOrderPaid once with store_id, after capture, before transfers and emails', async () => {
    const b = build({ changed: true, invoices: true });
    await b.service.onPaymentSucceeded(pi);
    expect(b.prisma.order.findUnique).toHaveBeenCalledWith({
      where: { id: 'o1' },
      select: { stripe_account_id: true, store_id: true },
    });
    expect(b.invoices!.onOrderPaid).toHaveBeenCalledTimes(1);
    expect(b.invoices!.onOrderPaid).toHaveBeenCalledWith({
      id: 'o1',
      store_id: 's1',
      payment_status: 'paid',
    });
    const paid = order(b.invoices!.onOrderPaid);
    expect(order(b.capture)).toBeLessThan(paid);
    expect(paid).toBeLessThan(order(b.transfers));
    expect(paid).toBeLessThan(order(b.mail.dispatchOrderEmail));
    expect(b.mail.dispatchOrderEmail).toHaveBeenCalledWith(
      'o1',
      'order_confirmation',
    );
  });

  it('a replayed event (changed=false) still calls onOrderPaid, sends no email', async () => {
    const b = build({ changed: false, invoices: true });
    await b.service.onPaymentSucceeded(pi);
    expect(b.invoices!.onOrderPaid).toHaveBeenCalledTimes(1);
    expect(b.mail.dispatchOrderEmail).not.toHaveBeenCalled();
  });

  it('without the injected service the paid path is unchanged', async () => {
    const b = build({ changed: true });
    await expect(b.service.onPaymentSucceeded(pi)).resolves.toBeUndefined();
    expect(b.transfers).toHaveBeenCalled();
    expect(b.mail.dispatchOrderEmail).toHaveBeenCalledTimes(2);
  });

  it("partial refund: Stripe's cumulative amount_refunded and the loaded store id", async () => {
    const b = build({ changed: false });
    b.prisma.order.findFirst.mockResolvedValue({
      id: 'o1',
      order_number: 'MS-1',
      payment_status: 'paid',
      store_id: 's1',
      stripe_account_id: null,
    });
    await b.service.onChargeRefunded({ id: 'ch_1', payment_intent: 'pi_1' });
    expect(b.orders.recordPartialRefund).toHaveBeenCalledWith(
      'o1',
      50,
      'sek',
      'Stripe',
      { cumulativeRefunded: 50, storeId: 's1' },
    );
  });
});

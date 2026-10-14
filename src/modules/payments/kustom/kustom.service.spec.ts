import { KustomService } from './kustom.service';
import type { KustomClient, KustomManagementOrder } from './kustom.client';
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

// b2b app (D5 / L2): a shopper who switched to "organisation" inside the
// Kustom iframe has an order whose snapshot still says person. Once Kustom
// reports the completed checkout, the company columns are filled from it -
// only while they are still empty.

const order = {
  id: 'o1',
  order_number: 'MS-1',
  total: 299,
  currency: 'SEK',
  kustom_order_id: 'k-1',
};

function build(live: Partial<KustomManagementOrder>) {
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
    markOrderPaid: jest.fn(() => Promise.resolve({ changed: false })),
  };
  const service = new KustomService(
    {} as ConfigService,
    prisma as unknown as PrismaService,
    {} as CryptoService,
    orders as unknown as OrdersService,
    {} as NotificationsService,
    {} as MailService,
    {} as RevalidationService,
    {} as TaxService,
    {} as MarketsContextService,
    {} as B2bService,
  );
  const client = {
    getOrder: jest.fn(() =>
      Promise.resolve({
        order_id: 'k-1',
        status: 'CAPTURED',
        order_amount: 29900,
        purchase_currency: 'SEK',
        merchant_reference1: 'o1',
        ...live,
      }),
    ),
    acknowledge: jest.fn(() => Promise.resolve()),
  } as unknown as KustomClient;
  return { service, prisma, client };
}

describe('KustomService.processCompletedCheckout (b2b app)', () => {
  it('fills an empty company snapshot from an organisation purchase', async () => {
    const { service, prisma, client } = build({
      customer: {
        type: 'organization',
        organization_registration_id: '556036-0793',
        vat_id: 'SE556036079301',
      },
      billing_address: {
        organization_name: 'Kustom Org AB',
        buyer_reference: 'PO-4711',
      },
    });
    const res = await service.processCompletedCheckout(order, client, 'k-1');
    expect(res.paid).toBe(true);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', customer_type: null },
      data: {
        customer_type: 'COMPANY',
        company_name: 'Kustom Org AB',
        org_number: '556036-0793',
        vat_number: 'SE556036079301',
        buyer_reference: 'PO-4711',
      },
    });
  });

  it('leaves a person purchase untouched', async () => {
    const { service, prisma, client } = build({
      customer: { type: 'person' },
      billing_address: { organization_name: 'ignored' },
    });
    await service.processCompletedCheckout(order, client, 'k-1');
    const companyWrites = prisma.order.updateMany.mock.calls.filter(
      (c) =>
        'customer_type' in ((c as unknown as [{ data: object }])[0].data ?? {}),
    );
    expect(companyWrites).toHaveLength(0);
  });

  it('never fails the payment when the snapshot write fails', async () => {
    const { service, prisma, client } = build({
      customer: { type: 'organization' },
    });
    prisma.order.updateMany.mockImplementation((args?: unknown) =>
      'customer_type' in ((args as { data: object }).data ?? {})
        ? Promise.reject(new Error('db down'))
        : Promise.resolve({ count: 1 }),
    );
    const res = await service.processCompletedCheckout(order, client, 'k-1');
    expect(res.paid).toBe(true);
  });
});

describe('KustomService.processCompletedCheckout (address sync failure)', () => {
  it('a DB error while syncing the address never skips the invoice or the emails', async () => {
    const prisma = {
      order: {
        update: jest.fn(() => Promise.resolve({})),
        updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
        // syncShippingAddress reads the order's current address first; only
        // that first read fails (later reads, e.g. the capture check, work).
        findUnique: jest
          .fn()
          .mockRejectedValueOnce(new Error('db hiccup'))
          .mockResolvedValue(null),
      },
      kustomCheckoutSession: {
        findFirst: jest.fn(() => Promise.resolve(null)),
      },
    };
    const orders = {
      registerShippedHook: jest.fn(),
      markOrderPaid: jest.fn(() =>
        Promise.resolve({
          changed: true,
          order: {
            store_id: 's1',
            payment_method: 'KUSTOM',
            order_number: 'MS-1',
            customer: { user_id: 'u1' },
          },
        }),
      ),
    };
    const notifications = { create: jest.fn(() => Promise.resolve()) };
    const mail = { dispatchOrderEmail: jest.fn(() => Promise.resolve()) };
    const invoices = { onOrderPaid: jest.fn(() => Promise.resolve()) };
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
      invoices as unknown as InvoiceTriggersService,
    );
    const client = {
      getOrder: jest.fn(() =>
        Promise.resolve({
          order_id: 'k-1',
          status: 'AUTHORIZED',
          order_amount: 29900,
          purchase_currency: 'SEK',
          merchant_reference1: 'o1',
          shipping_address: {
            street_address: 'Ny gata 1',
            city: 'Malmö',
            postal_code: '21111',
            country: 'SE',
          },
        }),
      ),
      acknowledge: jest.fn(() => Promise.resolve()),
    } as unknown as KustomClient;

    const res = await service.processCompletedCheckout(order, client, 'k-1');
    expect(res.paid).toBe(true);
    expect(prisma.order.findUnique).toHaveBeenCalled();
    expect(invoices.onOrderPaid).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'o1', store_id: 's1' }),
    );
    expect(mail.dispatchOrderEmail).toHaveBeenCalledWith(
      'o1',
      'order_confirmation',
    );
    expect(mail.dispatchOrderEmail).toHaveBeenCalledWith(
      'o1',
      'new_order_owner',
    );
  });
});

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

// M175: syncShippingAddress stores the "c/o" line Kustom reports and treats
// a changed c/o as a different delivery address.
describe('KustomService.processCompletedCheckout (M175 care_of)', () => {
  const current = {
    id: 'a1',
    customer_id: 'c1',
    full_name: 'Anna Svensson',
    line1: 'Sturegatan 6',
    line2: null,
    city: 'Stockholm',
    state: null as string | null,
    postal_code: '114 35',
    country_code: 'SE',
    phone: '+46700000000',
    care_of: null as string | null,
    company_name: null as string | null,
    org_number: null as string | null,
    buyer_reference: null as string | null,
  };
  const remote = {
    given_name: 'Anna',
    family_name: 'Svensson',
    street_address: 'Sturegatan 6',
    postal_code: '114 35',
    city: 'Stockholm',
    country: 'SE',
  };

  function buildSync(
    live: Partial<KustomManagementOrder>,
    address: typeof current = current,
  ) {
    const prisma = {
      order: {
        update: jest.fn(() => Promise.resolve({})),
        updateMany: jest.fn((_args: unknown) => Promise.resolve({ count: 1 })),
        findUnique: jest.fn(() =>
          Promise.resolve({ customer_id: 'c1', address }),
        ),
      },
      address: {
        findFirst: jest.fn((_args: unknown) => Promise.resolve(null)),
        create: jest.fn((_args: unknown) => Promise.resolve({ id: 'a2' })),
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
    const sync = async () => {
      const res = await service.processCompletedCheckout(order, client, 'k-1');
      expect(res.paid).toBe(true);
      return prisma;
    };
    return { sync };
  }
  const created = (prisma: { address: { create: jest.Mock } }) =>
    (
      prisma.address.create.mock.calls[0] as [{ data: Record<string, unknown> }]
    )[0].data;
  const repoints = (prisma: { order: { updateMany: jest.Mock } }) =>
    prisma.order.updateMany.mock.calls
      .map((c) => (c as [{ where: object; data: object }])[0])
      .filter((args) => 'address_id' in args.data);

  it('an identical address without c/o on either side is left alone', async () => {
    const prisma = await buildSync({ shipping_address: remote }).sync();
    expect(prisma.address.create).not.toHaveBeenCalled();
    expect(repoints(prisma)).toHaveLength(0);
  });

  it('a c/o added in the iframe creates a new row that carries it', async () => {
    const prisma = await buildSync({
      shipping_address: { ...remote, care_of: '  Familjen Lind ' },
    }).sync();
    expect(created(prisma)).toMatchObject({
      full_name: 'Anna Svensson',
      line1: 'Sturegatan 6',
      care_of: 'Familjen Lind',
    });
    expect(
      (prisma.address.findFirst.mock.calls[0] as [{ where: object }])[0].where,
    ).toMatchObject({ care_of: 'Familjen Lind' });
    expect(repoints(prisma)).toEqual([
      { where: { id: 'o1', address_id: 'a1' }, data: { address_id: 'a2' } },
    ]);
  });

  it('a changed c/o creates a new row; the same c/o (any case) does not', async () => {
    const withCareOf = { ...current, care_of: 'Familjen Lind' };
    const changed = await buildSync(
      { shipping_address: { ...remote, care_of: 'Karin Berg' } },
      withCareOf,
    ).sync();
    expect(created(changed).care_of).toBe('Karin Berg');

    const same = await buildSync(
      { shipping_address: { ...remote, care_of: 'familjen lind ' } },
      withCareOf,
    ).sync();
    expect(same.address.create).not.toHaveBeenCalled();
    expect(repoints(same)).toHaveLength(0);
  });

  it('a removed c/o creates a new row without one', async () => {
    const prisma = await buildSync(
      { shipping_address: remote },
      { ...current, care_of: 'Familjen Lind' },
    ).sync();
    expect(created(prisma).care_of).toBeNull();
  });

  it('c/o is read from the address the street comes from (shipping, else billing)', async () => {
    const shippingWins = await buildSync({
      billing_address: { ...remote, care_of: 'Billing Person' },
      shipping_address: remote,
    }).sync();
    expect(shippingWins.address.create).not.toHaveBeenCalled();

    const billingOnly = await buildSync({
      billing_address: { ...remote, care_of: 'Billing Person' },
    }).sync();
    expect(created(billingOnly).care_of).toBe('Billing Person');
  });

  it('caps c/o at 120 characters', async () => {
    const prisma = await buildSync({
      shipping_address: { ...remote, care_of: 'x'.repeat(300) },
    }).sync();
    expect(created(prisma).care_of).toBe('x'.repeat(120));
  });

  it('a re-pointed company address keeps its company columns and region', async () => {
    const company = {
      ...current,
      state: 'AB',
      company_name: 'Acme AB',
      org_number: '5560000000',
      buyer_reference: 'PO-7',
    };
    const prisma = await buildSync(
      { shipping_address: { ...remote, care_of: 'Reception' } },
      company,
    ).sync();
    const carried = {
      company_name: 'Acme AB',
      org_number: '5560000000',
      buyer_reference: 'PO-7',
    };
    expect(created(prisma)).toMatchObject({
      ...carried,
      care_of: 'Reception',
      state: 'AB',
    });
    expect(
      (prisma.address.findFirst.mock.calls[0] as [{ where: object }])[0].where,
    ).toMatchObject(carried);
  });

  it('a new postcode does not inherit the old region', async () => {
    const prisma = await buildSync(
      { shipping_address: { ...remote, postal_code: '411 05', city: 'Göteborg' } },
      { ...current, state: 'AB' },
    ).sync();
    expect(created(prisma).state).toBeNull();
  });

  const buyerWrites = (prisma: { order: { updateMany: jest.Mock } }) =>
    prisma.order.updateMany.mock.calls
      .map((c) => (c as [{ where: object; data: object }])[0])
      .filter((args) => 'buyer_name' in args.data);

  it('stores the billing name as the buyer of the order, null-safe and replay-safe', async () => {
    const prisma = await buildSync({
      billing_address: { ...remote, given_name: ' Erik ', family_name: 'Berg' },
      shipping_address: { ...remote, given_name: 'Karin' },
    }).sync();
    expect(buyerWrites(prisma)).toEqual([
      {
        where: {
          id: 'o1',
          OR: [{ buyer_name: null }, { buyer_name: { not: 'Erik Berg' } }],
        },
        data: { buyer_name: 'Erik Berg' },
      },
    ]);
  });

  it('no billing name: the shipping name is the buyer; no name at all writes nothing', async () => {
    const shippingOnly = await buildSync({ shipping_address: remote }).sync();
    expect(buyerWrites(shippingOnly)[0].data).toEqual({
      buyer_name: 'Anna Svensson',
    });
    const nameless = await buildSync({
      shipping_address: { ...remote, given_name: '', family_name: undefined },
    }).sync();
    expect(buyerWrites(nameless)).toHaveLength(0);
  });
});

import type { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import { MailService } from './mail.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CryptoService } from '../../common/crypto/crypto.service';
import type { NotificationTemplatesService } from '../notification-templates/notification-templates.service';
import {
  loadOrderForEmail,
  type OrderEmailEvent,
  type OrderMailExtension,
} from './order-mail.helpers';

// "Store without customer accounts" (`checkout_settings.no_customer_accounts`):
// the customer order emails of that store carry no "view your order" button
// or link ({{order_button}}, {{order_url_text}}, {{order_url}} and the
// invoices-app order URL are empty). Owner notifications keep their dashboard
// link, and every other store renders exactly the former strings.

type Internals = Record<string, (...args: unknown[]) => Promise<unknown>>;

const ORDER_URL = 'http://localhost:3003/store/prima/account/orders/o1';
const ADMIN_URL = 'http://localhost:3002/creator/orders/o1';
const CUSTOMER_EVENTS: OrderEmailEvent[] = [
  'order_confirmation',
  'order_shipped',
  'order_delivered',
  'order_cancelled',
  'order_refunded',
];
const EXTRA = {
  trackingNumber: 'SE1',
  trackingUrl: 'https://track.example.com/SE1',
  reason: 'Out of stock',
  refundAmount: 100,
};

function emailOrder() {
  return {
    id: 'o1',
    order_number: 'MS-1',
    store_id: 's1',
    hostname: null,
    currency: 'SEK',
    total: 100,
    subtotal: 100,
    discount_amount: 0,
    shipping_cost: 0,
    shipping_tax_amount: 0,
    shipping_method_name: null,
    tax_lines: null,
    tax_rate_bp: 0,
    tax_amount: 0,
    tax_pricing_mode: 'INCLUSIVE',
    created_at: new Date('2026-10-01T10:00:00Z'),
    payment_method: 'STRIPE',
    payment_status: 'paid',
    card_brand: null,
    card_last4: null,
    customer_type: null,
    customer: {
      id: 'c1',
      first_name: 'Anna',
      last_name: 'Lind',
      user: { email: 'anna@example.com' },
    },
    address: null,
    items: [],
  };
}

function storeRow(settings?: unknown) {
  return {
    id: 's1',
    slug: 'prima',
    name: 'Prima',
    custom_domain: null,
    logo_url: null,
    notification_email: null,
    currency: 'SEK',
    // A store that never saved checkout settings has no value at all.
    ...(settings !== undefined && { checkout_settings: settings }),
    language_config: { primary_locale: 'sv' },
    creator: { user: { email: 'owner@example.com' } },
  };
}

function build(
  opts: { settings?: unknown; noTemplate?: boolean; noOrders?: boolean } = {},
) {
  const prisma = {
    order: {
      findUnique: jest.fn(() => Promise.resolve(emailOrder())),
      findFirst: jest.fn(() =>
        Promise.resolve(opts.noOrders ? null : { id: 'o1' }),
      ),
    },
    store: {
      findUnique: jest.fn(() => Promise.resolve(storeRow(opts.settings))),
    },
    customer: {
      findUnique: jest.fn(() =>
        Promise.resolve({ first_name: 'Anna', last_name: 'Lind' }),
      ),
    },
    platformConfig: {
      findFirst: jest.fn(() =>
        Promise.resolve({ platform_name: 'Namez AB', default_currency: 'SEK' }),
      ),
    },
  };
  const templates = {
    render: jest.fn(() =>
      Promise.resolve(
        opts.noTemplate
          ? null
          : { subject: 'Subject', html: '<p>Body</p>', text: 'Body' },
      ),
    ),
  };
  const service = new MailService(
    { get: () => undefined } as unknown as ConfigService,
    prisma as unknown as PrismaService,
    {} as CryptoService,
    templates as unknown as NotificationTemplatesService,
  );
  const sendMail = jest.fn((_message: { html: string; text: string }) =>
    Promise.resolve({}),
  );
  const internals = service as unknown as Internals;
  jest.spyOn(internals, 'resolveStoreConfig').mockResolvedValue(null);
  jest.spyOn(internals, 'resolveConfig').mockResolvedValue({
    host: 'smtp.test',
    port: 587,
    secure: false,
    from: 'shop@example.com',
  });
  jest
    .spyOn(
      service as unknown as Record<string, () => unknown>,
      'transporterFor',
    )
    .mockReturnValue({ sendMail });
  jest.spyOn(internals, 'logDelivery').mockResolvedValue(undefined);
  return { service, prisma, templates, sendMail, internals };
}

const renderedVars = (templates: { render: jest.Mock }) =>
  (templates.render.mock.calls[0] as unknown[])[2] as Record<string, string>;

describe('loadOrderForEmail (no_customer_accounts)', () => {
  it('flags the store context only when the switch is on', async () => {
    const on = build({ settings: { no_customer_accounts: true } });
    const order = await loadOrderForEmail(
      on.prisma as unknown as PrismaClient,
      'o1',
    );
    expect(order?.storeCtx?.noCustomerAccounts).toBe(true);

    for (const settings of [
      undefined,
      null,
      { phone_required: true },
      { no_customer_accounts: false },
      { no_customer_accounts: 'true' },
    ]) {
      const off = build({ settings });
      const plain = await loadOrderForEmail(
        off.prisma as unknown as PrismaClient,
        'o1',
      );
      expect(plain?.storeCtx).toStrictEqual({
        id: 's1',
        slug: 'prima',
        name: 'Prima',
        customDomain: undefined,
        logoUrl: undefined,
        primaryLocale: 'sv',
        ownerEmail: 'owner@example.com',
      });
    }
  });
});

describe('order emails of a store without customer accounts', () => {
  it.each(CUSTOMER_EVENTS)(
    '%s: the template gets empty order link variables',
    async (event) => {
      const { service, templates, sendMail } = build({
        settings: { no_customer_accounts: true },
      });
      await service.dispatchOrderEmail('o1', event, EXTRA);
      expect(sendMail).toHaveBeenCalledTimes(1);
      const vars = renderedVars(templates);
      expect(vars.order_button).toBe('');
      expect(vars.order_url_text).toBe('');
      expect(vars.order_url).toBe('');
      expect(JSON.stringify(vars)).not.toContain('/account/orders');
    },
  );

  it.each(CUSTOMER_EVENTS)(
    '%s: the bundled fallback carries no account link either',
    async (event) => {
      const { service, sendMail } = build({
        settings: { no_customer_accounts: true },
        noTemplate: true,
      });
      await service.dispatchOrderEmail('o1', event, EXTRA);
      expect(sendMail).toHaveBeenCalledTimes(1);
      const message = sendMail.mock.calls[0][0];
      expect(message.html).not.toContain('/account/orders');
      expect(message.text).not.toContain('/account/orders');
    },
  );

  it('new_order_owner keeps its dashboard link', async () => {
    const { service, templates } = build({
      settings: { no_customer_accounts: true },
    });
    await service.dispatchOrderEmail('o1', 'new_order_owner');
    const vars = renderedVars(templates);
    expect(vars.order_url).toBe(ADMIN_URL);
    expect(vars.order_button).toContain(`href="${ADMIN_URL}"`);
    expect(vars.order_url_text).toContain(ADMIN_URL);
  });

  it('extensions (invoices app) get an empty order URL', async () => {
    const { service } = build({ settings: { no_customer_accounts: true } });
    const vars = jest.fn(() => Promise.resolve({}));
    const ext: OrderMailExtension = { vars };
    service.registerOrderMailExtension(ext);
    await service.dispatchOrderEmail('o1', 'order_confirmation');
    expect(vars).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'o1' }),
      'order_confirmation',
      'sv',
      { orderUrl: '' },
    );
  });

  it('template preview: real-order and made-up samples have no link', async () => {
    for (const noOrders of [false, true]) {
      const { internals } = build({
        settings: { no_customer_accounts: true },
        noOrders,
      });
      const vars = (await internals.sampleTemplateVars(
        'order_confirmation',
        'sv',
        's1',
      )) as Record<string, string>;
      expect(vars.order_url).toBe('');
      expect(vars.order_button).toBe('');
      expect(vars.order_url_text).toBe('');

      const owner = (await internals.sampleTemplateVars(
        'new_order_owner',
        'sv',
        's1',
      )) as Record<string, string>;
      expect(owner.order_url).toContain('/creator/orders');
      expect(owner.order_button).toContain('/creator/orders');
    }
  });
});

describe('order emails of every other store are unchanged', () => {
  const button = `<p style="margin:20px 0;"><a href="${ORDER_URL}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 20px;border-radius:8px;">Visa din beställning</a></p>`;

  it.each([
    ['no settings column value', undefined],
    ['NULL settings', null],
    ['other settings', { phone_required: true, external_site_url: 'https://example.se/' }],
    ['flag stored as false', { no_customer_accounts: false }],
  ])('%s: the former link strings', async (_label, settings) => {
    for (const event of CUSTOMER_EVENTS) {
      const { service, templates } = build({ settings });
      await service.dispatchOrderEmail('o1', event, EXTRA);
      const vars = renderedVars(templates);
      expect(vars.order_url).toBe(ORDER_URL);
      expect(vars.order_button).toBe(button);
      expect(vars.order_url_text).toBe(
        `\n\nVisa din beställning: ${ORDER_URL}`,
      );
    }
  });

  it('the bundled fallback still links to the account order page', async () => {
    const { service, sendMail } = build({ noTemplate: true });
    await service.dispatchOrderEmail('o1', 'order_confirmation');
    const message = sendMail.mock.calls[0][0];
    expect(message.html).toContain(ORDER_URL);
    expect(message.text).toContain(ORDER_URL);
  });

  it('extensions get the order URL; the made-up preview keeps its link', async () => {
    const { service, internals } = build({ noOrders: true });
    const vars = jest.fn(() => Promise.resolve({}));
    service.registerOrderMailExtension({ vars });
    await service.dispatchOrderEmail('o1', 'order_confirmation');
    expect(vars).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'o1' }),
      'order_confirmation',
      'sv',
      { orderUrl: ORDER_URL },
    );
    const sample = (await internals.sampleTemplateVars(
      'order_confirmation',
      'sv',
      's1',
    )) as Record<string, string>;
    expect(sample.order_url).toBe(
      'http://localhost:3003/store/prima/account/orders',
    );
  });
});

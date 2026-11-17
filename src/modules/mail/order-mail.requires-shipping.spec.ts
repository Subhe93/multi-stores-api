import type { ConfigService } from '@nestjs/config';
import { MailService } from './mail.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CryptoService } from '../../common/crypto/crypto.service';
import { NotificationTemplatesService } from '../notification-templates/notification-templates.service';
import type { OrderEmailEvent } from './order-mail.helpers';
import { orderDeliveredEmail, orderFulfilledEmail } from './templates';
import {
  buildPlatformEmailTemplates,
  PLATFORM_EMAIL_LOCALES,
} from '../../../prisma/platform-email-templates';

// Orders that required no shipping (services / digital products): every
// order email gets an empty delivery address and the address under
// `billing_address_*` instead, and fulfilment sends the neutral
// `order_fulfilled` email. Orders that require shipping (also every order
// placed before the column existed) render exactly as before.

type Internals = Record<string, (...args: unknown[]) => Promise<unknown>>;

const ADDRESS = {
  full_name: 'Anna Lind',
  line1: 'Storgatan 12',
  line2: null,
  city: 'Stockholm',
  state: null,
  postal_code: '111 23',
  country_code: 'SE',
  phone: null,
};

function emailOrder(requiresShipping?: boolean) {
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
    // Absent = an order row read before the column existed.
    ...(requiresShipping === undefined
      ? {}
      : { requires_shipping: requiresShipping }),
    customer: {
      id: 'c1',
      first_name: 'Anna',
      last_name: 'Lind',
      user: { email: 'anna@example.com' },
    },
    address: ADDRESS,
    items: [],
  };
}

function build(
  opts: {
    requiresShipping?: boolean;
    noTemplate?: boolean;
    noOrders?: boolean;
  } = {},
) {
  const prisma = {
    order: {
      findUnique: jest.fn(() =>
        Promise.resolve(emailOrder(opts.requiresShipping)),
      ),
      findFirst: jest.fn(() =>
        Promise.resolve(opts.noOrders ? null : { id: 'o1' }),
      ),
    },
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 's1',
          slug: 'prima',
          name: 'Prima',
          custom_domain: null,
          logo_url: null,
          notification_email: null,
          currency: 'SEK',
          language_config: { primary_locale: 'en' },
          creator: { user: { email: 'owner@example.com' } },
        }),
      ),
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
    storeLanguageConfig: {
      findUnique: jest.fn(() => Promise.resolve({ primary_locale: 'en' })),
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
  const sendMail = jest.fn(
    (_message: { subject: string; html: string; text: string }) =>
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
  const logDelivery = jest
    .spyOn(internals, 'logDelivery')
    .mockResolvedValue(undefined);
  return { service, prisma, templates, sendMail, logDelivery };
}

const renderCall = (templates: { render: jest.Mock }) =>
  templates.render.mock.calls[0] as [string, string, Record<string, string>];

const ADDRESS_HTML = 'Anna Lind<br />Storgatan 12<br />111 23 Stockholm';

const EVENTS: OrderEmailEvent[] = [
  'order_confirmation',
  'order_shipped',
  'order_delivered',
  'order_fulfilled',
  'order_cancelled',
  'order_refunded',
  'new_order_owner',
];

describe('address variables of the order emails', () => {
  it.each(EVENTS)(
    '%s, order without shipping: no delivery address, billing address instead',
    async (event) => {
      const { service, templates } = build({ requiresShipping: false });
      await service.dispatchOrderEmail('o1', event);
      const vars = renderCall(templates)[2];
      expect(vars.shipping_address_html).toBe('');
      expect(vars.shipping_address_text).toBe('');
      expect(vars.billing_address_html).toContain(ADDRESS_HTML);
      expect(vars.billing_address_text).toContain(
        'Anna Lind\nStorgatan 12\n111 23 Stockholm',
      );
    },
  );

  it.each([
    ['column true', true],
    ['column missing (order before the migration)', undefined],
  ])(
    'order that requires shipping (%s): delivery address as before, billing empty',
    async (_label, flag) => {
      const { service, templates } = build({ requiresShipping: flag });
      await service.dispatchOrderEmail('o1', 'order_confirmation');
      const vars = renderCall(templates)[2];
      expect(vars.shipping_address_html).toContain(ADDRESS_HTML);
      expect(vars.shipping_address_text).toContain(
        'Anna Lind\nStorgatan 12\n111 23 Stockholm',
      );
      expect(vars.billing_address_html).toBe('');
      expect(vars.billing_address_text).toBe('');
    },
  );

  it('the delivery address string is identical with and without the column', async () => {
    const before = build({});
    await before.service.dispatchOrderEmail('o1', 'order_confirmation');
    const after = build({ requiresShipping: true });
    await after.service.dispatchOrderEmail('o1', 'order_confirmation');
    const a = renderCall(before.templates)[2];
    const b = renderCall(after.templates)[2];
    expect(b.shipping_address_html).toBe(a.shipping_address_html);
    expect(b.shipping_address_text).toBe(a.shipping_address_text);
  });
});

describe('order_fulfilled email', () => {
  it('renders the order_fulfilled template with the delivered variables', async () => {
    const { service, templates, sendMail, logDelivery } = build({
      requiresShipping: false,
    });
    await service.dispatchOrderEmail('o1', 'order_fulfilled');
    const [event, , vars] = renderCall(templates);
    expect(event).toBe('order_fulfilled');
    expect(vars).toMatchObject({
      store_name: 'Prima',
      order_number: 'MS-1',
      items_html: expect.any(String) as string,
      items_text: expect.any(String) as string,
    });
    expect(vars).toHaveProperty('order_button');
    expect(vars).toHaveProperty('order_url_text');
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0]).toMatchObject({
      to: 'anna@example.com',
      subject: 'Subject',
    });
    expect(JSON.stringify(logDelivery.mock.calls)).toContain('order_fulfilled');
  });

  it('without a stored template the bundled builder sends the mail', async () => {
    const { service, sendMail } = build({
      requiresShipping: false,
      noTemplate: true,
    });
    await service.dispatchOrderEmail('o1', 'order_fulfilled');
    expect(sendMail).toHaveBeenCalledTimes(1);
    const message = sendMail.mock.calls[0][0];
    expect(message.subject).toBe('Your order MS-1 is complete');
    expect(message.html).toContain('Your order is complete');
    expect(message.html).toContain(
      'Your order <strong>MS-1</strong> has been completed. Thank you for your purchase.',
    );
    expect(message.text).toContain('Your order MS-1 is complete.');
    expect(message.html).not.toMatch(/deliver/i);
  });

  it('carries the attachments of the extensions (COD invoice on fulfilment)', async () => {
    const { service, sendMail } = build({ requiresShipping: false });
    const onSent = jest.fn(() => Promise.resolve());
    const attachments = jest.fn(() =>
      Promise.resolve({
        files: [
          {
            filename: 'invoice.pdf',
            content: Buffer.from('pdf'),
            contentType: 'application/pdf',
          },
        ],
        onSent,
      }),
    );
    service.registerOrderMailExtension({ attachments } as never);
    await service.dispatchOrderEmail('o1', 'order_fulfilled');
    expect(attachments).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'o1' }),
      'order_fulfilled',
    );
    expect(
      (sendMail.mock.calls[0][0] as unknown as { attachments: unknown[] })
        .attachments,
    ).toHaveLength(1);
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it('the bundled builder mirrors the delivered one except for the wording', () => {
    const data = {
      orderNumber: 'MS-1',
      orderUrl: 'https://shop.example.com/account/orders/o1',
      itemsHtml: '<table></table>',
      itemsText: '- Course x 1',
    };
    const fulfilled = orderFulfilledEmail(data);
    const delivered = orderDeliveredEmail(data);
    expect(fulfilled.subject).toBe('Your order MS-1 is complete');
    expect(fulfilled.text).toBe(
      'Your order MS-1 is complete.\n\n- Course x 1\n\nView order: https://shop.example.com/account/orders/o1',
    );
    expect(fulfilled.html).toContain('<table></table>');
    expect(fulfilled.html).toContain(
      'href="https://shop.example.com/account/orders/o1"',
    );
    // The delivered email itself is untouched.
    expect(delivered.subject).toBe('Your order MS-1 has been delivered');
  });
});

describe('order_fulfilled in the template registry', () => {
  const catalog = NotificationTemplatesService.EVENT_CATALOG;
  const entry = (event: string) => catalog.find((e) => e.event === event);

  it('is a known event with the variables of order_delivered', () => {
    expect(entry('order_fulfilled')).toBeDefined();
    expect(entry('order_fulfilled')?.variables).toEqual(
      entry('order_delivered')?.variables,
    );
  });

  it('every order event lists the billing address variables', () => {
    for (const event of EVENTS) {
      expect(entry(event)?.variables).toEqual(
        expect.arrayContaining([
          'shipping_address_html',
          'shipping_address_text',
          'billing_address_html',
          'billing_address_text',
        ]),
      );
    }
  });

  it('platform template: six locales, the agreed English copy, the delivered markup', () => {
    const all = buildPlatformEmailTemplates();
    const fulfilled = all.order_fulfilled;
    expect(Object.keys(fulfilled).sort()).toEqual(
      [...PLATFORM_EMAIL_LOCALES].sort(),
    );
    expect(fulfilled.en.subject).toBe(
      'Your order {{order_number}} is complete',
    );
    expect(fulfilled.en.body_html).toContain('Your order is complete');
    expect(fulfilled.en.body_html).toContain(
      'Your order <strong>{{order_number}}</strong> has been completed. Thank you for your purchase.',
    );
    expect(fulfilled.en.body_text).toBe(
      'Your order {{order_number}} is complete.\n{{items_text}}{{order_url_text}}',
    );
    for (const loc of PLATFORM_EMAIL_LOCALES) {
      const t = fulfilled[loc];
      expect(t.subject).toContain('{{order_number}}');
      expect(t.body_html).toContain('{{items_html}}');
      expect(t.body_html).toContain('{{order_button}}');
      expect(t.body_text).toContain('{{items_text}}{{order_url_text}}');
      // No translation silently falls back to English.
      if (loc !== 'en') expect(t.subject).not.toBe(fulfilled.en.subject);
    }
    // order_delivered keeps its own copy.
    expect(all.order_delivered.en.subject).toBe(
      'Your order {{order_number}} has been delivered',
    );
  });
});

describe('template sample of order_fulfilled', () => {
  const draft = {
    subject: 'S',
    body_html: 'B[{{billing_address_html}}] S[{{shipping_address_html}}]',
    body_text: 'B[{{billing_address_text}}] S[{{shipping_address_text}}]',
  };

  it('order_fulfilled: sample billing address, no delivery address', async () => {
    const { service } = build({ noOrders: true });
    const out = await service.renderTemplateSample({
      event: 'order_fulfilled',
      locale: 'en',
      ...draft,
    });
    expect(out.html).toBe(
      'B[Anna Lindqvist<br />Storgatan 12<br />111 23 Stockholm] S[]',
    );
    expect(out.text).toBe(
      'B[Anna Lindqvist\nStorgatan 12\n111 23 Stockholm] S[]',
    );
  });

  it('every other event: the former delivery sample, empty billing', async () => {
    const { service } = build({ noOrders: true });
    const out = await service.renderTemplateSample({
      event: 'order_delivered',
      locale: 'en',
      ...draft,
    });
    expect(out.html).toBe(
      'B[] S[Anna Lindqvist<br />Storgatan 12<br />111 23 Stockholm]',
    );
    expect(out.text).toBe(
      'B[] S[Anna Lindqvist\nStorgatan 12\n111 23 Stockholm]',
    );
  });
});

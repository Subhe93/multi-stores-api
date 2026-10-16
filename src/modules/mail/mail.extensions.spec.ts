import type { ConfigService } from '@nestjs/config';
import { MailService } from './mail.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CryptoService } from '../../common/crypto/crypto.service';
import type { NotificationTemplatesService } from '../notification-templates/notification-templates.service';
import type { OrderMailExtension } from './order-mail.helpers';
import { InvoicesMailExtension } from '../invoices/invoices-mail.extension';
import { PdfUnavailableError } from '../invoices/pdf/pdf-renderer';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { InvoicePdfService } from '../invoices/pdf/invoice-pdf.service';
import type { LegalProfileService } from '../invoices/legal-profile.service';

// The order-email extension seam (M3 D6, §3.5): attachments reach nodemailer
// only when there are some (otherwise its arguments are exactly the
// pre-seam ones), extension variables are merged without overriding core
// ones, onSent runs only after a successful send, and a failing extension
// never stops the email.

type Internals = Record<string, (...args: unknown[]) => Promise<unknown>>;

const INVOICE_KEYS = [
  'invoice_number',
  'credit_note_number',
  'invoice_url',
  'seller_block_html',
  'seller_block_text',
  'seller_legal_line',
];

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

function build(opts: { sendFails?: boolean } = {}) {
  const prisma = {
    order: { findUnique: jest.fn(() => Promise.resolve(emailOrder())) },
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 's1',
          slug: 'namez',
          name: 'Namez',
          custom_domain: null,
          logo_url: null,
          notification_email: null,
          language_config: { primary_locale: 'sv' },
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
      findFirst: jest.fn(() => Promise.resolve({ platform_name: 'Namez AB' })),
    },
    invoice: {
      findMany: jest.fn((): Promise<unknown[]> => Promise.resolve([])),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
  };
  const templates = {
    render: jest.fn(() =>
      Promise.resolve({
        subject: 'Subject',
        html: '<p>Body</p>',
        text: 'Body',
      }),
    ),
  };
  const service = new MailService(
    { get: () => undefined } as unknown as ConfigService,
    prisma as unknown as PrismaService,
    {} as CryptoService,
    templates as unknown as NotificationTemplatesService,
  );
  const sendMail = jest.fn(() =>
    opts.sendFails
      ? Promise.reject(new Error('smtp down'))
      : Promise.resolve({}),
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
  return { service, prisma, templates, sendMail };
}

const renderedVars = (templates: { render: jest.Mock }) =>
  (templates.render.mock.calls[0] as unknown[])[2] as Record<string, string>;

const pdfBuffer = Buffer.from('%PDF-1.7 test');

describe('MailService.send attachments', () => {
  it('without attachments nodemailer gets exactly the pre-seam arguments', async () => {
    const { service, sendMail } = build();
    await service.send({
      to: 'a@x.se',
      subject: 'S',
      html: '<p>h</p>',
      text: 't',
    });
    await service.send({
      to: 'a@x.se',
      subject: 'S',
      html: '<p>h</p>',
      text: 't',
      attachments: [],
    });
    for (const call of sendMail.mock.calls) {
      expect((call as unknown[])[0]).toEqual({
        from: 'shop@example.com',
        to: 'a@x.se',
        subject: 'S',
        html: '<p>h</p>',
        text: 't',
      });
      expect('attachments' in ((call as unknown[])[0] as object)).toBe(false);
    }
  });

  it('with attachments they are forwarded', async () => {
    const { service, sendMail } = build();
    const files = [
      {
        filename: 'Faktura-1001.pdf',
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ];
    await service.send({
      to: 'a@x.se',
      subject: 'S',
      html: 'h',
      attachments: files,
    });
    expect((sendMail.mock.calls[0] as unknown[])[0]).toMatchObject({
      attachments: files,
    });
  });
});

describe('MailService order email extensions', () => {
  it('no extension: no invoice variables, no attachments key', async () => {
    const { service, templates, sendMail } = build();
    await service.dispatchOrderEmail('o1', 'order_confirmation');
    const vars = renderedVars(templates);
    for (const key of INVOICE_KEYS) expect(key in vars).toBe(false);
    expect(
      'attachments' in ((sendMail.mock.calls[0] as unknown[])[0] as object),
    ).toBe(false);
  });

  it('extension: vars merged (core ones win), attachments forwarded, onSent after the send', async () => {
    const { service, templates, sendMail } = build();
    const onSent = jest.fn(() => Promise.resolve());
    const vars = jest.fn(() =>
      Promise.resolve({ invoice_number: '1001', customer_name: 'Hijack' }),
    );
    const ext: OrderMailExtension = {
      vars,
      attachments: jest.fn(() =>
        Promise.resolve({
          files: [
            {
              filename: 'Faktura-1001.pdf',
              content: pdfBuffer,
              contentType: 'application/pdf',
            },
          ],
          onSent,
        }),
      ),
    };
    service.registerOrderMailExtension(ext);
    await service.dispatchOrderEmail('o1', 'order_confirmation');

    const rendered = renderedVars(templates);
    expect(rendered.invoice_number).toBe('1001');
    expect(rendered.customer_name).toBe('Anna Lind');
    expect(vars).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'o1' }),
      'order_confirmation',
      'sv',
      { orderUrl: 'http://localhost:3003/store/namez/account/orders/o1' },
    );
    expect((sendMail.mock.calls[0] as unknown[])[0]).toMatchObject({
      attachments: [expect.objectContaining({ filename: 'Faktura-1001.pdf' })],
    });
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onSent.mock.invocationCallOrder[0]).toBeGreaterThan(
      sendMail.mock.invocationCallOrder[0],
    );
  });

  it('a failed send never calls onSent', async () => {
    const { service } = build({ sendFails: true });
    const onSent = jest.fn(() => Promise.resolve());
    service.registerOrderMailExtension({
      attachments: () =>
        Promise.resolve({
          files: [
            {
              filename: 'a.pdf',
              content: pdfBuffer,
              contentType: 'application/pdf',
            },
          ],
          onSent,
        }),
    });
    await service.dispatchOrderEmail('o1', 'order_delivered');
    expect(onSent).not.toHaveBeenCalled();
  });

  it('a throwing extension never stops the email', async () => {
    const { service, sendMail } = build();
    service.registerOrderMailExtension({
      vars: () => Promise.reject(new Error('vars boom')),
      attachments: () => Promise.reject(new Error('attach boom')),
    });
    await service.dispatchOrderEmail('o1', 'order_refunded');
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(
      'attachments' in ((sendMail.mock.calls[0] as unknown[])[0] as object),
    ).toBe(false);
  });

  it('events without documents (shipped, owner) never ask for attachments', async () => {
    const { service } = build();
    const attachments = jest.fn(() => Promise.resolve(null));
    service.registerOrderMailExtension({ attachments });
    await service.dispatchOrderEmail('o1', 'order_shipped');
    await service.dispatchOrderEmail('o1', 'new_order_owner');
    expect(attachments).not.toHaveBeenCalled();
  });
});

describe('InvoicesMailExtension through MailService', () => {
  function withInvoices(opts: {
    enabled: boolean;
    pdf: () => Promise<unknown>;
  }) {
    const b = build();
    const storeApps = {
      isEnabled: jest.fn(() => Promise.resolve(opts.enabled)),
      getSettings: jest.fn(() => Promise.resolve(opts.enabled ? {} : null)),
    };
    const pdf = { getPdf: jest.fn(opts.pdf) };
    const ext = new InvoicesMailExtension(
      b.service,
      b.prisma as unknown as PrismaService,
      storeApps as unknown as StoreAppsService,
      pdf as unknown as InvoicePdfService,
      {
        find: jest.fn(() => Promise.resolve(null)),
      } as unknown as LegalProfileService,
    );
    ext.onModuleInit();
    return { ...b, storeApps, pdf };
  }

  it('app off: empty variables, no invoice query, nodemailer args unchanged', async () => {
    const plain = build();
    await plain.service.dispatchOrderEmail('o1', 'order_confirmation');

    const b = withInvoices({
      enabled: false,
      pdf: () => Promise.resolve(null),
    });
    await b.service.dispatchOrderEmail('o1', 'order_confirmation');
    const vars = renderedVars(b.templates);
    for (const key of INVOICE_KEYS) expect(vars[key]).toBe('');
    expect(b.prisma.invoice.findMany).not.toHaveBeenCalled();
    expect(b.pdf.getPdf).not.toHaveBeenCalled();
    expect(b.sendMail.mock.calls[0]).toEqual(plain.sendMail.mock.calls[0]);
  });

  it('PDF unavailable: the email still goes, without attachment, emailed_at untouched', async () => {
    const b = withInvoices({
      enabled: true,
      pdf: () => Promise.reject(new PdfUnavailableError('no browser')),
    });
    b.prisma.invoice.findMany.mockResolvedValue([
      { id: 'inv1', number: '1001', kind: 'INVOICE', snapshot: {} },
    ]);
    await b.service.dispatchOrderEmail('o1', 'order_confirmation');
    expect(b.sendMail).toHaveBeenCalledTimes(1);
    expect(
      'attachments' in ((b.sendMail.mock.calls[0] as unknown[])[0] as object),
    ).toBe(false);
    expect(b.prisma.invoice.updateMany).not.toHaveBeenCalled();
  });

  it('PDF available: attached and emailed_at set after the send', async () => {
    const b = withInvoices({
      enabled: true,
      pdf: () =>
        Promise.resolve({ buffer: pdfBuffer, filename: 'Faktura-1001.pdf' }),
    });
    b.prisma.invoice.findMany.mockResolvedValue([
      { id: 'inv1', number: '1001', kind: 'INVOICE', snapshot: {} },
    ]);
    await b.service.dispatchOrderEmail('o1', 'order_confirmation');
    expect((b.sendMail.mock.calls[0] as unknown[])[0]).toMatchObject({
      attachments: [
        {
          filename: 'Faktura-1001.pdf',
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });
    expect(b.prisma.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['inv1'] }, emailed_at: null },
      data: { emailed_at: expect.any(Date) as Date },
    });
  });
});

describe('MailService order email itemImages (M4.2 WP10)', () => {
  const item = {
    id: 'i1',
    quantity: 1,
    unit_price: 100,
    product: {
      translations: [{ locale: 'sv', title: 'Skylt' }],
      images: [{ url: '/uploads/p.webp' }],
    },
    variant: null,
    custom_product: null,
    custom_field_values: [],
  };

  it('an extension image replaces the line image; a failing one is skipped', async () => {
    const plain = build();
    plain.prisma.order.findUnique.mockResolvedValue({
      ...emailOrder(),
      items: [item],
    } as never);
    await plain.service.dispatchOrderEmail('o1', 'order_confirmation');
    const before = renderedVars(plain.templates).items_html;
    expect(before).toContain('/uploads/p.webp');

    const t = build();
    t.prisma.order.findUnique.mockResolvedValue({
      ...emailOrder(),
      items: [item],
    } as never);
    t.service.registerOrderMailExtension({
      itemImages: () => Promise.reject(new Error('images boom')),
    } as OrderMailExtension);
    t.service.registerOrderMailExtension({
      itemImages: () =>
        Promise.resolve({ i1: 'https://api.example/api/designer/files/t' }),
    } as OrderMailExtension);
    await t.service.dispatchOrderEmail('o1', 'order_confirmation');
    const html = renderedVars(t.templates).items_html;
    expect(html).toContain('https://api.example/api/designer/files/t');
    expect(html).not.toContain('/uploads/p.webp');
    expect(t.sendMail).toHaveBeenCalled();
  });

  it('extensions without images leave the items block unchanged', async () => {
    const a = build();
    a.prisma.order.findUnique.mockResolvedValue({
      ...emailOrder(),
      items: [item],
    } as never);
    await a.service.dispatchOrderEmail('o1', 'order_confirmation');
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue({
      ...emailOrder(),
      items: [item],
    } as never);
    b.service.registerOrderMailExtension({
      itemImages: () => Promise.resolve({}),
    } as OrderMailExtension);
    await b.service.dispatchOrderEmail('o1', 'order_confirmation');
    expect(renderedVars(b.templates).items_html).toBe(
      renderedVars(a.templates).items_html,
    );
  });
});

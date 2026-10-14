import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { MailService } from '../mail/mail.service';
import type { OrderForEmail } from '../mail/order-mail.helpers';
import type { LegalProfileService } from './legal-profile.service';
import type { InvoicePdfService } from './pdf/invoice-pdf.service';
import { PdfUnavailableError } from './pdf/pdf-renderer';
import {
  INVOICE_MAIL_VARS,
  InvoicesMailExtension,
  emailPdfBudgetMs,
  renderSellerBlock,
} from './invoices-mail.extension';
import type { InvoiceSeller } from './invoices.types';

// The invoices app's order-email extension (§3.5): variables and PDF
// attachments, empty / null without the app or before anything is issued.

const seller: InvoiceSeller = {
  legal_name: 'Neronet Academy <AB>',
  brand_name: 'Swedags',
  org_number: '556036-0793',
  vat_number: 'SE556036079301',
  address: {
    line1: 'Storgatan 1',
    line2: null,
    postal_code: '11122',
    city: 'Stockholm',
    country_code: 'SE',
  },
  registered_office: 'Stockholm',
  email: 'info@namz.se',
  phone: null,
  website: 'https://namz.se',
  f_tax_approved: true,
  logo_url: null,
  footer_note: null,
};

const order = {
  id: 'o1',
  store_id: 's1',
  storeCtx: { id: 's1', slug: 'namez', name: 'Namez' },
} as unknown as OrderForEmail;

const ctx = { orderUrl: 'https://namz.se/account/orders/o1' };

function build(opts: {
  enabled: boolean;
  settings?: Record<string, unknown>;
  docs?: unknown[];
  pdf?: (id: string) => Promise<unknown>;
}) {
  const prisma = {
    invoice: {
      findMany: jest.fn(() => Promise.resolve(opts.docs ?? [])),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
  };
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(opts.enabled)),
    getSettings: jest.fn(() =>
      Promise.resolve(opts.enabled ? (opts.settings ?? {}) : null),
    ),
  };
  const pdf = {
    getPdf: jest.fn(
      opts.pdf ??
        ((id: string) =>
          Promise.resolve({ buffer: Buffer.from(id), filename: `${id}.pdf` })),
    ),
  };
  const mail = { registerOrderMailExtension: jest.fn() };
  const legal = { find: jest.fn(() => Promise.resolve(null)) };
  const ext = new InvoicesMailExtension(
    mail as unknown as MailService,
    prisma as unknown as PrismaService,
    storeApps as unknown as StoreAppsService,
    pdf as unknown as InvoicePdfService,
    legal as unknown as LegalProfileService,
  );
  return { ext, prisma, storeApps, pdf, mail };
}

const allEmpty = Object.fromEntries(INVOICE_MAIL_VARS.map((k) => [k, '']));

describe('InvoicesMailExtension', () => {
  it('registers itself with MailService', () => {
    const b = build({ enabled: false });
    b.ext.onModuleInit();
    expect(b.mail.registerOrderMailExtension).toHaveBeenCalledWith(b.ext);
  });

  it('app off: empty strings and no Prisma call', async () => {
    const b = build({ enabled: false });
    expect(await b.ext.vars(order, 'order_confirmation', 'sv', ctx)).toEqual(
      allEmpty,
    );
    expect(await b.ext.attachments(order, 'order_confirmation')).toBeNull();
    expect(b.prisma.invoice.findMany).not.toHaveBeenCalled();
    expect(b.storeApps.getSettings).not.toHaveBeenCalled();
  });

  it('no store: empty strings without even an isEnabled call', async () => {
    const b = build({ enabled: true });
    const noStore = { ...order, store_id: null } as unknown as OrderForEmail;
    expect(await b.ext.vars(noStore, 'order_confirmation', 'sv', ctx)).toEqual(
      allEmpty,
    );
    expect(b.storeApps.isEnabled).not.toHaveBeenCalled();
  });

  it('app on, nothing issued: empty strings', async () => {
    const b = build({ enabled: true });
    expect(await b.ext.vars(order, 'order_confirmation', 'sv', ctx)).toEqual(
      allEmpty,
    );
  });

  it('invoice + credit note: numbers, account link, seller block (escaped)', async () => {
    const b = build({
      enabled: true,
      docs: [
        { kind: 'INVOICE', number: 'INV<1001>', snapshot: { seller } },
        { kind: 'CREDIT_NOTE', number: 'CN-1', snapshot: { seller } },
        { kind: 'CREDIT_NOTE', number: 'CN-2', snapshot: { seller } },
      ],
    });
    const vars = await b.ext.vars(order, 'order_refunded', 'sv', ctx);
    expect(vars.invoice_number).toBe('INV<1001>');
    expect(vars['html:invoice_number']).toBe('INV&lt;1001&gt;');
    expect(vars.credit_note_number).toBe('CN-2');
    expect(vars.invoice_url).toBe('https://namz.se/account/orders/o1#invoices');
    expect(vars.seller_legal_line).toBe(
      'Neronet Academy <AB> · Org.nr 556036-0793 · Momsreg.nr SE556036079301',
    );
    expect(vars['html:seller_legal_line']).toContain(
      'Neronet Academy &lt;AB&gt;',
    );
    expect(vars.seller_block_html).toContain(
      'Neronet Academy &lt;AB&gt;<br />',
    );
    expect(vars.seller_block_html).toContain('Godkänd för F-skatt');
    expect(vars.seller_block_text.split('\n')).toEqual([
      'Neronet Academy <AB>',
      'Storgatan 1',
      '11122 Stockholm',
      'Sverige',
      'Org.nr 556036-0793',
      'Momsreg.nr SE556036079301',
      'Säte: Stockholm',
      'Godkänd för F-skatt',
      'info@namz.se · https://namz.se',
    ]);
  });

  it('renderSellerBlock omits what the seller left empty', () => {
    const block = renderSellerBlock(
      {
        ...seller,
        legal_name: 'Solo AB',
        vat_number: null,
        registered_office: null,
        f_tax_approved: false,
        email: null,
        website: null,
      },
      'en',
    );
    expect(block.legalLine).toBe('Solo AB · Org. no. 556036-0793');
    expect(block.lines).not.toContain('Approved for F-tax');
  });

  it('attachments: every unemailed document, onSent stamps exactly those', async () => {
    const b = build({
      enabled: true,
      docs: [
        { id: 'inv1', number: '1001' },
        { id: 'cn1', number: 'CN-1' },
      ],
    });
    const res = await b.ext.attachments(order, 'order_refunded');
    expect(b.prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { order_id: 'o1', emailed_at: null },
      }),
    );
    expect(res?.files.map((f) => f.filename)).toEqual(['inv1.pdf', 'cn1.pdf']);
    expect(res?.files[0].contentType).toBe('application/pdf');
    await res?.onSent?.();
    expect(b.prisma.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['inv1', 'cn1'] }, emailed_at: null },
      data: { emailed_at: expect.any(Date) as Date },
    });
  });

  it('attachments: a failing PDF is left out, the others still go', async () => {
    const b = build({
      enabled: true,
      docs: [
        { id: 'inv1', number: '1001' },
        { id: 'cn1', number: 'CN-1' },
      ],
      pdf: (id) =>
        id === 'inv1'
          ? Promise.reject(new PdfUnavailableError('no browser'))
          : Promise.resolve({ buffer: Buffer.from('x'), filename: 'cn.pdf' }),
    });
    const res = await b.ext.attachments(order, 'order_refunded');
    expect(res?.files.map((f) => f.filename)).toEqual(['cn.pdf']);
    await res?.onSent?.();
    expect(b.prisma.invoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['cn1'] }, emailed_at: null },
      }),
    );
  });

  it('attachments: all PDFs failing → null (email goes without attachment)', async () => {
    const b = build({
      enabled: true,
      docs: [{ id: 'inv1', number: '1001' }],
      pdf: () => Promise.reject(new PdfUnavailableError('off')),
    });
    expect(await b.ext.attachments(order, 'order_confirmation')).toBeNull();
  });

  it('attachments: attach_pdf_to_email=false → null, no invoice query', async () => {
    const b = build({
      enabled: true,
      settings: { attach_pdf_to_email: false },
      docs: [{ id: 'inv1', number: '1001' }],
    });
    expect(await b.ext.attachments(order, 'order_confirmation')).toBeNull();
    expect(b.prisma.invoice.findMany).not.toHaveBeenCalled();
  });

  describe('attachments: rendering time budget (INVOICE_EMAIL_PDF_BUDGET_MS)', () => {
    const saved = process.env.INVOICE_EMAIL_PDF_BUDGET_MS;
    afterEach(() => {
      if (saved === undefined) delete process.env.INVOICE_EMAIL_PDF_BUDGET_MS;
      else process.env.INVOICE_EMAIL_PDF_BUDGET_MS = saved;
    });

    it('defaults to 8000 ms', () => {
      delete process.env.INVOICE_EMAIL_PDF_BUDGET_MS;
      expect(emailPdfBudgetMs()).toBe(8000);
      process.env.INVOICE_EMAIL_PDF_BUDGET_MS = 'abc';
      expect(emailPdfBudgetMs()).toBe(8000);
    });

    it('a slow renderer misses the budget: email goes without it, doc stays unemailed', async () => {
      process.env.INVOICE_EMAIL_PDF_BUDGET_MS = '50';
      const b = build({
        enabled: true,
        docs: [
          { id: 'fast', number: '1001' },
          { id: 'slow', number: 'CN-1' },
        ],
        pdf: (id) =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ buffer: Buffer.from(id), filename: `${id}.pdf` }),
              id === 'slow' ? 400 : 0,
            ),
          ),
      });
      const started = Date.now();
      const res = await b.ext.attachments(order, 'order_refunded');
      expect(Date.now() - started).toBeLessThan(300);
      expect(res?.files.map((f) => f.filename)).toEqual(['fast.pdf']);
      await res?.onSent?.();
      expect(b.prisma.invoice.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['fast'] }, emailed_at: null },
        }),
      );
    });

    it('nothing ready in time → null (no attachment at all)', async () => {
      process.env.INVOICE_EMAIL_PDF_BUDGET_MS = '20';
      const b = build({
        enabled: true,
        docs: [{ id: 'slow', number: '1001' }],
        pdf: () => new Promise((resolve) => setTimeout(resolve, 300)),
      });
      expect(await b.ext.attachments(order, 'order_confirmation')).toBeNull();
    });
  });
});

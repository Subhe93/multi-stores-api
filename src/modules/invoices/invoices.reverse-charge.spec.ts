import {
  buildCreditSnapshot,
  buildInvoiceSnapshot,
  snapshotInvariantErrors,
  withNumber,
  type SnapshotOrder,
} from './invoice-snapshot.builder';
import { InvoicesService } from './invoices.service';
import { InvoiceNumberingService } from './invoice-numbering.service';
import { LegalProfileService } from './legal-profile.service';
import { profileCompleteness } from './legal-profile.util';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { InvoicePdfService } from './pdf/invoice-pdf.service';
import {
  completeProfile,
  makeFakePrisma,
  paidOrder,
} from './fake-invoices-prisma.mockspec';
import {
  INVOICE_TEMPLATE_VERSION,
  type InvoiceSnapshot,
} from './invoices.types';
import {
  INVOICE_PHRASES,
  PDF_LOCALES,
  getInvoicePhrases,
} from './pdf/invoice-phrases';
import { renderInvoiceHtml } from './pdf/invoice-template';
import { toSnapshotForPdf } from './pdf/snapshot-for-pdf';
import {
  sampleArPersonInvoice,
  sampleSvCompanyInvoice,
  sampleSvCreditNote,
  sampleSvReverseChargeInvoice,
} from './pdf/testing/sample-snapshots';

// b2b app M2.5 on invoices: the exemption block of the snapshot, credit
// notes inheriting it, the seller VAT requirement, the INSERT-only columns
// and the legal block of the PDF. Taxed documents must not change at all.

const EVIDENCE = {
  source: 'VIES',
  vat_number: 'DE123456789',
  country_code: 'DE',
  status: 'valid',
  valid: true,
  name: 'Muster GmbH',
  address: null,
  request_identifier: 'WAPIAAAAZ1x2y3',
  requester: 'SE556036079301',
  checked_at: '2026-10-15T09:12:00.000Z',
  check_id: 'chk-1',
  seller_country: 'SE',
  destination_country: 'DE',
  vat_country_matches_destination: true,
};

/** 125 SEK incl. 25 % netted to 100.00 + shipping 49 → 39.20, no VAT. */
function rcOrder(id = 'rc1', extra: Record<string, unknown> = {}) {
  return paidOrder(id, {
    total: 139.2,
    tax_amount: 0,
    tax_rate_bp: 0,
    tax_lines: [
      {
        label: 'Omvänd skattskyldighet',
        rate_bp: 0,
        taxable_amount: 139.2,
        tax_amount: 0,
        exempt_reason: 'REVERSE_CHARGE',
      },
    ],
    shipping_cost: 39.2,
    shipping_tax_rate_bp: 0,
    shipping_tax_amount: 0,
    shipping_method_name: 'DHL',
    customer_type: 'COMPANY',
    company_name: 'Muster GmbH',
    org_number: 'HRB 1234',
    // A differently formatted snapshot number: the validated one wins.
    vat_number: 'DE 123 456 789',
    tax_exempt_reason: 'REVERSE_CHARGE',
    vat_validation: EVIDENCE,
    address: {
      full_name: 'Max Muster',
      line1: 'Musterstr. 1',
      postal_code: '10115',
      city: 'Berlin',
      country_code: 'DE',
    },
    items: [
      {
        quantity: 1,
        unit_price: 100,
        total_price: 100,
        tax_rate_bp: 0,
        fulfiller_id: 'creator1',
        product: { sku: 'P1', translations: [{ locale: 'sv', title: 'Mugg' }] },
        variant: null,
        custom_product: null,
        custom_field_values: [],
      },
    ],
    ...extra,
  });
}

const SELLER = {
  legal_name: 'Neronet Academy AB',
  brand_name: null,
  org_number: '556036-0793',
  vat_number: 'SE556036079301',
  address: {
    line1: 'Storgatan 1',
    line2: null,
    postal_code: '11122',
    city: 'Stockholm',
    country_code: 'SE',
  },
  registered_office: null,
  email: null,
  phone: null,
  website: null,
  f_tax_approved: true,
  logo_url: null,
  footer_note: null,
};

function build(order: Record<string, unknown>, locale = 'sv') {
  return withNumber(
    buildInvoiceSnapshot({
      order: order as unknown as SnapshotOrder,
      seller: SELLER,
      bank: {
        bankgiro: '5050-1055',
        plusgiro: null,
        iban: null,
        bic: null,
        bank_name: null,
      },
      locale,
      issueDate: '2026-10-15',
      timezone: 'Europe/Stockholm',
      dueDays: 30,
      paid: true,
    }),
    'INV-7',
  );
}

describe('invoice snapshot: reverse charge', () => {
  it('RC order → 0 % row with exempt_reason, tax_exemption block, excl layout, invariants', () => {
    const s = build(rcOrder());
    expect(snapshotInvariantErrors(s)).toEqual([]);
    expect(s.template_version).toBe(2);
    expect(s.version).toBe(1);
    expect(s.vat_summary).toEqual([
      {
        label: 'Omvänd skattskyldighet',
        rate_bp: 0,
        net: 139.2,
        vat: 0,
        gross: 139.2,
        exempt_reason: 'REVERSE_CHARGE',
      },
    ]);
    expect(s.totals).toEqual({
      net: 139.2,
      vat: 0,
      gross: 139.2,
      layout: 'excl',
    });
    expect(s.buyer.vat_number).toBe('DE123456789');
    expect(s.tax_exemption).toEqual({
      reason: 'REVERSE_CHARGE',
      vat_number: 'DE123456789',
      buyer_country: 'DE',
      seller_vat_number: 'SE556036079301',
      legal_text_key: 'REVERSE_CHARGE_ART_138',
      vies: {
        request_identifier: 'WAPIAAAAZ1x2y3',
        checked_at: '2026-10-15T09:12:00.000Z',
        checked_on: '2026-10-15',
        name: 'Muster GmbH',
      },
    });
  });

  it('the VIES consultation day is the seller-local day (22:43Z -> next day in Stockholm)', () => {
    const s = build(
      rcOrder('late', {
        vat_validation: { ...EVIDENCE, checked_at: '2026-10-15T22:43:00.000Z' },
      }),
    );
    expect(s.tax_exemption?.vies).toMatchObject({
      checked_at: '2026-10-15T22:43:00.000Z',
      checked_on: '2026-10-16',
    });
    const html = renderInvoiceHtml(
      toSnapshotForPdf(s),
      getInvoicePhrases('sv'),
    );
    const block = html.slice(html.indexOf('<div class="exemption'));
    expect(block).toContain('2026-10-16');
    expect(block).not.toContain('2026-10-15');
  });

  it('the VIES consultation date falls back to checked_at for older snapshots', () => {
    const snap = rcSnapshot('sv');
    expect(snap.tax_exemption?.vies?.checked_on).toBeUndefined();
    const html = renderInvoiceHtml(
      toSnapshotForPdf(snap),
      getInvoicePhrases('sv'),
    );
    expect(html.slice(html.indexOf('<div class="exemption'))).toContain(
      '2026-10-15',
    );
  });

  it('a manual reverse-charge exemption has no VIES block', () => {
    const s = build(
      rcOrder('m1', {
        vat_validation: {
          ...EVIDENCE,
          source: 'MANUAL',
          request_identifier: null,
        },
      }),
    );
    expect(s.tax_exemption?.vies).toBeNull();
    expect(s.tax_exemption?.legal_text_key).toBe('REVERSE_CHARGE_ART_138');
  });

  it('CUSTOMER_EXEMPT on a person order → legal key CUSTOMER_EXEMPT, excl layout', () => {
    const s = build(
      paidOrder('p1', {
        total: 100,
        tax_amount: 0,
        tax_lines: [
          {
            label: 'Momsbefriad',
            rate_bp: 0,
            taxable_amount: 100,
            tax_amount: 0,
            exempt_reason: 'CUSTOMER_EXEMPT',
          },
        ],
        tax_exempt_reason: 'CUSTOMER_EXEMPT',
        vat_validation: { source: 'MANUAL', vat_number: '' },
        items: [
          {
            quantity: 1,
            unit_price: 100,
            total_price: 100,
            tax_rate_bp: 0,
            product: { sku: 'P1', translations: [] },
          },
        ],
      }),
    );
    expect(snapshotInvariantErrors(s)).toEqual([]);
    expect(s.buyer.vat_number).toBeNull();
    expect(s.totals.layout).toBe('excl');
    expect(s.tax_exemption).toMatchObject({
      reason: 'CUSTOMER_EXEMPT',
      legal_text_key: 'CUSTOMER_EXEMPT',
      vat_number: null,
      vies: null,
    });
  });

  it('a taxed order gets no tax_exemption key and no exempt_reason', () => {
    const s = build(paidOrder());
    expect(s).not.toHaveProperty('tax_exemption');
    expect(s.vat_summary[0]).not.toHaveProperty('exempt_reason');
    expect(s.template_version).toBe(INVOICE_TEMPLATE_VERSION);
  });

  it('full and partial credit notes keep exempt_reason and tax_exemption', () => {
    const original = build(rcOrder());
    const full = buildCreditSnapshot({
      original,
      amount: 'full',
      priorCredited: 0,
      issueDate: '2026-10-16',
    });
    expect(snapshotInvariantErrors(full)).toEqual([]);
    expect(full.tax_exemption).toEqual(original.tax_exemption);
    expect(full.vat_summary[0]).toMatchObject({
      exempt_reason: 'REVERSE_CHARGE',
      gross: -139.2,
    });
    const partial = buildCreditSnapshot({
      original,
      amount: 50,
      priorCredited: 0,
      issueDate: '2026-10-16',
    });
    expect(snapshotInvariantErrors(partial)).toEqual([]);
    expect(partial.tax_exemption).toEqual(original.tax_exemption);
    expect(partial.vat_summary).toEqual([
      {
        label: 'Omvänd skattskyldighet',
        rate_bp: 0,
        net: -50,
        vat: 0,
        gross: -50,
        exempt_reason: 'REVERSE_CHARGE',
      },
    ]);
    // A credit of a v1 (pre-M2.5) invoice stays without the block.
    const v1 = buildCreditSnapshot({
      original: sampleSvCompanyInvoice(),
      amount: 10,
      priorCredited: 0,
      issueDate: '2026-10-16',
    });
    expect(v1).not.toHaveProperty('tax_exemption');
  });
});

function service(
  order: Record<string, unknown>,
  profile: Record<string, unknown> = completeProfile(),
) {
  const fake = makeFakePrisma({ orders: [order], profile });
  const numbering = new InvoiceNumberingService(fake.prisma);
  const svc = new InvoicesService(
    fake.prisma,
    {
      isEnabled: () => Promise.resolve(true),
    } as unknown as StoreAppsService,
    new LegalProfileService(fake.prisma, numbering),
    numbering,
    {} as InvoicePdfService,
  );
  return { svc, ...fake };
}

describe('InvoicesService: reverse charge', () => {
  it('requires the seller VAT number for an RC invoice (not for a zero-VAT taxed one)', async () => {
    expect(
      profileCompleteness(
        { ...completeProfile(), vat_number: null as string | null },
        { chargesVat: true },
      ).missing,
    ).toEqual(['vat_number']);
    const { svc } = service(rcOrder(), {
      ...completeProfile(),
      vat_number: null,
    });
    await expect(
      svc.issueForOrder('rc1', { trigger: 'MANUAL' }),
    ).rejects.toMatchObject({
      response: { code: 'INVOICE_PROFILE_INCOMPLETE', missing: ['vat_number'] },
    });
    // A zero-VAT order without reverse charge still needs no VAT number.
    const plain = service(
      paidOrder('z1', {
        total: 100,
        tax_amount: 0,
        tax_lines: [],
        items: [
          {
            quantity: 1,
            unit_price: 100,
            total_price: 100,
            tax_rate_bp: 0,
            product: { sku: 'P1', translations: [] },
          },
        ],
      }),
      { ...completeProfile(), vat_number: null },
    );
    await expect(
      plain.svc.issueForOrder('z1', { trigger: 'MANUAL' }),
    ).resolves.toMatchObject({ created: true });
  });

  it('writes the exemption columns on INSERT; the credit note inherits them; no update', async () => {
    const { svc, invoices, mock } = service(rcOrder());
    const { invoice } = await svc.issueForOrder('rc1', { trigger: 'MANUAL' });
    expect(invoice).toMatchObject({
      tax_exempt_reason: 'REVERSE_CHARGE',
      buyer_vat_number: 'DE123456789',
      buyer_country: 'DE',
      vat_total: 0,
      gross_total: 139.2,
    });
    const credit = await svc.issueCreditNote(invoice.id, {
      amount: 39.2,
      trigger: 'MANUAL',
      idempotencyKey: 'cn-1',
    });
    expect(credit.invoice).toMatchObject({
      kind: 'CREDIT_NOTE',
      tax_exempt_reason: 'REVERSE_CHARGE',
      buyer_vat_number: 'DE123456789',
      buyer_country: 'DE',
      gross_total: -39.2,
    });
    // INSERT only: both documents got the columns from invoice.create.
    expect(mock.invoice.create).toHaveBeenCalledTimes(2);
    expect(invoices).toHaveLength(2);
    // List summary / detail expose them (GET /invoices/my, /invoices/my/:id).
    expect(
      svc.toSummary({
        ...invoice,
        credit_notes: [],
        credited_invoice: null,
      } as unknown as Parameters<typeof svc.toSummary>[0]),
    ).toMatchObject({
      tax_exempt_reason: 'REVERSE_CHARGE',
      buyer_vat_number: 'DE123456789',
      buyer_country: 'DE',
    });
  });

  it('a taxed invoice gets none of the exemption columns', async () => {
    const { svc } = service(paidOrder());
    const { invoice } = await svc.issueForOrder('o1', { trigger: 'MANUAL' });
    expect(invoice).not.toHaveProperty('tax_exempt_reason');
    expect(invoice).not.toHaveProperty('buyer_vat_number');
    expect(invoice).not.toHaveProperty('buyer_country');
  });
});

const TITLES: Record<string, string> = {
  sv: 'Omvänd skattskyldighet',
  en: 'Reverse charge',
  de: 'Steuerschuldnerschaft des Leistungsempfängers',
  fr: 'Autoliquidation',
  ar: 'التكليف العكسي',
  tr: 'Ters ifa (sorumlu sıfatıyla)',
};
const ARTICLE: Record<string, RegExp> = {
  sv: /10 kap\. 42 § mervärdesskattelagen.*artikel 138/,
  en: /Article 138/,
  de: /Art\. 138/,
  fr: /article 138/,
  ar: /138/,
  tr: /138\./,
};

function rcSnapshot(locale: string): InvoiceSnapshot {
  return { ...sampleSvReverseChargeInvoice(), locale };
}

describe('invoice PDF template: reverse charge', () => {
  it.each(PDF_LOCALES)(
    '%s: legal block with title, article line, seller + buyer VAT; VAT row and summary label',
    (loc) => {
      const view = toSnapshotForPdf(rcSnapshot(loc));
      const p = getInvoicePhrases(loc);
      const html = renderInvoiceHtml(view, p);
      expect(p.reverseChargeTitle).toBe(TITLES[loc]);
      expect(p.reverseChargeNote).toMatch(ARTICLE[loc]);
      const block = html.slice(html.indexOf('<div class="exemption'));
      expect(block).toContain(TITLES[loc]);
      expect(block).toContain(p.reverseChargeNote.replace(/'/g, '&#39;'));
      expect(block).toContain('<bdi dir="ltr">SE556036079301</bdi>');
      expect(block).toContain('<bdi dir="ltr">DE123456789</bdi>');
      expect(block).toContain('WAPIAAAAZ1x2y3');
      expect(html).toContain('class="vat-exempt"');
      expect(html).toContain(` — ${p.reverseChargeShort}`);
      // The block sits under the totals, before the bank box / footer note.
      expect(html.indexOf('class="exemption')).toBeGreaterThan(
        html.indexOf('class="totals'),
      );
      if (loc === 'ar') expect(html).toContain('dir="rtl"');
    },
  );

  it('the VIES reference is printed only when present', () => {
    const snap = rcSnapshot('en');
    snap.tax_exemption = { ...snap.tax_exemption!, vies: null };
    const html = renderInvoiceHtml(
      toSnapshotForPdf(snap),
      getInvoicePhrases('en'),
    );
    expect(html).not.toContain('VIES consultation');
    expect(html).toContain('Seller VAT no.');
  });

  it('CUSTOMER_EXEMPT prints "Tax exempt" without the article', () => {
    const snap = rcSnapshot('en');
    snap.tax_exemption = {
      reason: 'CUSTOMER_EXEMPT',
      vat_number: null,
      buyer_country: 'SE',
      seller_vat_number: 'SE556036079301',
      legal_text_key: 'CUSTOMER_EXEMPT',
      vies: null,
    };
    snap.vat_summary = snap.vat_summary.map((r) => ({
      ...r,
      exempt_reason: 'CUSTOMER_EXEMPT' as const,
    }));
    const html = renderInvoiceHtml(
      toSnapshotForPdf(snap),
      getInvoicePhrases('en'),
    );
    expect(html).toContain('<div class="title">Tax exempt</div>');
    expect(html).not.toContain('Article 138');
    expect(html).not.toContain('Seller VAT no.');
    expect(html).toContain('VAT <bdi dir="ltr">0%</bdi> (tax exempt)');
  });

  it.each([
    ['sv company', sampleSvCompanyInvoice],
    ['ar person', sampleArPersonInvoice],
    ['sv credit note', sampleSvCreditNote],
  ])(
    'non-exempt %s: template v1 and v2 render byte-identical HTML',
    (_name, sample) => {
      const v1 = { ...sample(), template_version: 1 };
      const v2 = { ...sample(), template_version: 2 };
      const phrases = INVOICE_PHRASES[v1.locale as 'sv'];
      const a = renderInvoiceHtml(toSnapshotForPdf(v1), phrases);
      const b = renderInvoiceHtml(toSnapshotForPdf(v2), phrases);
      expect(b).toBe(a);
      expect(a).not.toContain('exemption');
    },
  );
});

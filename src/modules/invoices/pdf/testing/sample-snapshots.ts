/**
 * Sample snapshots for the PDF specs, the smoke test and manual previews.
 * Org numbers are Luhn-valid fixtures (L18); IBAN/bankgiro are the public
 * test values used by Swedish banks' documentation.
 */
import type { InvoiceSnapshot } from '../../invoices.types';

const seller: InvoiceSnapshot['seller'] = {
  legal_name: 'Neronet Academy AB',
  brand_name: 'Swedags',
  org_number: '556036-0793',
  vat_number: 'SE556036079301',
  address: {
    line1: 'Storgatan 1',
    line2: null,
    postal_code: '111 22',
    city: 'Stockholm',
    country_code: 'SE',
  },
  registered_office: 'Stockholm',
  email: 'info@namz.se',
  phone: '+46 8 123 456 78',
  website: 'namz.se',
  f_tax_approved: true,
  logo_url: null,
  footer_note:
    'Tack för din beställning! Vid frågor, kontakta oss på info@namz.se.',
};

/** Company buyer on an EXCLUSIVE store, unpaid → bank box, `excl` totals. */
export function sampleSvCompanyInvoice(): InvoiceSnapshot {
  return {
    version: 1,
    template_version: 1,
    kind: 'INVOICE',
    locale: 'sv',
    currency: 'SEK',
    tax_mode: 'EXCLUSIVE',
    seller: { ...seller },
    buyer: {
      type: 'COMPANY',
      name: 'Elektronikhuset Norden AB',
      company_name: 'Elektronikhuset Norden AB',
      org_number: '556677-8899',
      vat_number: 'SE556677889901',
      reference: 'PO-2026-0412',
      email: 'ekonomi@elektronikhuset.se',
      billing_address: {
        name: 'Anna Lindqvist',
        company_name: 'Elektronikhuset Norden AB',
        line1: 'Box 1234',
        line2: null,
        postal_code: '411 05',
        city: 'Göteborg',
        state: null,
        country_code: 'SE',
        phone: '+46 31 700 00 00',
      },
      shipping_address: {
        name: 'Anna Lindqvist',
        company_name: 'Elektronikhuset Norden AB',
        line1: 'Lagervägen 7',
        line2: 'Port 3',
        postal_code: '415 02',
        city: 'Göteborg',
        state: null,
        country_code: 'SE',
        phone: null,
      },
    },
    lines: [
      {
        kind: 'item',
        description: 'Hoodie Classic',
        sku: 'HD-100-BLK-L',
        details: [
          { label: 'Färg', value: 'Svart' },
          { label: 'Storlek', value: 'L' },
        ],
        qty: 2,
        unit_net: 400,
        vat_rate_bp: 2500,
        line_net: 800,
      },
      {
        kind: 'item',
        description: 'Kaffebönor Mellanrost 500 g',
        sku: 'KF-500',
        details: [],
        qty: 3,
        unit_net: 90,
        vat_rate_bp: 1200,
        line_net: 270,
      },
      {
        kind: 'item',
        description: 'Bok: Svensk design under 100 år',
        sku: null,
        details: [{ label: 'Gravyr', value: 'Grattis på födelsedagen, Åsa!' }],
        qty: 1,
        unit_net: 250,
        vat_rate_bp: 600,
        line_net: 250,
      },
      {
        kind: 'shipping',
        description: 'PostNord MyPack',
        sku: null,
        details: [],
        qty: 1,
        unit_net: 59,
        vat_rate_bp: 2500,
        line_net: 59,
      },
      {
        kind: 'discount',
        description: 'HÖST10',
        sku: null,
        details: [],
        qty: 1,
        unit_net: -132,
        vat_rate_bp: null,
        line_net: -132,
      },
    ],
    vat_summary: [
      { label: 'Moms', rate_bp: 2500, net: 779, vat: 194.75, gross: 973.75 },
      { label: 'Moms', rate_bp: 1200, net: 243, vat: 29.16, gross: 272.16 },
      { label: 'Moms', rate_bp: 600, net: 225, vat: 13.5, gross: 238.5 },
    ],
    totals: { net: 1247, vat: 237.41, gross: 1484.41, layout: 'excl' },
    payment: {
      method: 'STRIPE',
      label: 'Faktura 30 dagar',
      status: 'unpaid',
      paid: false,
      paid_at: null,
    },
    bank: {
      bankgiro: '5050-1055',
      plusgiro: null,
      iban: 'SE45 5000 0000 0583 9825 7466',
      bic: 'ESSESESS',
      bank_name: 'SEB',
      reference: '1001',
    },
    refs: {
      order_number: 'ORD-7F3K2Q',
      order_date: '2026-10-12',
      invoice_number: '1001',
      issue_date: '2026-10-14',
      due_date: '2026-11-13',
    },
  };
}

/** Person on an INCLUSIVE store, paid by card → `incl` totals, no bank box. */
export function sampleArPersonInvoice(): InvoiceSnapshot {
  return {
    version: 1,
    template_version: 1,
    kind: 'INVOICE',
    locale: 'ar',
    currency: 'SEK',
    tax_mode: 'INCLUSIVE',
    seller: { ...seller, footer_note: 'شكراً لتسوقكم معنا!' },
    buyer: {
      type: 'PERSON',
      name: 'سارة أحمد',
      company_name: null,
      org_number: null,
      vat_number: null,
      reference: null,
      email: 'sara@example.com',
      billing_address: {
        name: 'سارة أحمد',
        company_name: null,
        line1: 'Drottninggatan 45',
        line2: 'شقة 12',
        postal_code: '211 41',
        city: 'Malmö',
        state: null,
        country_code: 'SE',
        phone: '+46 70 123 45 67',
      },
      shipping_address: {
        name: 'سارة أحمد',
        company_name: null,
        line1: 'Drottninggatan 45',
        line2: 'شقة 12',
        postal_code: '211 41',
        city: 'Malmö',
        state: null,
        country_code: 'SE',
        phone: '+46 70 123 45 67',
      },
    },
    lines: [
      {
        kind: 'item',
        description: 'عباية سوداء كلاسيكية',
        sku: 'AB-200-L',
        details: [
          { label: 'المقاس', value: 'L' },
          { label: 'اللون', value: 'أسود' },
        ],
        qty: 1,
        unit_net: 799.2,
        vat_rate_bp: 2500,
        line_net: 799.2,
      },
      {
        kind: 'item',
        description: 'تمر مجدول فاخر 1 كغ',
        sku: 'DT-1000',
        details: [],
        qty: 2,
        unit_net: 133.04,
        vat_rate_bp: 1200,
        line_net: 266.07,
      },
      {
        kind: 'shipping',
        description: 'PostNord',
        sku: null,
        details: [],
        qty: 1,
        unit_net: 39.2,
        vat_rate_bp: 2500,
        line_net: 39.2,
      },
    ],
    vat_summary: [
      { label: 'Moms', rate_bp: 2500, net: 838.4, vat: 209.6, gross: 1048 },
      { label: 'Moms', rate_bp: 1200, net: 266.07, vat: 31.93, gross: 298 },
    ],
    totals: { net: 1104.47, vat: 241.53, gross: 1346, layout: 'incl' },
    payment: {
      method: 'STRIPE',
      label: 'Visa •••• 4242',
      status: 'paid',
      paid: true,
      paid_at: '2026-10-14T09:12:00.000Z',
    },
    bank: null,
    refs: {
      order_number: 'ORD-9A1B7C',
      order_date: '2026-10-14',
      invoice_number: '1002',
      issue_date: '2026-10-14',
      due_date: '2026-10-14',
    },
  };
}

/** Full credit note for the sv sample (negated mirror). */
export function sampleSvCreditNote(): InvoiceSnapshot {
  const inv = sampleSvCompanyInvoice();
  return {
    ...inv,
    kind: 'CREDIT_NOTE',
    lines: inv.lines.map((l) => ({
      ...l,
      unit_net: -l.unit_net,
      line_net: -l.line_net,
      ...(l.kind === 'discount' ? { unit_net: 132, line_net: 132 } : {}),
    })),
    vat_summary: inv.vat_summary.map((r) => ({
      ...r,
      net: -r.net,
      vat: -r.vat,
      gross: -r.gross,
    })),
    totals: { ...inv.totals, net: -1247, vat: -237.41, gross: -1484.41 },
    bank: null,
    refs: {
      ...inv.refs,
      invoice_number: 'CN-1',
      issue_date: '2026-10-20',
      due_date: null,
      credited_number: '1001',
      credited_issue_date: '2026-10-14',
      reason_code: 'refund',
    },
  };
}

/**
 * b2b app M2.5: reverse-charge invoice (template v2) of an SE seller to a
 * German company, 'net' pricing on an INCLUSIVE store (125 → 100.00, 49 →
 * 39.20), paid via Kustom: one exempt 0 % row, the legal block.
 */
export function sampleSvReverseChargeInvoice(): InvoiceSnapshot {
  const billing = {
    name: 'Max Muster',
    company_name: 'Muster GmbH',
    line1: 'Musterstraße 1',
    line2: null,
    postal_code: '10115',
    city: 'Berlin',
    state: null,
    country_code: 'DE',
    phone: '+49 30 123456',
  };
  return {
    version: 1,
    template_version: 2,
    kind: 'INVOICE',
    locale: 'sv',
    currency: 'SEK',
    tax_mode: 'INCLUSIVE',
    seller: { ...seller },
    buyer: {
      type: 'COMPANY',
      name: 'Muster GmbH',
      company_name: 'Muster GmbH',
      org_number: 'HRB 123456 B',
      vat_number: 'DE123456789',
      reference: 'PO-4711',
      email: 'einkauf@muster.de',
      billing_address: billing,
      shipping_address: { ...billing },
    },
    lines: [
      {
        kind: 'item',
        description: 'Hoodie Classic',
        sku: 'HD-100-BLK-L',
        details: [{ label: 'Storlek', value: 'L' }],
        qty: 4,
        unit_net: 400,
        vat_rate_bp: 0,
        line_net: 1600,
      },
      {
        kind: 'shipping',
        description: 'DHL Europaket',
        sku: null,
        details: [],
        qty: 1,
        unit_net: 39.2,
        vat_rate_bp: 0,
        line_net: 39.2,
      },
    ],
    vat_summary: [
      {
        label: 'Omvänd skattskyldighet',
        rate_bp: 0,
        net: 1639.2,
        vat: 0,
        gross: 1639.2,
        exempt_reason: 'REVERSE_CHARGE',
      },
    ],
    totals: { net: 1639.2, vat: 0, gross: 1639.2, layout: 'excl' },
    payment: {
      method: 'KUSTOM',
      label: 'Kustom',
      status: 'paid',
      paid: true,
      paid_at: '2026-10-15T09:20:00.000Z',
    },
    bank: null,
    refs: {
      order_number: 'ORD-RC42',
      order_date: '2026-10-15',
      invoice_number: '1042',
      issue_date: '2026-10-15',
      due_date: '2026-10-15',
    },
    tax_exemption: {
      reason: 'REVERSE_CHARGE',
      vat_number: 'DE123456789',
      buyer_country: 'DE',
      seller_vat_number: 'SE556036079301',
      legal_text_key: 'REVERSE_CHARGE_ART_138',
      vies: {
        request_identifier: 'WAPIAAAAZ1x2y3',
        checked_at: '2026-10-15T09:12:00.000Z',
        name: 'Muster GmbH',
      },
    },
  };
}

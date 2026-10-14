// Shared in-memory PrismaService fake of the invoices specs (not a test file
// itself: the name ends in "spec.ts" so the build skips it, but not in
// ".spec.ts" so jest does not run it). It models just enough of Prisma for
// InvoicesService / LegalProfileService / InvoiceNumberingService:
// sequences locked via $queryRaw, invoices with credit links, and a
// $transaction that rolls the sequence counters back when the callback throws.

import { randomUUID } from 'crypto';
import type { PrismaService } from '../../prisma/prisma.service';

export const STORE_ID = 's1';
export const PROFILE_ID = 'lp1';

export interface FakeSeq {
  id: string;
  kind: 'INVOICE' | 'CREDIT_NOTE';
  prefix: string;
  padding: number;
  next_number: number;
  issued_count: number;
  start_number: number;
}

export type FakeInvoice = Record<string, unknown> & {
  id: string;
  kind: 'INVOICE' | 'CREDIT_NOTE';
  order_id: string;
  store_id: string;
  number: string;
  gross_total: number;
  credited_invoice_id: string | null;
  idempotency_key: string;
  trigger: string;
};

export function completeProfile() {
  return {
    id: PROFILE_ID,
    store_id: STORE_ID,
    key: 'default',
    legal_name: 'Neronet Academy AB',
    brand_name: null,
    org_number: '556036-0793',
    vat_number: 'SE556036079301',
    address_line1: 'Storgatan 1',
    address_line2: null,
    postal_code: '11122',
    city: 'Stockholm',
    country_code: 'SE',
    registered_office: null,
    email: null,
    phone: null,
    website: null,
    bankgiro: '5050-1055',
    plusgiro: null,
    iban: null,
    bic: null,
    bank_name: null,
    logo_url: null,
    f_tax_approved: true,
    due_days: 30,
    footer_note: null,
    timezone: 'Europe/Stockholm',
  };
}

/** A paid Stripe order of 125.00 SEK incl. 25.00 VAT, no shipping. */
export function paidOrder(id = 'o1', extra: Record<string, unknown> = {}) {
  return {
    id,
    order_number: `ORD-${id}`,
    store_id: STORE_ID,
    status: 'CONFIRMED',
    created_at: new Date('2026-10-14T10:00:00Z'),
    currency: 'SEK',
    locale: 'sv',
    payment_method: 'STRIPE',
    payment_status: 'paid',
    paid_at: new Date('2026-10-14T10:01:00Z'),
    card_brand: 'visa',
    card_last4: '4242',
    total: 125,
    tax_amount: 25,
    tax_rate_bp: 2500,
    tax_pricing_mode: 'INCLUSIVE',
    tax_lines: [
      { label: 'Moms', rate_bp: 2500, taxable_amount: 100, tax_amount: 25 },
    ],
    shipping_cost: 0,
    shipping_tax_rate_bp: 0,
    shipping_tax_amount: 0,
    shipping_method_name: null,
    discount_amount: 0,
    customer_type: null,
    company_name: null,
    org_number: null,
    vat_number: null,
    buyer_reference: null,
    address: {
      full_name: 'Anna Svensson',
      line1: 'Gatan 2',
      postal_code: '11123',
      city: 'Stockholm',
      country_code: 'SE',
    },
    customer: {
      user_id: 'cust-user',
      first_name: 'Anna',
      last_name: 'Svensson',
      user: { email: 'anna@example.com' },
    },
    items: [
      {
        quantity: 1,
        unit_price: 125,
        total_price: 125,
        tax_rate_bp: 2500,
        fulfiller_id: 'creator1',
        product: { sku: 'P1', translations: [{ locale: 'sv', title: 'Mugg' }] },
        variant: null,
        custom_product: null,
        custom_field_values: [],
      },
    ],
    ...extra,
  };
}

export function makeFakePrisma(
  opts: {
    orders?: Record<string, unknown>[];
    profile?: Record<string, unknown> | null;
  } = {},
) {
  const orders = new Map<string, Record<string, unknown>>(
    (opts.orders ?? [paidOrder()]).map(
      (o: Record<string, unknown>): [string, Record<string, unknown>] => [
        o.id as string,
        o,
      ],
    ),
  );
  const profile = opts.profile === undefined ? completeProfile() : opts.profile;
  const seqs: Record<string, FakeSeq> = {
    INVOICE: {
      id: 'seqI',
      kind: 'INVOICE',
      prefix: '',
      padding: 0,
      next_number: 1001,
      issued_count: 0,
      start_number: 1001,
    },
    CREDIT_NOTE: {
      id: 'seqC',
      kind: 'CREDIT_NOTE',
      prefix: 'CN-',
      padding: 0,
      next_number: 1,
      issued_count: 0,
      start_number: 1,
    },
  };
  const invoices: FakeInvoice[] = [];
  // Late-bound self reference for $transaction (avoids a circular type).
  let self: unknown = null;

  const decorate = (inv: FakeInvoice) => {
    const credited = invoices.find((i) => i.id === inv.credited_invoice_id);
    return {
      ...inv,
      credited_invoice: credited
        ? { id: credited.id, number: credited.number }
        : null,
      credit_notes: invoices
        .filter((i) => i.credited_invoice_id === inv.id)
        .map((i) => ({ gross_total: i.gross_total })),
    };
  };
  const findInvoice = (where: Record<string, unknown>) => {
    if (where.id) return invoices.find((i) => i.id === where.id);
    const key = where.store_id_idempotency_key as
      | { store_id: string; idempotency_key: string }
      | undefined;
    if (key) {
      return invoices.find(
        (i) =>
          i.store_id === key.store_id &&
          i.idempotency_key === key.idempotency_key,
      );
    }
    return invoices.find(
      (i) =>
        (!where.order_id || i.order_id === where.order_id) &&
        (!where.kind || i.kind === where.kind),
    );
  };

  const prisma = {
    order: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(orders.get(where.id) ?? null),
      ),
      findMany: jest.fn(() => Promise.resolve([...orders.values()])),
      count: jest.fn(() => Promise.resolve(orders.size)),
    },
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          name: 'Namez',
          logo_url: null,
          language_config: { primary_locale: 'sv' },
        }),
      ),
    },
    storeLegalProfile: {
      findUnique: jest.fn(() =>
        Promise.resolve(
          profile
            ? {
                ...profile,
                sequences: Object.values(seqs).map((s) => ({ ...s })),
              }
            : null,
        ),
      ),
    },
    invoiceSequence: {
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const seq = Object.values(seqs).find((s) => s.id === where.id)!;
          for (const [k, v] of Object.entries(data)) {
            if (v && typeof v === 'object' && 'increment' in v) {
              (seq as unknown as Record<string, number>)[k] += (
                v as { increment: number }
              ).increment;
            } else if (k in seq) {
              (seq as unknown as Record<string, unknown>)[k] = v;
            }
          }
          return Promise.resolve({ ...seq });
        },
      ),
      createMany: jest.fn(() => Promise.resolve({ count: 0 })),
    },
    invoice: {
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(findInvoice(where) ?? null),
      ),
      findUnique: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        const inv = findInvoice(where);
        return Promise.resolve(inv ? decorate(inv) : null);
      }),
      findUniqueOrThrow: jest.fn(
        ({ where }: { where: Record<string, unknown> }) => {
          const inv = findInvoice(where);
          if (!inv) return Promise.reject(new Error('not found'));
          return Promise.resolve(decorate(inv));
        },
      ),
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          invoices
            .filter(
              (i) =>
                (!where.credited_invoice_id ||
                  i.credited_invoice_id === where.credited_invoice_id) &&
                (!where.order_id || i.order_id === where.order_id),
            )
            .map(decorate),
        ),
      ),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: randomUUID(),
          issued_at: new Date(),
          credited_invoice_id: null,
          reason: null,
          ...data,
        } as unknown as FakeInvoice;
        invoices.push(row);
        return Promise.resolve({ ...row });
      }),
    },
    orderTimeline: { create: jest.fn(() => Promise.resolve({})) },
    creator: {
      findUnique: jest.fn(({ where }: { where: { user_id: string } }) =>
        Promise.resolve(
          where.user_id === 'creator-user'
            ? { id: 'creator1', store: { id: STORE_ID } }
            : where.user_id === 'other-creator'
              ? { id: 'creator2', store: { id: 's2' } }
              : null,
        ),
      ),
    },
    provider: { findUnique: jest.fn(() => Promise.resolve(null)) },
    $queryRaw: jest.fn(
      (_s: TemplateStringsArray, _profile: string, kind: string) =>
        Promise.resolve(profile ? [{ ...seqs[kind] }] : []),
    ),
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const saved = JSON.stringify(seqs);
      const count = invoices.length;
      try {
        return await fn(self);
      } catch (e) {
        Object.assign(seqs, JSON.parse(saved));
        invoices.splice(count);
        throw e;
      }
    }),
  };
  self = prisma;
  return {
    prisma: prisma as unknown as PrismaService,
    mock: prisma,
    seqs,
    invoices,
    orders,
  };
}

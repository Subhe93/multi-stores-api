import { InvoicesService } from './invoices.service';
import { InvoicesProviderController } from './invoices-provider.controller';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { LegalProfileService } from './legal-profile.service';
import type { InvoiceNumberingService } from './invoice-numbering.service';
import type { InvoicePdfService } from './pdf/invoice-pdf.service';
import type { InvoiceLine } from './invoices.types';

// GET /invoices/provider and GET /invoices/provider/:id/pdf over a tiny
// in-memory Prisma: ownership through order items (fulfiller_type +
// fulfiller_id), supplier-copy lines matched from the stored snapshot,
// filters, in-memory pagination and the narrowed row shape (no buyer data,
// no order totals).

interface Item {
  fulfiller_type: 'PROVIDER' | 'CREATOR';
  fulfiller_id: string;
  title: string;
  unit: number;
  qty: number;
}
interface Row {
  id: string;
  store_id: string;
  kind: 'INVOICE' | 'CREDIT_NOTE';
  number: string;
  order_id: string;
  order_number: string;
  issue_date: Date;
  issued_at: Date;
  paid: boolean;
  gross_total: number;
  credited_invoice: { id: string; number: string } | null;
  lines: InvoiceLine[];
}

const ORDERS: Record<string, Item[]> = {
  // Provider p1 fulfils one line next to the creator's own line.
  o1: [
    {
      fulfiller_type: 'PROVIDER',
      fulfiller_id: 'p1',
      title: 'Mug',
      unit: 50,
      qty: 2,
    },
    {
      fulfiller_type: 'CREATOR',
      fulfiller_id: 'c1',
      title: 'Poster',
      unit: 200,
      qty: 1,
    },
  ],
  // Another provider only.
  o2: [
    {
      fulfiller_type: 'PROVIDER',
      fulfiller_id: 'p2',
      title: 'Cap',
      unit: 80,
      qty: 1,
    },
  ],
  // Same id as p1 but as a creator fulfiller: must not leak.
  o3: [
    {
      fulfiller_type: 'CREATOR',
      fulfiller_id: 'p1',
      title: 'Tee',
      unit: 150,
      qty: 1,
    },
  ],
  o4: [
    {
      fulfiller_type: 'PROVIDER',
      fulfiller_id: 'p1',
      title: 'Bag',
      unit: 60,
      qty: 1,
    },
  ],
};

/** EXCLUSIVE snapshot lines: net = price, so the amounts stay readable. */
function itemLines(orderId: string, sign = 1): InvoiceLine[] {
  return [
    ...ORDERS[orderId].map(
      (i): InvoiceLine => ({
        kind: 'item',
        description: i.title,
        sku: null,
        details: [],
        qty: i.qty,
        unit_net: sign * i.unit,
        vat_rate_bp: 2500,
        line_net: sign * i.unit * i.qty,
      }),
    ),
    {
      kind: 'shipping',
      description: 'PostNord',
      sku: null,
      details: [],
      qty: 1,
      unit_net: sign * 49,
      vat_rate_bp: 2500,
      line_net: sign * 49,
    },
  ];
}

function doc(
  id: string,
  order_id: string,
  kind: Row['kind'],
  day: number,
  extra: Partial<Row> = {},
): Row {
  return {
    id,
    store_id: order_id === 'o4' ? 's2' : 's1',
    kind,
    number: id.toUpperCase(),
    order_id,
    order_number: `ORD-${order_id}`,
    issue_date: new Date(Date.UTC(2026, 9, day)),
    issued_at: new Date(Date.UTC(2026, 9, day, 12)),
    paid: true,
    gross_total: kind === 'CREDIT_NOTE' ? -50 : 125,
    credited_invoice: null,
    lines: itemLines(order_id, kind === 'CREDIT_NOTE' ? -1 : 1),
    ...extra,
  };
}

const ROWS: Row[] = [
  doc('inv1', 'o1', 'INVOICE', 1),
  // Full credit note: the invoice lines negated.
  doc('cn1', 'o1', 'CREDIT_NOTE', 3, {
    credited_invoice: { id: 'inv1', number: 'INV1' },
  }),
  // Partial credit note: one line per VAT rate, nobody's item lines.
  doc('cn2', 'o1', 'CREDIT_NOTE', 3, {
    issued_at: new Date(Date.UTC(2026, 9, 3, 8)),
    credited_invoice: { id: 'inv1', number: 'INV1' },
    lines: [
      {
        kind: 'credit',
        description: '',
        sku: null,
        details: [],
        qty: 1,
        unit_net: -40,
        vat_rate_bp: 2500,
        line_net: -40,
      },
    ],
  }),
  doc('inv2', 'o2', 'INVOICE', 2),
  doc('inv3', 'o3', 'INVOICE', 4),
  doc('inv4', 'o4', 'INVOICE', 5, { paid: false }),
];

type Where = {
  kind?: string;
  paid?: boolean;
  issue_date?: { gte?: Date; lte?: Date };
  OR?: Record<string, { contains: string }>[];
  order?: { items: { some: Pick<Item, 'fulfiller_type' | 'fulfiller_id'> } };
};

function matches(r: Row, w: Where): boolean {
  if (w.kind && r.kind !== w.kind) return false;
  if (w.paid !== undefined && r.paid !== w.paid) return false;
  if (w.issue_date?.gte && r.issue_date < w.issue_date.gte) return false;
  if (w.issue_date?.lte && r.issue_date > w.issue_date.lte) return false;
  if (
    w.OR &&
    !w.OR.some((c) =>
      Object.entries(c).some(([k, v]) => {
        const value = (r as unknown as Record<string, unknown>)[k];
        return (
          typeof value === 'string' &&
          value.toLowerCase().includes(v.contains.toLowerCase())
        );
      }),
    )
  )
    return false;
  if (w.order) {
    const want = w.order.items.some;
    if (
      !(ORDERS[r.order_id] ?? []).some(
        (i) =>
          i.fulfiller_type === want.fulfiller_type &&
          i.fulfiller_id === want.fulfiller_id,
      )
    )
      return false;
  }
  return true;
}

/** The order items as Prisma returns them for providerMatchItemSelect. */
function orderItems(orderId: string) {
  return (ORDERS[orderId] ?? []).map((i) => ({
    order_id: orderId,
    quantity: i.qty,
    unit_price: i.unit,
    total_price: i.unit * i.qty,
    tax_rate_bp: 2500,
    fulfiller_type: i.fulfiller_type,
    fulfiller_id: i.fulfiller_id,
    product: { sku: null, translations: [{ locale: 'en', title: i.title }] },
    variant: null,
    custom_product: null,
    custom_field_values: [],
  }));
}

function snapshotOf(r: Row) {
  return {
    version: 1,
    kind: r.kind,
    locale: 'en',
    currency: 'SEK',
    tax_mode: 'EXCLUSIVE',
    lines: r.lines,
    buyer: { name: 'Anna Svensson', email: 'anna@example.com' },
  };
}

function build() {
  const sorted = () =>
    [...ROWS].sort(
      (a, b) =>
        b.issue_date.getTime() - a.issue_date.getTime() ||
        b.issued_at.getTime() - a.issued_at.getTime(),
    );
  const prisma = {
    provider: {
      findUnique: jest.fn(({ where }: { where: { user_id: string } }) =>
        Promise.resolve(
          where.user_id === 'u-p1'
            ? { id: 'p1' }
            : where.user_id === 'u-p2'
              ? { id: 'p2' }
              : null,
        ),
      ),
    },
    invoice: {
      count: jest.fn(),
      findMany: jest.fn(({ where, take }: { where: Where; take: number }) =>
        Promise.resolve(
          sorted()
            .filter((r) => matches(r, where))
            .slice(0, take)
            .map((r) => ({
              ...r,
              due_date: null,
              currency: 'SEK',
              net_total: r.gross_total * 0.8,
              vat_total: r.gross_total * 0.2,
              buyer_name: 'Anna Svensson',
              buyer_type: 'PERSON',
              trigger: 'PAYMENT',
              reason: null,
              tax_exempt_reason: null,
              buyer_vat_number: 'SE556677889901',
              buyer_country: 'SE',
              credit_notes: [],
              snapshot: snapshotOf(r),
            })),
        ),
      ),
      findUnique: jest.fn(({ where }: { where: { id: string } }) => {
        const r = ROWS.find((x) => x.id === where.id);
        return Promise.resolve(
          r
            ? {
                number: r.number,
                locale: 'en',
                order_id: r.order_id,
                store_id: r.store_id,
                snapshot: snapshotOf(r),
                order: { items: orderItems(r.order_id) },
              }
            : null,
        );
      }),
    },
    orderItem: {
      findMany: jest.fn(
        ({ where }: { where: { order_id: { in: string[] } } }) =>
          Promise.resolve(where.order_id.in.flatMap((id) => orderItems(id))),
      ),
    },
    order: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve({
          store_id: 's1',
          customer: null,
          items: (ORDERS[where.id] ?? []).map((i) => ({
            fulfiller_type: i.fulfiller_type,
            fulfiller_id: i.fulfiller_id,
          })),
        }),
      ),
    },
    store: {
      findMany: jest.fn(() =>
        Promise.resolve([
          { id: 's1', name: 'Store One', language_config: null },
          {
            id: 's2',
            name: 'Store Two',
            language_config: { primary_locale: 'sv' },
          },
        ]),
      ),
      findUnique: jest.fn(() =>
        Promise.resolve({ language_config: { primary_locale: 'sv' } }),
      ),
    },
  };
  const pdf = {
    getPdf: jest.fn(() =>
      Promise.resolve({ buffer: Buffer.from('full'), filename: 'Invoice.pdf' }),
    ),
    renderSupplierCopy: jest.fn(() => Promise.resolve(Buffer.from('copy'))),
  };
  const service = new InvoicesService(
    prisma as unknown as PrismaService,
    {} as StoreAppsService,
    {} as LegalProfileService,
    {} as InvoiceNumberingService,
    pdf as unknown as InvoicePdfService,
  );
  return { service, prisma, pdf };
}

describe('InvoicesService.listForProvider', () => {
  it('lists only documents with lines this provider fulfils', async () => {
    const { service } = build();
    const res = await service.listForProvider('u-p1', {});
    // cn2 (partial credit, per-rate lines) has none of p1's lines.
    expect(res.items.map((i) => i.id)).toEqual(['inv4', 'cn1', 'inv1']);
    expect(res.total).toBe(3);

    const other = await service.listForProvider('u-p2', {});
    expect(other.items.map((i) => i.id)).toEqual(['inv2']);
  });

  it('reports the subtotal of the provider lines, not the order totals', async () => {
    const { service } = build();
    const res = await service.listForProvider('u-p1', {});
    const by = Object.fromEntries(res.items.map((i) => [i.id, i]));
    // o1: Mug 2 × 50 = 100 (the creator's Poster and shipping excluded).
    expect(by.inv1).toMatchObject({
      provider_subtotal: 100,
      provider_line_count: 1,
      currency: 'SEK',
    });
    expect(by.cn1.provider_subtotal).toBe(-100);
    expect(by.inv4.provider_subtotal).toBe(60);
  });

  it('ignores items where the same id is a creator fulfiller', async () => {
    const { service } = build();
    const res = await service.listForProvider('u-p1', {});
    expect(res.items.some((i) => i.order_id === 'o3')).toBe(false);
  });

  it('returns an empty page for a user without a provider profile', async () => {
    const { service, prisma } = build();
    const res = await service.listForProvider('u-nobody', { page: 2 });
    expect(res).toEqual({
      items: [],
      total: 0,
      page: 2,
      limit: 25,
      truncated: false,
    });
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
  });

  it('loads only the translations the matching can pick, in one query', async () => {
    const { service, prisma } = build();
    const res = await service.listForProvider('u-p1', {});
    expect(res.truncated).toBe(false);
    expect(prisma.orderItem.findMany).toHaveBeenCalledTimes(1);
    const arg = (
      prisma.orderItem.findMany.mock.calls[0] as unknown as [
        {
          select: {
            product: {
              select: { translations: { where: unknown } };
            };
          };
        },
      ]
    )[0];
    expect(arg.select.product.select.translations.where).toEqual({
      locale: { in: ['en', 'sv'] },
    });
  });

  it('flags a list cut at the scan cap', async () => {
    const { service, prisma } = build();
    const many = Array.from({ length: 2000 }, (_, i) => ({
      ...doc(`x${i}`, 'o1', 'INVOICE', 1),
      due_date: null,
      currency: 'SEK',
      net_total: 0,
      vat_total: 0,
      buyer_name: '',
      buyer_type: 'PERSON',
      trigger: 'PAYMENT',
      reason: null,
      tax_exempt_reason: null,
      buyer_vat_number: null,
      buyer_country: null,
      credit_notes: [],
      snapshot: snapshotOf(doc(`x${i}`, 'o1', 'INVOICE', 1)),
    }));
    prisma.invoice.findMany.mockImplementationOnce(() =>
      Promise.resolve(many as never),
    );
    const res = await service.listForProvider('u-p1', { limit: 5 });
    expect(res.truncated).toBe(true);
    expect(res.total).toBe(2000);
    expect(res.items).toHaveLength(5);
  });

  it('filters by kind (invoices vs credit notes)', async () => {
    const { service } = build();
    const credits = await service.listForProvider('u-p1', {
      kind: 'CREDIT_NOTE',
    });
    expect(credits.items.map((i) => i.id)).toEqual(['cn1']);
    expect(credits.total).toBe(1);
    expect(credits.items[0].credited_invoice).toEqual({
      id: 'inv1',
      number: 'INV1',
    });

    const invoices = await service.listForProvider('u-p1', { kind: 'INVOICE' });
    expect(invoices.items.map((i) => i.id)).toEqual(['inv4', 'inv1']);
  });

  it('paginates after dropping documents without provider lines', async () => {
    const { service } = build();
    const p1 = await service.listForProvider('u-p1', { page: 1, limit: 2 });
    const p2 = await service.listForProvider('u-p1', { page: 2, limit: 2 });
    expect(p1.items.map((i) => i.id)).toEqual(['inv4', 'cn1']);
    expect(p2.items.map((i) => i.id)).toEqual(['inv1']);
    expect(p2).toMatchObject({ total: 3, page: 2, limit: 2 });

    const clamped = await service.listForProvider('u-p1', { limit: 500 });
    expect(clamped.limit).toBe(100);
  });

  it('searches number / order number only, plus date range and paid', async () => {
    const { service, prisma } = build();
    const byOrder = await service.listForProvider('u-p1', { q: 'ord-o4' });
    expect(byOrder.items.map((i) => i.id)).toEqual(['inv4']);

    // Buyer names are not searchable for providers.
    const byBuyer = await service.listForProvider('u-p1', { q: 'Anna' });
    expect(byBuyer.total).toBe(0);
    const lastCall = prisma.invoice.findMany.mock.calls.at(-1) as
      | [{ where: Where }]
      | undefined;
    expect(lastCall?.[0].where.OR?.map((c) => Object.keys(c)[0])).toEqual([
      'number',
      'order_number',
    ]);

    const ranged = await service.listForProvider('u-p1', {
      from: '2026-10-02',
      to: '2026-10-04',
    });
    expect(ranged.items.map((i) => i.id)).toEqual(['cn1']);

    const unpaid = await service.listForProvider('u-p1', { paid: false });
    expect(unpaid.items.map((i) => i.id)).toEqual(['inv4']);
  });

  it('returns the narrowed shape: store name, no buyer data, no order totals', async () => {
    const { service } = build();
    const res = await service.listForProvider('u-p1', {});
    const row = res.items.find((i) => i.id === 'inv4');
    expect(row).toMatchObject({
      store_id: 's2',
      store_name: 'Store Two',
      order_number: 'ORD-o4',
      currency: 'SEK',
      paid: false,
    });
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        'id',
        'kind',
        'number',
        'issue_date',
        'order_id',
        'order_number',
        'store_id',
        'store_name',
        'currency',
        'provider_subtotal',
        'provider_line_count',
        'paid',
        'credited_invoice',
        'pdf_available',
      ].sort(),
    );
  });
});

describe('Provider access to documents', () => {
  const P1_USER = { id: 'u-p1', role: 'PROVIDER' as const };

  it('refuses the full tax-invoice PDF to a provider', async () => {
    const { service, pdf } = build();
    await expect(
      service.pdfForUser('inv1', P1_USER as never),
    ).rejects.toMatchObject({ response: { code: 'INVOICE_NOT_FOUND' } });
    expect(pdf.getPdf).not.toHaveBeenCalled();
  });

  it('refuses the full document summaries of an order to a provider', async () => {
    const { service } = build();
    await expect(
      service.findForOrder('o1', P1_USER as never),
    ).rejects.toMatchObject({ response: { code: 'INVOICE_NOT_FOUND' } });
  });

  it('still serves the full PDF to an admin', async () => {
    const { service, pdf } = build();
    await service.pdfForUser('inv1', { id: 'a', role: 'ADMIN' } as never);
    expect(pdf.getPdf).toHaveBeenCalledWith('inv1');
  });

  it('renders the supplier copy with only the provider lines', async () => {
    const { service, pdf } = build();
    const res = await service.supplierCopyPdf('inv1', 'u-p1');
    expect(res.filename).toBe('Supplier-copy-INV1.pdf');
    expect(res.buffer.toString()).toBe('copy');
    // Line 0 = Mug (p1); line 1 = Poster (creator); line 2 = shipping.
    expect(pdf.renderSupplierCopy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'INVOICE' }),
      [0],
    );
    expect(pdf.getPdf).not.toHaveBeenCalled();
  });

  it("refuses another provider's copy and documents without own lines", async () => {
    const { service, pdf } = build();
    const notFound = { response: { code: 'INVOICE_NOT_FOUND' } };
    // p2 fulfils nothing on o1.
    await expect(service.supplierCopyPdf('inv1', 'u-p2')).rejects.toMatchObject(
      notFound,
    );
    // p1 only as a creator id on o3.
    await expect(service.supplierCopyPdf('inv3', 'u-p1')).rejects.toMatchObject(
      notFound,
    );
    // Partial credit note: no provider lines.
    await expect(service.supplierCopyPdf('cn2', 'u-p1')).rejects.toMatchObject(
      notFound,
    );
    // No provider profile / unknown document.
    await expect(
      service.supplierCopyPdf('inv1', 'u-nobody'),
    ).rejects.toMatchObject(notFound);
    await expect(service.supplierCopyPdf('nope', 'u-p1')).rejects.toMatchObject(
      notFound,
    );
    expect(pdf.renderSupplierCopy).not.toHaveBeenCalled();
  });
});

describe('InvoicesProviderController', () => {
  it('passes the signed-in user id and query to the service', async () => {
    const listForProvider = jest.fn(() => Promise.resolve({}));
    const ctrl = new InvoicesProviderController({
      listForProvider,
    } as unknown as InvoicesService);
    await ctrl.list('u-p1', { kind: 'INVOICE', page: 2 });
    expect(listForProvider).toHaveBeenCalledWith('u-p1', {
      kind: 'INVOICE',
      page: 2,
    });
  });

  it('streams the supplier copy of the signed-in provider', async () => {
    const supplierCopyPdf = jest.fn(() =>
      Promise.resolve({ buffer: Buffer.from('copy'), filename: 'S-1.pdf' }),
    );
    const ctrl = new InvoicesProviderController({
      supplierCopyPdf,
    } as unknown as InvoicesService);
    const file = await ctrl.pdf('u-p1', 'inv1');
    expect(supplierCopyPdf).toHaveBeenCalledWith('inv1', 'u-p1');
    expect(file.getHeaders()).toMatchObject({
      type: 'application/pdf',
      disposition: 'attachment; filename="S-1.pdf"',
    });
  });
});

describe('InvoicesService.canRead fulfiller type', () => {
  // Provider and creator ids live in different tables: the role must match
  // the item's fulfiller type, not just the id.
  function reader(creatorStore: { id: string } | null = null) {
    const svc = Object.create(InvoicesService.prototype) as InvoicesService;
    (svc as unknown as { prisma: unknown }).prisma = {
      provider: { findUnique: jest.fn(() => Promise.resolve({ id: 'x1' })) },
      creator: {
        findUnique: jest.fn(() =>
          Promise.resolve({ id: 'x1', store: creatorStore }),
        ),
      },
    };
    const typed = svc as unknown as {
      canRead: (o: unknown, u: unknown) => Promise<boolean>;
    };
    return (o: unknown, u: unknown) => typed.canRead(o, u);
  }
  const order = (fulfiller_type: 'PROVIDER' | 'CREATOR') => ({
    store_id: 's1',
    customer: null,
    items: [{ fulfiller_type, fulfiller_id: 'x1' }],
  });

  it('a provider reads only orders with its own PROVIDER items', async () => {
    const canRead = reader();
    const user = { id: 'u1', role: 'PROVIDER' };
    await expect(canRead(order('PROVIDER'), user)).resolves.toBe(true);
    await expect(canRead(order('CREATOR'), user)).resolves.toBe(false);
  });

  it("a creator that only fulfils items of another store's order is refused", async () => {
    const user = { id: 'u1', role: 'CREATOR' };
    // No store of its own, fulfils the item: still no full document.
    await expect(reader()(order('CREATOR'), user)).resolves.toBe(false);
    // Owns another store and fulfils an item of s1's order: refused.
    await expect(reader({ id: 's2' })(order('CREATOR'), user)).resolves.toBe(
      false,
    );
    await expect(reader({ id: 's2' })(order('PROVIDER'), user)).resolves.toBe(
      false,
    );
  });

  it("the store owner reads its own store's orders, whoever fulfils them", async () => {
    const user = { id: 'u1', role: 'CREATOR' };
    const owner = reader({ id: 's1' });
    await expect(owner(order('CREATOR'), user)).resolves.toBe(true);
    await expect(owner(order('PROVIDER'), user)).resolves.toBe(true);
    // An order without a store id never matches.
    await expect(
      owner({ ...order('CREATOR'), store_id: null }, user),
    ).resolves.toBe(false);
  });

  it('refuses the full PDF and summaries to a fulfiller-only creator', async () => {
    const { service, prisma, pdf } = build();
    (prisma as unknown as { creator: unknown }).creator = {
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 'c1', store: { id: 's2' } }),
      ),
    };
    const user = { id: 'u-c1', role: 'CREATOR' } as never;
    const notFound = { response: { code: 'INVOICE_NOT_FOUND' } };
    // c1 fulfils the Poster of o1 (store s1).
    await expect(service.pdfForUser('inv1', user)).rejects.toMatchObject(
      notFound,
    );
    await expect(service.findForOrder('o1', user)).rejects.toMatchObject(
      notFound,
    );
    expect(pdf.getPdf).not.toHaveBeenCalled();
  });
});

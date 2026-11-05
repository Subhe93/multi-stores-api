import { InvoicesService } from './invoices.service';
import { InvoicesProviderController } from './invoices-provider.controller';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { LegalProfileService } from './legal-profile.service';
import type { InvoiceNumberingService } from './invoice-numbering.service';
import type { InvoicePdfService } from './pdf/invoice-pdf.service';

// GET /invoices/provider over a tiny in-memory Prisma: ownership through
// order items (fulfiller_type + fulfiller_id), filters, pagination and the
// narrowed row shape (no buyer data).

interface Item {
  fulfiller_type: 'PROVIDER' | 'CREATOR';
  fulfiller_id: string;
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
}

const ORDERS: Record<string, Item[]> = {
  // Provider p1 fulfils one line next to the creator's own line.
  o1: [
    { fulfiller_type: 'PROVIDER', fulfiller_id: 'p1' },
    { fulfiller_type: 'CREATOR', fulfiller_id: 'c1' },
  ],
  // Another provider only.
  o2: [{ fulfiller_type: 'PROVIDER', fulfiller_id: 'p2' }],
  // Same id as p1 but as a creator fulfiller: must not leak.
  o3: [{ fulfiller_type: 'CREATOR', fulfiller_id: 'p1' }],
  o4: [{ fulfiller_type: 'PROVIDER', fulfiller_id: 'p1' }],
};

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
    ...extra,
  };
}

const ROWS: Row[] = [
  doc('inv1', 'o1', 'INVOICE', 1),
  doc('cn1', 'o1', 'CREDIT_NOTE', 3, {
    credited_invoice: { id: 'inv1', number: 'INV1' },
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
  order?: { items: { some: Item } };
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
      count: jest.fn(({ where }: { where: Where }) =>
        Promise.resolve(ROWS.filter((r) => matches(r, where)).length),
      ),
      findMany: jest.fn(
        ({ where, skip, take }: { where: Where; skip: number; take: number }) =>
          Promise.resolve(
            sorted()
              .filter((r) => matches(r, where))
              .slice(skip, skip + take)
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
              })),
          ),
      ),
    },
    store: {
      findMany: jest.fn(() =>
        Promise.resolve([
          { id: 's1', name: 'Store One' },
          { id: 's2', name: 'Store Two' },
        ]),
      ),
    },
  };
  const service = new InvoicesService(
    prisma as unknown as PrismaService,
    {} as StoreAppsService,
    {} as LegalProfileService,
    {} as InvoiceNumberingService,
    {} as InvoicePdfService,
  );
  return { service, prisma };
}

describe('InvoicesService.listForProvider', () => {
  it('lists only documents of orders with an item this provider fulfils', async () => {
    const { service } = build();
    const res = await service.listForProvider('u-p1', {});
    expect(res.items.map((i) => i.id)).toEqual(['inv4', 'cn1', 'inv1']);
    expect(res.total).toBe(3);

    const other = await service.listForProvider('u-p2', {});
    expect(other.items.map((i) => i.id)).toEqual(['inv2']);
  });

  it('ignores items where the same id is a creator fulfiller', async () => {
    const { service } = build();
    const res = await service.listForProvider('u-p1', {});
    expect(res.items.some((i) => i.order_id === 'o3')).toBe(false);
  });

  it('returns an empty page for a user without a provider profile', async () => {
    const { service, prisma } = build();
    const res = await service.listForProvider('u-nobody', { page: 2 });
    expect(res).toEqual({ items: [], total: 0, page: 2, limit: 25 });
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
  });

  it('filters by kind (invoices vs credit notes)', async () => {
    const { service } = build();
    const credits = await service.listForProvider('u-p1', {
      kind: 'CREDIT_NOTE',
    });
    expect(credits.items.map((i) => i.id)).toEqual(['cn1']);
    expect(credits.items[0].credited_invoice).toEqual({
      id: 'inv1',
      number: 'INV1',
    });
    expect(credits.items[0].gross_total).toBe(-50);

    const invoices = await service.listForProvider('u-p1', { kind: 'INVOICE' });
    expect(invoices.items.map((i) => i.id)).toEqual(['inv4', 'inv1']);
  });

  it('paginates and clamps the limit to 100', async () => {
    const { service, prisma } = build();
    const p1 = await service.listForProvider('u-p1', { page: 1, limit: 2 });
    const p2 = await service.listForProvider('u-p1', { page: 2, limit: 2 });
    expect(p1.items.map((i) => i.id)).toEqual(['inv4', 'cn1']);
    expect(p2.items.map((i) => i.id)).toEqual(['inv1']);
    expect(p2).toMatchObject({ total: 3, page: 2, limit: 2 });

    await service.listForProvider('u-p1', { limit: 500 });
    expect(prisma.invoice.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 100, skip: 0 }),
    );
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

  it('returns the narrowed shape with the store name and no buyer data', async () => {
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
        'net_total',
        'vat_total',
        'gross_total',
        'paid',
        'credited_invoice',
        'pdf_available',
      ].sort(),
    );
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
});

describe('InvoicesService.canRead fulfiller type', () => {
  // Provider and creator ids live in different tables: the role must match
  // the item's fulfiller type, not just the id.
  function reader() {
    const svc = Object.create(InvoicesService.prototype) as InvoicesService;
    (svc as unknown as { prisma: unknown }).prisma = {
      provider: { findUnique: jest.fn(() => Promise.resolve({ id: 'x1' })) },
      creator: {
        findUnique: jest.fn(() => Promise.resolve({ id: 'x1', store: null })),
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

  it('a creator reads only orders with its own CREATOR items', async () => {
    const canRead = reader();
    const user = { id: 'u1', role: 'CREATOR' };
    await expect(canRead(order('CREATOR'), user)).resolves.toBe(true);
    await expect(canRead(order('PROVIDER'), user)).resolves.toBe(false);
  });
});

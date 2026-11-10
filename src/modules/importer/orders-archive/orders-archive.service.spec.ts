/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- in-memory Prisma fake rows are untyped in tests */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { createFakePrisma } from '../__fixtures__/fake-prisma';
import { OrdersArchiveService } from './orders-archive.service';
import { loadFixture } from './wc-orders-parser.spec';

const STORE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_STORE_ID = '55555555-5555-4555-8555-555555555555';
const CREATOR_ID = '22222222-2222-4222-8222-222222222222';
const PRODUCT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_PRODUCT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function setup(opts: { source?: boolean } = {}) {
  const db: any = createFakePrisma();
  db.store.rows.push(
    { id: STORE_ID, creator_id: CREATOR_ID, slug: 'namez' },
    { id: OTHER_STORE_ID, creator_id: 'other-creator', slug: 'other' },
  );
  db.storeLanguageConfig.rows.push({
    store_id: STORE_ID,
    primary_locale: 'sv',
  });
  if (opts.source !== false)
    db.importSource.rows.push({
      store_id: STORE_ID,
      kind: 'WP_BUNDLE',
      site_host: 'namez.se',
      host_aliases: ['www.namez.se'],
    });
  // Product 501 imported from namez.se, variation 502 of it; 777 belongs to
  // another store (must not match).
  db.product.rows.push(
    {
      id: PRODUCT_ID,
      creator_id: CREATOR_ID,
      external_ref: 'woo:namez.se:product:501',
      translations: [
        { locale: 'en', title: 'Wooden name sign', slug: 'wooden-name-sign' },
        { locale: 'sv', title: 'Namnskylt trä', slug: 'namnskylt-tra' },
      ],
    },
    {
      id: OTHER_PRODUCT_ID,
      creator_id: 'other-creator',
      external_ref: 'woo:namez.se:product:777',
      translations: [],
    },
  );
  db.productVariant.rows.push({
    id: 'variant-1',
    product_id: PRODUCT_ID,
    external_ref: 'woo:namez.se:variation:502',
  });
  const service = new OrdersArchiveService(db);
  return { db, service };
}

describe('OrdersArchiveService: import', () => {
  it('dry run summarizes without writing', async () => {
    const { db, service } = setup();
    const parsed = OrdersArchiveService.parse(loadFixture('hpos'));
    const s = await service.importParsed(STORE_ID, parsed, { dryRun: true });
    expect(s.dry_run).toBe(true);
    expect(s.shape).toBe('hpos');
    expect(s.site_host).toBe('namez.se');
    expect(s.resolved_hosts.sort()).toEqual(['namez.se', 'www.namez.se']);
    expect(s.orders).toEqual({ total: 3, create: 3, update: 0, skipped: 1 });
    expect(s.lines).toEqual({ total: 4, with_product: 2, without_product: 2 });
    expect(s.refunds).toBe(1);
    expect(s.statuses).toEqual({ processing: 1, completed: 1, cancelled: 1 });
    expect(s.currencies).toEqual({ SEK: 3 });
    expect(s.payment_methods).toEqual({ Klarna: 1, 'Kort (Stripe)': 1 });
    expect(s.unknown_payment_methods).toBe(1);
    expect(s.date_range).toEqual({
      min: '2022-06-01T12:00:00.000Z',
      max: '2024-03-05T10:15:00.000Z',
    });
    expect(db.archivedOrder.rows).toHaveLength(0);
    expect(db.writeCount(['archivedOrder', 'archivedOrderLine'])).toBe(0);
  });

  it('applies, resolves products through the external refs, and re-imports idempotently', async () => {
    const { db, service } = setup();
    const parsed = OrdersArchiveService.parse(loadFixture('hpos'));
    const first = await service.importParsed(STORE_ID, parsed, {
      dryRun: false,
    });
    expect(first.orders).toMatchObject({ create: 3, update: 0 });
    expect(db.archivedOrder.rows).toHaveLength(3);
    expect(db.archivedOrderLine.rows).toHaveLength(4);

    const o1001 = db.archivedOrder.rows.find(
      (r: any) => r.external_id === '1001',
    );
    expect(o1001).toMatchObject({
      store_id: STORE_ID,
      source: 'woocommerce',
      number: 'NZ-1001',
      status: 'processing',
      currency: 'SEK',
      total: '312.50',
      customer_email: 'anna.svensson@example.com',
    });
    expect(o1001.refunds).toEqual([]);
    const o1002 = db.archivedOrder.rows.find(
      (r: any) => r.external_id === '1002',
    );
    expect(o1002.refunds).toHaveLength(1);
    expect(o1002.refunds[0]).toMatchObject({
      external_id: '1003',
      amount: '50.00',
    });

    const lines1001 = db.archivedOrderLine.rows
      .filter((l: any) => l.archived_order_id === o1001.id)
      .sort((a: any, b: any) => a.position - b.position);
    // Variation 502 → product 501; product 777 belongs to another store.
    expect(lines1001[0].product_id).toBe(PRODUCT_ID);
    expect(lines1001[1].product_id).toBeNull();
    expect(lines1001[0].meta).toEqual({
      pa_farg: 'rod',
      ppom_fields: { Namn: 'Alaa', Färg: 'Röd' },
    });

    // Re-import: same rows, lines replaced, summary reports updates.
    const ids = db.archivedOrder.rows.map((r: any) => r.id).sort();
    const second = await service.importParsed(STORE_ID, parsed, {
      dryRun: false,
    });
    expect(second.orders).toMatchObject({ create: 0, update: 3 });
    expect(db.archivedOrder.rows).toHaveLength(3);
    expect(db.archivedOrder.rows.map((r: any) => r.id).sort()).toEqual(ids);
    expect(db.archivedOrderLine.rows).toHaveLength(4);
    expect(
      db.archivedOrderLine.rows.filter(
        (l: any) => l.archived_order_id === o1001.id,
      ),
    ).toHaveLength(2);
  });

  it('resolves refs with the manifest host alone when the store has no import source', async () => {
    const { db, service } = setup({ source: false });
    const parsed = OrdersArchiveService.parse(loadFixture('hpos'));
    const s = await service.importParsed(STORE_ID, parsed, { dryRun: true });
    expect(s.resolved_hosts).toEqual(['namez.se']);
    expect(s.lines.with_product).toBe(2);
    expect(db.archivedOrder.rows).toHaveLength(0);
  });

  it('legacy archive without a manifest or source matches nothing but imports', async () => {
    const { db, service } = setup({ source: false });
    const parsed = OrdersArchiveService.parse(loadFixture('legacy'));
    const s = await service.importParsed(STORE_ID, parsed, { dryRun: false });
    expect(s.shape).toBe('legacy');
    expect(s.resolved_hosts).toEqual([]);
    expect(s.lines).toEqual({ total: 2, with_product: 0, without_product: 2 });
    expect(db.archivedOrder.rows).toHaveLength(2);
    expect(
      db.archivedOrderLine.rows.every((l: any) => l.product_id === null),
    ).toBe(true);
  });

  it('refuses a second import of the same store while one is in flight', async () => {
    const { service } = setup();
    const parsed = OrdersArchiveService.parse(loadFixture('hpos'));
    const first = service.importParsed(STORE_ID, parsed, { dryRun: true });
    await expect(
      service.importParsed(STORE_ID, parsed, { dryRun: true }),
    ).rejects.toBeInstanceOf(ConflictException);
    // Another store is not blocked.
    await expect(
      service.importParsed(OTHER_STORE_ID, parsed, { dryRun: true }),
    ).resolves.toMatchObject({ dry_run: true });
    await first;
    // Released afterwards.
    await expect(
      service.importParsed(STORE_ID, parsed, { dryRun: true }),
    ).resolves.toMatchObject({ dry_run: true });
  });

  it('rejects an unknown store', async () => {
    const { service } = setup();
    await expect(
      service.importParsed(
        '99999999-9999-4999-8999-999999999999',
        OrdersArchiveService.parse(loadFixture('hpos')),
        {
          dryRun: true,
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('OrdersArchiveService: reads', () => {
  async function seeded() {
    const ctx = setup();
    await ctx.service.importParsed(
      STORE_ID,
      OrdersArchiveService.parse(loadFixture('hpos')),
      {
        dryRun: false,
      },
    );
    // A row of another store must never show up.
    ctx.db.archivedOrder.rows.push({
      id: 'other-order',
      store_id: OTHER_STORE_ID,
      source: 'woocommerce',
      external_id: '1001',
      number: 'NZ-1001',
      status: 'processing',
      created_at_source: new Date('2024-03-05T10:15:00.000Z'),
      currency: 'SEK',
      total: '1.00',
      customer_name: 'Anna Svensson',
      customer_email: 'anna.svensson@example.com',
      refunds: [],
      raw: {},
    });
    return ctx;
  }

  it('summary counts the store rows and the date range', async () => {
    const { service } = await seeded();
    const s = await service.summary(STORE_ID);
    expect(s.count).toBe(3);
    expect(new Date(s.min_date!).toISOString()).toBe(
      '2022-06-01T12:00:00.000Z',
    );
    expect(new Date(s.max_date!).toISOString()).toBe(
      '2024-03-05T10:15:00.000Z',
    );
    expect(await service.summary(OTHER_STORE_ID)).toMatchObject({ count: 1 });
  });

  it('lists newest first with pagination and lines_count', async () => {
    const { service } = await seeded();
    const page1 = await service.list(STORE_ID, { limit: 2 });
    expect(page1.meta).toEqual({ total: 3, page: 1, limit: 2, totalPages: 2 });
    expect(page1.data.map((o) => o.external_id)).toEqual(['1001', '1002']);
    expect(page1.data[0]).toMatchObject({ number: 'NZ-1001', lines_count: 2 });
    expect(page1.data[0]).not.toHaveProperty('raw');
    const page2 = await service.list(STORE_ID, { limit: 2, page: 2 });
    expect(page2.data.map((o) => o.external_id)).toEqual(['1005']);
  });

  it('filters by q (number / name / email, case-insensitive), status and dates', async () => {
    const { service } = await seeded();
    const byEmail = await service.list(STORE_ID, { q: 'ANNA.svensson' });
    expect(byEmail.data.map((o) => o.external_id)).toEqual(['1001']);
    const byName = await service.list(STORE_ID, { q: 'björn' });
    expect(byName.data.map((o) => o.external_id)).toEqual(['1002']);
    const byNumber = await service.list(STORE_ID, { q: 'nz-10' });
    expect(byNumber.data.map((o) => o.external_id)).toEqual(['1001']);
    const byStatus = await service.list(STORE_ID, { status: 'Completed' });
    expect(byStatus.data.map((o) => o.external_id)).toEqual(['1002']);
    const from = await service.list(STORE_ID, { from: '2023-11-20' });
    expect(from.data.map((o) => o.external_id)).toEqual(['1001', '1002']);
    const to = await service.list(STORE_ID, { to: '2023-11-20' });
    expect(to.data.map((o) => o.external_id)).toEqual(['1002', '1005']);
    const window = await service.list(STORE_ID, {
      from: '2023-01-01',
      to: '2023-12-31',
    });
    expect(window.data.map((o) => o.external_id)).toEqual(['1002']);
    const none = await service.list(STORE_ID, { q: 'nobody' });
    expect(none.meta.total).toBe(0);
  });

  it('detail returns the lines with the matched product and 404s across stores', async () => {
    const { db, service } = await seeded();
    const id = db.archivedOrder.rows.find(
      (r: any) => r.external_id === '1001' && r.store_id === STORE_ID,
    ).id;
    const d = await service.detail(STORE_ID, id);
    expect(d.number).toBe('NZ-1001');
    expect(d.lines).toHaveLength(2);
    expect(d.lines[0].product).toEqual({
      id: PRODUCT_ID,
      name: 'Namnskylt trä',
      slug: 'namnskylt-tra',
    });
    expect(d.lines[1].product).toBeNull();
    await expect(service.detail(OTHER_STORE_ID, id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('exports the filtered list as CSV', async () => {
    const { service } = await seeded();
    const csv = await service.exportCsv(STORE_ID, { status: 'completed' });
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith('number,external_id,date,status,')).toBe(true);
    expect(
      lines[1].startsWith('1002,1002,2023-11-20T08:00:00.000Z,completed,'),
    ).toBe(true);
    expect(lines[1]).toContain('bjorn@example.com');
    // Refunded total column and line count.
    expect(lines[1]).toContain(',50.00,Kort (Stripe),Standardfrakt,2,SE,');
    const all = await service.exportCsv(STORE_ID, {});
    expect(all.trim().split('\n')).toHaveLength(4);
  });
});

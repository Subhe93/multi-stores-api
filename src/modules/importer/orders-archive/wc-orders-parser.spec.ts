import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  decodeMeta,
  detectNullToken,
  isDroppedRawKey,
  money,
  mysqlDateUtc,
  parseManifest,
  parseOrdersArchive,
  OrdersArchiveParseError,
  type OrdersArchiveFiles,
} from './wc-orders-parser';

export const FIXTURES = join(__dirname, '__fixtures__');

export function loadFixture(name: 'hpos' | 'legacy'): OrdersArchiveFiles {
  const dir = join(FIXTURES, name);
  const out: OrdersArchiveFiles = {};
  for (const f of readdirSync(dir)) out[f] = readFileSync(join(dir, f), 'utf8');
  return out;
}

describe('wc-orders parser: helpers', () => {
  it('money rounds to 2 decimals and tolerates garbage', () => {
    expect(money('200')).toBe('200.00');
    expect(money(1.005)).toBe('1.01');
    expect(money('-50')).toBe('-50.00');
    expect(money(null)).toBe('0.00');
    expect(money('abc')).toBe('0.00');
  });

  it('mysqlDateUtc reads MySQL datetimes as UTC and rejects the zero date', () => {
    expect(mysqlDateUtc('2024-03-05 10:15:00')?.toISOString()).toBe(
      '2024-03-05T10:15:00.000Z',
    );
    expect(mysqlDateUtc('0000-00-00 00:00:00')).toBeNull();
    expect(mysqlDateUtc(null)).toBeNull();
  });

  it('detects the NULL token of an export', () => {
    expect(detectNullToken('id\tx\n1\t\\N\n')).toBe('\\N');
    expect(detectNullToken('id\tx\n1\tNULL\n')).toBe('NULL');
  });

  it('decodes serialized meta and keeps plain strings', () => {
    expect(decodeMeta('a:1:{s:4:"Namn";s:4:"Alaa";}')).toEqual({
      Namn: 'Alaa',
    });
    expect(decodeMeta('plain')).toBe('plain');
    expect(decodeMeta(null)).toBeNull();
  });

  it('parses manifest.txt key=value lines', () => {
    expect(
      parseManifest('# c\nsite_url=https://namez.se\nformat=hpos\nbad line\n'),
    ).toEqual({ site_url: 'https://namez.se', format: 'hpos' });
  });

  it('reads the real manifest form (key: value) and takes the host from it', () => {
    const files = loadFixture('hpos');
    files['manifest.txt'] =
      'site_host: namez.se\nsource: namez.se wp_wc_orders\nhpos: yes\n';
    const parsed = parseOrdersArchive(files);
    expect(parsed.manifest).toEqual({
      site_host: 'namez.se',
      source: 'namez.se wp_wc_orders',
      hpos: 'yes',
    });
    expect(parsed.site_host).toBe('namez.se');
    // `source:` alone is enough (the first token is the host).
    files['manifest.txt'] =
      'source: namez.se WordPress on Hostinger (retired)\n';
    expect(parseOrdersArchive(files).site_host).toBe('namez.se');
  });

  it('drops privacy-sensitive raw keys', () => {
    for (const k of [
      'ip_address',
      '_customer_ip_address',
      'user_agent',
      '_customer_user_agent',
      '_wc_order_attribution_source_type',
      '_stripe_customer_token',
      'cart_hash',
      'order_key',
      '_stripe_customer_id',
      '_stripe_source_id',
      '_stripe_intent_id',
      '_stripe_payment_method_id',
      '_stripe_charge_id',
      '_paypal_payer_id',
      '_wc_klarna_order_id',
      '_kp_session_id',
      '_ppcp_paypal_order_id',
      '_klarna_order_id',
    ])
      expect(isDroppedRawKey(k)).toBe(true);
    expect(isDroppedRawKey('_order_number')).toBe(false);
    expect(isDroppedRawKey('_refund_amount')).toBe(false);
    expect(isDroppedRawKey('_stripe_fee')).toBe(false);
    expect(isDroppedRawKey('payment_method_title')).toBe(false);
  });

  it('refuses an archive without order tables', () => {
    expect(() => parseOrdersArchive({ 'manifest.txt': 'format=hpos' })).toThrow(
      OrdersArchiveParseError,
    );
  });
});

describe('wc-orders parser: HPOS tables', () => {
  const parsed = parseOrdersArchive(loadFixture('hpos'));

  it('detects the shape and the site host from the manifest', () => {
    expect(parsed.shape).toBe('hpos');
    expect(parsed.site_host).toBe('namez.se');
    expect(parsed.manifest.wc_version).toBe('8.5.1');
  });

  it('imports every shop_order, attaches refunds, skips other types', () => {
    expect(parsed.orders.map((o) => o.external_id)).toEqual([
      '1005',
      '1002',
      '1001',
    ]);
    expect(parsed.skipped).toEqual([
      { external_id: '1004', reason: 'type shop_subscription' },
    ]);
    const o1002 = parsed.orders.find((o) => o.external_id === '1002')!;
    expect(o1002.refunds).toEqual([
      {
        external_id: '1003',
        amount: '50.00',
        reason: 'Skadad vara',
        created_at: '2023-11-22T09:00:00.000Z',
      },
    ]);
    expect(parsed.orders.find((o) => o.external_id === '1003')).toBeUndefined();
  });

  it('maps the header fields of an order', () => {
    const o = parsed.orders.find((o) => o.external_id === '1001')!;
    expect(o.number).toBe('NZ-1001');
    expect(o.status).toBe('processing');
    expect(o.created_at.toISOString()).toBe('2024-03-05T10:15:00.000Z');
    expect(o.currency).toBe('SEK');
    expect(o.subtotal).toBe('250.00');
    expect(o.shipping_total).toBe('50.00');
    expect(o.discount_total).toBe('0.00');
    expect(o.tax_total).toBe('62.50');
    expect(o.total).toBe('312.50');
    expect(o.payment_method_title).toBe('Klarna');
    expect(o.shipping_method_title).toBe('Standardfrakt');
    expect(o.customer_name).toBe('Anna Svensson');
    expect(o.customer_email).toBe('anna.svensson@example.com');
    expect(o.customer_phone).toBe('+46701234567');
    expect(o.billing_address).toEqual({
      first_name: 'Anna',
      last_name: 'Svensson',
      address_1: 'Storgatan 1',
      city: 'Stockholm',
      postcode: '11122',
      country: 'SE',
      email: 'anna.svensson@example.com',
      phone: '+46701234567',
    });
    expect(o.shipping_address?.country).toBe('SE');
    // Escaped newline in the TSV round-trips.
    expect(o.customer_note).toBe('Leverera till grannen\nTack!');
  });

  it('falls back to the id as number and keeps empty payment titles null', () => {
    const o = parsed.orders.find((o) => o.external_id === '1005')!;
    expect(o.number).toBe('1005');
    expect(o.status).toBe('cancelled');
    expect(o.payment_method_title).toBeNull();
    expect(o.customer_email).toBeNull();
    expect(o.lines).toEqual([]);
  });

  it('builds lines with product refs, decoded customisation meta and fees', () => {
    const o = parsed.orders.find((o) => o.external_id === '1001')!;
    expect(o.lines).toHaveLength(2);
    const [l1, l2] = o.lines;
    expect(l1).toMatchObject({
      position: 0,
      name: 'Namnskylt trä - Röd',
      quantity: '2.00',
      unit_price: '100.00',
      line_total: '200.00',
      line_tax: '40.00',
      product_external_id: '501',
      variation_external_id: '502',
    });
    // Serialized PPOM meta decoded; underscore keys skipped; UTF-8 byte lengths honoured.
    expect(l1.meta).toEqual({
      pa_farg: 'rod',
      ppom_fields: { Namn: 'Alaa', Färg: 'Röd' },
    });
    expect(l2).toMatchObject({
      position: 1,
      name: 'Presentkort',
      product_external_id: '777',
      variation_external_id: null,
      meta: null,
    });
    const o2 = parsed.orders.find((o) => o.external_id === '1002')!;
    expect(o2.lines.map((l) => l.name)).toEqual(['Dörrskylt', 'Expressavgift']);
    expect(o2.lines[0].meta).toEqual({ 'Text på skylten': 'Välkommen' });
    expect(o2.lines[0].unit_price).toBe('120.00');
    expect(o2.lines[0].line_total).toBe('95.00');
    expect(o2.lines[1]).toMatchObject({
      quantity: '1.00',
      unit_price: null,
      line_total: '25.00',
      line_tax: '5.00',
      meta: { item_type: 'fee' },
    });
    expect(o2.discount_total).toBe('25.00');
  });

  it('keeps the merged source rows in raw without the private keys', () => {
    const o = parsed.orders.find((o) => o.external_id === '1001')!;
    const raw = o.raw as {
      order: Record<string, unknown>;
      operational: Record<string, unknown>;
      meta: Record<string, unknown>;
      items: { type: string; meta: Record<string, unknown> }[];
    };
    expect(raw.order.payment_method).toBe('klarna_payments');
    expect(raw.order).not.toHaveProperty('ip_address');
    expect(raw.order).not.toHaveProperty('user_agent');
    expect(raw.operational).not.toHaveProperty('order_key');
    expect(raw.operational).not.toHaveProperty('cart_hash');
    expect(raw.meta).toEqual({
      _order_number: 'NZ-1001',
      _billing_address_index: 'Anna Svensson Storgatan 1',
    });
    expect(raw.items.map((i) => i.type)).toEqual([
      'line_item',
      'line_item',
      'shipping',
    ]);
    expect(raw.items[0].meta._line_tax_data).toEqual({ total: { 1: '40' } });
  });
});

describe('wc-orders parser: legacy posts tables', () => {
  const parsed = parseOrdersArchive(loadFixture('legacy'));

  it('detects the legacy shape without a manifest', () => {
    expect(parsed.shape).toBe('legacy');
    expect(parsed.site_host).toBeNull();
  });

  it('imports shop_order posts, skips auto-drafts and other post types', () => {
    expect(parsed.orders.map((o) => o.external_id)).toEqual(['2001', '2002']);
    expect(parsed.skipped).toEqual([
      { external_id: '2004', reason: 'auto-draft' },
      { external_id: '2005', reason: 'post_type product' },
    ]);
  });

  it('reads totals, customer and addresses from postmeta', () => {
    const o = parsed.orders.find((o) => o.external_id === '2001')!;
    expect(o.number).toBe('#N2001');
    expect(o.status).toBe('completed');
    expect(o.created_at.toISOString()).toBe('2021-05-10T12:00:00.000Z');
    expect(o.currency).toBe('SEK');
    expect(o.subtotal).toBe('200.00');
    expect(o.shipping_total).toBe('50.00');
    expect(o.tax_total).toBe('50.00');
    expect(o.total).toBe('250.00');
    expect(o.payment_method_title).toBe('Swish');
    expect(o.shipping_method_title).toBe('Frakt');
    expect(o.customer_name).toBe('Carl Nilsson');
    expect(o.customer_email).toBe('carl@example.com');
    expect(o.billing_address).toMatchObject({
      address_1: 'Vägen 3',
      city: 'Malmö',
    });
    expect(o.shipping_address).toMatchObject({ country: 'SE' });
    expect(o.customer_note).toBe('Ring före leverans');
    expect(o.lines[0]).toMatchObject({
      name: 'Namnskylt trä',
      product_external_id: '501',
      unit_price: '100.00',
      meta: { ppom_fields: { Namn: 'Alaa', Färg: 'Röd' } },
    });
    const raw = o.raw as {
      meta: Record<string, unknown>;
      post: Record<string, unknown>;
    };
    expect(raw.meta).not.toHaveProperty('_customer_ip_address');
    expect(raw.meta).not.toHaveProperty('_customer_user_agent');
    expect(raw.post.post_type).toBe('shop_order');
  });

  it('attaches shop_order_refund posts to the parent', () => {
    const o = parsed.orders.find((o) => o.external_id === '2001')!;
    expect(o.refunds).toEqual([
      {
        external_id: '2003',
        amount: '100.00',
        reason: 'Fel storlek',
        created_at: '2021-05-12T08:00:00.000Z',
      },
    ]);
  });

  it('falls back to post_date when post_date_gmt is the zero date', () => {
    const o = parsed.orders.find((o) => o.external_id === '2002')!;
    expect(o.created_at.toISOString()).toBe('2021-06-01T09:30:00.000Z');
    expect(o.status).toBe('on-hold');
    expect(o.currency).toBe('EUR');
    expect(o.customer_name).toBe('Dora Lind');
    expect(o.lines[0].product_external_id).toBe('999');
  });
});

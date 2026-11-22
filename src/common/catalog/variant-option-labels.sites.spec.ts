import {
  renderOrderItems,
  lineVariantLabel,
} from '../../modules/mail/order-mail.helpers';
import { resolveItemName } from '../../modules/payments/kustom/kustom.mapper';
import { itemDetails } from '../../modules/invoices/invoice-snapshot.builder';
import { optionsOf } from '../../modules/feeds/feeds.service';
import {
  normalizeFacetQuery,
  runFacets,
  toFacetRow,
} from '../../modules/storefront/product-list-facets';
import { buyerOrderItem } from '../../modules/orders/buyer-order-view';
import { forGuest } from '../../modules/orders/guest-order-view';
import { buildOptionsDisplaySnapshot } from './variant-option-labels';

// M159: every API display site of the variant options. With labels / a
// display snapshot the text is translated; without, it is exactly today's.

const DE = {
  names: { Färg: 'Farbe', Storlek: 'Größe' },
  values: { Färg: { Svart: 'Schwarz' }, Storlek: { Liten: 'Klein' } },
};
const OPTIONS = { Färg: 'Svart', Storlek: 'Liten' };
const SNAP = buildOptionsDisplaySnapshot(OPTIONS, DE, 'de');

describe('order emails', () => {
  const item = (display: unknown) => ({
    id: 'i1',
    quantity: 1,
    unit_price: 10,
    product: { translations: [{ locale: 'de', title: 'Tasse' }] },
    variant: { options: OPTIONS },
    variant_options_display: display,
  });

  it('buyer email in the snapshot language is translated', () => {
    expect(lineVariantLabel(item(SNAP), 'de')).toBe(
      'Farbe: Schwarz / Größe: Klein',
    );
    const out = renderOrderItems(
      [item(SNAP)] as never,
      'EUR',
      'de',
      'http://api',
    );
    expect(out.items_text).toContain('Farbe: Schwarz / Größe: Klein');
    expect(out.items_html).toContain('Farbe: Schwarz / Größe: Klein');
  });

  it('a store-locale email stays canonical', () => {
    expect(lineVariantLabel(item(SNAP), 'sv')).toBe(
      'Färg: Svart / Storlek: Liten',
    );
  });

  it('no snapshot: byte-identical output', () => {
    const a = renderOrderItems(
      [item(null)] as never,
      'EUR',
      'de',
      'http://api',
    );
    const { variant_options_display: _d, ...plain } = item(null);
    const b = renderOrderItems([plain] as never, 'EUR', 'de', 'http://api');
    expect(a).toEqual(b);
    expect(a.items_text).toContain('Färg: Svart / Storlek: Liten');
  });
});

describe('Kustom line names', () => {
  const base = {
    id: 'i1',
    quantity: 1,
    unit_price: 10,
    total_price: 10,
    product: { translations: [{ locale: 'de', title: 'Tasse' }] },
    variant: { options: OPTIONS },
  };
  it('order line: from the snapshot of the session locale', () => {
    expect(
      resolveItemName({ ...base, variant_options_display: SNAP }, 'de'),
    ).toBe('Tasse (Schwarz / Klein)');
    expect(
      resolveItemName({ ...base, variant_options_display: SNAP }, 'sv'),
    ).toBe('Tasse (Svart / Liten)');
  });
  it('quote line: from the live labels', () => {
    expect(resolveItemName({ ...base, option_labels: DE }, 'de')).toBe(
      'Tasse (Schwarz / Klein)',
    );
  });
  it('without labels: canonical (today)', () => {
    expect(resolveItemName(base, 'de')).toBe('Tasse (Svart / Liten)');
  });
});

describe('invoice detail rows', () => {
  const item = (display: unknown) => ({
    quantity: 1,
    unit_price: 10,
    total_price: 10,
    tax_rate_bp: 0,
    variant: { options: OPTIONS },
    variant_options_display: display,
  });
  it('translated when the invoice locale matches the snapshot', () => {
    expect(itemDetails(item(SNAP), 'de')).toEqual([
      { label: 'Farbe', value: 'Schwarz' },
      { label: 'Größe', value: 'Klein' },
    ]);
  });
  it('canonical otherwise', () => {
    const canonical = [
      { label: 'Färg', value: 'Svart' },
      { label: 'Storlek', value: 'Liten' },
    ];
    expect(itemDetails(item(SNAP), 'sv')).toEqual(canonical);
    expect(itemDetails(item(null), 'de')).toEqual(canonical);
  });
});

describe('feeds colour / size', () => {
  it('uses the feed-language label, detection on canonical names', () => {
    expect(optionsOf({ Färg: 'Svart', Storlek: 'Liten' }, DE)).toEqual({
      color: 'Schwarz',
      size: 'Klein',
    });
    expect(optionsOf({ Färg: ' Svart ' })).toEqual({
      color: 'Svart',
      size: null,
    });
  });
});

describe('listing facets', () => {
  const src = (optionLabels?: typeof DE | null) => ({
    kind: 'p' as const,
    id: 'p1',
    created_at: new Date(0),
    price: 10,
    category_id: null,
    links: [],
    track_inventory: false,
    stock_quantity: null,
    variants: [
      { options: { Färg: 'Svart', Storlek: 'Liten' }, stock_quantity: 1 },
    ],
    variant_option_config: null,
    optionLabels,
  });
  it('labels translated, values (keys) canonical', () => {
    const row = toFacetRow(src(DE));
    expect([...row.colorLabels]).toEqual([['svart', 'Schwarz']]);
    expect([...row.sizeLabels]).toEqual([['liten', 'Klein']]);
    expect(row.variants[0]).toMatchObject({ color: 'svart', size: 'liten' });
  });
  it('no labels: identical row', () => {
    const { optionLabels: _o, ...plain } = src(null);
    expect(toFacetRow(src(null))).toEqual(toFacetRow(plain));
    expect([...toFacetRow(plain).colorLabels]).toEqual([['svart', 'Svart']]);
  });
  it('merged rows: a translated label wins whatever the list order', () => {
    const plain = toFacetRow({ ...src(null), id: 'p0' });
    const labelled = toFacetRow(src(DE));
    const run = (rows: ReturnType<typeof toFacetRow>[]) =>
      runFacets(
        {
          rows,
          filters: normalizeFacetQuery({}).filters,
          collections: [],
          categories: [],
        },
        true,
      ).facets!;
    for (const rows of [
      [plain, labelled],
      [labelled, plain],
    ]) {
      const f = run(rows);
      expect(f.color).toEqual([
        expect.objectContaining({ value: 'svart', label: 'Schwarz' }),
      ]);
      expect(f.size).toEqual([
        expect.objectContaining({ value: 'liten', label: 'Klein' }),
      ]);
    }
    expect(run([plain]).color[0].label).toBe('Svart');
  });
});

describe('buyer / guest order views', () => {
  it('pass the display snapshot through', () => {
    const line = {
      id: 'i1',
      provider_base_amount: 5,
      variant_options_display: SNAP,
    };
    expect(
      (buyerOrderItem(line) as Record<string, unknown>).variant_options_display,
    ).toEqual(SNAP);
    const guest = forGuest({
      id: 'o1',
      customer: {},
      items: [line],
    }) as unknown as {
      items: Record<string, unknown>[];
    };
    expect(guest.items[0].variant_options_display).toEqual(SNAP);
  });
});

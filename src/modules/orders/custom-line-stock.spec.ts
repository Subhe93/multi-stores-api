import {
  CUSTOM_LINE_STOCK_ENV,
  customLineHoldsStock,
  lineStockTarget,
  parseCustomLineStockSince,
  type StockLine,
} from './custom-line-stock';

// Imported (custom product) lines take the provider's stock from a cut-over
// moment on; orders before it never return or re-take stock for them.

describe('parseCustomLineStockSince', () => {
  it('the env name', () => {
    expect(CUSTOM_LINE_STOCK_ENV).toBe('CUSTOM_LINE_STOCK_SINCE');
  });

  it.each([
    ['unset', undefined],
    ['null', null],
    ['empty', ''],
    ['blank', '   '],
    ['garbage', 'yes'],
    ['a date only', '2026-11-20'],
    ['no zone', '2026-11-20T03:10:00'],
    ['a space instead of T', '2026-11-20 03:10:00Z'],
    ['an invalid date', '2026-13-45T25:61:00Z'],
    ['epoch millis', '1763608200000'],
  ])('%s gives null (off)', (_label, raw) => {
    expect(parseCustomLineStockSince(raw)).toBeNull();
  });

  it.each([
    ['Z', '2026-11-20T03:10:00Z', '2026-11-20T03:10:00.000Z'],
    ['Z without seconds', '2026-11-20T03:10Z', '2026-11-20T03:10:00.000Z'],
    ['milliseconds', '2026-11-20T03:10:00.250Z', '2026-11-20T03:10:00.250Z'],
    ['an offset', '2026-11-20T04:10:00+01:00', '2026-11-20T03:10:00.000Z'],
    [
      'surrounding spaces',
      ' 2026-11-20T03:10:00Z ',
      '2026-11-20T03:10:00.000Z',
    ],
  ])('%s parses', (_label, raw, iso) => {
    expect(parseCustomLineStockSince(raw)?.toISOString()).toBe(iso);
  });
});

describe('customLineHoldsStock', () => {
  const since = new Date('2026-11-20T03:10:00Z');
  it.each([
    ['before', '2026-11-20T03:09:59.999Z', false],
    ['at', '2026-11-20T03:10:00.000Z', true],
    ['after', '2026-11-21T00:00:00.000Z', true],
  ])('%s the cut-over', (_label, at, holds) => {
    expect(customLineHoldsStock(new Date(at), since)).toBe(holds);
  });

  it('off (null) never holds; a missing date never holds', () => {
    expect(customLineHoldsStock(new Date(), null)).toBe(false);
    expect(customLineHoldsStock(undefined, since)).toBe(false);
    expect(customLineHoldsStock(null, since)).toBe(false);
  });
});

describe('lineStockTarget', () => {
  const since = new Date('2026-11-20T03:10:00Z');
  const NEW = new Date('2026-11-21T10:00:00Z');
  const OLD = new Date('2026-11-01T10:00:00Z');
  const line = (over: Partial<StockLine>): StockLine => ({
    variant_id: null,
    product_id: null,
    custom_product_id: null,
    variant_options_snapshot: null,
    custom_product: null,
    variant: null,
    product: null,
    ...over,
  });
  const ownVariant = line({
    variant_id: 'v-own',
    product_id: 'p-own',
    variant_options_snapshot: { size: 'M' },
    variant: { product: { creator_id: 'c1' } },
    product: { creator_id: 'c1' },
  });
  const ownProduct = line({
    product_id: 'p-own',
    product: { creator_id: 'c1' },
  });
  const customVariant = line({
    variant_id: 'v-base',
    custom_product_id: 'cp1',
    variant_options_snapshot: { size: 'M' },
    custom_product: { product_id: 'base' },
    variant: { product: { creator_id: null } },
  });
  const customVariantless = line({
    custom_product_id: 'cp1',
    custom_product: { product_id: 'base' },
  });

  it.each([
    ['own variant', ownVariant, NEW, { kind: 'variant', id: 'v-own' }],
    [
      'own variant, old order',
      ownVariant,
      OLD,
      { kind: 'variant', id: 'v-own' },
    ],
    ['own product', ownProduct, NEW, { kind: 'product', id: 'p-own' }],
    [
      'own product, old order',
      ownProduct,
      OLD,
      { kind: 'product', id: 'p-own' },
    ],
    ['custom variant', customVariant, NEW, { kind: 'variant', id: 'v-base' }],
    [
      'custom variantless',
      customVariantless,
      NEW,
      { kind: 'product', id: 'base' },
    ],
    [
      'custom with a crafted product_id: the base, never the crafted id',
      line({
        custom_product_id: 'cp1',
        product_id: 'victim',
        custom_product: { product_id: 'base' },
        product: { creator_id: 'c9' },
      }),
      NEW,
      { kind: 'product', id: 'base' },
    ],
    [
      'deleted CustomProduct, provider variant: still resale',
      line({
        variant_id: 'v-base',
        variant_options_snapshot: { size: 'M' },
        variant: { product: { creator_id: null } },
      }),
      NEW,
      { kind: 'variant', id: 'v-base' },
    ],
    ['custom variant, old order', customVariant, OLD, null],
    ['custom variantless, old order', customVariantless, OLD, null],
    [
      'deleted CustomProduct, provider variant, old order',
      line({
        variant_id: 'v-base',
        variant: { product: { creator_id: null } },
      }),
      OLD,
      null,
    ],
    ['deleted CustomProduct, variantless: base unknown', line({}), NEW, null],
    [
      'deleted CustomProduct, variantless, legacy product_id of a provider product',
      line({ product_id: 'base', product: { creator_id: null } }),
      NEW,
      null,
    ],
    [
      'deleted own variant (snapshot kept): nothing',
      line({
        product_id: 'p-own',
        variant_options_snapshot: { size: 'M' },
        product: { creator_id: 'c1' },
      }),
      NEW,
      null,
    ],
    [
      'deleted base variant of a custom line (snapshot kept): nothing',
      line({
        custom_product_id: 'cp1',
        variant_options_snapshot: { size: 'M' },
        custom_product: { product_id: 'base' },
      }),
      NEW,
      null,
    ],
  ] as const)('%s', (_label, l, at, target) => {
    expect(lineStockTarget(l, at, since)).toEqual(target);
  });

  it('the cut-over unset: custom lines give nothing, own lines unchanged', () => {
    expect(lineStockTarget(customVariant, NEW, null)).toBeNull();
    expect(lineStockTarget(customVariantless, NEW, null)).toBeNull();
    expect(lineStockTarget(ownVariant, NEW, null)).toEqual({
      kind: 'variant',
      id: 'v-own',
    });
    expect(lineStockTarget(ownProduct, OLD, null)).toEqual({
      kind: 'product',
      id: 'p-own',
    });
  });

  it('rows loaded without relations (older readers) count as own lines', () => {
    expect(
      lineStockTarget({ variant_id: 'v1', product_id: null }, undefined, since),
    ).toEqual({ kind: 'variant', id: 'v1' });
    expect(
      lineStockTarget({ variant_id: null, product_id: 'p1' }, undefined, null),
    ).toEqual({ kind: 'product', id: 'p1' });
  });
});

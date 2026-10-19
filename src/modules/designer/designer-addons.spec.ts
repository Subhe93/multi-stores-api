import {
  addonDetailText,
  addonNamesText,
  convertAddonLines,
  enabledAddons,
  legacyAddonPresets,
  orderAddonsOf,
  priceAddons,
  readAddonsConfig,
  sanitizeSelection,
  storedAddonsValue,
  validateAddonsConfig,
} from './designer-addons';
import { DesignsService } from './designs.service';
import { DesignerCartService } from './designer-cart.service';
import { normalizeNppAddons } from './npp/npp-import.service';
import { buildKustomOrderLines } from '../payments/kustom/kustom.mapper';

// M5.5 paid designer add-ons: config validator, presets of imported NPP
// data, server pricing, selection filtering and the payment line names.

const DOUBLE = {
  key: 'double',
  type: 'toggle',
  label: { sv: 'Dubbelsidig', en: 'Double-sided' },
  price: 149,
  enabled: true,
};
const RAIN = {
  key: 'raincover',
  type: 'toggle',
  label: { sv: 'Regnskydd' },
  price: 29,
  enabled: false,
};
const POSTER = {
  key: 'poster',
  type: 'quantity',
  label: { sv: 'Poster' },
  price: 179,
  max_qty: 10,
  enabled: true,
};
const CONFIG = { v: 2, items: [DOUBLE, RAIN, POSTER] };

describe('validateAddonsConfig', () => {
  it('accepts a valid config and normalizes sort', () => {
    const res = validateAddonsConfig(CONFIG);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.items.map((i) => [i.key, i.sort])).toEqual([
      ['double', 0],
      ['raincover', 1],
      ['poster', 2],
    ]);
    expect(res.value.items[2].max_qty).toBe(10);
  });

  it('orders by sort', () => {
    const res = validateAddonsConfig({
      v: 2,
      items: [
        { ...DOUBLE, sort: 5 },
        { ...POSTER, sort: 1 },
      ],
    });
    expect(res.ok && res.value.items.map((i) => i.key)).toEqual([
      'poster',
      'double',
    ]);
  });

  it.each([
    ['unknown top-level key', { ...CONFIG, extra: 1 }, 'unknown_key'],
    [
      'unknown item key',
      { v: 2, items: [{ ...DOUBLE, colour: 'red' }] },
      'unknown_key',
    ],
    ['wrong version', { v: 1, items: [] }, 'version'],
    ['negative price', { v: 2, items: [{ ...DOUBLE, price: -1 }] }, 'price'],
    ['NaN price', { v: 2, items: [{ ...DOUBLE, price: Number.NaN }] }, 'price'],
    ['string price', { v: 2, items: [{ ...DOUBLE, price: '149' }] }, 'price'],
    [
      '3-decimal price',
      { v: 2, items: [{ ...DOUBLE, price: 1.005 }] },
      'price',
    ],
    ['bad key', { v: 2, items: [{ ...DOUBLE, key: 'Bad Key' }] }, 'key'],
    ['duplicate key', { v: 2, items: [DOUBLE, DOUBLE] }, 'duplicate_key'],
    ['bad type', { v: 2, items: [{ ...DOUBLE, type: 'radio' }] }, 'type'],
    ['empty label', { v: 2, items: [{ ...DOUBLE, label: {} }] }, 'label'],
    ['max_qty 0', { v: 2, items: [{ ...POSTER, max_qty: 0 }] }, 'max_qty'],
    ['max_qty 21', { v: 2, items: [{ ...POSTER, max_qty: 21 }] }, 'max_qty'],
    [
      'quantity without max_qty',
      { v: 2, items: [{ ...POSTER, max_qty: undefined }] },
      'max_qty',
    ],
    [
      'toggle with max_qty',
      { v: 2, items: [{ ...DOUBLE, max_qty: 3 }] },
      'max_qty',
    ],
    [
      'missing enabled',
      { v: 2, items: [{ ...DOUBLE, enabled: 'yes' }] },
      'enabled',
    ],
    [
      'more than 10 items',
      {
        v: 2,
        items: Array.from({ length: 11 }, (_, i) => ({
          ...DOUBLE,
          key: `a${i}`,
        })),
      },
      'too_many',
    ],
  ])('rejects %s', (_name, raw, rule) => {
    const res = validateAddonsConfig(raw);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.map((e) => e.rule)).toContain(rule);
  });
});

describe('legacy NPP data → suggested disabled presets', () => {
  const legacy = normalizeNppAddons(
    { double: false, raincover: false, poster: false, welcome: false },
    {
      double_extra: '149',
      rain_extra: 29,
      poster_price: 179,
      welcome_price: 99,
    },
  );

  it('offers double / rain / poster, all disabled, with the imported prices; never priced', () => {
    const presets = legacyAddonPresets(legacy);
    expect(presets.map((p) => [p.key, p.type, p.price, p.enabled])).toEqual([
      ['double', 'toggle', 149, false],
      ['raincover', 'toggle', 29, false],
      ['poster', 'quantity', 179, false],
    ]);
    expect(presets[2].max_qty).toBe(10);
    expect(presets[0].label.sv).toBe('Dubbelsidig');
    expect(Object.keys(presets[0].label).sort()).toEqual([
      'ar',
      'de',
      'en',
      'fr',
      'sv',
      'tr',
    ]);
    // The legacy shape itself is never a v2 config: nothing is priced.
    expect(readAddonsConfig(legacy)).toBeNull();
    expect(priceAddons(legacy, { double: 1 })).toEqual({ lines: [], total: 0 });
  });

  it('falls back to NPP prices when the import carried none; {} has no presets', () => {
    const noPrices = normalizeNppAddons({ double: true }, {});
    expect(legacyAddonPresets(noPrices).map((p) => p.price)).toEqual([
      149, 29, 179,
    ]);
    expect(legacyAddonPresets({})).toEqual([]);
  });

  it('a saved v2 config keeps the imported block (presets stay available)', () => {
    const res = validateAddonsConfig({ v: 2, items: [DOUBLE] });
    if (!res.ok) throw new Error('invalid');
    const stored = storedAddonsValue(res.value, legacy);
    expect(stored.imported).toEqual(legacy);
    expect(legacyAddonPresets(stored)).toHaveLength(3);
    expect(readAddonsConfig(stored)?.items).toHaveLength(1);
  });
});

describe('priceAddons (server pricing)', () => {
  it('toggle: +price once', () => {
    expect(priceAddons(CONFIG, { double: 1 }).total).toBe(149);
    // A toggle sent with qty 3 still counts once.
    expect(priceAddons(CONFIG, { double: 3 }).lines[0]).toMatchObject({
      qty: 1,
      amount: 149,
    });
  });

  it('quantity: qty × price, clamped to max_qty', () => {
    expect(priceAddons(CONFIG, { poster: 2 }).total).toBe(358);
    expect(priceAddons(CONFIG, { poster: 15 }).lines[0]).toMatchObject({
      qty: 10,
      amount: 1790,
    });
  });

  it('base + Σ toggles + Σ qty × price (NPP total)', () => {
    const { total, lines } = priceAddons(CONFIG, { double: 1, poster: 2 });
    expect(total).toBe(149 + 2 * 179);
    expect(lines.map((l) => l.key)).toEqual(['double', 'poster']);
  });

  it('disabled and unknown keys are ignored; malformed selections price 0', () => {
    expect(priceAddons(CONFIG, { raincover: 1, ghost: 1 })).toEqual({
      lines: [],
      total: 0,
    });
    expect(priceAddons(CONFIG, 'x').total).toBe(0);
    expect(priceAddons(CONFIG, { double: -1 }).total).toBe(0);
    expect(priceAddons(null, { double: 1 }).total).toBe(0);
  });

  it('enabledAddons skips disabled items', () => {
    expect(enabledAddons(CONFIG).map((i) => i.key)).toEqual([
      'double',
      'poster',
    ]);
  });

  it('DesignerCartService.lineDelta prices the design selection', () => {
    const cart = Object.create(
      DesignerCartService.prototype,
    ) as DesignerCartService;
    expect(cart.lineDelta(CONFIG, { double: 1, poster: 1 }).priceDelta).toBe(
      328,
    );
    expect(cart.lineDelta(CONFIG, null)).toEqual({ priceDelta: 0, addons: [] });
    expect(cart.lineDelta(undefined, { double: 1 })).toEqual({
      priceDelta: 0,
      addons: [],
    });
  });
});

describe('selection', () => {
  it('sanitizeSelection checks the shape only', () => {
    expect(sanitizeSelection({ double: 1, poster: 0 })).toEqual({ double: 1 });
    expect(sanitizeSelection({ double: 1.5 })).toBeNull();
    expect(sanitizeSelection({ 'Bad Key': 1 })).toBeNull();
    expect(sanitizeSelection({ double: 21 })).toBeNull();
    expect(sanitizeSelection([])).toBeNull();
  });

  it('DesignsService.selectionFor keeps only enabled add-ons and clamps', async () => {
    const prisma = {
      productDesigner: {
        findUnique: jest.fn(() => Promise.resolve({ addons: CONFIG })),
      },
    };
    const svc = Object.create(DesignsService.prototype) as DesignsService;
    (svc as unknown as { prisma: unknown }).prisma = prisma;
    await expect(
      svc.selectionFor('p1', { double: 2, raincover: 1, ghost: 1, poster: 30 }),
    ).rejects.toMatchObject({ response: { code: 'DESIGNER_ADDONS_INVALID' } });
    await expect(
      svc.selectionFor('p1', { double: 2, raincover: 1, ghost: 1, poster: 12 }),
    ).resolves.toEqual({ double: 1, poster: 10 });
    await expect(svc.selectionFor('p1', { raincover: 1 })).resolves.toBeNull();
    await expect(svc.selectionFor('p1', {})).resolves.toBeNull();
    await expect(svc.selectionFor('p1', 'nope')).rejects.toMatchObject({
      response: { code: 'DESIGNER_ADDONS_INVALID' },
    });
  });
});

describe('market conversion + display', () => {
  it('converts each unit price (amount = unit × qty)', () => {
    const { lines } = priceAddons(CONFIG, { double: 1, poster: 3 });
    const convert = jest.fn((a: number) => Math.round(a * 0.0917 * 100) / 100);
    const conv = convertAddonLines(lines, convert);
    expect(convert).toHaveBeenCalledWith(149);
    expect(convert).toHaveBeenCalledWith(179);
    expect(conv.lines[1]).toMatchObject({ unit_price: 16.41, amount: 49.23 });
    expect(conv.total).toBe(Math.round((13.66 + 49.23) * 100) / 100);
    expect(convertAddonLines(lines, null).total).toBe(149 + 537);
  });

  it('readable details', () => {
    const { lines } = priceAddons(CONFIG, { double: 1, poster: 2 });
    expect(addonDetailText(lines[0], 'SEK', 'sv')).toMatch(/^\+149\s?kr$/);
    expect(addonDetailText(lines[1], 'SEK', 'sv')).toMatch(
      /^× 2 \(\+358\s?kr\)$/,
    );
    expect(addonNamesText(lines, 'sv')).toBe('Dubbelsidig, Poster × 2');
    expect(addonNamesText(lines, 'en')).toBe('Double-sided, Poster × 2');
  });

  it('orderAddonsOf reads the frozen breakdown (empty on old rows)', () => {
    expect(orderAddonsOf({ designer_delta: 0, addons: [] })).toEqual([]);
    expect(orderAddonsOf(null)).toEqual([]);
    expect(
      orderAddonsOf({
        addons: [
          {
            key: 'double',
            type: 'toggle',
            label: { sv: 'D' },
            qty: 1,
            unit_price: 149,
            amount: 149,
          },
        ],
      })[0],
    ).toMatchObject({ key: 'double', amount: 149 });
  });
});

describe('Kustom order lines', () => {
  const base = {
    currency: 'SEK',
    shipping_cost: 0,
    discount_amount: 0,
    tax_pricing_mode: 'INCLUSIVE' as const,
  };

  it('a quote item names its add-ons and carries the add-on-inclusive amounts', () => {
    const { lines } = priceAddons(CONFIG, { double: 1, poster: 2 });
    const unit = 299 + 507;
    const [line] = buildKustomOrderLines(
      {
        ...base,
        total: unit * 2,
        items: [
          {
            id: 'p1',
            quantity: 2,
            unit_price: unit,
            total_price: unit * 2,
            tax_rate_bp: 2500,
            tax_amount: (unit * 2) / 5,
            product: { translations: [{ locale: 'sv', title: 'Poster' }] },
            designer_addons: lines,
          },
        ],
      },
      'sv',
    );
    expect(line.name).toBe('Poster + Dubbelsidig, Poster × 2');
    expect(line.unit_price).toBe(80600);
    expect(line.total_amount).toBe(161200);
    expect(line.tax_rate).toBe(2500);
  });

  it('an order item reads the add-ons from its frozen design; plain lines keep their name', () => {
    const [designed, plain] = buildKustomOrderLines(
      {
        ...base,
        total: 448 + 299,
        items: [
          {
            id: 'i1',
            quantity: 1,
            unit_price: 448,
            total_price: 448,
            product: { translations: [{ locale: 'sv', title: 'Poster' }] },
            design: {
              price_breakdown: {
                designer_delta: 149,
                addons: [
                  {
                    key: 'double',
                    type: 'toggle',
                    label: { sv: 'Dubbelsidig' },
                    qty: 1,
                    unit_price: 149,
                    amount: 149,
                  },
                ],
              },
            },
          },
          {
            id: 'i2',
            quantity: 1,
            unit_price: 299,
            total_price: 299,
            product: { translations: [{ locale: 'sv', title: 'Poster' }] },
            design: { price_breakdown: { designer_delta: 0, addons: [] } },
          },
        ],
      },
      'sv',
    );
    expect(designed.name).toBe('Poster + Dubbelsidig');
    expect(designed.total_amount).toBe(44800);
    expect(plain.name).toBe('Poster');
  });
});

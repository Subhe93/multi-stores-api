import { validateOptionConfig } from './personalization-config.validator';
import { introducesCardConfig } from './personalization-option-refs';
import { shapeOptionConfigForStorefront } from './personalization-runtime';
import { resolveOptionConfig } from '../importer/apply/apply-products';

// Variant cards v2: option-level `card_layout` / `card_show_savings` and
// valueMeta `ribbon` / `ribbon_color` / `units` / `i18n.*.ribbon`.

const option = (extra: Record<string, unknown>, meta?: unknown) => [
  {
    name: 'Antal',
    style: 'card',
    values: ['1', '3'],
    ...extra,
    ...(meta !== undefined ? { valueMeta: { '3': meta } } : {}),
  },
];
const codes = (issues: { path: string; code: string }[]) =>
  issues.map((i) => `${i.path}:${i.code}`);
const P = 'variant_option_config[0].valueMeta.3';

describe('validateOptionConfig - cards v2 keys', () => {
  it('accepts every valid new key', () => {
    expect(
      validateOptionConfig(
        option(
          { card_layout: 'list', card_show_savings: false },
          {
            label: '3 st',
            ribbon: 'Best seller',
            ribbon_color: '#111827',
            units: 3,
            i18n: { sv: { ribbon: 'Bästsäljare', label: '3 st' } },
          },
        ),
      ),
    ).toEqual([]);
    expect(
      validateOptionConfig(
        option(
          { card_layout: 'grid', card_show_savings: true },
          { ribbon: '', ribbon_color: '#fff', units: 99 },
        ),
      ),
    ).toEqual([]);
    expect(validateOptionConfig(option({}, { units: 2 }))).toEqual([]);
    // null clears like the existing keys.
    expect(
      validateOptionConfig(
        option(
          { card_layout: null, card_show_savings: null },
          { ribbon: null, ribbon_color: null, units: null },
        ),
      ),
    ).toEqual([]);
  });

  it('option-level keys are checked without valueMeta too', () => {
    expect(
      codes(
        validateOptionConfig(
          option({ card_layout: 'carousel', card_show_savings: 'yes' }),
        ),
      ),
    ).toEqual([
      'variant_option_config[0].card_layout:INVALID_VALUE',
      'variant_option_config[0].card_show_savings:INVALID_VALUE',
    ]);
    expect(codes(validateOptionConfig(option({ card_layout: 1 })))).toEqual([
      'variant_option_config[0].card_layout:INVALID_VALUE',
    ]);
  });

  it('rejects invalid value-level keys', () => {
    expect(
      codes(
        validateOptionConfig(
          option({}, { ribbon: 'x'.repeat(41), ribbon_color: 'red', units: 1 }),
        ),
      ),
    ).toEqual([
      `${P}.ribbon:INVALID_VALUE`,
      `${P}.ribbon_color:INVALID_HEX`,
      `${P}.units:OUT_OF_RANGE`,
    ]);
    expect(
      codes(validateOptionConfig(option({}, { ribbon: 5, units: 100 }))),
    ).toEqual([`${P}.ribbon:INVALID_VALUE`, `${P}.units:OUT_OF_RANGE`]);
    expect(codes(validateOptionConfig(option({}, { units: 2.5 })))).toEqual([
      `${P}.units:OUT_OF_RANGE`,
    ]);
    expect(codes(validateOptionConfig(option({}, { units: '3' })))).toEqual([
      `${P}.units:OUT_OF_RANGE`,
    ]);
    expect(
      codes(
        validateOptionConfig(
          option({}, { i18n: { en: { ribbon: 'x'.repeat(41) } } }),
        ),
      ),
    ).toEqual([`${P}.i18n.en.ribbon:TOO_LONG`]);
    expect(
      codes(validateOptionConfig(option({}, { i18n: { en: { ribbon: 1 } } }))),
    ).toEqual([`${P}.i18n.en.ribbon:INVALID_VALUE`]);
  });

  it('existing keys keep their limits; unknown keys are still rejected', () => {
    expect(
      validateOptionConfig(option({}, { badge: 'x'.repeat(200) })),
    ).toEqual([]);
    expect(
      validateOptionConfig(
        option({}, { i18n: { en: { badge: 'x'.repeat(200) } } }),
      ),
    ).toEqual([]);
    expect(
      codes(validateOptionConfig(option({}, { ribbon_text: 'x' }))),
    ).toEqual([`${P}.ribbon_text:UNKNOWN_KEY`]);
  });
});

describe('introducesCardConfig - option-level card keys', () => {
  const stored = option({ card_layout: 'grid' }, { badge: 'x' });

  it('unchanged keys pass; a changed layout or savings flag needs the app', () => {
    expect(introducesCardConfig(stored, stored)).toBe(false);
    expect(
      introducesCardConfig(
        stored,
        option({ card_layout: 'list' }, { badge: 'x' }),
      ),
    ).toBe(true);
    expect(
      introducesCardConfig(
        stored,
        option(
          { card_layout: 'grid', card_show_savings: false },
          { badge: 'x' },
        ),
      ),
    ).toBe(true);
  });

  it('removing them is allowed', () => {
    expect(introducesCardConfig(stored, option({}, { badge: 'x' }))).toBe(
      false,
    );
  });
});

describe('shapeOptionConfigForStorefront - cards v2', () => {
  it('app off strips the option-level card keys; app on keeps them', () => {
    const config = option(
      { card_layout: 'list', card_show_savings: false },
      { ribbon: 'Best seller', units: 3 },
    );
    expect(shapeOptionConfigForStorefront(config, true)).toBe(config);
    expect(shapeOptionConfigForStorefront(config, false)).toEqual([
      { name: 'Antal', style: 'text', values: ['1', '3'] },
    ]);
  });
});

describe('resolveOptionConfig - re-import keeps dashboard-only card keys', () => {
  const ctx: any = { media: new Map() };

  it('carries card_layout, card_show_savings, ribbon, ribbon_color, units and i18n ribbon', () => {
    const out = resolveOptionConfig(
      ctx,
      [
        {
          name: 'Antal',
          style: 'card',
          values: ['1', '3'],
          valueMeta: {
            '3': { badge: 'Populär' },
          },
        },
      ],
      [
        {
          name: 'Antal',
          style: 'card',
          card_layout: 'list',
          card_show_savings: false,
          values: ['1', '3', '5'],
          valueMeta: {
            '3': {
              badge: 'Old',
              ribbon: 'Bästsäljare',
              ribbon_color: '#111827',
              units: 3,
              i18n: { en: { badge: 'Old', ribbon: 'Best seller' } },
            },
            '5': { ribbon: 'Gone' },
          },
        },
      ],
    ) as any[];
    expect(out[0]).toEqual({
      name: 'Antal',
      style: 'card',
      values: ['1', '3'],
      card_layout: 'list',
      card_show_savings: false,
      valueMeta: {
        '3': {
          // The source wins for imported keys.
          badge: 'Populär',
          ribbon: 'Bästsäljare',
          ribbon_color: '#111827',
          units: 3,
          i18n: { en: { ribbon: 'Best seller' } },
        },
      },
    });
  });

  it('nothing stored: output unchanged', () => {
    const out = resolveOptionConfig(
      ctx,
      [{ name: 'Antal', style: 'text', values: ['1'] }],
      null,
    ) as any[];
    expect(out[0]).toEqual({ name: 'Antal', style: 'text', values: ['1'] });
  });
});

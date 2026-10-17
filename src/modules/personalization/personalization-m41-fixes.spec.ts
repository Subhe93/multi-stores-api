import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { Logger } from '@nestjs/common';
import {
  validateFieldConfig,
  validateOptionConfig,
} from './personalization-config.validator';
import {
  brokenOptionReferences,
  introducesCardConfig,
  optionReferencesOf,
} from './personalization-option-refs';
import { fieldReferencesTo } from './personalization-json';
import { remapLinkTarget } from './personalization-library.service';
import {
  createServerPatternTester,
  isKnownSlowPattern,
  TIMED_OUT_PATTERN_TTL_MS,
} from '../../common/personalization/pattern-tester';
import {
  CustomFieldTranslationDto,
  isBoundedLabelMap,
} from '../custom-fields/dto/custom-field.dto';

// M4.1 fixes: the pure parts (config validator bounds, option and field
// references, library link remap, pattern tester memory and budget, DTO
// bounds).

const OPTIONS = [
  { name: 'Färg', values: ['Röd', 'Blå'] },
  { name: 'Välj antal', values: ['1 produkt', '2 produkter'] },
];

const codes = (issues: { path: string; code: string }[]) =>
  issues.map((i) => `${i.path}:${i.code}`);

describe('validateFieldConfig pricing (per_option)', () => {
  const draft = (extra: Record<string, unknown>) => ({
    name: 'f',
    type: 'SELECT',
    sort_order: 0,
    options: ['S', 'M'],
    ...extra,
  });

  it('keys must be options of the field (NOT_IN_OPTIONS)', () => {
    expect(
      codes(
        validateFieldConfig(
          draft({
            pricing: { mode: 'per_option', option_prices: { S: 1, XL: 2 } },
          }),
          [],
          OPTIONS,
        ),
      ),
    ).toEqual(['pricing.option_prices.XL:NOT_IN_OPTIONS']);
  });

  it('a prototype name that is not an option is NOT_IN_OPTIONS too', () => {
    const option_prices = JSON.parse(
      '{"__proto__": 1, "constructor": 2}',
    ) as Record<string, number>;
    expect(
      codes(
        validateFieldConfig(
          draft({ pricing: { mode: 'per_option', option_prices } }),
          [],
          OPTIONS,
        ),
      ),
    ).toEqual([
      'pricing.option_prices.__proto__:NOT_IN_OPTIONS',
      'pricing.option_prices.constructor:NOT_IN_OPTIONS',
    ]);
  });

  it('per_option needs a non-empty option list (FONT included)', () => {
    expect(
      codes(
        validateFieldConfig(
          draft({
            type: 'FONT',
            options: [],
            pricing: { mode: 'per_option', option_prices: {} },
          }),
          [],
          OPTIONS,
        ),
      ),
    ).toEqual(['options:INVALID_VALUE']);
  });

  it('a palette read from an option prices that option’s values', () => {
    const base = {
      name: 'p',
      type: 'COLOR_PALETTE',
      sort_order: 0,
      ui: { palette_from_option: 'Färg' },
    };
    expect(
      validateFieldConfig(
        {
          ...base,
          pricing: { mode: 'per_option', option_prices: { Röd: 5 } },
        },
        [],
        OPTIONS,
      ),
    ).toEqual([]);
    expect(
      codes(
        validateFieldConfig(
          {
            ...base,
            pricing: { mode: 'per_option', option_prices: { Grön: 5 } },
          },
          [],
          OPTIONS,
        ),
      ),
    ).toEqual(['pricing.option_prices.Grön:NOT_IN_OPTIONS']);
  });
});

describe('validateFieldConfig JSON bounds', () => {
  const long = 'x'.repeat(121);

  it('caps key lengths of option_prices, palette_hex and count.map at 120', () => {
    expect(
      codes(
        validateFieldConfig(
          {
            name: 'f',
            type: 'SELECT',
            sort_order: 0,
            options: [long],
            pricing: { mode: 'per_option', option_prices: { [long]: 1 } },
          },
          [],
          OPTIONS,
        ),
      ),
    ).toContain('pricing.option_prices:TOO_LONG');
    expect(
      codes(
        validateFieldConfig(
          {
            name: 'p',
            type: 'COLOR_PALETTE',
            sort_order: 0,
            options: ['a'],
            ui: { palette_hex: { [long]: '#ffffff' } },
          },
          [],
          OPTIONS,
        ),
      ),
    ).toEqual(['ui.palette_hex:TOO_LONG']);
    expect(
      codes(
        validateFieldConfig(
          {
            name: 'r',
            type: 'REPEATER',
            sort_order: 0,
            repeat: {
              count: { option: 'Välj antal', map: { [long]: 1 } },
              start_index: 1,
              max: 5,
            },
          },
          [],
          OPTIONS,
        ),
      ),
    ).toEqual(['repeat.count.map:TOO_LONG']);
  });

  it('ui.font_family is a plain font list (no CSS injection characters)', () => {
    const check = (font_family: string) =>
      codes(
        validateFieldConfig(
          { name: 'f', type: 'TEXT', sort_order: 0, ui: { font_family } },
          [],
          OPTIONS,
        ),
      );
    expect(check(`"Playfair Display", serif`)).toEqual([]);
    expect(check('Arial; } body { color: red')).toEqual([
      'ui.font_family:INVALID_VALUE',
    ]);
    expect(check('url(x)')).toEqual(['ui.font_family:INVALID_VALUE']);
  });
});

describe('validateOptionConfig valueMeta', () => {
  const config = (valueMeta: unknown) => [
    { name: 'Färg', values: ['Röd'], valueMeta },
  ];

  it('paths are variant_option_config[i].valueMeta.<value>.<key>', () => {
    expect(
      codes(validateOptionConfig(config({ Röd: { badge_color: 'red' } }))),
    ).toEqual([
      'variant_option_config[0].valueMeta.Röd.badge_color:INVALID_HEX',
    ]);
  });

  it('i18n holds label/sublabel/badge strings per locale, within limits', () => {
    expect(
      validateOptionConfig(
        config({ Röd: { i18n: { en: { label: 'Red', badge: 'New' } } } }),
      ),
    ).toEqual([]);
    expect(
      codes(
        validateOptionConfig(
          config({
            Röd: {
              i18n: {
                en: { label: 'x'.repeat(201), color: 'x', badge: 3 },
                'not a locale': { label: 'x' },
                de: 'Rot',
              },
            },
          }),
        ),
      ),
    ).toEqual([
      'variant_option_config[0].valueMeta.Röd.i18n.en.color:UNKNOWN_KEY',
      'variant_option_config[0].valueMeta.Röd.i18n.en.label:TOO_LONG',
      'variant_option_config[0].valueMeta.Röd.i18n.en.badge:INVALID_VALUE',
      'variant_option_config[0].valueMeta.Röd.i18n:INVALID_VALUE',
      'variant_option_config[0].valueMeta.Röd.i18n.de:INVALID_SHAPE',
    ]);
  });

  it('valueMeta keys longer than 120 are TOO_LONG', () => {
    const long = 'x'.repeat(121);
    expect(
      codes(
        validateOptionConfig([
          { name: 'Färg', values: [long], valueMeta: { [long]: {} } },
        ]),
      ),
    ).toEqual(['variant_option_config[0].valueMeta:TOO_LONG']);
  });
});

describe('option references', () => {
  const fields = [
    {
      id: 'r1',
      name: 'dnc_items',
      parent_id: null,
      type: 'REPEATER',
      repeat: {
        count: { option: 'Välj antal', map: { '2 produkter': 2 } },
        start_index: 2,
        max: 5,
        lead: { options: ['Färg'] },
      },
    },
    {
      id: 'c1',
      name: 'color',
      parent_id: 'r1',
      type: 'COLOR_PALETTE',
      ui: { palette_from_option: 'Färg' },
      pricing: { mode: 'per_option', option_prices: { Blå: 5 } },
    },
    {
      id: 'f2',
      name: 'engraving',
      parent_id: null,
      type: 'TEXT',
      conditions: {
        match: 'all',
        rules: [{ source: 'option', key: 'Gravyr', op: 'eq', value: 'Ja' }],
      },
    },
  ];
  const before = [...OPTIONS, { name: 'Gravyr', values: ['Ja', 'Nej'] }];

  it('collects names and values from repeat, lead, palette, pricing and conditions', () => {
    expect(optionReferencesOf(fields[0])).toEqual([
      { option: 'Välj antal' },
      { option: 'Välj antal', value: '2 produkter' },
      { option: 'Färg' },
    ]);
    expect(optionReferencesOf(fields[1])).toEqual([
      { option: 'Färg' },
      { option: 'Färg', value: 'Blå' },
    ]);
  });

  it('an unchanged config breaks nothing', () => {
    expect(brokenOptionReferences(fields, before, before)).toEqual({
      fields: [],
      options: [],
    });
  });

  it('a renamed option breaks every field that reads it', () => {
    const after = before.map((o) =>
      o.name === 'Färg' ? { ...o, name: 'Colour' } : o,
    );
    expect(brokenOptionReferences(fields, before, after)).toEqual({
      fields: ['dnc_items', 'dnc_items.color'],
      options: ['Färg'],
    });
  });

  it('a removed referenced value breaks; an unreferenced one does not', () => {
    const noBlue = before.map((o) =>
      o.name === 'Färg' ? { ...o, values: ['Röd'] } : o,
    );
    expect(brokenOptionReferences(fields, before, noBlue).fields).toEqual([
      'dnc_items.color',
    ]);
    const noNej = before.map((o) =>
      o.name === 'Gravyr' ? { ...o, values: ['Ja'] } : o,
    );
    expect(brokenOptionReferences(fields, before, noNej).fields).toEqual([]);
  });

  it('references that were already broken are not reported', () => {
    const withoutGravyr = OPTIONS;
    expect(
      brokenOptionReferences(fields, withoutGravyr, withoutGravyr).fields,
    ).toEqual([]);
  });

  it('card keys: new or changed values need the app; unchanged ones and removals do not', () => {
    const cards = [
      {
        name: 'Färg',
        values: ['Röd'],
        style: 'card',
        valueMeta: { Röd: { badge: 'Ny', label: 'Röd' } },
      },
    ];
    expect(introducesCardConfig(OPTIONS, cards)).toBe(true);
    // Same content, other key order: unchanged.
    const reordered = [
      {
        valueMeta: { Röd: { label: 'Röd', badge: 'Ny' } },
        style: 'card',
        values: ['Röd'],
        name: 'Färg',
      },
    ];
    expect(introducesCardConfig(cards, reordered)).toBe(false);
    expect(
      introducesCardConfig(cards, [
        { ...cards[0], valueMeta: { Röd: { badge: 'Rea' } } },
      ]),
    ).toBe(true);
    expect(introducesCardConfig(cards, OPTIONS)).toBe(false);
    expect(introducesCardConfig(cards, [{ ...cards[0], valueMeta: {} }])).toBe(
      false,
    );
  });
});

describe('fieldReferencesTo', () => {
  const rows = [
    { id: 'a', name: 'name_1', parent_id: null },
    {
      id: 'b',
      name: 'name_2',
      parent_id: null,
      linked_validation: { type: 'equal_length', target: 'name_1' },
    },
    {
      id: 'c',
      name: 'gift',
      parent_id: null,
      conditions: {
        match: 'all',
        rules: [{ source: 'field', key: 'name_1', op: 'set' }],
      },
    },
    {
      id: 'r',
      name: 'items',
      parent_id: null,
      repeat: { lead: { fields: ['name_1'] } },
    },
    {
      id: 'k1',
      name: 'child_a',
      parent_id: 'r',
    },
    {
      id: 'k2',
      name: 'child_b',
      parent_id: 'r',
      linked_validation: { type: 'equal_length', target: 'k1' },
    },
  ];

  it('links, field conditions and lead lists of a top-level field', () => {
    expect(
      fieldReferencesTo({ id: 'a', name: 'name_1', parent_id: null }, rows),
    ).toEqual(['name_2', 'gift', 'items']);
  });

  it('a child: sibling links only (legacy id targets too)', () => {
    expect(
      fieldReferencesTo({ id: 'k1', name: 'child_a', parent_id: 'r' }, rows),
    ).toEqual(['child_b']);
  });

  it('a repeater: its own children do not count', () => {
    expect(
      fieldReferencesTo({ id: 'r', name: 'items', parent_id: null }, rows),
    ).toEqual([]);
  });
});

describe('remapLinkTarget (library save)', () => {
  const names = new Map([['id-1', 'first']]);

  it('rewrites a legacy id target (target or target_field_id) to the name', () => {
    expect(
      remapLinkTarget({ type: 'equal_length', target: 'id-1' }, names),
    ).toEqual({ type: 'equal_length', target: 'first' });
    expect(
      remapLinkTarget(
        { type: 'max_combined', target_field_id: 'id-1', max: 5 },
        names,
      ),
    ).toEqual({ type: 'max_combined', target: 'first', max: 5 });
  });

  it('leaves name targets and null alone', () => {
    const link = { type: 'equal_length', target: 'first' };
    expect(remapLinkTarget(link, names)).toBe(link);
    expect(remapLinkTarget(null, names)).toBeNull();
  });
});

describe('server pattern tester (memory and budget)', () => {
  const EVIL = '^([A-Za-z]+ ?)+$';
  const EVIL_INPUT = 'Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!';
  const field = { id: 'f', name: 'f', type: 'TEXT', is_required: false };
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('a timed-out pattern fails closed later without running again', () => {
    const tester = createServerPatternTester();
    expect(tester(EVIL, EVIL_INPUT, field)).toBe(false);
    expect(isKnownSlowPattern(EVIL)).toBe(true);
    // Would match, but the pattern is known to be slow: refused without
    // running (no second timeout warning is logged).
    const warnings = warn.mock.calls.length;
    expect(createServerPatternTester()(EVIL, 'Anna', field)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(warnings);
  });

  it('the total vm time of one evaluation is capped', () => {
    const tester = createServerPatternTester(0);
    // Would match, but the evaluation has no vm time left: fails closed
    // without running the pattern.
    expect(tester('^[A-Z]+$', 'ANNA', field)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('budget'));
    expect(isKnownSlowPattern('^[A-Z]+$')).toBe(false);
  });

  it('a remembered timeout expires', () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(now);
      createServerPatternTester()(EVIL, EVIL_INPUT, field);
      clock.mockReturnValue(now + TIMED_OUT_PATTERN_TTL_MS + 1);
      expect(isKnownSlowPattern(EVIL)).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it('a pattern that does not compile is still ignored (true)', () => {
    expect(createServerPatternTester(0)('^(abc$', 'x', field)).toBe(true);
  });
});

describe('CustomFieldTranslationDto bounds', () => {
  const errorsOf = async (raw: Record<string, unknown>) =>
    (await validate(plainToInstance(CustomFieldTranslationDto, raw))).map(
      (e) => e.property,
    );

  it('locale is a language code of at most 10 characters', async () => {
    expect(await errorsOf({ locale: 'sv', label: 'x' })).toEqual([]);
    expect(await errorsOf({ locale: 'en-US', label: 'x' })).toEqual([]);
    expect(await errorsOf({ locale: '<script>', label: 'x' })).toEqual([
      'locale',
    ]);
    expect(await errorsOf({ locale: 'abcdefghijk', label: 'x' })).toEqual([
      'locale',
    ]);
  });

  it('option_labels is a bounded {value: label} map', async () => {
    expect(
      await errorsOf({ locale: 'sv', label: 'x', option_labels: { a: 'A' } }),
    ).toEqual([]);
    expect(
      await errorsOf({ locale: 'sv', label: 'x', option_labels: ['A'] }),
    ).toEqual(['option_labels']);
    expect(isBoundedLabelMap({ a: 'x'.repeat(501) })).toBe(false);
    expect(isBoundedLabelMap({ a: { nested: true } })).toBe(false);
    const many = Object.fromEntries(
      Array.from({ length: 201 }, (_, i) => [`v${i}`, 'x']),
    );
    expect(isBoundedLabelMap(many)).toBe(false);
  });
});

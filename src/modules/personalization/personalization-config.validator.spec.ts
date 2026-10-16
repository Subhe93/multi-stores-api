import {
  type ConfigDraft,
  type ConfigSibling,
  validateFieldConfig,
  validateOptionConfig,
  validateTranslationExtras,
} from './personalization-config.validator';

const OPTIONS = [
  { name: 'Välj antal', values: ['1 produkt', '2 produkter', '3 produkter'] },
  { name: 'Färg', values: ['Röd', 'Blå'], colorMap: { Röd: '#dd3333' } },
];

const SIBLINGS: ConfigSibling[] = [
  {
    id: 'a',
    name: 'custom_name_v3',
    type: 'TEXT',
    parent_id: null,
    sort_order: 0,
  },
  {
    id: 'r',
    name: 'dnc_items',
    type: 'REPEATER',
    parent_id: null,
    sort_order: 1,
  },
  {
    id: 'c1',
    name: 'color',
    type: 'COLOR_PALETTE',
    parent_id: 'r',
    sort_order: 0,
  },
  { id: 'z', name: 'later', type: 'TEXT', parent_id: null, sort_order: 5 },
];

function codes(draft: Partial<ConfigDraft>, siblings = SIBLINGS, opts = {}) {
  return validateFieldConfig(
    { name: 'x', type: 'TEXT', sort_order: 3, ...draft },
    siblings,
    OPTIONS,
    opts,
  ).map((i) => `${i.path}:${i.code}`);
}

describe('validateFieldConfig (M4.1 §4.1)', () => {
  it('accepts a plain field and the namez P3 repeater', () => {
    expect(codes({})).toEqual([]);
    expect(
      codes({
        name: 'dnc_items2',
        type: 'REPEATER',
        repeat: {
          count: { option: 'Välj antal', map: { '1 produkt': 1 } },
          start_index: 2,
          max: 5,
          lead: { fields: ['custom_name_v3'], options: ['Färg'] },
        },
        ui: { placement: 'after_variants', validation_summary: true },
      }),
    ).toEqual([]);
  });

  it('tree rules: child types, child conditions, repeater top level only', () => {
    expect(codes({ parent_id: 'r', type: 'REPEATER', repeat: null })).toEqual(
      expect.arrayContaining([
        'type:CHILD_TYPE_NOT_ALLOWED',
        'parent_id:REPEATER_TOP_LEVEL_ONLY',
      ]),
    );
    expect(codes({ parent_id: 'r', type: 'IMAGE' })).toContain(
      'type:CHILD_TYPE_NOT_ALLOWED',
    );
    expect(
      codes({
        parent_id: 'r',
        conditions: {
          match: 'all',
          rules: [{ source: 'option', key: 'Färg', op: 'set' }],
        },
      }),
    ).toContain('conditions:CHILD_NO_CONDITIONS');
    expect(codes({ parent_id: 'missing' })).toContain(
      'parent_id:PARENT_NOT_FOUND',
    );
    expect(codes({ parent_id: 'a' })).toContain(
      'parent_id:PARENT_NOT_REPEATER',
    );
    expect(codes({ parent_id: 'r' })).toEqual([]);
  });

  it('repeat is required on a REPEATER and only there', () => {
    expect(codes({ type: 'REPEATER' })).toContain('repeat:REPEAT_REQUIRED');
    expect(
      codes({
        repeat: { count: { option: 'Välj antal' }, start_index: 1, max: 1 },
      }),
    ).toContain('repeat:REPEAT_ONLY_REPEATER');
    expect(
      codes({ id: 'r', name: 'dnc_items', type: 'TEXT' }, SIBLINGS, {
        hasChildren: true,
      }),
    ).toContain('type:REPEATER_HAS_CHILDREN');
  });

  it('repeat: option exists, start/max 1..20, lead fields earlier and top level', () => {
    const rep = (repeat: unknown) => codes({ type: 'REPEATER', repeat });
    expect(
      rep({ count: { option: 'Nope' }, start_index: 2, max: 5 }),
    ).toContain('repeat.count.option:UNKNOWN_OPTION');
    expect(
      rep({ count: { option: 'Välj antal' }, start_index: 0, max: 21 }),
    ).toEqual(
      expect.arrayContaining([
        'repeat.start_index:OUT_OF_RANGE',
        'repeat.max:OUT_OF_RANGE',
      ]),
    );
    expect(
      rep({
        count: { option: 'Välj antal', map: { a: 101 } },
        start_index: 1,
        max: 2,
      }),
    ).toContain('repeat.count.map.a:OUT_OF_RANGE');
    expect(
      rep({
        count: { option: 'Välj antal' },
        start_index: 2,
        max: 5,
        lead: { fields: ['later', 'color', 'nope'], options: ['Storlek'] },
      }),
    ).toEqual(
      expect.arrayContaining([
        'repeat.lead.fields[0]:FORWARD_REFERENCE',
        'repeat.lead.fields[1]:UNKNOWN_FIELD',
        'repeat.lead.fields[2]:UNKNOWN_FIELD',
        'repeat.lead.options[0]:UNKNOWN_OPTION',
      ]),
    );
    expect(
      rep({
        count: { option: 'Välj antal' },
        start_index: 2,
        max: 5,
        extra: 1,
      }),
    ).toContain('repeat.extra:UNKNOWN_KEY');
  });

  it('conditions: option / earlier field keys, ops and values', () => {
    const cond = (rules: unknown[], match = 'all') =>
      codes({ conditions: { match, rules } });
    expect(
      cond([
        { source: 'option', key: 'Välj antal', op: 'gte', value: 2 },
        { source: 'field', key: 'custom_name_v3', op: 'set' },
        { source: 'option', key: 'Färg', op: 'in', value: ['Röd'] },
      ]),
    ).toEqual([]);
    expect(
      cond([{ source: 'option', key: 'Storlek', op: 'eq', value: 'S' }]),
    ).toContain('conditions.rules[0].key:UNKNOWN_OPTION');
    expect(cond([{ source: 'field', key: 'later', op: 'set' }])).toContain(
      'conditions.rules[0].key:FORWARD_REFERENCE',
    );
    expect(cond([{ source: 'field', key: 'color', op: 'set' }])).toContain(
      'conditions.rules[0].key:UNKNOWN_FIELD',
    );
    expect(
      cond([{ source: 'option', key: 'Färg', op: 'gte', value: 'x' }]),
    ).toContain('conditions.rules[0].value:INVALID_VALUE');
    expect(
      cond([{ source: 'option', key: 'Färg', op: 'like', value: 'x' }]),
    ).toContain('conditions.rules[0].op:INVALID_VALUE');
    expect(
      cond([{ source: 'option', key: 'Färg', op: 'set', value: 'x' }]),
    ).toContain('conditions.rules[0].value:INVALID_VALUE');
    expect(cond([], 'all')).toContain('conditions.rules:OUT_OF_RANGE');
    expect(
      cond([{ source: 'option', key: 'Färg', op: 'set' }], 'some'),
    ).toContain('conditions.match:INVALID_VALUE');
  });

  it('pricing: non-negative, mode allowed for the type', () => {
    expect(codes({ pricing: { mode: 'fixed', amount: 10.5 } })).toEqual([]);
    expect(codes({ pricing: { mode: 'per_char', amount: '1,50' } })).toEqual(
      [],
    );
    expect(codes({ pricing: { mode: 'fixed', amount: -1 } })).toContain(
      'pricing.amount:NEGATIVE_PRICE',
    );
    expect(codes({ pricing: { mode: 'fixed', amount: '-1' } })).toContain(
      'pricing.amount:NEGATIVE_PRICE',
    );
    expect(codes({ pricing: { mode: 'fixed', amount: 1.234 } })).toContain(
      'pricing.amount:INVALID_PRICE',
    );
    expect(codes({ pricing: { mode: 'per_item', amount: 1 } })).toContain(
      'pricing.mode:PRICING_NOT_ALLOWED',
    );
    expect(
      codes({
        type: 'SELECT',
        options: ['a'],
        pricing: { mode: 'per_option', option_prices: { a: 5, b: -2 } },
      }),
    ).toEqual(['pricing.option_prices.b:NEGATIVE_PRICE']);
    expect(codes({ pricing: { mode: 'free' } })).toContain(
      'pricing.mode:INVALID_VALUE',
    );
  });

  it('ui: enums, insert_char, default_checked ⊆ options, palette option, hex', () => {
    expect(
      codes({
        ui: {
          placement: 'before_variants',
          transform: 'uppercase',
          counter: 'linked',
          insert_char: '❤',
          limit_to_target: true,
        },
      }),
    ).toEqual([]);
    expect(codes({ ui: { placement: 'top' } })).toContain(
      'ui.placement:INVALID_VALUE',
    );
    expect(codes({ ui: { insert_char: '❤❤' } })).toContain(
      'ui.insert_char:INVALID_VALUE',
    );
    expect(codes({ ui: { foo: 1 } })).toContain('ui.foo:UNKNOWN_KEY');
    expect(
      codes({
        type: 'CHECKBOX_GROUP',
        options: ['A', 'B'],
        ui: { default_checked: ['A', 'C'] },
      }),
    ).toEqual(['ui.default_checked[1]:NOT_IN_OPTIONS']);
    expect(
      codes({ type: 'COLOR_PALETTE', ui: { palette_from_option: 'Färg' } }),
    ).toEqual([]);
    expect(
      codes({ type: 'COLOR_PALETTE', ui: { palette_from_option: 'Nope' } }),
    ).toContain('ui.palette_from_option:UNKNOWN_OPTION');
    expect(
      codes({
        type: 'COLOR_PALETTE',
        options: ['Röd'],
        ui: { palette_hex: { Röd: 'red' } },
      }),
    ).toContain('ui.palette_hex.Röd:INVALID_HEX');
    expect(codes({ type: 'COLOR_PALETTE' })).toContain('options:INVALID_VALUE');
  });

  it('linked_validation.target must be a sibling in the same set (C16)', () => {
    expect(
      codes({
        linked_validation: { type: 'equal_length', target: 'custom_name_v3' },
      }),
    ).toEqual([]);
    expect(
      codes({ linked_validation: { type: 'equal_length', target: 'color' } }),
    ).toContain('linked_validation.target:LINK_TARGET_NOT_SIBLING');
    expect(
      codes({
        parent_id: 'r',
        linked_validation: { type: 'equal_length', target: 'color' },
      }),
    ).toEqual([]);
  });
});

describe('validateTranslationExtras', () => {
  it('checks message keys, lengths and the help image URL', () => {
    expect(
      validateTranslationExtras(
        {
          help_image_url: 'https://cdn.example/x.jpg',
          messages: { required: 'x', equal_length: 'y' },
        },
        't',
      ),
    ).toEqual([]);
    expect(
      validateTranslationExtras(
        { help_image_url: '/uploads/imports/a.jpg' },
        't',
      ),
    ).toEqual([]);
    const bad = validateTranslationExtras(
      {
        help_image_url: 'javascript:alert(1)',
        messages: { nope: 'x', required: 5 },
        note: 'x'.repeat(2001),
      },
      't',
    ).map((i) => `${i.path}:${i.code}`);
    expect(bad).toEqual(
      expect.arrayContaining([
        't.help_image_url:INVALID_URL',
        't.messages.nope:UNKNOWN_KEY',
        't.messages.required:INVALID_VALUE',
        't.note:TOO_LONG',
      ]),
    );
    expect(
      validateTranslationExtras({ help_image_url: '//evil.example/x' }, 't'),
    ).toHaveLength(1);
  });
});

describe('validateOptionConfig (cards)', () => {
  it('valueMeta keys ⊆ values, badge_color hex, count 0..100', () => {
    expect(
      validateOptionConfig([
        {
          name: 'Välj antal',
          style: 'card',
          values: ['3'],
          valueMeta: {
            '3': {
              label: 'Mest Populärt ⭐',
              badge_color: '#FFD84D',
              count: 3,
            },
          },
        },
      ]),
    ).toEqual([]);
    expect(
      validateOptionConfig([
        {
          name: 'A',
          values: ['1'],
          valueMeta: {
            '2': { badge_color: 'yellow', count: 101, swatch_image: 'x' },
          },
        },
      ]).map((i) => i.code),
    ).toEqual(
      expect.arrayContaining([
        'NOT_IN_OPTIONS',
        'INVALID_HEX',
        'OUT_OF_RANGE',
        'UNKNOWN_KEY',
      ]),
    );
  });
});

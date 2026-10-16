/**
 * Test fixture (M4.1 WP-C specs): a namez-like product with the
 * personalization app's config — P2 single name (lead field), P3 repeater
 * "Artikel {i}" with a colour palette and a name per item, priced per item —
 * plus an M4.0 product row shape for the "app off" comparisons. Rows look
 * like Prisma rows (every M4.1 column present, null when unused).
 */

export const PRODUCT_ID = 'p1';
export const F_NAME = 'aaaaaaaa-0000-4000-8000-000000000001';
export const F_REP = 'aaaaaaaa-0000-4000-8000-000000000002';
export const C_COLOR = 'aaaaaaaa-0000-4000-8000-000000000003';
export const C_NAME = 'aaaaaaaa-0000-4000-8000-000000000004';
export const F_PLAIN = 'aaaaaaaa-0000-4000-8000-000000000005';

const tr = (
  locale: string,
  label: string,
  extra: Record<string, unknown> = {},
) => ({
  id: `t-${locale}-${label}`,
  field_id: 'x',
  locale,
  label,
  placeholder: null,
  option_labels: null,
  display_label: null,
  sublabel: null,
  note: null,
  help_text: null,
  help_image_url: null,
  messages: null,
  ...extra,
});

const base = {
  product_id: PRODUCT_ID,
  options: null,
  validation_rules: null,
  linked_validation: null,
  parent_id: null,
  conditions: null,
  pricing: null,
  repeat: null,
  ui: null,
  preset_key: null,
  preset_ref: null,
  created_at: new Date('2026-10-01T00:00:00Z'),
  updated_at: new Date('2026-10-01T00:00:00Z'),
};

/** The app product's fields, flat (children carry `parent_id`). */
export function appFields() {
  return [
    {
      ...base,
      id: F_NAME,
      name: 'custom_name_v3',
      type: 'TEXT',
      is_required: true,
      sort_order: 0,
      validation_rules: { max_length: 12, allowed_chars: 'A-Za-zÅÄÖåäö0-9' },
      ui: { placement: 'after_variants' },
      preset_key: 'single_name',
      translations: [
        tr('sv', 'Skriv namn här:', {
          display_label: 'Namn',
          messages: { required: 'Vänligen skriv ett namn.' },
        }),
        tr('en', 'Write the name here:', { display_label: 'Name' }),
      ],
    },
    {
      ...base,
      id: F_REP,
      name: 'dnc_items',
      type: 'REPEATER',
      is_required: false,
      sort_order: 1,
      pricing: { mode: 'per_item', amount: 25 },
      repeat: {
        count: { option: 'Välj antal' },
        start_index: 2,
        max: 5,
        lead: { fields: ['custom_name_v3'], options: ['Färg'] },
      },
      ui: { placement: 'after_variants', validation_summary: true },
      preset_key: 'name_color_per_item',
      preset_ref: 'woo:namez.se:product:4106',
      translations: [tr('sv', 'Artikel {i}'), tr('en', 'Item {i}')],
    },
    {
      ...base,
      id: C_COLOR,
      name: 'color',
      type: 'COLOR_PALETTE',
      is_required: true,
      sort_order: 0,
      parent_id: F_REP,
      ui: { palette_from_option: 'Färg' },
      translations: [
        tr('sv', 'Färg', {
          messages: { required: 'Artikel {i}: Färg måste väljas' },
        }),
        tr('en', 'Colour'),
      ],
    },
    {
      ...base,
      id: C_NAME,
      name: 'name',
      type: 'TEXT',
      is_required: true,
      sort_order: 1,
      parent_id: F_REP,
      validation_rules: { max_length: 12 },
      translations: [
        tr('sv', 'Skriv namn här:', { display_label: 'Namn' }),
        tr('en', 'Name'),
      ],
    },
  ];
}

/** An M4.0 product's field (no M4.1 config), as Prisma returns it today. */
export function plainFields() {
  return [
    {
      ...base,
      id: F_PLAIN,
      name: 'name_1',
      type: 'TEXT',
      is_required: true,
      sort_order: 0,
      validation_rules: { max_length: 11 },
      translations: [tr('sv', 'Namn'), tr('en', 'Name')],
    },
  ];
}

/** The same row as the M4.0 API returned it (before the M4.1 columns). */
export function plainFieldsM40() {
  return [
    {
      product_id: PRODUCT_ID,
      options: null,
      validation_rules: { max_length: 11 },
      linked_validation: null,
      created_at: new Date('2026-10-01T00:00:00Z'),
      updated_at: new Date('2026-10-01T00:00:00Z'),
      id: F_PLAIN,
      name: 'name_1',
      type: 'TEXT',
      is_required: true,
      sort_order: 0,
      translations: [
        {
          id: 't-sv-Namn',
          field_id: 'x',
          locale: 'sv',
          label: 'Namn',
          placeholder: null,
          option_labels: null,
        },
        {
          id: 't-en-Name',
          field_id: 'x',
          locale: 'en',
          label: 'Name',
          placeholder: null,
          option_labels: null,
        },
      ],
    },
  ];
}

export const OPTION_CONFIG = [
  {
    name: 'Välj antal',
    style: 'card',
    values: ['1 produkt', '2 produkter', '3 produkter'],
    valueMeta: {
      '3 produkter': { label: '3 st', badge: 'Mest populärt', count: 3 },
    },
  },
  {
    name: 'Färg',
    style: 'color',
    values: ['Röd', 'Blå'],
    colorMap: { Röd: '#dd3333', Blå: '#3333dd' },
  },
];

/** Variant of the app product: 3 items, red lead item, +200 on 299. */
export const VARIANT = {
  id: 'v3',
  product_id: PRODUCT_ID,
  options: { 'Välj antal': '3 produkter', Färg: 'Röd' },
  price_adjustment: 200,
  is_active: true,
  stock_quantity: null,
};

/** Valid raw values for VARIANT: lead name + items 2 and 3. */
export function validValues(): Record<string, unknown> {
  return {
    [F_NAME]: 'Kristofer',
    [F_REP]: [
      { [C_COLOR]: 'Blå', [C_NAME]: 'karin ' },
      { [C_COLOR]: 'Röd', [C_NAME]: 'Olle' },
    ],
  };
}

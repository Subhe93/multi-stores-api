import {
  hasExtraValue,
  linesToDisplay,
  personalizationInvalid,
  shapeFieldsForStorefront,
  shapeOptionConfigForStorefront,
  stripEmptyExtraColumns,
  usesAdvancedFields,
  usesAdvancedOptionConfig,
} from './personalization-runtime';
import { buildStorefrontApps } from '../store-apps/storefront-apps';
import {
  OPTION_CONFIG,
  appFields,
  plainFields,
  plainFieldsM40,
} from './__fixtures__/app-fields';
import type { PLine } from '../../common/personalization/types';

// M4.1 WP-C pure helpers: the gate, the payload shaping that keeps stores
// without the app byte-identical, and the cart display mapping.

describe('personalization runtime helpers', () => {
  it('gate: only M4.1 features count (children and app-only types included)', () => {
    expect(usesAdvancedFields(plainFields())).toBe(false);
    expect(usesAdvancedFields(appFields())).toBe(true);
    expect(usesAdvancedFields([])).toBe(false);
    expect(usesAdvancedFields(null)).toBe(false);
    expect(usesAdvancedOptionConfig(null)).toBe(false);
    expect(usesAdvancedOptionConfig([{ name: 'A', style: 'text' }])).toBe(
      false,
    );
    expect(usesAdvancedOptionConfig(OPTION_CONFIG)).toBe(true);
  });

  it('off shaping of M4.0 rows is byte-identical to the pre-M4.1 rows', () => {
    expect(JSON.stringify(shapeFieldsForStorefront(plainFields(), false))).toBe(
      JSON.stringify(plainFieldsM40()),
    );
    expect(
      JSON.stringify(plainFields().map((r) => stripEmptyExtraColumns(r))),
    ).toBe(JSON.stringify(plainFieldsM40()));
  });

  it('public rows keep stored M4.1 values (never lost when the app is off)', () => {
    const [name] = appFields();
    const row = stripEmptyExtraColumns(name) as Record<string, unknown>;
    expect(row.ui).toEqual({ placement: 'after_variants' });
    expect(row).not.toHaveProperty('conditions');
    expect(
      (row.translations as Record<string, unknown>[])[0].display_label,
    ).toBe('Namn');
    expect(hasExtraValue(name)).toBe(true);
    expect(plainFields().some((r) => hasExtraValue(r))).toBe(false);
  });

  it('option config: untouched without card config; stripped when off', () => {
    const plain = [{ name: 'Färg', style: 'color', values: ['Röd'] }];
    expect(shapeOptionConfigForStorefront(plain, false)).toBe(plain);
    expect(shapeOptionConfigForStorefront(OPTION_CONFIG, true)).toBe(
      OPTION_CONFIG,
    );
    const withSwatch = [
      {
        name: 'Font',
        style: 'card',
        values: ['A'],
        swatchMap: { A: '/a.png' },
        valueMeta: { A: { badge: 'x' } },
      },
    ];
    expect(shapeOptionConfigForStorefront(withSwatch, false)).toEqual([
      {
        name: 'Font',
        style: 'text',
        values: ['A'],
        swatchMap: { A: '/a.png' },
      },
    ]);
  });

  it('display lines follow the web mapping (ids, display only when different)', () => {
    const line = (over: Partial<PLine>): PLine => ({
      field_id: 'f1',
      field_name: 'size',
      source: 'FIELD',
      type: 'SELECT',
      label: 'Storlek',
      value: 'S',
      display_value: 'Liten',
      is_file: false,
      group_key: null,
      group_index: null,
      group_label: null,
      price_delta: '0.00',
      price_delta_minor: 0,
      meta: null,
      sort_order: 0,
      i18n: { label: null, display_value: null, group_label: null },
      ...over,
    });
    expect(
      linesToDisplay([
        line({}),
        line({
          field_id: null,
          field_name: 'Färg',
          source: 'OPTION',
          type: 'OPTION',
          label: 'Färg',
          value: 'Röd',
          display_value: 'Röd',
          group_key: 'dnc_items',
          group_index: 1,
          group_label: 'Artikel 1',
          meta: { hex: '#dd3333', option_name: 'Färg' },
        }),
      ]),
    ).toEqual([
      {
        id: 'f1',
        label: 'Storlek',
        value: 'S',
        display: 'Liten',
        source: 'FIELD',
      },
      {
        id: 'option:Färg#1',
        label: 'Färg',
        value: 'Röd',
        display: null,
        group_key: 'dnc_items',
        group_index: 1,
        group_label: 'Artikel 1',
        hex: '#dd3333',
        source: 'OPTION',
      },
    ]);
  });

  it('PERSONALIZATION_INVALID envelope carries errors and the line ref', () => {
    const err = personalizationInvalid(
      [
        {
          code: 'CUSTOM_FIELD_REQUIRED',
          field_id: 'f',
          field_name: 'n',
          message: '',
        },
      ],
      { line_index: 2 },
    );
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toEqual({
      code: 'PERSONALIZATION_INVALID',
      message: 'Please check your personalization',
      errors: [
        {
          code: 'CUSTOM_FIELD_REQUIRED',
          field_id: 'f',
          field_name: 'n',
          message: '',
        },
      ],
      line_index: 2,
    });
  });

  it('public settings: whitelist only, leniently parsed with defaults', () => {
    const apps = buildStorefrontApps([
      {
        app_key: 'personalization',
        available: true,
        enabled: true,
        settings: {
          card_price_mode: 'from',
          free_shipping_country: 'SE',
          retention_days: 90,
          url_prefill: { name1: 'custom_name_v3', 'bad key!': 'x' },
        },
      },
    ]);
    expect(apps.personalization).toEqual({
      enabled: true,
      settings: {
        free_shipping_badge: true,
        card_price_mode: 'from',
        validation_summary: true,
        url_prefill: { name1: 'custom_name_v3' },
        listing_cta: 'personalize',
      },
    });
  });
});

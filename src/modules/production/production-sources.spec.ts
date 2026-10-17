import {
  buildLineSources,
  readValueSnapshot,
  sourceHash,
  type ProductionSourceLine,
  type ProductionValueRow,
} from './production-sources';
import {
  DEFAULT_PRODUCTION_SETTINGS,
  PRODUCTION_PRESETS,
  normalizeProductionSettings,
  type ProductionSettings,
} from './production-settings';
import { valueRow } from './fake-production-prisma.mockspec';

const settings = (over: Partial<ProductionSettings> = {}) =>
  normalizeProductionSettings({ ...DEFAULT_PRODUCTION_SETTINGS, ...over });

const line = (
  over: Partial<ProductionSourceLine> = {},
): ProductionSourceLine => ({
  id: 'i1',
  fulfiller_type: 'CREATOR',
  fulfiller_id: 'cr1',
  variant: null,
  custom_field_values: [],
  ...over,
});

const row = (id: string, over: Record<string, unknown> = {}) =>
  valueRow(id, over) as unknown as ProductionValueRow;

describe('production sources (M4.3 §3.2, C24)', () => {
  it('one check per value row, labelled from the snapshot in the primary locale', () => {
    const out = buildLineSources(
      line({
        custom_field_values: [
          row('v1', {
            value: 'ANNA',
            field_name: 'name_1',
            field_label: { sv: 'Namn', en: 'Name' },
            sort_order: 0,
          }),
          row('v2', {
            value: 'S',
            field_type: 'SELECT',
            field_label: { sv: 'Storlek' },
            display_value: { sv: 'Liten', en: 'Small' },
            sort_order: 1,
          }),
        ],
      }),
      settings(),
      'sv',
    );
    expect(out.map((s) => [s.source_key, s.label, s.value])).toEqual([
      ['fv:v1', 'Namn', 'ANNA'],
      ['fv:v2', 'Storlek', 'Liten'],
    ]);
    expect(out.every((s) => s.source === 'FIELD_VALUE')).toBe(true);
  });

  it('a deleted field (custom_field_id null, no live field) still yields its check from the snapshot', () => {
    const out = buildLineSources(
      line({
        custom_field_values: [
          row('v1', {
            custom_field_id: null,
            custom_field: null,
            value: 'KARIN',
            field_name: 'gone',
            field_label: { sv: 'Gammalt fält' },
          }),
        ],
      }),
      settings(),
      'sv',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ label: 'Gammalt fält', value: 'KARIN' });
  });

  it('pre-M4.0 rows (no snapshot) fall back to the live field translations', () => {
    const snap = readValueSnapshot(
      row('v1', {
        field_type: null,
        value: 'S',
        custom_field: {
          name: 'size',
          type: 'SELECT',
          translations: [
            { locale: 'sv', label: 'Storlek', option_labels: { S: 'Liten' } },
          ],
        },
      }),
      'sv',
    );
    expect(snap).toMatchObject({ label: 'Storlek', value: 'Liten' });
  });

  it('empty values are skipped; file rows keep the thumbnail and no text value', () => {
    const out = buildLineSources(
      line({
        custom_field_values: [
          row('v1', { value: '' }),
          row('v2', { value: null }),
          row('v3', {
            field_type: 'IMAGE',
            value: '/uploads/p.webp',
            file_url: '/uploads/p.webp',
            field_label: { sv: 'Foto' },
          }),
        ],
      }),
      settings(),
      'sv',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source_key: 'fv:v3',
      value: null,
      file_url: '/uploads/p.webp',
    });
  });

  it('repeater rows get the group label as prefix', () => {
    const out = buildLineSources(
      line({
        custom_field_values: [
          row('v1', {
            value: 'ALICE',
            field_label: { sv: 'Namn' },
            group_index: 2,
            group_label: { sv: 'Artikel 2' },
          }),
          row('v2', {
            value: 'BOB',
            field_label: { sv: 'Namn' },
            group_index: 3,
          }),
        ],
      }),
      settings(),
      'sv',
    );
    expect(out.map((s) => s.label)).toEqual(['Artikel 2 – Namn', '#3 – Namn']);
    expect(out[0].group_index).toBe(2);
  });

  it('variant attributes are checks; the quantity attribute is excluded (namez preset)', () => {
    const l = line({
      variant_options_snapshot: { Färg: 'Röd', 'Välj antal': 'tre' },
    });
    const all = buildLineSources(l, settings(), 'sv');
    expect(all.map((s) => s.source_key).sort()).toEqual([
      'opt:Färg',
      'opt:Välj antal',
    ]);
    const namez = buildLineSources(
      l,
      normalizeProductionSettings(PRODUCTION_PRESETS.namez),
      'sv',
    );
    expect(namez.map((s) => [s.source, s.source_key, s.value])).toEqual([
      ['VARIANT_OPTION', 'opt:Färg', 'Röd'],
    ]);
    expect(
      buildLineSources(l, settings({ include_variant_options: false }), 'sv'),
    ).toEqual([]);
  });

  it('an M4.1 OPTION value row suppresses the matching opt: check', () => {
    const out = buildLineSources(
      line({
        variant_options_snapshot: { Färg: 'Röd' },
        custom_field_values: [
          row('v1', {
            source: 'OPTION',
            value: 'Röd',
            field_name: 'Färg',
            meta: { option_name: 'Färg' },
            group_index: 1,
            group_label: { sv: 'Artikel 1' },
          }),
        ],
      }),
      settings(),
      'sv',
    );
    expect(out.map((s) => s.source_key)).toEqual(['fv:v1']);
  });

  it('exclusions by field type and by field name or label', () => {
    const out = buildLineSources(
      line({
        custom_field_values: [
          row('v1', { value: 'x', field_type: 'DATE' }),
          row('v2', { value: 'y', field_name: 'internal_note' }),
          row('v3', { value: 'z', field_label: { sv: 'Hemlig' } }),
          row('v4', { value: 'keep', field_label: { sv: 'Namn' } }),
        ],
      }),
      settings({
        exclude_field_types: ['DATE'],
        exclude_field_names: ['Internal-Note', 'hemlig'],
      }),
      'sv',
    );
    expect(out.map((s) => s.source_key)).toEqual(['fv:v4']);
  });

  it('default custom items are appended per line with stable keys', () => {
    const out = buildLineSources(
      line(),
      settings({ default_custom_items: ['Packed', 'QC photo'] }),
      'sv',
    );
    expect(out.map((s) => [s.source, s.source_key])).toEqual([
      ['CUSTOM', 'custom:default:packed'],
      ['CUSTOM', 'custom:default:qc-photo'],
    ]);
  });

  it('builds are deterministic (stable keys and hashes)', () => {
    const l = line({
      variant_options_snapshot: { Färg: 'Röd' },
      custom_field_values: [row('v1', { value: 'ANNA' })],
    });
    const a = buildLineSources(l, settings(), 'sv');
    const b = buildLineSources(l, settings(), 'sv');
    expect(a).toEqual(b);
    expect(sourceHash('b', null)).toBe(sourceHash('b', null));
    expect(sourceHash('b', null)).not.toBe(sourceHash('c', null));
    expect(sourceHash('b', null)).not.toBe(sourceHash('b', '/f.png'));
    expect(sourceHash('b', null)).toHaveLength(64);
  });

  it('the hash covers value and file only: a relabel never changes it', () => {
    const a = buildLineSources(
      line({
        custom_field_values: [
          row('v1', { value: 'ANNA', field_label: { sv: 'Namn' } }),
        ],
      }),
      settings(),
      'sv',
    )[0];
    const b = buildLineSources(
      line({
        custom_field_values: [
          row('v1', { value: 'ANNA', field_label: { sv: 'Förnamn' } }),
        ],
      }),
      settings(),
      'sv',
    )[0];
    expect(a.label).not.toBe(b.label);
    expect(sourceHash(a.value, a.file_url)).toBe(
      sourceHash(b.value, b.file_url),
    );
  });

  it('opt: checks come from the order-time snapshot, never the live variant', () => {
    const out = buildLineSources(
      line({
        variant_options_snapshot: { Färg: 'Röd' },
        // The variant was edited after the order.
        variant: { options: { Färg: 'Blå', Storlek: 'L' } },
      }),
      settings(),
      'sv',
    );
    expect(out.map((s) => [s.source_key, s.value, s.insert_only])).toEqual([
      ['opt:Färg', 'Röd', undefined],
    ]);
    // Variant deleted: the snapshot still yields the check.
    expect(
      buildLineSources(
        line({ variant_options_snapshot: { Färg: 'Röd' }, variant: null }),
        settings(),
        'sv',
      ).map((s) => s.source_key),
    ).toEqual(['opt:Färg']);
  });

  it('a pre-snapshot line seeds opt: checks from the live variant as insert-only', () => {
    const out = buildLineSources(
      line({
        variant_options_snapshot: null,
        variant: { options: { Färg: 'Röd' } },
      }),
      settings(),
      'sv',
    );
    expect(out).toEqual([
      expect.objectContaining({ source_key: 'opt:Färg', insert_only: true }),
    ]);
    expect(buildLineSources(line({ variant: null }), settings(), 'sv')).toEqual(
      [],
    );
  });
});

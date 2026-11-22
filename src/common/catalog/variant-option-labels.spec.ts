import {
  buildOptionsDisplaySnapshot,
  formatOptionPairs,
  formatOptionValues,
  labelRowsForLocale,
  labelsForLocale,
  normalizeVariantOptionLabels,
  optionDisplayEntries,
  optionNameLabel,
  optionValueLabel,
  productOptionSet,
  pruneVariantOptionLabels,
  readVariantOptionLabels,
  relabelOptionLines,
  sameVariantOptionLabels,
  snapshotEntriesFor,
  trimLabelRows,
  type RelabelableLine,
} from './variant-option-labels';

const DE = {
  names: { Färg: 'Farbe', Storlek: 'Größe' },
  values: { Färg: { Svart: 'Schwarz', Vit: 'Weiß' } },
};

describe('variant-option-labels', () => {
  it('parses defensively', () => {
    expect(readVariantOptionLabels(null)).toBeNull();
    expect(readVariantOptionLabels('x')).toBeNull();
    expect(
      readVariantOptionLabels({ names: { a: 1, b: '' }, values: { c: 'x' } }),
    ).toBeNull();
    expect(
      readVariantOptionLabels({
        names: { a: 'A' },
        values: { c: { d: 'D', e: 3 } },
      }),
    ).toEqual({
      names: { a: 'A' },
      values: { c: { d: 'D' } },
    });
  });

  it('picks exact locale, then base language, never en', () => {
    const rows = [
      { locale: 'sv', variant_option_labels: null },
      { locale: 'en', variant_option_labels: { names: { Färg: 'Colour' } } },
      { locale: 'de', variant_option_labels: DE },
    ];
    expect(labelsForLocale(rows, 'de')).toEqual(DE);
    expect(labelsForLocale(rows, 'de-AT')).toEqual(DE);
    expect(labelsForLocale(rows, 'fr')).toBeNull();
    expect(labelsForLocale(rows, 'sv')).toBeNull();
    expect(labelsForLocale(undefined, 'de')).toBeNull();
  });

  it('falls back to canonical strings', () => {
    expect(optionNameLabel(DE, 'Färg')).toBe('Farbe');
    expect(optionNameLabel(DE, 'Djur')).toBe('Djur');
    expect(optionValueLabel(DE, 'Färg', 'Svart')).toBe('Schwarz');
    expect(optionValueLabel(DE, 'Färg', 'Röd')).toBe('Röd');
    expect(optionValueLabel(null, 'Färg', 'Svart')).toBe('Svart');
    expect(optionNameLabel(DE, 'constructor')).toBe('constructor');
  });

  it('builds entries in map order and formats', () => {
    const entries = optionDisplayEntries({ Storlek: 'M', Färg: 'Svart' }, DE);
    expect(entries.map((e) => e.name)).toEqual(['Storlek', 'Färg']);
    expect(formatOptionPairs(entries)).toBe('Größe: M / Farbe: Schwarz');
    expect(formatOptionValues(entries)).toBe('M / Schwarz');
    expect(
      formatOptionPairs(optionDisplayEntries({ Färg: 'Svart' }, null)),
    ).toBe('Färg: Svart');
  });

  it('snapshot is null when nothing differs, and matches by base language', () => {
    expect(buildOptionsDisplaySnapshot({ Djur: 'Zebra' }, DE, 'de')).toBeNull();
    expect(
      buildOptionsDisplaySnapshot({ Färg: 'Svart' }, null, 'de'),
    ).toBeNull();
    const snap = buildOptionsDisplaySnapshot({ Färg: 'Svart' }, DE, 'de');
    expect(snap).toEqual({
      locale: 'de',
      entries: [
        {
          name: 'Färg',
          value: 'Svart',
          name_label: 'Farbe',
          value_label: 'Schwarz',
        },
      ],
    });
    expect(snapshotEntriesFor(snap, 'de-AT')).toEqual(snap!.entries);
    expect(snapshotEntriesFor(snap, 'sv')).toBeNull();
    expect(snapshotEntriesFor(null, 'de')).toBeNull();
  });

  it('collects the option set from variants and config', () => {
    const set = productOptionSet(
      [{ Färg: 'Svart' }, { Färg: 'Vit', Storlek: 'M' }, null],
      [{ name: 'Färg', values: ['Röd'] }, { name: 'Djur' }],
    );
    expect([...set.keys()]).toEqual(['Färg', 'Storlek', 'Djur']);
    expect([...set.get('Färg')!]).toEqual(['Svart', 'Vit', 'Röd']);
  });

  it('normalizes: trims, drops empty / equal, flags unknown keys and limits', () => {
    const set = productOptionSet([{ Färg: 'Svart' }, { Färg: 'Orange' }], null);
    const ok = normalizeVariantOptionLabels(
      {
        names: { Färg: '  Farbe\n' },
        values: { Färg: { Svart: 'Schwarz', Orange: 'Orange' } },
      },
      set,
    );
    expect(ok.issues).toEqual([]);
    expect(ok.labels).toEqual({
      names: { Färg: 'Farbe' },
      values: { Färg: { Svart: 'Schwarz' } },
    });
    expect(
      normalizeVariantOptionLabels({ names: { Färg: '' } }, set).labels,
    ).toBeNull();

    const bad = normalizeVariantOptionLabels(
      { names: { Djur: 'Tier' }, values: { Färg: { Lila: 'Lila!' } } },
      set,
    );
    expect(bad.issues).toEqual([
      { path: 'names.Djur', reason: 'unknown_option' },
      { path: 'values.Färg.Lila', reason: 'unknown_option' },
    ]);
    expect(
      normalizeVariantOptionLabels({ names: { Färg: 'x'.repeat(81) } }, set)
        .issues[0].reason,
    ).toBe('too_long');
    expect(
      normalizeVariantOptionLabels({ names: 'x' }, set).issues[0].reason,
    ).toBe('shape');
    expect(
      normalizeVariantOptionLabels({ other: 1 }, set).issues[0].reason,
    ).toBe('shape');
    expect(normalizeVariantOptionLabels(null, set)).toEqual({
      labels: null,
      issues: [],
    });
  });

  it('prunes stored labels silently', () => {
    const set = productOptionSet([{ Färg: 'Vit' }], null);
    expect(pruneVariantOptionLabels(DE, set)).toEqual({
      names: { Färg: 'Farbe' },
      values: { Färg: { Vit: 'Weiß' } },
    });
    expect(
      pruneVariantOptionLabels(DE, productOptionSet([{ Djur: 'Zebra' }], null)),
    ).toBeNull();
  });

  it('compares labels ignoring key order', () => {
    expect(
      sameVariantOptionLabels(
        { names: { a: 'A', b: 'B' } },
        { names: { b: 'B', a: 'A' } },
      ),
    ).toBe(true);
    expect(sameVariantOptionLabels(null, undefined)).toBe(true);
    expect(sameVariantOptionLabels(DE, null)).toBe(false);
  });

  it('relabels OPTION lines only and keeps canonical keys', () => {
    const optionLine: RelabelableLine = {
      source: 'OPTION',
      label: 'Färg',
      value: 'Svart',
      display_value: 'Svart',
      field_name: 'Färg',
      meta: { option_name: 'Färg' },
      i18n: {
        label: { sv: 'Färg' },
        display_value: { sv: 'Svart' },
        group_label: null,
      },
    };
    const fieldLine: RelabelableLine = {
      ...optionLine,
      source: 'FIELD',
      label: 'Text',
    };
    const [o, f] = relabelOptionLines([optionLine, fieldLine], DE, 'de', 'sv');
    expect(o.label).toBe('Farbe');
    expect(o.display_value).toBe('Schwarz');
    expect(o.value).toBe('Svart');
    expect(o.field_name).toBe('Färg');
    expect(o.i18n).toEqual({
      label: { sv: 'Färg', de: 'Farbe' },
      display_value: { sv: 'Svart', de: 'Schwarz' },
      group_label: null,
    });
    expect(f).toBe(fieldLine);
    expect(optionLine.label).toBe('Färg');
    expect(relabelOptionLines([optionLine], DE, 'sv', 'sv')[0]).toBe(
      optionLine,
    );
    expect(relabelOptionLines([optionLine], null, 'de', 'sv')[0]).toBe(
      optionLine,
    );
  });

  describe('palette FIELD lines (palette_from_option)', () => {
    const paletteDef = (ownDe?: Record<string, string>) => ({
      id: 'c-color',
      type: 'COLOR_PALETTE',
      ui: { palette_from_option: 'Färg' },
      translations: [
        { locale: 'sv', option_labels: null },
        ...(ownDe ? [{ locale: 'de', option_labels: ownDe }] : []),
      ],
    });
    const line: RelabelableLine = {
      source: 'FIELD',
      field_id: 'c-color',
      label: 'Färg',
      value: 'Svart',
      display_value: 'Svart',
      field_name: 'Färg',
      meta: null,
      i18n: { label: null, display_value: null, group_label: null },
    };
    it('takes the product option label; value stays canonical', () => {
      const [l] = relabelOptionLines([line], DE, 'de', 'sv', [
        { id: 'rep', type: 'REPEATER', children: [paletteDef()] },
      ]);
      expect(l.display_value).toBe('Schwarz');
      expect(l.value).toBe('Svart');
      expect(l.i18n?.display_value).toEqual({ sv: 'Svart', de: 'Schwarz' });
    });
    it("keeps the field's own label of the locale", () => {
      const own = { ...line, display_value: 'Tiefschwarz' };
      expect(
        relabelOptionLines([own], DE, 'de', 'sv', [
          paletteDef({ Svart: 'Tiefschwarz' }),
        ])[0],
      ).toBe(own);
    });
    it('no defs, no palette option or primary locale: unchanged', () => {
      expect(relabelOptionLines([line], DE, 'de', 'sv')[0]).toBe(line);
      const plainDef = { ...paletteDef(), ui: {} };
      expect(relabelOptionLines([line], DE, 'de', 'sv', [plainDef])[0]).toBe(
        line,
      );
      expect(
        relabelOptionLines([line], DE, 'sv', 'sv', [paletteDef()])[0],
      ).toBe(line);
    });
  });

  it('trims label rows to the request locale and its base language', () => {
    const rows = [
      { locale: 'sv', title: 'A', variant_option_labels: null },
      { locale: 'de', title: 'B', variant_option_labels: DE },
      { locale: 'fr', title: 'C', variant_option_labels: DE },
    ];
    expect(trimLabelRows(rows, 'de-AT')).toEqual([
      { locale: 'sv', title: 'A' },
      { locale: 'de', title: 'B', variant_option_labels: DE },
      { locale: 'fr', title: 'C' },
    ]);
    expect(
      trimLabelRows(rows, null).every((r) => !('variant_option_labels' in r)),
    ).toBe(true);
    const plain = [{ locale: 'de', title: 'B' }];
    expect(trimLabelRows(plain, 'fr')[0]).toBe(plain[0]);
    expect(labelRowsForLocale(rows, 'de')).toEqual([
      { locale: 'de', variant_option_labels: DE },
    ]);
    expect(labelRowsForLocale(rows, 'sv')).toEqual([]);
  });
});

import { createHash } from 'crypto';
import {
  personalizationPrintLines,
  renderOrderItems,
} from './order-mail.helpers';

// M4.1 §4.2: personalization items (repeater groups) print as one line per
// item in the email ("Artikel 2: KARIN · Röd" in HTML, "KARIN, Röd" in
// text), escaped and localized; rows without groups render exactly as the
// M4.0 flat list.

const item = (rows: Record<string, unknown>[]) => ({
  quantity: 1,
  unit_price: 549,
  product: {
    translations: [{ locale: 'sv', title: 'Halsband' }],
    images: [],
  },
  variant: { options: { Färg: 'Röd' }, images: [] },
  custom_field_values: rows,
});

const grouped = [
  {
    value: 'KRISTOFER',
    field_name: 'custom_name_v3',
    field_label: { sv: 'Namn', en: 'Name' },
    sort_order: 0,
    group_key: 'dnc_items',
    group_index: 1,
    group_label: { sv: 'Artikel 1', en: 'Item 1' },
    source: 'FIELD',
  },
  {
    value: 'Röd',
    field_name: 'Färg',
    field_label: { sv: 'Färg' },
    sort_order: 1,
    group_key: 'dnc_items',
    group_index: 1,
    group_label: { sv: 'Artikel 1', en: 'Item 1' },
    source: 'OPTION',
    meta: { hex: '#dd3333' },
  },
  {
    value: '<b>KARIN</b>',
    field_name: 'name',
    field_label: { sv: 'Namn' },
    sort_order: 3,
    group_key: 'dnc_items',
    group_index: 2,
    group_label: { sv: 'Artikel 2', en: 'Item 2' },
    source: 'FIELD',
  },
  {
    value: 'Blå',
    field_name: 'color',
    field_label: { sv: 'Färg' },
    sort_order: 2,
    group_key: 'dnc_items',
    group_index: 2,
    group_label: { sv: 'Artikel 2', en: 'Item 2' },
    source: 'FIELD',
  },
];

function sha(s: { items_html: string; items_text: string }): string {
  return createHash('sha256')
    .update(s.items_html + '\u0000' + s.items_text)
    .digest('hex');
}

describe('order email personalization items (M4.1)', () => {
  it('HTML: one escaped line per item, parts joined with a dot', () => {
    const out = renderOrderItems(
      [item(grouped)] as never,
      'SEK',
      'sv',
      'http://api',
    );
    expect(out.items_html).toContain(
      '<div style="color:#71717a;font-size:11px;margin-top:2px;">Artikel 1: KRISTOFER · Röd</div>',
    );
    expect(out.items_html).toContain(
      '<div style="color:#71717a;font-size:11px;margin-top:2px;">Artikel 2: Blå · &lt;b&gt;KARIN&lt;/b&gt;</div>',
    );
    expect(out.items_html).not.toContain('<b>KARIN');
    expect(out.items_text).toContain('\n    Artikel 1: KRISTOFER, Röd');
    expect(out.items_text).toContain('\n    Artikel 2: Blå, <b>KARIN</b>');
  });

  it('localized: the group label in the email locale; a missing label uses the phrase', () => {
    const en = personalizationPrintLines(grouped, 'en', 'sv', 'File');
    expect(en.map((l) => l.label)).toEqual(['Item 1', 'Item 2']);
    const unlabeled = grouped.map((r) => ({ ...r, group_label: null }));
    expect(
      personalizationPrintLines(unlabeled, 'de', 'sv', 'Datei').map(
        (l) => l.label,
      ),
    ).toEqual(['Artikel 1', 'Artikel 2']);
    expect(
      personalizationPrintLines(unlabeled, 'en', 'sv', 'File').map(
        (l) => l.label,
      ),
    ).toEqual(['Item 1', 'Item 2']);
  });

  it('rows without groups: the M4.0 flat output (same bytes as before M4.1)', () => {
    const flat = [
      {
        value: 'Hej',
        field_name: 'note',
        field_label: { sv: 'Hälsning' },
        sort_order: 0,
      },
      {
        value: null,
        file_url: '/uploads/customer-previews/x.webp',
        field_name: 'logo',
        field_type: 'IMAGE',
        sort_order: 1,
      },
    ];
    const out = renderOrderItems(
      [item(flat)] as never,
      'SEK',
      'sv',
      'http://api',
    );
    expect(out.items_html).toContain('>Hälsning: Hej</div>');
    expect(out.items_html).toContain('>logo: Fil uppladdad</div>');
    // The same rows with the M4.1 default columns render identically.
    const withDefaults = flat.map((r) => ({
      ...r,
      group_key: null,
      group_index: null,
      group_label: null,
      source: 'FIELD',
      meta: null,
    }));
    expect(
      sha(
        renderOrderItems(
          [item(withDefaults)] as never,
          'SEK',
          'sv',
          'http://api',
        ),
      ),
    ).toBe(sha(out));
  });
});

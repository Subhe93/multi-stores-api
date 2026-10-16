import { createHash } from 'crypto';
import { emailPhrases, renderOrderItems } from './order-mail.helpers';

// M4.0 §7: order emails list the personalization values of each line,
// escaped, labelled from the order-time snapshot in the email's locale, with
// a phrase (never a URL) for files. A line without values renders exactly as
// before M4.0 (golden hash taken from the pre-M4.0 renderer).

const base = {
  quantity: 2,
  unit_price: 99.5,
  product: {
    translations: [
      { locale: 'en', title: 'Tee <b>' },
      { locale: 'sv', title: 'Tröja' },
    ],
    images: [{ url: '/uploads/a.webp' }],
  },
  variant: { options: { Color: 'Red', Size: 'M' }, images: [] },
};

function sha(s: { items_html: string; items_text: string }): string {
  return createHash('sha256')
    .update(s.items_html + '\u0000' + s.items_text)
    .digest('hex');
}

describe('renderOrderItems personalization (M4.0)', () => {
  it('G0: a line without values equals the pre-M4.0 output', () => {
    const plain = renderOrderItems([base] as never, 'SEK', 'sv', 'http://api');
    const empty = renderOrderItems(
      [{ ...base, custom_field_values: [] }] as never,
      'SEK',
      'sv',
      'http://api',
    );
    expect(empty).toEqual(plain);
    expect(sha(plain)).toBe(GOLDEN_SV);
  });

  it('values: snapshot labels in the email locale, sorted, escaped, files as a phrase', () => {
    const item = {
      ...base,
      custom_field_values: [
        {
          value: null,
          file_url: '/uploads/customer-previews/x.webp',
          field_type: 'IMAGE',
          field_label: { sv: 'Foto', en: 'Photo' },
          sort_order: 2,
        },
        {
          value: '<script>alert(1)</script>',
          file_url: null,
          field_type: 'TEXT',
          field_label: { sv: 'Andra texten', en: 'Second text' },
          sort_order: 1,
          // The field was deleted after ordering.
          custom_field: null,
        },
        {
          value: 'S',
          file_url: null,
          field_type: 'SELECT',
          field_label: { sv: 'Storlek' },
          display_value: { sv: 'Liten', en: 'Small' },
          sort_order: 0,
        },
      ],
    };
    const out = renderOrderItems([item] as never, 'SEK', 'sv', 'http://api');
    expect(out.items_html).toContain('Storlek: Liten</div>');
    expect(out.items_html).toContain(
      'Andra texten: &lt;script&gt;alert(1)&lt;/script&gt;</div>',
    );
    expect(out.items_html).not.toContain('<script>');
    expect(out.items_html).toContain(
      `Foto: ${emailPhrases('sv').fileUploaded}`,
    );
    expect(out.items_html).not.toContain('customer-previews');
    expect(out.items_html.indexOf('Storlek')).toBeLessThan(
      out.items_html.indexOf('Andra texten'),
    );
    expect(out.items_text).toMatch(/^- Tröja \(Color: Red \/ Size: M\) × 2 — /);
    // The amount uses Intl spacing; compare everything after the first line.
    expect(out.items_text.slice(out.items_text.indexOf('\n'))).toBe(
      '\n    Storlek: Liten' +
        '\n    Andra texten: <script>alert(1)</script>' +
        '\n    Foto: Fil uppladdad',
    );
  });

  it('MULTI_IMAGE: one line per file row', () => {
    const file = (n: number) => ({
      value: null,
      file_url: `/uploads/custom-fields/${n}.webp`,
      field_type: 'MULTI_IMAGE',
      field_label: { en: 'Photos' },
      sort_order: 0,
    });
    const out = renderOrderItems(
      [{ ...base, custom_field_values: [file(1), file(2), file(3)] }] as never,
      'SEK',
      'en',
      'http://api',
    );
    expect(out.items_text.match(/Photos: File uploaded/g)).toHaveLength(3);
  });

  it('every email locale has the file phrase', () => {
    for (const l of ['en', 'sv', 'de', 'fr', 'tr', 'ar']) {
      expect(emailPhrases(l).fileUploaded).toBeTruthy();
    }
  });

  it('labels fall back to the store primary locale before en/first', () => {
    const row = {
      value: 'Anna',
      field_name: 'name_1',
      field_type: 'TEXT',
      field_label: { sv: 'Namn', de: 'Vorname' },
      sort_order: 0,
    };
    const item = { ...base, custom_field_values: [row] };
    const withPrimary = renderOrderItems(
      [item] as never,
      'SEK',
      'fr',
      'http://api',
      'de',
    );
    expect(withPrimary.items_text).toContain('Vorname: Anna');
    const without = renderOrderItems(
      [item] as never,
      'SEK',
      'fr',
      'http://api',
    );
    expect(without.items_text).toContain('Namn: Anna');
  });
});

const GOLDEN_SV =
  '04dcc078f173014c524d78dd5d994e51eaa1ba8cdb082c22d09304be6fa28f25';

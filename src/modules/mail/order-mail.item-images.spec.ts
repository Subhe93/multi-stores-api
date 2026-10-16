import { createHash } from 'crypto';
import { renderOrderItems } from './order-mail.helpers';

// M4.2 §8.5 (WP10): the `itemImages` overrides of an app (the designer
// proof) replace the product image of their line only. Without overrides,
// or with an empty map, the items block is byte-identical (the same golden
// hash as the M4.0 G0 spec).

const GOLDEN_SV =
  '04dcc078f173014c524d78dd5d994e51eaa1ba8cdb082c22d09304be6fa28f25';

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

describe('renderOrderItems item image overrides (M4.2 WP10)', () => {
  it('no overrides / empty / unrelated ids: byte-identical output', () => {
    const plain = renderOrderItems([base] as never, 'SEK', 'sv', 'http://api');
    const withId = renderOrderItems(
      [{ ...base, id: 'i1' }] as never,
      'SEK',
      'sv',
      'http://api',
      undefined,
      {},
    );
    const unrelated = renderOrderItems(
      [{ ...base, id: 'i1' }] as never,
      'SEK',
      'sv',
      'http://api',
      undefined,
      { other: 'https://api/x.webp' },
    );
    expect(withId).toEqual(plain);
    expect(unrelated).toEqual(plain);
    expect(sha(plain)).toBe(GOLDEN_SV);
  });

  it('an override replaces only its line image and keeps its aspect', () => {
    const items = [
      { ...base, id: 'i1' },
      { ...base, id: 'i2' },
    ];
    const out = renderOrderItems(
      items as never,
      'SEK',
      'sv',
      'http://api',
      undefined,
      { i1: '/api/designer/files/tok&en' },
    );
    expect(out.items_html).toContain(
      'src="http://api/api/designer/files/tok&amp;en"',
    );
    expect(out.items_html).toContain('width:64px;height:auto;');
    // The other line keeps its product image and the square thumbnail.
    expect(out.items_html).toContain('src="http://api/uploads/a.webp"');
    expect(out.items_html).toContain('width="64" height="64"');
    // The text block never shows image URLs.
    expect(out.items_text).toEqual(
      renderOrderItems(items as never, 'SEK', 'sv', 'http://api').items_text,
    );
  });
});

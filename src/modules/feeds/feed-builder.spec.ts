import {
  FACEBOOK_HEADER,
  buildFacebookCsv,
  buildGoogleFeed,
  facebookRow,
  feedMoney,
  googleItem,
  type FeedItem,
} from './feed-builder';
import { csvCell, htmlToPlainText, xmlEscape } from './feed-text';

const SMILE = '\u{1F600}';

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'p1',
    item_group_id: null,
    title: 'Plain tee',
    description: '<p>Soft &amp; warm</p>',
    link: 'https://namz.se/products/plain-tee',
    image_link: 'https://cdn/img1.jpg',
    additional_image_links: ['https://cdn/img2.jpg'],
    availability: 'in_stock',
    price: 199,
    sale_price: null,
    currency: 'SEK',
    brand: 'Namz',
    gtin: '4006381333931',
    mpn: null,
    condition: 'new',
    google_product_category: '1604',
    product_type: 'Clothing > Tees',
    custom_label_0: 'Tees',
    color: null,
    size: null,
    shipping: [],
    ...overrides,
  };
}

describe('feed text helpers', () => {
  it('escapes XML specials and keeps emoji', () => {
    expect(xmlEscape(`Tom & Jerry <3 "quotes" ${SMILE}`)).toBe(
      `Tom &amp; Jerry &lt;3 &quot;quotes&quot; ${SMILE}`,
    );
    expect(xmlEscape("it's")).toBe('it&apos;s');
    expect(xmlEscape('a\u0001b')).toBe('ab');
  });

  it('quotes CSV cells with commas, quotes and line breaks', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell(' padded ')).toBe('" padded "');
    expect(csvCell(null)).toBe('');
    expect(csvCell(12.5)).toBe('12.5');
  });

  it('turns HTML into plain text, decodes entities and caps at 5000', () => {
    expect(
      htmlToPlainText(
        '<p>Hello <b>world</b></p><ul><li>one</li><li>two &amp; three</li></ul><script>x()</script>',
      ),
    ).toBe('Hello world\n- one\n- two & three');
    expect(htmlToPlainText('&#x1F600; &nbsp; &#169;')).toBe(`${SMILE} ©`);
    const long = 'word '.repeat(1200);
    const out = htmlToPlainText(long);
    expect(out.length).toBeLessThanOrEqual(5000);
    expect(out.endsWith('word')).toBe(true);
    expect(htmlToPlainText(null)).toBe('');
  });

  it('formats money with two decimals and the currency', () => {
    expect(feedMoney(199, 'sek')).toBe('199.00 SEK');
    expect(feedMoney(12.5, 'EUR')).toBe('12.50 EUR');
  });
});

describe('Google Merchant RSS item', () => {
  it('carries the g: fields, escaped, with a plain-text description', () => {
    const xml = googleItem(
      item({
        title: `Tee & Co <XL> ${SMILE}`,
        shipping: [{ country: 'SE', service: 'Standard' }],
      }),
    );
    expect(xml).toContain('<g:id>p1</g:id>');
    expect(xml).toContain(
      `<g:title>Tee &amp; Co &lt;XL&gt; ${SMILE}</g:title>`,
    );
    expect(xml).toContain('<g:description>Soft &amp; warm</g:description>');
    expect(xml).toContain(
      '<g:link>https://namz.se/products/plain-tee</g:link>',
    );
    expect(xml).toContain('<g:image_link>https://cdn/img1.jpg</g:image_link>');
    expect(xml).toContain(
      '<g:additional_image_link>https://cdn/img2.jpg</g:additional_image_link>',
    );
    expect(xml).toContain('<g:availability>in_stock</g:availability>');
    expect(xml).toContain('<g:price>199.00 SEK</g:price>');
    expect(xml).not.toContain('g:sale_price');
    expect(xml).toContain('<g:brand>Namz</g:brand>');
    expect(xml).toContain('<g:gtin>4006381333931</g:gtin>');
    expect(xml).not.toContain('g:mpn');
    expect(xml).not.toContain('g:identifier_exists');
    expect(xml).toContain('<g:condition>new</g:condition>');
    expect(xml).toContain(
      '<g:google_product_category>1604</g:google_product_category>',
    );
    expect(xml).toContain(
      '<g:product_type>Clothing &gt; Tees</g:product_type>',
    );
    expect(xml).toContain('<g:custom_label_0>Tees</g:custom_label_0>');
    expect(xml).toContain(
      '<g:shipping><g:country>SE</g:country><g:service>Standard</g:service></g:shipping>',
    );
    expect(xml).not.toContain('g:item_group_id');
  });

  it('sends identifier_exists=no without gtin/mpn, sale_price with a compare-at', () => {
    const xml = googleItem(
      item({
        gtin: null,
        mpn: null,
        price: 249,
        sale_price: 199,
        item_group_id: 'prod',
        id: 'var1',
        color: 'Red',
        size: 'L',
      }),
    );
    expect(xml).toContain('<g:identifier_exists>no</g:identifier_exists>');
    expect(xml).toContain('<g:price>249.00 SEK</g:price>');
    expect(xml).toContain('<g:sale_price>199.00 SEK</g:sale_price>');
    expect(xml).toContain('<g:item_group_id>prod</g:item_group_id>');
    expect(xml).toContain('<g:color>Red</g:color><g:size>L</g:size>');
    expect(xml).not.toContain('<g:brand></g:brand>');
  });

  it('mpn alone is an identifier', () => {
    const xml = googleItem(item({ gtin: null, mpn: 'ABC-1' }));
    expect(xml).toContain('<g:mpn>ABC-1</g:mpn>');
    expect(xml).not.toContain('identifier_exists');
  });

  it('wraps items in an RSS 2.0 channel with the g namespace', () => {
    const feed = buildGoogleFeed(
      { title: 'Namz & Co', link: 'https://namz.se', description: 'd' },
      [item()],
    );
    expect(
      feed.startsWith(
        '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">',
      ),
    ).toBe(true);
    expect(feed).toContain('<channel>\n<title>Namz &amp; Co</title>');
    expect(feed).toContain('<item>');
    expect(feed.endsWith('</channel>\n</rss>\n')).toBe(true);
  });
});

describe('Meta catalog CSV', () => {
  it('has the header and one quoted row per item', () => {
    const csv = buildFacebookCsv([
      item({
        title: 'Tee, "classic"',
        description: 'line1<br>line2',
        sale_price: 150,
        color: 'Red',
      }),
    ]);
    expect(csv.startsWith(FACEBOOK_HEADER)).toBe(true);
    expect(
      FACEBOOK_HEADER.startsWith(
        'id,title,description,availability,condition,price,link,image_link,brand,gtin,mpn,item_group_id',
      ),
    ).toBe(true);
    const body = csv.slice(FACEBOOK_HEADER.length);
    expect(
      body.startsWith('p1,"Tee, ""classic""","line1\nline2",in stock,new,'),
    ).toBe(true);
    expect(body).toContain(
      ',in stock,new,199.00 SEK,https://namz.se/products/plain-tee,https://cdn/img1.jpg,Namz,4006381333931,,,1604,Clothing > Tees,150.00 SEK,https://cdn/img2.jpg,Red,,Tees\n',
    );
    expect(body.endsWith('\n')).toBe(true);
  });

  it('writes out of stock and joins additional images with commas (quoted)', () => {
    const row = facebookRow(
      item({
        availability: 'out_of_stock',
        additional_image_links: ['a.jpg', 'b.jpg'],
      }),
    );
    expect(row).toContain(',out of stock,');
    expect(row).toContain('"a.jpg,b.jpg"');
  });
});

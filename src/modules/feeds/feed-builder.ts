import { csvCell, htmlToPlainText, xmlEscape } from './feed-text';

// Pure builders of the two feed formats (M5.6). The service shapes catalogue
// rows into FeedItem (prices already in the market currency, tax applied,
// links on the market domain); nothing here touches the database.

export type FeedAvailability = 'in_stock' | 'out_of_stock';
export type FeedCondition = 'new' | 'refurbished' | 'used';

export interface FeedItem {
  /** Variant id when include_variants, else the product id. */
  id: string;
  /** Product id of a variant item; null for a product item. */
  item_group_id: string | null;
  title: string;
  /** HTML or plain text; the builders convert it to plain text (<= 5000). */
  description: string;
  link: string;
  image_link: string | null;
  additional_image_links: string[];
  availability: FeedAvailability;
  /** Regular price; sale_price set when a compare-at price applies. */
  price: number;
  sale_price: number | null;
  currency: string;
  brand: string | null;
  gtin: string | null;
  mpn: string | null;
  condition: FeedCondition;
  google_product_category: string | null;
  /** Collection path ("Parent > Child"); null when the product is in none. */
  product_type: string | null;
  /** Leaf collection name (custom_label_0). */
  custom_label_0: string | null;
  color: string | null;
  size: string | null;
  /** Google g:shipping rows: one per market country when a label is set. */
  shipping: { country: string; service: string }[];
}

export interface FeedChannel {
  title: string;
  link: string;
  description: string;
}

/** "12.50 SEK" — the money format both Google and Meta accept. */
export function feedMoney(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency.toUpperCase()}`;
}

function tag(name: string, value: string | null | undefined): string {
  if (value == null || value === '') return '';
  return `<${name}>${xmlEscape(value)}</${name}>`;
}

/** One `<item>` of the Google Merchant RSS 2.0 feed. */
export function googleItem(item: FeedItem): string {
  const parts: string[] = ['<item>'];
  parts.push(tag('g:id', item.id));
  parts.push(tag('g:title', item.title.slice(0, 150)));
  parts.push(tag('g:description', htmlToPlainText(item.description, 5000)));
  parts.push(tag('g:link', item.link));
  parts.push(tag('g:image_link', item.image_link));
  for (const url of item.additional_image_links.slice(0, 10)) {
    parts.push(tag('g:additional_image_link', url));
  }
  parts.push(tag('g:availability', item.availability));
  parts.push(tag('g:price', feedMoney(item.price, item.currency)));
  if (item.sale_price != null) {
    parts.push(tag('g:sale_price', feedMoney(item.sale_price, item.currency)));
  }
  parts.push(tag('g:brand', item.brand));
  if (item.gtin) parts.push(tag('g:gtin', item.gtin));
  if (item.mpn) parts.push(tag('g:mpn', item.mpn));
  // Google: without any product identifier the item needs an explicit
  // identifier_exists=false (plus a brand) to be accepted at all.
  if (!item.gtin && !item.mpn) {
    parts.push(tag('g:identifier_exists', 'no'));
  }
  parts.push(tag('g:condition', item.condition));
  parts.push(tag('g:google_product_category', item.google_product_category));
  parts.push(tag('g:product_type', item.product_type));
  parts.push(tag('g:item_group_id', item.item_group_id));
  parts.push(tag('g:color', item.color));
  parts.push(tag('g:size', item.size));
  for (const s of item.shipping) {
    parts.push(
      `<g:shipping>${tag('g:country', s.country)}${tag('g:service', s.service)}</g:shipping>`,
    );
  }
  parts.push(tag('g:custom_label_0', item.custom_label_0));
  parts.push('</item>');
  return parts.filter(Boolean).join('');
}

/** Head of the Google feed (up to and including the channel metadata). */
export function googleHead(channel: FeedChannel): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n<channel>\n' +
    tag('title', channel.title) +
    tag('link', channel.link) +
    tag('description', channel.description) +
    '\n'
  );
}

export const GOOGLE_TAIL = '</channel>\n</rss>\n';

/** Whole Google feed as a string (tests, validation, small catalogues). */
export function buildGoogleFeed(
  channel: FeedChannel,
  items: FeedItem[],
): string {
  return (
    googleHead(channel) +
    items.map((i) => googleItem(i) + '\n').join('') +
    GOOGLE_TAIL
  );
}

/** Meta catalog CSV columns, in this order. */
export const FACEBOOK_COLUMNS = [
  'id',
  'title',
  'description',
  'availability',
  'condition',
  'price',
  'link',
  'image_link',
  'brand',
  'gtin',
  'mpn',
  'item_group_id',
  'google_product_category',
  'product_type',
  'sale_price',
  'additional_image_link',
  'color',
  'size',
  'custom_label_0',
] as const;

export const FACEBOOK_HEADER = FACEBOOK_COLUMNS.join(',') + '\n';

/** One row of the Meta catalog CSV. */
export function facebookRow(item: FeedItem): string {
  const cells: (string | null)[] = [
    item.id,
    item.title.slice(0, 200),
    htmlToPlainText(item.description, 5000),
    item.availability === 'in_stock' ? 'in stock' : 'out of stock',
    item.condition,
    feedMoney(item.price, item.currency),
    item.link,
    item.image_link,
    item.brand,
    item.gtin,
    item.mpn,
    item.item_group_id,
    item.google_product_category,
    item.product_type,
    item.sale_price != null ? feedMoney(item.sale_price, item.currency) : null,
    item.additional_image_links.slice(0, 10).join(','),
    item.color,
    item.size,
    item.custom_label_0,
  ];
  return cells.map(csvCell).join(',') + '\n';
}

/** Whole Meta CSV as a string. */
export function buildFacebookCsv(items: FeedItem[]): string {
  return FACEBOOK_HEADER + items.map(facebookRow).join('');
}

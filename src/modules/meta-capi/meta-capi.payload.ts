import { createHash } from 'crypto';
import type { TrackingContext } from './tracking-context';

// Pure helpers of the Meta Conversions API Purchase event: normalisation and
// SHA-256 hashing of the customer parameters (Meta's "customer information
// parameters" rules) and the event payload builder. No I/O here.

/** Graph API version of the Conversions API endpoint. */
export const META_GRAPH_API_VERSION = 'v24.0';

export function metaEventsUrl(pixelId: string): string {
  return `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${encodeURIComponent(pixelId)}/events`;
}

/** Shared with the browser pixel (`eventID`), so Meta deduplicates the two. */
export function purchaseEventId(orderId: string): string {
  return `purchase_${orderId}`;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Email: trimmed and lower-cased. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().toLowerCase();
  return v && v.includes('@') ? v : null;
}

// Countries whose national numbers are written with a leading trunk "0" that
// is dropped behind the country calling code (070-123 45 67 -> 46 70 ...).
const TRUNK_ZERO_CALLING_CODES: Record<string, string> = {
  SE: '46',
  FI: '358',
  DE: '49',
  FR: '33',
  NL: '31',
  BE: '32',
  AT: '43',
  CH: '41',
  GB: '44',
  IE: '353',
  TR: '90',
  SA: '966',
  AE: '971',
};

/**
 * Phone: digits only, including the country code, without a leading "+" or
 * "00". A national number with a trunk zero gets the calling code of
 * `countryCode` when that country is known; otherwise it is left as typed.
 */
export function normalizePhone(
  raw: string | null | undefined,
  countryCode?: string | null,
): string | null {
  const typed = (raw ?? '').trim();
  if (!typed) return null;
  const international = typed.startsWith('+');
  // "+46 (0)70 ..." : the bracketed trunk zero is not part of the number.
  let digits = typed.replace(/\(0\)/g, '').replace(/\D/g, '');
  if (!digits) return null;
  if (!international) {
    if (digits.startsWith('00')) {
      digits = digits.slice(2);
    } else if (digits.startsWith('0')) {
      const calling =
        TRUNK_ZERO_CALLING_CODES[(countryCode ?? '').trim().toUpperCase()];
      if (calling) digits = calling + digits.slice(1);
    }
  }
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

/** First / last name: lower-cased, punctuation removed, trimmed. */
export function normalizeName(raw: string | null | undefined): string | null {
  const v = (raw ?? '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return v || null;
}

/** City: lower-cased, without spaces, punctuation or digits. */
export function normalizeCity(raw: string | null | undefined): string | null {
  const v = (raw ?? '').toLowerCase().replace(/[\p{P}\p{S}\s\d]/gu, '');
  return v || null;
}

/** Postcode: lower-cased, no spaces or dashes; US ZIP+4 keeps 5 digits. */
export function normalizePostcode(
  raw: string | null | undefined,
  countryCode?: string | null,
): string | null {
  let v = (raw ?? '').toLowerCase().replace(/[\s-]/g, '');
  if (!v) return null;
  if ((countryCode ?? '').trim().toUpperCase() === 'US') v = v.slice(0, 5);
  return v;
}

/** Country: ISO 3166-1 alpha-2, lower-cased. */
export function normalizeCountry(
  raw: string | null | undefined,
): string | null {
  const v = (raw ?? '').trim().toLowerCase();
  return /^[a-z]{2}$/.test(v) ? v : null;
}

/** "Anna Maria Svensson" -> ["Anna Maria", "Svensson"]. */
export function splitFullName(raw: string | null | undefined): {
  first: string | null;
  last: string | null;
} {
  const parts = (raw ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  return {
    first: parts.slice(0, -1).join(' '),
    last: parts[parts.length - 1],
  };
}

export interface MetaPurchaseCustomer {
  email?: string | null;
  phone?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  city?: string | null;
  postcode?: string | null;
  country_code?: string | null;
}

export interface MetaUserData {
  em?: string[];
  ph?: string[];
  fn?: string[];
  ln?: string[];
  ct?: string[];
  zp?: string[];
  country?: string[];
  client_ip_address?: string;
  client_user_agent?: string;
  fbp?: string;
  fbc?: string;
}

/**
 * `user_data` of a server event: the customer parameters hashed (SHA-256,
 * lower-case hex) after normalisation; IP, user agent and the Meta cookies
 * are sent as they are, as Meta requires.
 */
export function buildUserData(
  customer: MetaPurchaseCustomer,
  context: TrackingContext | null,
): MetaUserData {
  const out: MetaUserData = {};
  const hashed = (v: string | null): string[] | undefined =>
    v ? [sha256Hex(v)] : undefined;
  const em = hashed(normalizeEmail(customer.email));
  const ph = hashed(normalizePhone(customer.phone, customer.country_code));
  const fn = hashed(normalizeName(customer.first_name));
  const ln = hashed(normalizeName(customer.last_name));
  const ct = hashed(normalizeCity(customer.city));
  const zp = hashed(
    normalizePostcode(customer.postcode, customer.country_code),
  );
  const country = hashed(normalizeCountry(customer.country_code));
  if (em) out.em = em;
  if (ph) out.ph = ph;
  if (fn) out.fn = fn;
  if (ln) out.ln = ln;
  if (ct) out.ct = ct;
  if (zp) out.zp = zp;
  if (country) out.country = country;
  if (context?.ip) out.client_ip_address = context.ip;
  if (context?.user_agent) out.client_user_agent = context.user_agent;
  if (context?.fbp) out.fbp = context.fbp;
  if (context?.fbc) out.fbc = context.fbc;
  return out;
}

export interface MetaPurchaseItem {
  /** Content id: the product id (or the custom product id). */
  id: string;
  quantity: number;
  unit_price: number | string | { toString(): string };
}

export interface MetaPurchaseOrder {
  id: string;
  order_number: string;
  total: number | string | { toString(): string };
  currency: string;
  paid_at?: Date | null;
  items: MetaPurchaseItem[];
  customer: MetaPurchaseCustomer;
  context: TrackingContext | null;
  /** Used as event_source_url when the context carries none. */
  fallback_source_url?: string | null;
}

export interface MetaPurchaseEvent {
  event_name: 'Purchase';
  event_time: number;
  event_id: string;
  action_source: 'website';
  event_source_url?: string;
  user_data: MetaUserData;
  custom_data: {
    currency: string;
    value: number;
    content_type: 'product';
    contents: { id: string; quantity: number; item_price: number }[];
    content_ids: string[];
    num_items: number;
    order_id: string;
  };
}

function toNumber(value: number | string | { toString(): string }): number {
  const n = typeof value === 'number' ? value : Number(value.toString());
  return Number.isFinite(n) ? n : 0;
}

export function buildPurchaseEvent(
  order: MetaPurchaseOrder,
  now: Date = new Date(),
): MetaPurchaseEvent {
  const contents = order.items.map((item) => ({
    id: item.id,
    quantity: item.quantity,
    item_price: toNumber(item.unit_price),
  }));
  const sourceUrl =
    order.context?.source_url || order.fallback_source_url || undefined;
  return {
    event_name: 'Purchase',
    event_time: Math.floor((order.paid_at ?? now).getTime() / 1000),
    event_id: purchaseEventId(order.id),
    action_source: 'website',
    ...(sourceUrl ? { event_source_url: sourceUrl } : {}),
    user_data: buildUserData(order.customer, order.context),
    custom_data: {
      currency: order.currency.trim().toUpperCase(),
      value: toNumber(order.total),
      content_type: 'product',
      contents,
      content_ids: Array.from(new Set(contents.map((c) => c.id))),
      num_items: contents.reduce((sum, c) => sum + c.quantity, 0),
      order_id: order.order_number,
    },
  };
}

export interface MetaEventsRequestBody {
  data: MetaPurchaseEvent[];
  test_event_code?: string;
  access_token: string;
}

export function buildEventsRequestBody(
  event: MetaPurchaseEvent,
  accessToken: string,
  testEventCode?: string | null,
): MetaEventsRequestBody {
  return {
    data: [event],
    ...(testEventCode ? { test_event_code: testEventCode } : {}),
    access_token: accessToken,
  };
}

import { toStripeAmount } from '../../../common/money/currency.util';
import type {
  KustomAddress,
  KustomCheckoutPayload,
  KustomMerchantUrls,
  KustomOrderLine,
} from './kustom.client';

/**
 * Pure functions that turn one of our orders into the Kustom checkout payload.
 * Nothing here touches the database or the network, so the mapping can be
 * unit-tested and reused for both the create and the update call.
 */

type Translation = { locale: string; title: string };

export interface KustomOrderItemInput {
  id: string;
  quantity: number;
  unit_price: unknown; // Prisma Decimal
  total_price: unknown; // Prisma Decimal
  product?: { translations?: Translation[] } | null;
  custom_product?: { translations?: Translation[] } | null;
  variant?: { sku?: string | null; options?: unknown } | null;
}

export interface KustomOrderInput {
  id: string;
  order_number: string;
  currency: string;
  subtotal: unknown;
  shipping_cost: unknown;
  discount_amount: unknown;
  total: unknown;
  items: KustomOrderItemInput[];
  address: {
    full_name: string;
    line1: string;
    line2?: string | null;
    city: string;
    state?: string | null;
    postal_code: string;
    country_code: string;
    phone?: string | null;
  };
  customer: {
    phone?: string | null;
    user?: { email?: string | null } | null;
  };
}

export interface KustomMapperContext {
  storeSlug: string;
  /** Verified custom domain of the store, when it has one. */
  customDomain?: string | null;
  /** Store content locale, e.g. 'sv', 'en'. */
  primaryLocale: string | null | undefined;
  /** STOREFRONT_URL, no trailing slash needed. */
  storefrontBase: string;
  /** PUBLIC_API_URL, no trailing slash needed. */
  apiBase: string;
  pushToken: string;
}

// ── Locale ──────────────────────────────────────────────────────────────────

// Kustom's core markets each have one canonical checkout locale. When the
// customer ships to one of them, that locale wins over the store language:
// it selects the market-specific payment methods (Swish, invoice, ...).
const COUNTRY_LOCALES: Record<string, string> = {
  SE: 'sv-SE',
  NO: 'nb-NO',
  FI: 'fi-FI',
  DK: 'da-DK',
  DE: 'de-DE',
  AT: 'de-AT',
  NL: 'nl-NL',
  GB: 'en-GB',
  US: 'en-US',
  CH: 'de-CH',
  ES: 'es-ES',
  FR: 'fr-FR',
  BE: 'nl-BE',
  PL: 'pl-PL',
};

// Store content locale → RFC 1766 checkout locale. Arabic has no Kustom
// locale, so it falls back to British English like any unknown language.
const LANGUAGE_LOCALES: Record<string, string> = {
  en: 'en-GB',
  sv: 'sv-SE',
  de: 'de-DE',
  fr: 'fr-FR',
  tr: 'tr-TR',
  nb: 'nb-NO',
  no: 'nb-NO',
  da: 'da-DK',
  fi: 'fi-FI',
  nl: 'nl-NL',
  es: 'es-ES',
  pl: 'pl-PL',
};

export function resolveKustomLocale(
  primaryLocale: string | null | undefined,
  countryCode: string | null | undefined,
): string {
  const country = (countryCode ?? '').toUpperCase();
  if (COUNTRY_LOCALES[country]) return COUNTRY_LOCALES[country];
  const lang = (primaryLocale ?? 'en').toLowerCase().split(/[-_]/)[0];
  return LANGUAGE_LOCALES[lang] ?? 'en-GB';
}

// ── Names / addresses ───────────────────────────────────────────────────────

function pickTitle(
  translations: Translation[] | undefined,
  locale: string,
): string {
  if (!translations?.length) return '';
  return (
    translations.find((t) => t.locale === locale)?.title ||
    translations.find((t) => t.locale === 'en')?.title ||
    translations[0].title ||
    ''
  );
}

function variantLabel(options: unknown): string {
  if (!options || typeof options !== 'object') return '';
  return Object.values(options as Record<string, unknown>)
    .filter((v) => typeof v === 'string' && v)
    .join(' / ');
}

/** Display name of a line: translated title plus the chosen variant, if any. */
export function resolveItemName(
  item: KustomOrderItemInput,
  locale: string,
): string {
  const title =
    pickTitle(item.custom_product?.translations, locale) ||
    pickTitle(item.product?.translations, locale) ||
    'Item';
  const variant = variantLabel(item.variant?.options);
  // Kustom caps line names at 255 characters.
  return (variant ? `${title} (${variant})` : title).slice(0, 255);
}

/** Split "Anna Maria Svensson" into given/family the way Kustom expects. */
export function splitFullName(fullName: string): {
  given_name: string;
  family_name: string;
} {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { given_name: '', family_name: '' };
  if (parts.length === 1) return { given_name: parts[0], family_name: '' };
  return {
    given_name: parts.slice(0, -1).join(' '),
    family_name: parts[parts.length - 1],
  };
}

export function buildKustomAddress(
  order: Pick<KustomOrderInput, 'address' | 'customer'>,
): KustomAddress {
  const a = order.address;
  const { given_name, family_name } = splitFullName(a.full_name);
  const email = order.customer.user?.email ?? undefined;
  const phone = a.phone || order.customer.phone || undefined;
  const address: KustomAddress = {
    given_name,
    family_name,
    street_address: a.line1,
    postal_code: a.postal_code,
    city: a.city,
    country: a.country_code.toUpperCase(),
  };
  if (a.line2) address.street_address2 = a.line2;
  if (a.state) address.region = a.state;
  if (email) address.email = email;
  if (phone) address.phone = phone;
  return address;
}

// ── Lines / amounts ─────────────────────────────────────────────────────────

/**
 * Kustom validates `total_amount == quantity * unit_price - total_discount_amount`
 * on every line. Our stored unit/total prices are independently rounded to two
 * decimals, so derive the two from the line total: any rounding gap becomes a
 * (non-negative) line discount, or a bumped unit price when the total is the
 * larger one — the line total is what the customer actually pays.
 */
function consistentLineAmounts(
  unitMinor: number,
  totalMinor: number,
  quantity: number,
): { unit_price: number; total_amount: number; total_discount_amount: number } {
  const qty = Math.max(1, quantity);
  let unit = unitMinor;
  if (unit * qty < totalMinor) unit = Math.ceil(totalMinor / qty);
  return {
    unit_price: unit,
    total_amount: totalMinor,
    total_discount_amount: unit * qty - totalMinor,
  };
}

export function buildKustomOrderLines(
  order: KustomOrderInput,
  locale: string,
): KustomOrderLine[] {
  const cur = order.currency;
  const lines: KustomOrderLine[] = order.items.map((item) => {
    const amounts = consistentLineAmounts(
      toStripeAmount(Number(item.unit_price), cur),
      toStripeAmount(Number(item.total_price), cur),
      item.quantity,
    );
    return {
      type: 'physical',
      reference: (item.variant?.sku || item.id).slice(0, 64),
      name: resolveItemName(item, locale),
      quantity: item.quantity,
      quantity_unit: 'pcs',
      // Tax is not modelled per line yet — see API-CONTRACT.md.
      tax_rate: 0,
      total_tax_amount: 0,
      ...amounts,
    };
  });

  const shippingMinor = toStripeAmount(Number(order.shipping_cost), cur);
  if (shippingMinor > 0) {
    lines.push({
      type: 'shipping_fee',
      reference: 'shipping',
      name: 'Shipping',
      quantity: 1,
      unit_price: shippingMinor,
      tax_rate: 0,
      total_amount: shippingMinor,
      total_discount_amount: 0,
      total_tax_amount: 0,
    });
  }

  const discountMinor = toStripeAmount(Number(order.discount_amount), cur);
  if (discountMinor > 0) {
    // Discounts are separate negative lines in Kustom's model.
    lines.push({
      type: 'discount',
      reference: 'discount',
      name: 'Discount',
      quantity: 1,
      unit_price: -discountMinor,
      tax_rate: 0,
      total_amount: -discountMinor,
      total_discount_amount: 0,
      total_tax_amount: 0,
    });
  }

  // Kustom also requires order_amount == sum(total_amount). The order total is
  // the authoritative figure (it is what validation and push compare against),
  // so absorb any leftover rounding in a one-off adjustment line.
  const orderMinor = toStripeAmount(Number(order.total), cur);
  const linesMinor = lines.reduce((s, l) => s + l.total_amount, 0);
  const gap = orderMinor - linesMinor;
  if (gap !== 0) {
    lines.push({
      type: gap > 0 ? 'surcharge' : 'discount',
      reference: 'rounding',
      name: 'Rounding adjustment',
      quantity: 1,
      unit_price: gap,
      tax_rate: 0,
      total_amount: gap,
      total_discount_amount: 0,
      total_tax_amount: 0,
    });
  }

  return lines;
}

// ── URLs ────────────────────────────────────────────────────────────────────

/**
 * Base URL of the store pages Kustom redirects the customer back to. The
 * customer's session lives in localStorage, i.e. per origin, so the redirect
 * must land on the origin they shopped on: the custom domain when the store
 * has one, otherwise the platform `/store/{slug}` path (which the storefront
 * proxy redirects to the store subdomain, query string included).
 */
export function resolveStoreBase(
  storefrontBase: string,
  storeSlug: string,
  customDomain?: string | null,
): string {
  const domain = (customDomain ?? '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  if (domain) return `https://${domain}`;
  return `${storefrontBase.replace(/\/$/, '')}/store/${storeSlug}`;
}

/**
 * Merchant URLs exactly as agreed in API-CONTRACT.md. `{checkout.order.id}` is
 * a literal placeholder Kustom substitutes with its own checkout id.
 */
export function buildKustomMerchantUrls(
  orderId: string,
  ctx: KustomMapperContext,
): KustomMerchantUrls {
  const base = resolveStoreBase(
    ctx.storefrontBase,
    ctx.storeSlug,
    ctx.customDomain,
  );
  const api = `${ctx.apiBase.replace(/\/$/, '')}/api`;
  const oid = encodeURIComponent(orderId);
  const token = encodeURIComponent(ctx.pushToken);
  return {
    // Every storefront mirrors the platform legal pages under /legal/{slug}.
    terms: `${base}/legal/terms`,
    checkout: `${base}/checkout/kustom?orderId=${oid}`,
    confirmation: `${base}/checkout/kustom/confirmation?orderId=${oid}&kustom_order_id={checkout.order.id}`,
    push: `${api}/payments/kustom/push?order_id=${oid}&token=${token}&kustom_order_id={checkout.order.id}`,
    validation: `${api}/payments/kustom/validation?order_id=${oid}&token=${token}`,
  };
}

// ── Payload ─────────────────────────────────────────────────────────────────

/** Full create/update body for `/checkout/v3/orders`. */
export function buildKustomCheckoutPayload(
  order: KustomOrderInput,
  ctx: KustomMapperContext,
): KustomCheckoutPayload {
  const country = order.address.country_code.toUpperCase();
  const contentLocale = (ctx.primaryLocale ?? 'en').toLowerCase();
  const locale = resolveKustomLocale(ctx.primaryLocale, country);
  const address = buildKustomAddress(order);
  const lines = buildKustomOrderLines(order, contentLocale);

  return {
    purchase_country: country,
    purchase_currency: order.currency.toUpperCase(),
    locale,
    order_amount: toStripeAmount(Number(order.total), order.currency),
    order_tax_amount: 0,
    order_lines: lines,
    // Reference1 is what push/validation verify against; reference2 is the
    // human-readable number shown in the Kustom merchant portal.
    merchant_reference1: order.id,
    merchant_reference2: order.order_number,
    merchant_urls: buildKustomMerchantUrls(order.id, ctx),
    // Prefill both with what the customer typed on our checkout page; they may
    // still change the shipping address inside the iframe.
    billing_address: address,
    shipping_address: address,
    options: {
      auto_capture: false,
      allow_separate_shipping_address: true,
      // Fail the purchase when our validation callback cannot answer in
      // time: stock and order state must be confirmed before Kustom
      // authorizes money, never assumed.
      require_validate_callback_success: true,
    },
  };
}

/** Minor-unit total we expect Kustom to authorize for this order. */
export function expectedKustomAmount(order: {
  total: unknown;
  currency: string;
}): number {
  return toStripeAmount(Number(order.total), order.currency);
}

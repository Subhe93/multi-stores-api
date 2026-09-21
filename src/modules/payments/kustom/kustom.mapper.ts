import { toStripeAmount } from '../../../common/money/currency.util';
import { includedTaxMinor } from '../../../common/money/tax.util';
import type {
  KustomAddress,
  KustomCheckoutPayload,
  KustomCheckoutUpdateResponse,
  KustomMerchantUrls,
  KustomOrderLine,
  KustomShippingOption,
} from './kustom.client';

/**
 * Pure functions that turn one of our orders — or a not-yet-ordered checkout
 * session — into the Kustom checkout payload. Nothing here touches the
 * database or the network, so the mapping can be unit-tested and reused for
 * the create, update and callback responses alike.
 */

type Translation = { locale: string; title: string };

export interface KustomOrderItemInput {
  id: string;
  quantity: number;
  unit_price: unknown; // Prisma Decimal or number
  total_price: unknown; // Prisma Decimal or number
  product?: { translations?: Translation[] } | null;
  custom_product?: { translations?: Translation[] } | null;
  variant?: { sku?: string | null; options?: unknown } | null;
}

export interface KustomAddressInput {
  full_name: string;
  line1: string;
  line2?: string | null;
  city: string;
  state?: string | null;
  postal_code: string;
  country_code: string;
  phone?: string | null;
}

/** The amounts every line builder needs; an Order row satisfies it. */
export interface KustomLinesInput {
  currency: string;
  shipping_cost: unknown;
  discount_amount: unknown;
  total: unknown;
  items: KustomOrderItemInput[];
}

export interface KustomOrderInput extends KustomLinesInput {
  id: string;
  order_number: string;
  subtotal: unknown;
  /** Snapshotted method name; becomes the shipping line's name when set. */
  shipping_method_name?: string | null;
  address: KustomAddressInput;
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
  /** VAT rate in basis points applied to every line (prices are inclusive). */
  taxRateBp?: number;
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

/**
 * Stamp a line with the VAT it includes. Prices are tax inclusive, so the
 * amounts never change: `total_tax_amount = total - total * 10000 / (10000 + rate)`
 * rounded to the minor unit, negative for negative (discount) lines.
 */
function withTax(
  line: Omit<KustomOrderLine, 'tax_rate' | 'total_tax_amount'>,
  taxRateBp: number,
): KustomOrderLine {
  return {
    ...line,
    tax_rate: taxRateBp,
    total_tax_amount: includedTaxMinor(line.total_amount, taxRateBp),
  };
}

export interface KustomLineOptions {
  /** VAT rate in basis points; 0 (the default) sends tax-free lines. */
  taxRateBp?: number;
  /** Name of the shipping line, e.g. the selected option's localized name. */
  shippingName?: string;
}

export function buildKustomOrderLines(
  order: KustomLinesInput,
  locale: string,
  opts: KustomLineOptions = {},
): KustomOrderLine[] {
  const cur = order.currency;
  const rate = Math.max(0, Math.trunc(opts.taxRateBp ?? 0));
  const lines: KustomOrderLine[] = order.items.map((item) => {
    const amounts = consistentLineAmounts(
      toStripeAmount(Number(item.unit_price), cur),
      toStripeAmount(Number(item.total_price), cur),
      item.quantity,
    );
    return withTax(
      {
        type: 'physical',
        reference: (item.variant?.sku || item.id).slice(0, 64),
        name: resolveItemName(item, locale),
        quantity: item.quantity,
        quantity_unit: 'pcs',
        ...amounts,
      },
      rate,
    );
  });

  const shippingMinor = toStripeAmount(Number(order.shipping_cost), cur);
  if (shippingMinor > 0) {
    lines.push(
      withTax(
        {
          type: 'shipping_fee',
          reference: 'shipping',
          name: (opts.shippingName || 'Shipping').slice(0, 255),
          quantity: 1,
          unit_price: shippingMinor,
          total_amount: shippingMinor,
          total_discount_amount: 0,
        },
        rate,
      ),
    );
  }

  const discountMinor = toStripeAmount(Number(order.discount_amount), cur);
  if (discountMinor > 0) {
    // Discounts are separate negative lines in Kustom's model.
    lines.push(
      withTax(
        {
          type: 'discount',
          reference: 'discount',
          name: 'Discount',
          quantity: 1,
          unit_price: -discountMinor,
          total_amount: -discountMinor,
          total_discount_amount: 0,
        },
        rate,
      ),
    );
  }

  // Kustom also requires order_amount == sum(total_amount). The order total is
  // the authoritative figure (it is what validation and push compare against),
  // so absorb any leftover rounding in a one-off adjustment line.
  const orderMinor = toStripeAmount(Number(order.total), cur);
  const linesMinor = lines.reduce((s, l) => s + l.total_amount, 0);
  const gap = orderMinor - linesMinor;
  if (gap !== 0) {
    lines.push(
      withTax(
        {
          type: gap > 0 ? 'surcharge' : 'discount',
          reference: 'rounding',
          name: 'Rounding adjustment',
          quantity: 1,
          unit_price: gap,
          total_amount: gap,
          total_discount_amount: 0,
        },
        rate,
      ),
    );
  }

  return lines;
}

/** `order_tax_amount` is the sum of the lines, never recomputed from the total. */
export function sumKustomTax(lines: KustomOrderLine[]): number {
  return lines.reduce((s, l) => s + l.total_tax_amount, 0);
}

// ── Shipping options ────────────────────────────────────────────────────────

/**
 * A shipping method priced for one destination, as the shipping module
 * quotes it (ShippingService.quoteForItems, one entry per ShippingMethod).
 */
export interface ShippingQuoteOption {
  /** The ShippingMethod id — what the order stores as shipping_method_id. */
  id: string;
  name: string;
  /** Overrides the "<min>–<max> days" text, e.g. "Pick up in store". */
  description?: string;
  type: 'delivery' | 'pickup';
  /** Major units. */
  cost: number;
  estimated_days?: { min: number; max: number } | null;
}

export function formatEstimatedDays(
  days: { min: number; max: number } | null | undefined,
): string | undefined {
  if (!days) return undefined;
  return days.min === days.max
    ? `${days.min} days`
    : `${days.min}–${days.max} days`;
}

/**
 * Kustom `shipping_options` for a set of quotes. The selected id (what the
 * customer picked in the iframe) is preselected when it is still offered,
 * else the first option — Kustom needs exactly one preselected entry.
 * Pickup methods are flagged `PickUpStore`, everything else `Home`, so the
 * iframe can label them accordingly.
 */
export function buildKustomShippingOptions(
  quotes: ShippingQuoteOption[],
  currency: string,
  taxRateBp: number,
  selectedId?: string | null,
): KustomShippingOption[] {
  const preselectedId = quotes.some((q) => q.id === selectedId)
    ? selectedId
    : quotes[0]?.id;
  return quotes.map((q) => {
    const price = toStripeAmount(q.cost, currency);
    const option: KustomShippingOption = {
      id: q.id,
      name: q.name.slice(0, 255),
      price,
      tax_rate: taxRateBp,
      tax_amount: includedTaxMinor(price, taxRateBp),
      preselected: q.id === preselectedId,
      shipping_method: q.type === 'pickup' ? 'PickUpStore' : 'Home',
    };
    const description = q.description ?? formatEstimatedDays(q.estimated_days);
    if (description) option.description = description.slice(0, 255);
    return option;
  });
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

function apiBaseOf(ctx: { apiBase: string }): string {
  return `${ctx.apiBase.replace(/\/$/, '')}/api`;
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
  const api = apiBaseOf(ctx);
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

// ── Payload (order-first flow) ──────────────────────────────────────────────

/** Full create/update body for `/checkout/v3/orders`. */
export function buildKustomCheckoutPayload(
  order: KustomOrderInput,
  ctx: KustomMapperContext,
): KustomCheckoutPayload {
  const country = order.address.country_code.toUpperCase();
  const contentLocale = (ctx.primaryLocale ?? 'en').toLowerCase();
  const locale = resolveKustomLocale(ctx.primaryLocale, country);
  const address = buildKustomAddress(order);
  const lines = buildKustomOrderLines(order, contentLocale, {
    taxRateBp: ctx.taxRateBp ?? 0,
    shippingName: order.shipping_method_name ?? undefined,
  });

  return {
    purchase_country: country,
    purchase_currency: order.currency.toUpperCase(),
    locale,
    order_amount: toStripeAmount(Number(order.total), order.currency),
    order_tax_amount: sumKustomTax(lines),
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

// ── Payload (session-first flow, API-CONTRACT-B.md) ─────────────────────────

export interface KustomSessionMapperContext {
  storeSlug: string;
  customDomain?: string | null;
  primaryLocale: string | null | undefined;
  storefrontBase: string;
  apiBase: string;
  sessionId: string;
  /**
   * Storefront secret: returned to the browser, so it only authenticates the
   * storefront-facing endpoints and the confirmation redirect URL.
   */
  token: string;
  /**
   * Server-side secret: only ever placed in the merchant URLs Kustom calls
   * (push, validation, address_update, shipping_option_update). Never
   * returned to the storefront.
   */
  callbackToken: string;
  taxRateBp: number;
}

/** A priced checkout session: the quote plus what Kustom should prefill. */
export interface KustomSessionInput extends KustomLinesInput {
  /** ISO 3166-1 alpha-2 country the purchase is made in. */
  purchaseCountry: string;
  /** `merchant_reference1` — the session id until the order exists. */
  reference: string;
  reference2?: string;
  email?: string | null;
  phone?: string | null;
  /** Prefilled billing/shipping address (logged-in customers). */
  address?: KustomAddressInput | null;
  /** Options to offer for the current destination; empty until known. */
  shippingOptions: ShippingQuoteOption[];
  selectedShippingId?: string | null;
}

/**
 * Merchant URLs of the session-first flow, all keyed by session id. The
 * confirmation page (opened in the shopper's browser) carries the storefront
 * token; the four server-to-server callbacks carry the callback token only.
 */
export function buildKustomSessionMerchantUrls(
  ctx: KustomSessionMapperContext,
): KustomMerchantUrls {
  const base = resolveStoreBase(
    ctx.storefrontBase,
    ctx.storeSlug,
    ctx.customDomain,
  );
  const api = `${apiBaseOf(ctx)}/payments/kustom/checkout`;
  const sid = encodeURIComponent(ctx.sessionId);
  const token = encodeURIComponent(ctx.token);
  const callback = encodeURIComponent(ctx.callbackToken);
  const auth = `session_id=${sid}&token=${callback}`;
  return {
    terms: `${base}/legal/terms`,
    checkout: `${base}/checkout?kustom_session=${sid}`,
    confirmation: `${base}/checkout/kustom/confirmation?session=${sid}&token=${token}&kustom_order_id={checkout.order.id}`,
    push: `${api}/push?${auth}&kustom_order_id={checkout.order.id}`,
    validation: `${api}/validation?${auth}`,
    address_update: `${api}/address-update?${auth}`,
    shipping_option_update: `${api}/shipping-option-update?${auth}`,
  };
}

/**
 * Amounts, lines and shipping options of a session — the body of an
 * address_update / shipping_option_update response, and the money part of
 * the create/update payload. The selected option's cost is already inside
 * `total` / `shipping_cost` (the quote priced it), so the shipping_fee line
 * simply mirrors it.
 */
export function buildKustomSessionAmounts(
  input: KustomSessionInput,
  ctx: KustomSessionMapperContext,
): KustomCheckoutUpdateResponse {
  const contentLocale = (ctx.primaryLocale ?? 'en').toLowerCase();
  const shippingOptions = buildKustomShippingOptions(
    input.shippingOptions,
    input.currency,
    ctx.taxRateBp,
    input.selectedShippingId,
  );
  const selected = shippingOptions.find((o) => o.preselected);
  const lines = buildKustomOrderLines(input, contentLocale, {
    taxRateBp: ctx.taxRateBp,
    shippingName: selected?.name,
  });
  return {
    order_amount: toStripeAmount(Number(input.total), input.currency),
    order_tax_amount: sumKustomTax(lines),
    order_lines: lines,
    shipping_options: shippingOptions,
    purchase_currency: input.currency.toUpperCase(),
  };
}

/** Full create/update body for a session-first checkout. */
export function buildKustomSessionPayload(
  input: KustomSessionInput,
  ctx: KustomSessionMapperContext,
): KustomCheckoutPayload {
  const amounts = buildKustomSessionAmounts(input, ctx);
  const country = input.purchaseCountry.toUpperCase();
  let address: KustomAddress | undefined;
  if (input.address) {
    address = buildKustomAddress({
      address: input.address,
      customer: { phone: input.phone, user: { email: input.email } },
    });
  } else if (input.email) {
    address = { email: input.email, country };
  }

  const payload: KustomCheckoutPayload = {
    purchase_country: country,
    purchase_currency: amounts.purchase_currency,
    locale: resolveKustomLocale(ctx.primaryLocale, country),
    order_amount: amounts.order_amount,
    order_tax_amount: amounts.order_tax_amount,
    order_lines: amounts.order_lines,
    merchant_reference1: input.reference,
    merchant_urls: buildKustomSessionMerchantUrls(ctx),
    options: {
      auto_capture: false,
      allow_separate_shipping_address: true,
      require_validate_callback_success: true,
    },
  };
  if (input.reference2) payload.merchant_reference2 = input.reference2;
  if (address) {
    payload.billing_address = address;
    payload.shipping_address = address;
  }
  // Omitted (not an empty array) until a destination is known.
  if (amounts.shipping_options.length) {
    payload.shipping_options = amounts.shipping_options;
  }
  return payload;
}

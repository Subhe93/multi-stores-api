import { Prisma, PrismaClient } from '@prisma/client';
import { promises as fs } from 'fs';
import { join, normalize, sep } from 'path';
import sharp from 'sharp';
import { currencyDecimals } from '../../common/money/currency.util';
import { resolveVariantImage } from '../../common/catalog/variant-image.util';

// Per-locale phrasing used inside order emails. The admin can edit the
// surrounding template body in NotificationTemplate, but list headers/labels
// and totals lines need to render in the email's actual locale.
const ITEMS_PHRASES = {
  en: {
    product: 'Product',
    qty: 'Qty',
    price: 'Price',
    subtotal: 'Subtotal',
    shipping: 'Shipping',
    discount: 'Discount',
    total: 'Total',
    includesVat: 'Includes VAT',
    includes: 'Includes',
    tax: 'Tax',
    variant: 'Variant',
    tracking: 'Tracking',
    cancelReason: 'Reason',
    refundAmount: 'Refunded amount',
    paid: 'Your payment was received.',
    cod: 'You chose cash on delivery — please pay the courier on arrival.',
    viewOrder: 'View your order',
  },
  ar: {
    product: 'المنتج',
    qty: 'الكمية',
    price: 'السعر',
    subtotal: 'المجموع الفرعي',
    shipping: 'الشحن',
    discount: 'الخصم',
    total: 'الإجمالي',
    includesVat: 'شامل ضريبة القيمة المضافة',
    includes: 'شامل',
    tax: 'الضريبة',
    variant: 'الخيار',
    tracking: 'رقم التتبّع',
    cancelReason: 'السبب',
    refundAmount: 'المبلغ المُعاد',
    paid: 'تمّ استلام دفعتك.',
    cod: 'اخترتَ الدفع عند الاستلام — يُرجى الدفع للمندوب عند الوصول.',
    viewOrder: 'عرض طلبك',
  },
  tr: {
    product: 'Ürün',
    qty: 'Adet',
    price: 'Fiyat',
    subtotal: 'Ara toplam',
    shipping: 'Kargo',
    discount: 'İndirim',
    total: 'Toplam',
    includesVat: 'KDV dahil',
    includes: 'Dahil',
    tax: 'Vergi',
    variant: 'Seçenek',
    tracking: 'Takip no',
    cancelReason: 'Neden',
    refundAmount: 'İade edilen tutar',
    paid: 'Ödemeniz alındı.',
    cod: 'Kapıda ödemeyi seçtiniz — teslimat sırasında lütfen kuryeye ödeyin.',
    viewOrder: 'Siparişinizi görüntüleyin',
  },
  de: {
    product: 'Produkt',
    qty: 'Menge',
    price: 'Preis',
    subtotal: 'Zwischensumme',
    shipping: 'Versand',
    discount: 'Rabatt',
    total: 'Gesamt',
    includesVat: 'Inkl. MwSt.',
    includes: 'Inkl.',
    tax: 'Steuer',
    variant: 'Variante',
    tracking: 'Sendungsnr.',
    cancelReason: 'Grund',
    refundAmount: 'Erstatteter Betrag',
    paid: 'Ihre Zahlung ist eingegangen.',
    cod: 'Sie haben Nachnahme gewählt — bitte zahlen Sie bei Zustellung.',
    viewOrder: 'Bestellung ansehen',
  },
  fr: {
    product: 'Produit',
    qty: 'Qté',
    price: 'Prix',
    subtotal: 'Sous-total',
    shipping: 'Livraison',
    discount: 'Remise',
    total: 'Total',
    includesVat: 'TVA incluse',
    includes: 'Inclus',
    tax: 'Taxe',
    variant: 'Variante',
    tracking: 'Suivi',
    cancelReason: 'Raison',
    refundAmount: 'Montant remboursé',
    paid: 'Votre paiement a été reçu.',
    cod: 'Paiement à la livraison — réglez le coursier à réception.',
    viewOrder: 'Voir votre commande',
  },
  sv: {
    product: 'Produkt',
    qty: 'Antal',
    price: 'Pris',
    subtotal: 'Delsumma',
    shipping: 'Frakt',
    discount: 'Rabatt',
    total: 'Totalt',
    includesVat: 'Inkl. moms',
    includes: 'Inkl.',
    tax: 'Skatt',
    variant: 'Variant',
    tracking: 'Spårning',
    cancelReason: 'Anledning',
    refundAmount: 'Återbetalat belopp',
    paid: 'Din betalning har mottagits.',
    cod: 'Du valde betalning vid leverans — vänligen betala kuriren vid ankomst.',
    viewOrder: 'Visa din beställning',
  },
} as const;

export type EmailLocale = keyof typeof ITEMS_PHRASES;

export function pickLocale(locale?: string): EmailLocale {
  if (locale && locale in ITEMS_PHRASES) return locale as EmailLocale;
  return 'en';
}

export function emailPhrases(locale?: string) {
  return ITEMS_PHRASES[pickLocale(locale)];
}

// HTML escape — defense-in-depth for translated product names that flow into the
// email body. Same pair lives in templates.ts; kept duplicated here so this file
// is independently importable.
function esc(s: string | number | boolean | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Amounts in emails follow the order's currency. `toFixed(2)` was wrong for
 * currencies with no minor unit (JPY 1200 is not "1200.00"), so the decimals
 * come from the currency itself. Falls back to the plain code + amount if the
 * runtime rejects the currency, since an email must never fail to render.
 */
export function formatMoney(amount: number, currency: string): string {
  const value = Number(amount);
  const digits = currencyDecimals(currency);
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(digits)}`;
  }
}

// Eager-include shape matching OrdersService.itemsWithProduct, sufficient for
// rendering an email line item: title (translated), one image, variant options.
// Order has no direct `store` relation (only `store_id`), so the store is
// loaded separately by loadOrderForEmail.
// `satisfies Prisma.OrderInclude` keeps the literal shape (so Prisma can derive
// the payload type) AND validates against the schema at compile time.
export const orderWithItemsInclude = {
  customer: { include: { user: { select: { email: true } } } },
  address: true,
  items: {
    include: {
      product: {
        include: {
          translations: true,
          images: { take: 1, orderBy: { sort_order: 'asc' } },
        },
      },
      // `images` on the variant, plus variant_option_config on both product
      // shapes, so the email can show the colour the buyer actually chose
      // rather than the generic product shot.
      variant: { include: { images: true } },
      custom_product: {
        include: {
          translations: true,
          mockup_images: { take: 1, orderBy: { sort_order: 'asc' } },
          product: {
            include: {
              images: { take: 1, orderBy: { sort_order: 'asc' } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.OrderInclude;

type Translation = { locale: string; title: string };

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

interface OrderItemForEmail {
  quantity: number;
  unit_price: unknown; // Prisma Decimal
  product?: {
    translations?: Translation[];
    images?: { url: string }[];
    variant_option_config?: unknown;
  } | null;
  variant?: {
    options?: unknown;
    images?: { url: string }[];
  } | null;
  custom_product?: {
    translations?: Translation[];
    mockup_images?: { url: string }[];
    product?: {
      images?: { url: string }[];
      variant_option_config?: unknown;
    } | null;
  } | null;
}

function variantLabel(options: unknown): string {
  if (!options || typeof options !== 'object') return '';
  return Object.entries(options as Record<string, string>)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' / ');
}

/**
 * Render an order's line items as an HTML block (a styled table) and a plain
 * text block. Image URLs are absolutized against PUBLIC_API_URL so mail clients
 * can fetch them.
 */
/** One entry of Order.tax_lines (major units). */
export interface OrderTaxLine {
  label: string;
  rate_bp: number;
  taxable_amount: number;
  tax_amount: number;
}

function formatPercent(rateBp: number): string {
  return (rateBp / 100).toLocaleString('en', { maximumFractionDigits: 2 });
}

/**
 * The itemized tax lines printed under an order total, one per rate:
 * "Inkl. Moms (25 %): SEK 55.00" for tax-inclusive orders (the total never
 * changes), "Moms (25 %): SEK 55.00" for tax-exclusive ones (the tax was
 * added). Orders from before the itemized snapshot fall back to a single
 * line from the headline rate and total. Empty when there is no tax.
 */
export function formatTaxLines(
  order: {
    tax_lines?: unknown;
    tax_pricing_mode?: 'INCLUSIVE' | 'EXCLUSIVE' | null;
    tax_rate_bp?: number | null;
    tax_amount?: unknown;
  },
  currency: string,
  locale?: string,
): string[] {
  const phrases = emailPhrases(locale);
  const inclusive = order.tax_pricing_mode !== 'EXCLUSIVE';
  const lines: OrderTaxLine[] = Array.isArray(order.tax_lines)
    ? (order.tax_lines as unknown[])
        .filter((l): l is OrderTaxLine => !!l && typeof l === 'object')
        .map((l) => ({
          label: String(l.label || phrases.tax),
          rate_bp: Number(l.rate_bp) || 0,
          taxable_amount: Number(l.taxable_amount) || 0,
          tax_amount: Number(l.tax_amount) || 0,
        }))
    : [];
  if (lines.length === 0) {
    const rate = Number(order.tax_rate_bp || 0);
    const amount = Number(order.tax_amount || 0);
    if (!(rate > 0) || !(amount > 0)) return [];
    return [
      `${phrases.includesVat} (${formatPercent(rate)} %): ${formatMoney(amount, currency)}`,
    ];
  }
  return lines
    .filter((l) => l.tax_amount !== 0)
    .map((l) => {
      const body = `${l.label} (${formatPercent(l.rate_bp)} %): ${formatMoney(l.tax_amount, currency)}`;
      return inclusive ? `${phrases.includes} ${body}` : body;
    });
}

/**
 * The "Shipping (Standard shipping): SEK 49.00" line printed above an order
 * total. The method name is the order's snapshot (already in the store's
 * locale); the line is empty when the order neither cost anything to ship
 * nor recorded a method.
 */
export function formatShippingLine(
  shippingCost: number | null | undefined,
  methodName: string | null | undefined,
  currency: string,
  locale?: string,
): string {
  const cost = Number(shippingCost || 0);
  const name = methodName?.trim();
  if (!(cost > 0) && !name) return '';
  const label = name
    ? `${emailPhrases(locale).shipping} (${name})`
    : emailPhrases(locale).shipping;
  return `${label}: ${formatMoney(cost, currency)}`;
}

export function renderOrderItems(
  items: OrderItemForEmail[],
  currency: string,
  locale: string | undefined,
  publicBase: string,
): { items_html: string; items_text: string } {
  const phrases = emailPhrases(locale);
  const lang = pickLocale(locale);

  if (!items.length) return { items_html: '', items_text: '' };

  const rows = items
    .map((item) => {
      const title =
        pickTitle(item.custom_product?.translations, lang) ||
        pickTitle(item.product?.translations, lang) ||
        phrases.product;
      // Same precedence the storefront and cart use: the creator's mockup
      // first, then the image for the chosen option value (the colour the
      // buyer picked), then the generic product shot.
      const variantImage = resolveVariantImage({
        optionConfig:
          item.product?.variant_option_config ??
          item.custom_product?.product?.variant_option_config,
        variantOptions: item.variant?.options,
        variantImages: item.variant?.images,
      });
      const imgPath =
        item.custom_product?.mockup_images?.[0]?.url ||
        variantImage ||
        item.custom_product?.product?.images?.[0]?.url ||
        item.product?.images?.[0]?.url;
      const imgUrl = imgPath ? absoluteUrl(imgPath, publicBase) : '';
      const vLabel = variantLabel(item.variant?.options);
      const unit = Number(item.unit_price ?? 0);
      const line = unit * item.quantity;

      return `<tr>
  <td style="padding:12px 8px;border-bottom:1px solid #e4e4e7;vertical-align:top;">
    ${imgUrl ? `<img src="${esc(imgUrl)}" alt="${esc(title)}" width="64" height="64" style="display:block;border-radius:6px;border:1px solid #e4e4e7;object-fit:cover;" />` : ''}
  </td>
  <td style="padding:12px 8px;border-bottom:1px solid #e4e4e7;vertical-align:top;font-size:13px;color:#18181b;">
    <div style="font-weight:600;">${esc(title)}</div>
    ${vLabel ? `<div style="color:#71717a;font-size:11px;margin-top:2px;">${esc(vLabel)}</div>` : ''}
    <div style="color:#71717a;font-size:11px;margin-top:2px;">${phrases.qty}: ${item.quantity}</div>
  </td>
  <td style="padding:12px 8px;border-bottom:1px solid #e4e4e7;vertical-align:top;text-align:end;font-size:13px;color:#18181b;font-weight:600;white-space:nowrap;">
    ${esc(formatMoney(line, currency))}
  </td>
</tr>`;
    })
    .join('\n');

  const items_html = `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:12px 0;">
  <tbody>
    ${rows}
  </tbody>
</table>`;

  const items_text = items
    .map((item) => {
      const title =
        pickTitle(item.custom_product?.translations, lang) ||
        pickTitle(item.product?.translations, lang) ||
        phrases.product;
      const vLabel = variantLabel(item.variant?.options);
      const unit = Number(item.unit_price ?? 0);
      const line = unit * item.quantity;
      return `- ${title}${vLabel ? ` (${vLabel})` : ''} × ${item.quantity} — ${formatMoney(line, currency)}`;
    })
    .join('\n');

  return { items_html, items_text };
}

export function absoluteUrl(maybeRelative: string, base: string): string {
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  const cleanBase = base.replace(/\/$/, '');
  const cleanPath = maybeRelative.startsWith('/')
    ? maybeRelative
    : `/${maybeRelative}`;
  return `${cleanBase}${cleanPath}`;
}

/**
 * Public home of a store: its own domain when it has one, otherwise its path
 * on the platform storefront.
 */
export function buildStoreUrl(
  storeSlug: string | undefined,
  storefrontBase: string,
  customDomain?: string,
): string {
  if (customDomain) return `https://${customDomain.replace(/\/$/, '')}`;
  const cleanBase = storefrontBase.replace(/\/$/, '');
  return storeSlug ? `${cleanBase}/store/${storeSlug}` : cleanBase;
}

export function buildOrderUrl(
  storeSlug: string | undefined,
  orderId: string,
  storefrontBase: string,
  customDomain?: string,
): string {
  return `${buildStoreUrl(storeSlug, storefrontBase, customDomain)}/account/orders/${orderId}`;
}

/**
 * Most mail clients (Gmail, Outlook) do not render SVG images, so a store
 * whose logo is an SVG would show no logo at all. Returns the path of a PNG
 * rendition stored next to the original (created on first use); any other
 * format, or any failure, returns the original path unchanged.
 */
export async function emailSafeLogoPath(logoPath: string): Promise<string> {
  if (/^https?:\/\//i.test(logoPath) || !/\.svg$/i.test(logoPath)) {
    return logoPath;
  }
  const relative = normalize(logoPath.replace(/^[\\/]+/, ''));
  // Only ever touch files under uploads/.
  if (!relative.startsWith(`uploads${sep}`) || relative.includes('..')) {
    return logoPath;
  }
  const source = join(process.cwd(), relative);
  const target = source.replace(/\.svg$/i, '.email.png');
  const publicPath = logoPath.replace(/\.svg$/i, '.email.png');
  try {
    await fs.access(target);
    return publicPath;
  } catch {
    // not rendered yet
  }
  try {
    await sharp(source, { density: 300 })
      .resize({ width: 480, withoutEnlargement: false })
      .png()
      .toFile(target);
    return publicPath;
  } catch {
    return logoPath;
  }
}

const TOTALS_PHRASES: Record<
  EmailLocale,
  { card: string; cod: string; free: string }
> = {
  en: { card: 'Card', cod: 'Cash on delivery', free: 'Free' },
  ar: { card: 'بطاقة', cod: 'الدفع عند الاستلام', free: 'مجاني' },
  tr: { card: 'Kart', cod: 'Kapıda ödeme', free: 'Ücretsiz' },
  de: { card: 'Karte', cod: 'Nachnahme', free: 'Kostenlos' },
  fr: { card: 'Carte', cod: 'Paiement à la livraison', free: 'Gratuit' },
  sv: { card: 'Kort', cod: 'Betalning vid leverans', free: 'Gratis' },
};

/** "Kustom", "Visa •••• 4242", "Card" or the cash-on-delivery label. */
export function formatPaymentMethod(
  order: {
    payment_method: string;
    card_brand?: string | null;
    card_last4?: string | null;
  },
  locale?: string,
): string {
  const phrases = TOTALS_PHRASES[pickLocale(locale)];
  if (order.payment_method === 'KUSTOM') return 'Kustom';
  if (order.payment_method === 'COD') return phrases.cod;
  if (order.card_brand && order.card_last4) {
    const brand =
      order.card_brand.charAt(0).toUpperCase() + order.card_brand.slice(1);
    return `${brand} •••• ${order.card_last4}`;
  }
  return phrases.card;
}

export function formatOrderDate(date: Date, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(pickLocale(locale), {
      dateStyle: 'long',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function countryName(code: string, locale?: string): string {
  try {
    return (
      new Intl.DisplayNames([pickLocale(locale)], { type: 'region' }).of(
        code.toUpperCase(),
      ) || code
    );
  } catch {
    return code;
  }
}

/** The delivery address as an HTML block (lines joined by <br>) and as text. */
export function renderShippingAddress(
  address:
    | {
        full_name: string;
        line1: string;
        line2?: string | null;
        city: string;
        state?: string | null;
        postal_code: string;
        country_code: string;
        phone?: string | null;
      }
    | null
    | undefined,
  locale?: string,
): { html: string; text: string } {
  if (!address) return { html: '', text: '' };
  const lines = [
    address.full_name,
    address.line1,
    address.line2 || '',
    [address.postal_code, address.city].filter(Boolean).join(' '),
    address.state || '',
    countryName(address.country_code, locale),
    address.phone || '',
  ]
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    html: lines.map((l) => esc(l)).join('<br />'),
    text: lines.join('\n'),
  };
}

/**
 * The totals block under the items: subtotal, discount, shipping, total and
 * the itemized tax lines, in the email's locale. Colours are neutral so the
 * block sits well inside any template.
 */
export function renderOrderTotals(
  input: {
    subtotal: number;
    discount: number;
    shipping: number;
    shippingMethod?: string | null;
    total: number;
    taxLines: string[];
  },
  currency: string,
  locale?: string,
): { totals_html: string; totals_text: string } {
  const phrases = emailPhrases(locale);
  const free = TOTALS_PHRASES[pickLocale(locale)].free;
  const method = input.shippingMethod?.trim();
  const shippingLabel = method
    ? `${phrases.shipping} (${method})`
    : phrases.shipping;
  const showShipping = input.shipping > 0 || !!method;

  const rows: Array<{ label: string; value: string }> = [
    { label: phrases.subtotal, value: formatMoney(input.subtotal, currency) },
  ];
  if (input.discount > 0) {
    rows.push({
      label: phrases.discount,
      value: `−${formatMoney(input.discount, currency)}`,
    });
  }
  if (showShipping) {
    rows.push({
      label: shippingLabel,
      value: input.shipping > 0 ? formatMoney(input.shipping, currency) : free,
    });
  }

  const cell =
    'padding:4px 0;font-size:13px;line-height:1.5;color:#52525b;vertical-align:top;';
  const htmlRows = rows
    .map(
      (r) => `<tr>
  <td style="${cell}">${esc(r.label)}</td>
  <td style="${cell}text-align:end;white-space:nowrap;">${esc(r.value)}</td>
</tr>`,
    )
    .join('\n');
  const totalCell =
    'padding:12px 0 4px;border-top:1px solid #e4e4e7;font-size:16px;font-weight:700;color:#18181b;';
  const taxHtml = input.taxLines
    .map(
      (line) =>
        `<tr><td colspan="2" style="padding:0;font-size:12px;line-height:1.6;color:#71717a;text-align:end;">${esc(line)}</td></tr>`,
    )
    .join('\n');

  const totals_html = `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:4px 0 0;">
  <tbody>
${htmlRows}
<tr><td colspan="2" style="padding:0;height:8px;line-height:8px;font-size:0;">&nbsp;</td></tr>
<tr>
  <td style="${totalCell}">${esc(phrases.total)}</td>
  <td style="${totalCell}text-align:end;white-space:nowrap;">${esc(formatMoney(input.total, currency))}</td>
</tr>
${taxHtml}
  </tbody>
</table>`;

  const totals_text = [
    ...rows.map((r) => `${r.label}: ${r.value}`),
    `${phrases.total}: ${formatMoney(input.total, currency)}`,
    ...input.taxLines,
  ].join('\n');

  return { totals_html, totals_text };
}

// Concrete Prisma payload type so call sites get full property typings without
// each one having to re-derive the include shape.
type OrderBasePayload = Prisma.OrderGetPayload<{
  include: typeof orderWithItemsInclude;
}>;

export interface OrderStoreContext {
  id: string;
  slug: string;
  name: string;
  /** The store's own domain, when it has one (links then point there). */
  customDomain?: string;
  /** Used to brand the email — customers buy from the shop, not the platform. */
  logoUrl?: string;
  primaryLocale?: string;
  ownerEmail?: string;
}

export type OrderForEmail = OrderBasePayload & {
  // Store is attached separately because Order has no direct relation to Store.
  storeCtx: OrderStoreContext | null;
};

/**
 * Load an order with everything an email might need (customer, items with
 * translated titles and primary image) plus the store context for locale +
 * owner-email lookup. Returns null when the order is missing.
 */
export async function loadOrderForEmail(
  prisma: PrismaClient,
  orderId: string,
): Promise<OrderForEmail | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: orderWithItemsInclude,
  });
  if (!order) return null;

  let storeCtx: OrderStoreContext | null = null;
  if (order.store_id) {
    const store = await prisma.store.findUnique({
      where: { id: order.store_id },
      select: {
        id: true,
        slug: true,
        name: true,
        custom_domain: true,
        logo_url: true,
        notification_email: true,
        language_config: { select: { primary_locale: true } },
        creator: { select: { user: { select: { email: true } } } },
      },
    });
    if (store) {
      storeCtx = {
        id: store.id,
        slug: store.slug,
        name: store.name,
        customDomain: store.custom_domain ?? undefined,
        logoUrl: store.logo_url ?? undefined,
        primaryLocale: store.language_config?.primary_locale,
        // The store's notifications address wins over the login email.
        ownerEmail:
          store.notification_email?.trim() || store.creator?.user?.email,
      };
    }
  }

  return { ...order, storeCtx };
}

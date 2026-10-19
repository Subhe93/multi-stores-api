import { Prisma, PrismaClient } from '@prisma/client';
import { promises as fs } from 'fs';
import { join, normalize, sep } from 'path';
import sharp from 'sharp';
import { currencyDecimals } from '../../common/money/currency.util';
import { resolveVariantImage } from '../../common/catalog/variant-image.util';
import {
  isSnapshotFileRow,
  snapshotLabel,
  sortSnapshotRows,
  type SnapshotValueRow,
} from '../../common/personalization/snapshot-label';
import {
  buildPersonalizationGroups,
  hasPersonalizationGroups,
  type PDisplayRow,
} from '@multi-stores/core/personalization/display';
import { SUPPORTED_LOCALES } from '../markets/market.types';

// Per-locale phrasing used inside order emails. The admin can edit the
// surrounding template body in NotificationTemplate, but list headers/labels
// and totals lines need to render in the email's actual locale.
const ITEMS_PHRASES = {
  en: {
    product: 'Product',
    qty: 'Qty',
    back: 'Back',
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
    fileUploaded: 'File uploaded',
    // M4.1: label of a personalization item without a stored label.
    itemN: 'Item {i}',
  },
  ar: {
    product: 'المنتج',
    qty: 'الكمية',
    back: 'الوجه الخلفي',
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
    fileUploaded: 'تم رفع ملف',
    // M4.1: label of a personalization item without a stored label.
    itemN: 'القطعة {i}',
  },
  tr: {
    product: 'Ürün',
    qty: 'Adet',
    back: 'Arka yüz',
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
    fileUploaded: 'Dosya yüklendi',
    // M4.1: label of a personalization item without a stored label.
    itemN: 'Ürün {i}',
  },
  de: {
    product: 'Produkt',
    qty: 'Menge',
    back: 'Rückseite',
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
    fileUploaded: 'Datei hochgeladen',
    // M4.1: label of a personalization item without a stored label.
    itemN: 'Artikel {i}',
  },
  fr: {
    product: 'Produit',
    qty: 'Qté',
    back: 'Verso',
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
    fileUploaded: 'Fichier téléversé',
    // M4.1: label of a personalization item without a stored label.
    itemN: 'Article {i}',
  },
  sv: {
    product: 'Produkt',
    qty: 'Antal',
    back: 'Baksida',
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
    fileUploaded: 'Fil uppladdad',
    // M4.1: label of a personalization item without a stored label.
    itemN: 'Artikel {i}',
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
      // M4.0 (§7): personalization values, read from the frozen snapshot
      // (the live field only for rows written before it existed).
      custom_field_values: {
        orderBy: { id: 'asc' },
        select: {
          value: true,
          file_url: true,
          field_name: true,
          field_type: true,
          field_label: true,
          display_value: true,
          sort_order: true,
          // M4.1 (C1): repeater grouping, option rows and colour meta.
          group_key: true,
          group_index: true,
          group_label: true,
          source: true,
          meta: true,
          custom_field: {
            select: {
              name: true,
              type: true,
              translations: {
                select: { locale: true, label: true, option_labels: true },
              },
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
  /** OrderItem.id (key of the `itemImages` overrides). */
  id?: string;
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
  /** M4.0: personalization values (snapshot columns + live fallback). */
  custom_field_values?: (SnapshotValueRow & PersonalizationGroupColumns)[];
}

/** M4.1 snapshot columns (C1) the grouped rendering reads. */
export interface PersonalizationGroupColumns {
  sort_order?: number | null;
  group_key?: string | null;
  group_index?: number | null;
  group_label?: unknown;
  source?: string | null;
  meta?: unknown;
}

/** "Artikel 2" when a grouped row stored no label (localized fallback). */
export function personalizationItemLabel(
  locale: string | undefined,
  index: number,
): string {
  return emailPhrases(locale).itemN.replace('{i}', String(index));
}

/**
 * One printable personalization line: a field ("Namn: KARIN"), or a
 * personalization item (M4.1) whose `parts` are its values in order
 * ("Artikel 2" with ["KARIN", "Röd"]).
 */
export interface PersonalizationPrintLine {
  label: string;
  text: string;
  parts?: string[];
}

/**
 * Personalization lines of one order line, shared by the email and the
 * invoice (M4.0 §7 / M4.1 §4.2). Rows without groups give the M4.0 flat
 * "Label: text" list unchanged. With repeater groups (rows carrying
 * `group_index`, app only), each item prints once at the position of its
 * first row, as its label and its values; variant option rows outside a
 * group are skipped (the variant line shows them).
 */
export function personalizationPrintLines(
  rows: readonly (SnapshotValueRow & PersonalizationGroupColumns)[],
  locale: string | undefined,
  primaryLocale: string | undefined,
  fileText: string,
): PersonalizationPrintLine[] {
  if (rows.length === 0) return [];
  const sorted = sortSnapshotRows(rows);
  const textOf = (
    row: SnapshotValueRow,
  ): { label: string; text: string | null } => {
    const { label, value } = snapshotLabel(row, locale, primaryLocale);
    return { label, text: isSnapshotFileRow(row) ? fileText : value };
  };
  if (!hasPersonalizationGroups(sorted)) {
    const out: PersonalizationPrintLine[] = [];
    for (const row of sorted) {
      const { label, text } = textOf(row);
      if (!text) continue;
      out.push({ label, text });
    }
    return out;
  }

  const display: PDisplayRow[] = sorted.map((row, i) => {
    const { label, text } = textOf(row);
    return {
      label,
      value: text,
      group_key: row.group_key ?? null,
      group_index: typeof row.group_index === 'number' ? row.group_index : null,
      group_label: (row.group_label ?? null) as PDisplayRow['group_label'],
      source: row.source ?? 'FIELD',
      meta: (row.meta ?? null) as PDisplayRow['meta'],
      // Already sorted: keep this order inside the groups.
      sort_order: i,
    };
  });
  const { groups } = buildPersonalizationGroups(display, {
    locale,
    primary: primaryLocale,
    defaultGroupLabel: (index) => personalizationItemLabel(locale, index),
  });
  const out: PersonalizationPrintLine[] = [];
  const printed = new Set<string>();
  for (const row of display) {
    if (typeof row.group_index !== 'number') {
      if (row.source === 'OPTION' || !row.value) continue;
      out.push({ label: row.label, text: row.value });
      continue;
    }
    const id = `${row.group_key ?? ''}#${row.group_index}`;
    if (printed.has(id)) continue;
    printed.add(id);
    const group = groups.find(
      (g) => g.key === (row.group_key ?? '') && g.index === row.group_index,
    );
    const parts = (group?.entries ?? [])
      .map((e) => e.value)
      .filter((v): v is string => typeof v === 'string' && v !== '');
    if (!group || parts.length === 0) continue;
    out.push({ label: group.label, text: parts.join(', '), parts });
  }
  return out;
}

/**
 * "Label: text" pairs of a line's personalization (M4.0 §7): sorted by the
 * snapshot's sort order, labels and option texts in the email's locale, and
 * a phrase instead of a URL for files (customer files are private). Empty
 * for a line without values.
 */
function personalizationLines(
  item: OrderItemForEmail,
  locale: string | undefined,
  primaryLocale: string | undefined,
): PersonalizationPrintLine[] {
  return personalizationPrintLines(
    item.custom_field_values ?? [],
    locale,
    primaryLocale,
    emailPhrases(locale).fileUploaded,
  );
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
  primaryLocale?: string,
  /**
   * Per order item image that wins over the product images (an app's
   * `itemImages` hook, e.g. the designer proof). Absent or empty: the output
   * is byte-identical to the renderer without overrides. A `<item id>:back`
   * entry (M5.6 double-sided) shows that image under the line's image.
   */
  imageOverrides?: Readonly<Record<string, string>>,
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
      const override = item.id ? imageOverrides?.[item.id] : undefined;
      const backOverride =
        override && item.id ? imageOverrides?.[`${item.id}:back`] : undefined;
      const imgUrl = override
        ? absoluteUrl(override, publicBase)
        : imgPath
          ? absoluteUrl(imgPath, publicBase)
          : '';
      const vLabel = variantLabel(item.variant?.options);
      const unit = Number(item.unit_price ?? 0);
      const line = unit * item.quantity;
      // Appended to the variant line, so a line without values renders
      // exactly as before (G0).
      const valuesHtml = personalizationLines(item, locale, primaryLocale)
        .map(
          (v) =>
            // M4.1 items: "Artikel 2: KARIN · Röd" (each part escaped).
            `<div style="color:#71717a;font-size:11px;margin-top:2px;">${esc(v.label)}: ${v.parts ? v.parts.map((x) => esc(x)).join(' · ') : esc(v.text)}</div>`,
        )
        .join('');

      return `<tr>
  <td style="padding:12px 8px;border-bottom:1px solid #e4e4e7;vertical-align:top;">
    ${
      override
        ? // An override keeps its own aspect ratio (a portrait proof is never squashed).
          `<img src="${esc(imgUrl)}" alt="${esc(title)}" width="64" style="display:block;width:64px;height:auto;border-radius:6px;border:1px solid #e4e4e7;" />${
            backOverride
              ? `<img src="${esc(absoluteUrl(backOverride, publicBase))}" alt="${esc(title)} (${phrases.back})" width="64" style="display:block;width:64px;height:auto;margin-top:4px;border-radius:6px;border:1px solid #e4e4e7;" />`
              : ''
          }`
        : imgUrl
          ? `<img src="${esc(imgUrl)}" alt="${esc(title)}" width="64" height="64" style="display:block;border-radius:6px;border:1px solid #e4e4e7;object-fit:cover;" />`
          : ''
    }
  </td>
  <td style="padding:12px 8px;border-bottom:1px solid #e4e4e7;vertical-align:top;font-size:13px;color:#18181b;">
    <div style="font-weight:600;">${esc(title)}</div>
    ${vLabel ? `<div style="color:#71717a;font-size:11px;margin-top:2px;">${esc(vLabel)}</div>` : ''}${valuesHtml}
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
      const valuesText = personalizationLines(item, locale, primaryLocale)
        .map(
          (v) => `
    ${v.label}: ${v.text}`,
        )
        .join('');
      return `- ${title}${vLabel ? ` (${vLabel})` : ''} × ${item.quantity} — ${formatMoney(line, currency)}${valuesText}`;
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

// b2b app: labels of the company block and of the net/gross rows a company
// order prints in its totals.
const COMPANY_PHRASES: Record<
  EmailLocale,
  {
    companyLabel: string;
    orgNumber: string;
    vatNumber: string;
    reference: string;
    netTotal: string;
    totalInclVat: string;
    /** M2.5: printed when the order carries reverse charge; {vat} = number. */
    reverseChargeNote: string;
  }
> = {
  en: {
    companyLabel: 'Company',
    orgNumber: 'Organisation number',
    vatNumber: 'VAT number',
    reference: 'Reference',
    netTotal: 'Net total',
    totalInclVat: 'Total incl. VAT',
    reverseChargeNote:
      'Reverse charge: VAT to be accounted for by the recipient (VAT no. {vat})',
  },
  ar: {
    companyLabel: 'الشركة',
    orgNumber: 'رقم السجل التجاري',
    vatNumber: 'الرقم الضريبي',
    reference: 'المرجع',
    netTotal: 'الإجمالي الصافي',
    totalInclVat: 'الإجمالي شامل الضريبة',
    reverseChargeNote:
      'التكليف العكسي: يتحمّل المستلم احتساب ضريبة القيمة المضافة (الرقم الضريبي {vat})',
  },
  tr: {
    companyLabel: 'Şirket',
    orgNumber: 'Kuruluş numarası',
    vatNumber: 'KDV numarası',
    reference: 'Referans',
    netTotal: 'Net toplam',
    totalInclVat: 'KDV dahil toplam',
    reverseChargeNote:
      'Ters ifa (sorumlu sıfatıyla): KDV alıcı tarafından beyan edilir (KDV no. {vat})',
  },
  de: {
    companyLabel: 'Firma',
    orgNumber: 'Organisationsnummer',
    vatNumber: 'USt-IdNr.',
    reference: 'Referenz',
    netTotal: 'Nettosumme',
    totalInclVat: 'Gesamt inkl. MwSt.',
    reverseChargeNote:
      'Steuerschuldnerschaft des Leistungsempfängers: Die Umsatzsteuer schuldet der Empfänger (USt-IdNr. {vat})',
  },
  fr: {
    companyLabel: 'Entreprise',
    orgNumber: 'Numéro d’organisation',
    vatNumber: 'Numéro de TVA',
    reference: 'Référence',
    netTotal: 'Total HT',
    totalInclVat: 'Total TTC',
    reverseChargeNote:
      'Autoliquidation : TVA due par le preneur (n° de TVA {vat})',
  },
  sv: {
    companyLabel: 'Företag',
    orgNumber: 'Organisationsnummer',
    vatNumber: 'Momsregistreringsnummer',
    reference: 'Referens',
    netTotal: 'Nettosumma',
    totalInclVat: 'Totalt inkl. moms',
    reverseChargeNote:
      'Omvänd skattskyldighet: köparen redovisar momsen (momsreg.nr {vat})',
  },
};

export function companyPhrases(locale?: string) {
  return COMPANY_PHRASES[pickLocale(locale)];
}

/**
 * The company block of an order placed as a company (b2b app): name,
 * organisation number, VAT number and buyer reference, as an HTML block
 * (lines joined by <br>) and as text. Empty for a person order, so a
 * template may always print `{{company_block_html}}`.
 */
export function renderCompanyBlock(
  order: {
    customer_type?: string | null;
    company_name?: string | null;
    org_number?: string | null;
    vat_number?: string | null;
    buyer_reference?: string | null;
    /** b2b app M2.5: set when the order carries no VAT. */
    tax_exempt_reason?: string | null;
    vat_validation?: unknown;
  },
  locale?: string,
): { html: string; text: string } {
  if (order.customer_type !== 'COMPANY') return { html: '', text: '' };
  const evidenceVat =
    order.vat_validation &&
    typeof order.vat_validation === 'object' &&
    typeof (order.vat_validation as { vat_number?: unknown }).vat_number ===
      'string'
      ? (order.vat_validation as { vat_number: string }).vat_number
      : '';
  const rcVat = order.vat_number?.trim() || evidenceVat;
  const phrases = companyPhrases(locale);
  const lines = [
    order.company_name?.trim() || '',
    order.org_number?.trim()
      ? `${phrases.orgNumber}: ${order.org_number.trim()}`
      : '',
    order.vat_number?.trim()
      ? `${phrases.vatNumber}: ${order.vat_number.trim()}`
      : '',
    order.buyer_reference?.trim()
      ? `${phrases.reference}: ${order.buyer_reference.trim()}`
      : '',
    order.tax_exempt_reason === 'REVERSE_CHARGE'
      ? phrases.reverseChargeNote.replace('{vat}', rcVat || '-')
      : '',
  ].filter(Boolean);
  if (lines.length === 0) return { html: '', text: '' };
  return {
    html: lines.map((l) => esc(l)).join('<br />'),
    text: lines.join('\n'),
  };
}

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
 *
 * b2b app: with `buyerMode: 'excl'` (a company order) the block prints a
 * "Net total" row and the VAT rows as regular rows before a final "Total
 * incl. VAT"; the amounts are the same, only the presentation changes.
 * Without it the output is exactly the pre-app one.
 */
export function renderOrderTotals(
  input: {
    subtotal: number;
    discount: number;
    shipping: number;
    shippingMethod?: string | null;
    total: number;
    taxLines: string[];
    /** 'excl' renders the company (net-first) layout; default 'incl'. */
    buyerMode?: 'incl' | 'excl';
    /** Net total (total - tax); required for the 'excl' layout. */
    netTotal?: number;
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
  const excl = input.buyerMode === 'excl';
  const company = companyPhrases(locale);

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
  if (excl) {
    rows.push({
      label: company.netTotal,
      value: formatMoney(input.netTotal ?? input.total, currency),
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
  // Company layout: the VAT rows sit above the total as regular rows;
  // person layout: muted lines under it (unchanged).
  const taxHtml = input.taxLines
    .map((line) =>
      excl
        ? `<tr><td colspan="2" style="${cell}text-align:end;">${esc(line)}</td></tr>`
        : `<tr><td colspan="2" style="padding:0;font-size:12px;line-height:1.6;color:#71717a;text-align:end;">${esc(line)}</td></tr>`,
    )
    .join('\n');
  const totalLabel = excl ? company.totalInclVat : phrases.total;
  const totalRow = `<tr><td colspan="2" style="padding:0;height:8px;line-height:8px;font-size:0;">&nbsp;</td></tr>
<tr>
  <td style="${totalCell}">${esc(totalLabel)}</td>
  <td style="${totalCell}text-align:end;white-space:nowrap;">${esc(formatMoney(input.total, currency))}</td>
</tr>`;

  const totals_html = `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:4px 0 0;">
  <tbody>
${htmlRows}
${excl ? `${taxHtml}\n${totalRow}` : `${totalRow}\n${taxHtml}`}
  </tbody>
</table>`;

  const totals_text = (
    excl
      ? [
          ...rows.map((r) => `${r.label}: ${r.value}`),
          ...input.taxLines,
          `${totalLabel}: ${formatMoney(input.total, currency)}`,
        ]
      : [
          ...rows.map((r) => `${r.label}: ${r.value}`),
          `${totalLabel}: ${formatMoney(input.total, currency)}`,
          ...input.taxLines,
        ]
  ).join('\n');

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

/** Markets app: the locales the order's market serves. */
export interface OrderMarketLocales {
  default_locale: string;
  locales: string[];
}

export type OrderForEmail = OrderBasePayload & {
  // Store is attached separately because Order has no direct relation to Store.
  storeCtx: OrderStoreContext | null;
  /** Markets app: absent / null for an order without a market. */
  marketLocales?: OrderMarketLocales | null;
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
        // Markets app: the host the order was placed on (null without it).
        customDomain: order.hostname ?? store.custom_domain ?? undefined,
        logoUrl: store.logo_url ?? undefined,
        primaryLocale: store.language_config?.primary_locale,
        // The store's notifications address wins over the login email.
        ownerEmail:
          store.notification_email?.trim() || store.creator?.user?.email,
      };
    }
  }

  // Markets app: the market's locales bound the customer email locale
  // (customerEmailLocale). No query for an order without a market.
  const marketLocales = order.market_id
    ? await prisma.market.findUnique({
        where: { id: order.market_id },
        select: { default_locale: true, locales: true },
      })
    : null;

  return order.market_id
    ? { ...order, storeCtx, marketLocales }
    : { ...order, storeCtx };
}

/**
 * Markets app: the locale a customer order email is rendered in. An order
 * placed in a market carries the storefront locale it was placed in (e.g.
 * `en` on namez.shop); that wins over the store's primary locale, like the
 * invoice PDF (resolveInvoiceLocale). The order locale is only honoured when
 * the market serves it (it comes from the storefront request); otherwise the
 * market's default locale answers. Undefined (= store primary, today's
 * behaviour) for orders without a market, or when neither is a supported
 * locale.
 */
export function customerEmailLocale(order: {
  market_id?: string | null;
  locale?: string | null;
  marketLocales?: OrderMarketLocales | null;
}): string | undefined {
  if (!order.market_id) return undefined;
  const supported = (raw: string | null | undefined) => {
    const lang = langOf(raw);
    return (SUPPORTED_LOCALES as readonly string[]).includes(lang)
      ? lang
      : undefined;
  };
  const served = order.marketLocales
    ? [order.marketLocales.default_locale, ...order.marketLocales.locales].map(
        langOf,
      )
    : null;
  const lang = supported(order.locale);
  if (lang && (!served || served.includes(lang))) return lang;
  return served ? supported(order.marketLocales?.default_locale) : undefined;
}

function langOf(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase().split(/[-_]/)[0];
}

/** The order events that send an email. */
export type OrderEmailEvent =
  | 'order_confirmation'
  | 'order_shipped'
  | 'order_delivered'
  | 'order_cancelled'
  | 'order_refunded'
  | 'new_order_owner';

/** A file attached to an outgoing email. */
export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

/** Context the dispatcher hands to an extension's `vars`. */
export interface OrderMailExtensionContext {
  /** The customer's order page (account, requires login). */
  orderUrl: string;
}

/**
 * A seam through which an app adds to order emails without MailModule
 * importing it (the reverse of OrdersService's shipped hooks). Registered with
 * MailService.registerOrderMailExtension, typically in an app module's
 * onModuleInit. Failures are logged and ignored: an extension can never stop
 * an order email from going out.
 */
export interface OrderMailExtension {
  /** Extra template variables (may include `html:` escaped variants). */
  vars?(
    order: OrderForEmail,
    event: OrderEmailEvent,
    locale: string | undefined,
    ctx: OrderMailExtensionContext,
  ): Promise<Record<string, string>>;
  /**
   * Files to attach to the customer email of this event. `onSent` runs only
   * after the message was actually handed to an SMTP server.
   */
  /**
   * Per order item images that replace the product image in the items block
   * (`OrderItem.id` → absolute or API-relative URL). Optional; an item
   * without an entry keeps its product image.
   */
  itemImages?(
    order: OrderForEmail,
    event: OrderEmailEvent,
  ): Promise<Record<string, string>>;
  attachments?(
    order: OrderForEmail,
    event: OrderEmailEvent,
  ): Promise<{
    files: MailAttachment[];
    onSent?: () => Promise<void>;
  } | null>;
}

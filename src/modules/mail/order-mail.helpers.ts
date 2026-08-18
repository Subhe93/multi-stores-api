import { Prisma, PrismaClient } from '@prisma/client';
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
  if (locale && (locale in ITEMS_PHRASES)) return locale as EmailLocale;
  return 'en';
}

export function emailPhrases(locale?: string) {
  return ITEMS_PHRASES[pickLocale(locale)];
}

// HTML escape — defense-in-depth for translated product names that flow into the
// email body. Same pair lives in templates.ts; kept duplicated here so this file
// is independently importable.
function esc(s: unknown): string {
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

function pickTitle(translations: Translation[] | undefined, locale: string): string {
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
    product?: { images?: { url: string }[]; variant_option_config?: unknown } | null;
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
    ${imgUrl ? `<img src="${esc(imgUrl)}" alt="${esc(title)}" width="48" height="48" style="border-radius:6px;border:1px solid #e4e4e7;object-fit:cover;" />` : ''}
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
  const cleanPath = maybeRelative.startsWith('/') ? maybeRelative : `/${maybeRelative}`;
  return `${cleanBase}${cleanPath}`;
}

export function buildOrderUrl(storeSlug: string | undefined, orderId: string, storefrontBase: string): string {
  const cleanBase = storefrontBase.replace(/\/$/, '');
  if (storeSlug) return `${cleanBase}/store/${storeSlug}/account/orders/${orderId}`;
  return `${cleanBase}/account/orders/${orderId}`;
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
        logo_url: true,
        language_config: { select: { primary_locale: true } },
        creator: { select: { user: { select: { email: true } } } },
      },
    });
    if (store) {
      storeCtx = {
        id: store.id,
        slug: store.slug,
        name: store.name,
        logoUrl: store.logo_url ?? undefined,
        primaryLocale: store.language_config?.primary_locale,
        ownerEmail: store.creator?.user?.email,
      };
    }
  }

  return { ...order, storeCtx };
}

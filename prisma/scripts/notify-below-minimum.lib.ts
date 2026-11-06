/**
 * Logic of notify-below-minimum.ts (kept apart so it can be tested with
 * mocked Prisma / mail): find PUBLISHED marketplace custom products priced
 * below the minimum (provider base + variant adjustment) x (1 + highest
 * destination VAT), group them per creator and warn each creator once
 * (in-app notification + email).
 *
 * The minimum itself comes from price-floor.ts (loadPriceFloorSetup +
 * customProductFloorViolation), the same check behind the dashboard's
 * `below_minimum` flag, so there is no second copy of the math here.
 */
import { ProductStatus, StoreType } from '@prisma/client';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { TaxService } from '../../src/modules/taxes/tax.service';
import {
  customProductFloorViolation,
  loadPriceFloorSetup,
  priceFloorInfo,
} from '../../src/modules/custom-products/price-floor';
import {
  emailButton,
  esc,
  layoutEmail,
  type EmailParts,
} from '../../src/modules/mail/templates';
import { formatMoney } from '../../src/modules/mail/order-mail.helpers';

/** Notification type of the warning; also the idempotency marker. */
export const NOTIFICATION_TYPE = 'PRICE_BELOW_MINIMUM';
/** Stable dedupe key stored in Notification.data. */
export const DEDUPE_KEY = 'price-below-minimum:vat-floor-v1';
/** Email event recorded in the delivery log. */
export const MAIL_EVENT = 'price_below_minimum';
/** A second --send within this window skips creators already warned. */
export const RESEND_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export const LOCALES = ['en', 'sv', 'ar', 'de', 'fr', 'tr'] as const;
export type Locale = (typeof LOCALES)[number];

// ── Options ─────────────────────────────────────────────────────────────────

export interface Options {
  send: boolean;
  force: boolean;
  delayMs: number;
}

export function parseArgs(argv: string[]): Options {
  const known = new Set(['--dry-run', '--send', '--force']);
  let delayMs = 1000;
  for (const arg of argv) {
    if (arg.startsWith('--delay-ms=')) {
      const n = Number(arg.slice('--delay-ms='.length));
      if (!Number.isFinite(n) || n < 0) throw new Error(`Bad ${arg}`);
      delayMs = n;
    } else if (!known.has(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  const send = argv.includes('--send') && !argv.includes('--dry-run');
  return { send, force: argv.includes('--force'), delayMs };
}

// ── Collection ──────────────────────────────────────────────────────────────

export interface BelowMinimumProduct {
  id: string;
  title: string;
  /** Current customer price of the offending variant (or the product). */
  price: number;
  /** Minimum customer price of that variant. */
  minimum: number;
}

export interface CreatorGroup {
  creatorId: string;
  userId: string;
  email: string;
  name: string;
  storeSlug: string;
  /** Store content locale (fallback for the email language). */
  primaryLocale: string | null;
  currency: string;
  products: BelowMinimumProduct[];
}

/** Custom product row shape the collector reads. */
const customProductSelect = {
  id: true,
  creator_id: true,
  pricing_type: true,
  final_price: true,
  margin_amount: true,
  translations: { select: { locale: true, title: true } },
  selected_variants: { select: { variant_id: true, custom_price: true } },
  product: {
    select: {
      base_price: true,
      provider_id: true,
      tax_class_id: true,
      tax_exempt: true,
      variants: {
        where: { is_active: true },
        select: { id: true, price_adjustment: true },
      },
    },
  },
  creator: {
    select: {
      id: true,
      user_id: true,
      display_name: true,
      user: { select: { email: true } },
      store: {
        select: {
          slug: true,
          language_config: { select: { primary_locale: true } },
        },
      },
    },
  },
} as const;

/** The title in the email locale, else the store locale, else any. */
export function pickTitle(
  translations: { locale: string; title: string | null }[],
  locales: (string | null | undefined)[],
): string {
  for (const locale of locales) {
    const hit = translations.find((t) => t.locale === locale && t.title);
    if (hit?.title) return hit.title;
  }
  return translations.find((t) => t.title)?.title ?? '';
}

/**
 * Every PUBLISHED custom product of a MARKETPLACE store that sells below its
 * minimum price, grouped per creator (creators in a stable order).
 */
export async function collectBelowMinimum(
  prisma: PrismaService,
  taxService: Pick<TaxService, 'contextFor' | 'loadTaxData'>,
): Promise<CreatorGroup[]> {
  const rows = await prisma.customProduct.findMany({
    where: {
      status: ProductStatus.PUBLISHED,
      product: { provider_id: { not: null } },
      creator: { store: { is: { store_type: StoreType.MARKETPLACE } } },
    },
    select: customProductSelect,
    orderBy: [{ creator_id: 'asc' }, { created_at: 'asc' }],
  });

  const byCreator = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byCreator.get(row.creator_id) ?? [];
    list.push(row);
    byCreator.set(row.creator_id, list);
  }

  const groups: CreatorGroup[] = [];
  for (const [creatorId, list] of byCreator) {
    const creator = list[0].creator;
    if (!creator?.store) continue;
    const setup = await loadPriceFloorSetup(prisma, taxService, creatorId);
    const primaryLocale = creator.store.language_config?.primary_locale ?? null;
    const titleLocales = [chooseLocale(null, primaryLocale), primaryLocale];
    const products: BelowMinimumProduct[] = [];
    for (const cp of list) {
      const violation = customProductFloorViolation(
        cp,
        priceFloorInfo(setup, cp.product),
      );
      if (!violation) continue;
      products.push({
        id: cp.id,
        title: pickTitle(cp.translations, titleLocales),
        price: violation.price,
        minimum: violation.minimum,
      });
    }
    if (!products.length) continue;
    groups.push({
      creatorId,
      userId: creator.user_id,
      email: creator.user?.email ?? '',
      name: creator.display_name ?? '',
      storeSlug: creator.store.slug,
      primaryLocale,
      currency: setup.currency,
      products,
    });
  }
  return groups;
}

// ── Locale + copy ───────────────────────────────────────────────────────────

function supported(raw: string | null | undefined): Locale | undefined {
  const lang = (raw ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return (LOCALES as readonly string[]).includes(lang)
    ? (lang as Locale)
    : undefined;
}

/**
 * Email / notification language: the creator's dashboard (UI) locale, else
 * the store's primary content locale, else English. The dashboard UI locale
 * is a browser cookie today (no column on User), so callers usually pass
 * null and the store locale decides.
 */
export function chooseLocale(
  uiLocale: string | null | undefined,
  storePrimaryLocale: string | null | undefined,
): Locale {
  return supported(uiLocale) ?? supported(storePrimaryLocale) ?? 'en';
}

interface Copy {
  subject: string;
  title: string;
  greeting: string;
  body: string[];
  product: string;
  current: string;
  minimum: string;
  edit: string;
  button: string;
  notificationBody: string;
}

/** Tokens: {count} {name}. */
export const COPY: Record<Locale, Copy> = {
  en: {
    subject: 'Action needed: product prices below the minimum ({count})',
    title: 'Some of your prices are below the new minimum',
    greeting: 'Hi {name},',
    body: [
      'VAT on marketplace sales is now reserved for the seller before the revenue is split. Your prices must therefore cover the supplier price plus VAT.',
      'The products below are priced under that minimum. They keep selling, but your share of each sale is lower until you raise the price.',
    ],
    product: 'Product',
    current: 'Current price',
    minimum: 'Minimum price',
    edit: 'Edit',
    button: 'Open my custom products',
    notificationBody:
      'Products priced below the minimum (supplier price + VAT): {count}. They keep selling, but your share is lower until you raise the price.',
  },
  sv: {
    subject: 'Åtgärd krävs: produktpriser under minimipriset ({count})',
    title: 'Några av dina priser ligger under det nya minimipriset',
    greeting: 'Hej {name},',
    body: [
      'Momsen på marknadsplatsförsäljning reserveras nu för säljaren innan intäkten delas. Dina priser måste därför täcka leverantörspriset plus moms.',
      'Produkterna nedan har ett pris under minimipriset. De säljs fortfarande, men din andel av varje försäljning är lägre tills du höjer priset.',
    ],
    product: 'Produkt',
    current: 'Nuvarande pris',
    minimum: 'Minimipris',
    edit: 'Redigera',
    button: 'Öppna mina anpassade produkter',
    notificationBody:
      'Produkter med pris under minimipriset (leverantörspris + moms): {count}. De säljs fortfarande, men din andel är lägre tills du höjer priset.',
  },
  ar: {
    subject: 'مطلوب إجراء: أسعار منتجات أقل من الحد الأدنى ({count})',
    title: 'بعض أسعارك أقل من الحد الأدنى الجديد',
    greeting: 'مرحباً {name}،',
    body: [
      'أصبحت ضريبة القيمة المضافة على مبيعات السوق محجوزة للبائع قبل تقسيم الإيرادات، لذلك يجب أن يغطي سعرك سعر المورّد مضافاً إليه الضريبة.',
      'المنتجات التالية مسعّرة بأقل من هذا الحد الأدنى. ستستمر في البيع، لكن حصتك من كل عملية بيع ستكون أقل حتى ترفع السعر.',
    ],
    product: 'المنتج',
    current: 'السعر الحالي',
    minimum: 'الحد الأدنى للسعر',
    edit: 'تعديل',
    button: 'فتح منتجاتي المخصّصة',
    notificationBody:
      'عدد منتجاتك المسعّرة بأقل من الحد الأدنى (سعر المورّد + الضريبة): {count}. ستستمر في البيع، لكن حصتك أقل حتى ترفع السعر.',
  },
  de: {
    subject: 'Handlung erforderlich: Produktpreise unter dem Mindestpreis ({count})',
    title: 'Einige deiner Preise liegen unter dem neuen Mindestpreis',
    greeting: 'Hallo {name},',
    body: [
      'Die Mehrwertsteuer auf Marktplatzverkäufe wird jetzt vor der Umsatzaufteilung für den Verkäufer reserviert. Deine Preise müssen daher den Lieferantenpreis plus Mehrwertsteuer decken.',
      'Die folgenden Produkte liegen unter diesem Mindestpreis. Sie werden weiter verkauft, aber dein Anteil an jedem Verkauf ist niedriger, bis du den Preis erhöhst.',
    ],
    product: 'Produkt',
    current: 'Aktueller Preis',
    minimum: 'Mindestpreis',
    edit: 'Bearbeiten',
    button: 'Meine individuellen Produkte öffnen',
    notificationBody:
      'Produkte unter dem Mindestpreis (Lieferantenpreis + MwSt.): {count}. Sie werden weiter verkauft, aber dein Anteil ist niedriger, bis du den Preis erhöhst.',
  },
  fr: {
    subject: 'Action requise : prix de produits sous le minimum ({count})',
    title: 'Certains de vos prix sont sous le nouveau prix minimum',
    greeting: 'Bonjour {name},',
    body: [
      'La TVA des ventes sur la marketplace est désormais réservée au vendeur avant le partage des revenus. Vos prix doivent donc couvrir le prix fournisseur plus la TVA.',
      'Les produits ci-dessous sont sous ce prix minimum. Ils restent en vente, mais votre part de chaque vente est plus faible tant que vous n’augmentez pas le prix.',
    ],
    product: 'Produit',
    current: 'Prix actuel',
    minimum: 'Prix minimum',
    edit: 'Modifier',
    button: 'Ouvrir mes produits personnalisés',
    notificationBody:
      'Produits sous le prix minimum (prix fournisseur + TVA) : {count}. Ils restent en vente, mais votre part est plus faible tant que vous n’augmentez pas le prix.',
  },
  tr: {
    subject: 'İşlem gerekli: minimumun altındaki ürün fiyatları ({count})',
    title: 'Bazı fiyatlarınız yeni minimum fiyatın altında',
    greeting: 'Merhaba {name},',
    body: [
      'Pazaryeri satışlarındaki KDV artık gelir paylaşılmadan önce satıcı için ayrılıyor. Bu nedenle fiyatlarınız tedarikçi fiyatını ve KDV’yi karşılamalıdır.',
      'Aşağıdaki ürünlerin fiyatı bu minimumun altında. Satılmaya devam ederler, ancak fiyatı yükseltene kadar her satıştaki payınız daha düşük olur.',
    ],
    product: 'Ürün',
    current: 'Mevcut fiyat',
    minimum: 'Minimum fiyat',
    edit: 'Düzenle',
    button: 'Özel ürünlerimi aç',
    notificationBody:
      'Minimumun altında fiyatlı ürünleriniz (tedarikçi fiyatı + KDV): {count}. Satılmaya devam ederler, ancak fiyatı yükseltene kadar payınız daha düşük olur.',
  },
};

/** Split/join token fill, so `$` patterns in values stay literal. */
function fill(phrase: string, tokens: Record<string, string>): string {
  return Object.entries(tokens).reduce(
    (out, [key, value]) => out.split(`{${key}}`).join(value),
    phrase,
  );
}

/** Currency in the reader's locale; the mail helper as a fallback. */
export function formatPrice(
  amount: number,
  currency: string,
  locale: Locale,
): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(amount);
  } catch {
    return formatMoney(amount, currency.toUpperCase());
  }
}

export function productEditUrl(dashboardUrl: string, id: string): string {
  return `${dashboardUrl.replace(/\/+$/, '')}/creator/custom-products/${id}`;
}

/** The in-app notification text (title + body) in the creator's locale. */
export function buildNotification(
  group: CreatorGroup,
  locale: Locale,
): { title: string; body: string } {
  const t = COPY[locale];
  const tokens = { count: String(group.products.length), name: group.name };
  return {
    title: fill(t.subject, tokens),
    body: fill(t.notificationBody, tokens),
  };
}

/** The warning email (HTML + text) in the creator's locale. */
export function buildEmail(
  group: CreatorGroup,
  locale: Locale,
  dashboardUrl: string,
  platformName?: string,
): EmailParts {
  const t = COPY[locale];
  const raw = { count: String(group.products.length), name: group.name };
  const html = { count: esc(raw.count), name: esc(raw.name) };
  const p = 'font-size:14px;line-height:1.6;color:#3f3f46;margin:0 0 12px;';
  const th =
    'text-align:start;font-size:12px;color:#71717a;padding:6px 8px;border-bottom:1px solid #e4e4e7;';
  const td =
    'font-size:13px;color:#18181b;padding:8px;border-bottom:1px solid #f4f4f5;vertical-align:top;';
  const rows = group.products.map((cp) => {
    const url = productEditUrl(dashboardUrl, cp.id);
    return {
      cp,
      url,
      price: formatPrice(cp.price, group.currency, locale),
      minimum: formatPrice(cp.minimum, group.currency, locale),
    };
  });
  const table =
    `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:8px 0 16px;">` +
    `<tr><th style="${th}">${esc(t.product)}</th><th style="${th}">${esc(t.current)}</th><th style="${th}">${esc(t.minimum)}</th><th style="${th}"></th></tr>` +
    rows
      .map(
        (r) =>
          `<tr><td style="${td}">${esc(r.cp.title)}</td>` +
          `<td style="${td}white-space:nowrap;">${esc(r.price)}</td>` +
          `<td style="${td}white-space:nowrap;font-weight:600;">${esc(r.minimum)}</td>` +
          `<td style="${td}white-space:nowrap;"><a href="${esc(r.url)}" style="color:#18181b;">${esc(t.edit)}</a></td></tr>`,
      )
      .join('') +
    `</table>`;
  const listUrl = `${dashboardUrl.replace(/\/+$/, '')}/creator/custom-products`;
  const content =
    `<p style="${p}">${fill(t.greeting, html)}</p>` +
    t.body.map((line) => `<p style="${p}">${fill(line, html)}</p>`).join('') +
    table +
    `<p style="margin:20px 0 0;">${emailButton(t.button, listUrl)}</p>`;
  const text = [
    fill(t.greeting, raw),
    '',
    ...t.body.map((line) => fill(line, raw)),
    '',
    ...rows.map(
      (r) =>
        `- ${r.cp.title}: ${t.current} ${r.price}, ${t.minimum} ${r.minimum}\n  ${r.url}`,
    ),
    '',
    `${t.button}: ${listUrl}`,
  ].join('\n');
  return {
    subject: fill(t.subject, raw),
    html: layoutEmail(
      esc(t.title),
      content,
      { platformName },
      locale === 'ar' ? 'rtl' : 'ltr',
    ),
    text,
  };
}

// ── Run ─────────────────────────────────────────────────────────────────────

/** The few Prisma calls the runner makes (mockable). */
export interface NotifyDb {
  notification: {
    findFirst(args: unknown): Promise<{
      id: string;
      data: unknown;
      created_at: Date;
    } | null>;
    create(args: unknown): Promise<{ id: string }>;
    update(args: unknown): Promise<unknown>;
  };
}

export interface NotifyMail {
  send(opts: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    event?: string;
    platformSenderOnly?: boolean;
  }): Promise<{ sent: boolean }>;
}

export interface RunDeps {
  db: NotifyDb;
  mail: NotifyMail;
  dashboardUrl: string;
  platformName?: string;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface RunSummary {
  creators: number;
  products: number;
  /** Creators whose warning was sent in this run. */
  sent: number;
  /** Creators skipped because they were warned within the window. */
  skipped: number;
  /** Creators whose notification or email failed. */
  failed: number;
}

interface MarkerData {
  dedupe_key?: string;
  email_sent?: boolean;
}

/** The latest marker of this campaign for a user within the window. */
async function findMarker(
  db: NotifyDb,
  userId: string,
  since: Date,
): Promise<{ id: string; data: MarkerData } | null> {
  const row = await db.notification.findFirst({
    where: {
      user_id: userId,
      type: NOTIFICATION_TYPE,
      created_at: { gte: since },
    },
    orderBy: { created_at: 'desc' },
    select: { id: true, data: true, created_at: true },
  });
  const data = (row?.data ?? {}) as MarkerData;
  if (!row || data.dedupe_key !== DEDUPE_KEY) return null;
  return { id: row.id, data };
}

/**
 * Dry run: counts plus one line per creator (ids, slug, count only; never a
 * name, email, title or price). Send: per creator one notification (the
 * idempotency marker) and one email, rate limited; a marker whose email did
 * not go out is retried without a second notification.
 */
export async function runNotify(
  groups: CreatorGroup[],
  opts: Options,
  deps: RunDeps,
): Promise<RunSummary> {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());
  const since = new Date(now().getTime() - RESEND_WINDOW_MS);
  const summary: RunSummary = {
    creators: groups.length,
    products: groups.reduce((n, g) => n + g.products.length, 0),
    sent: 0,
    skipped: 0,
    failed: 0,
  };

  deps.log(
    `${opts.send ? 'SEND' : 'DRY RUN'}: ${summary.creators} creators, ${summary.products} published custom products below the minimum`,
  );

  let first = true;
  for (const group of groups) {
    try {
      const marker = await findMarker(deps.db, group.userId, since);
      const done = !!marker?.data.email_sent && !opts.force;
      if (!opts.send) {
        deps.log(
          `  creator=${group.creatorId} store=${group.storeSlug} products=${group.products.length}${done ? ' (already notified)' : ''}`,
        );
        if (done) summary.skipped++;
        continue;
      }
      if (done) {
        summary.skipped++;
        continue;
      }
      if (!first && opts.delayMs > 0) await sleep(opts.delayMs);
      first = false;

      const locale = chooseLocale(null, group.primaryLocale);
      const productIds = group.products.map((p) => p.id);
      let markerId = marker && !opts.force ? marker.id : null;
      if (!markerId) {
        const note = buildNotification(group, locale);
        const created = await deps.db.notification.create({
          data: {
            user_id: group.userId,
            type: NOTIFICATION_TYPE,
            title: note.title,
            body: note.body,
            data: {
              dedupe_key: DEDUPE_KEY,
              custom_product_ids: productIds,
              locale,
              email_sent: false,
            },
          },
        });
        markerId = created.id;
      }

      const mail = buildEmail(
        group,
        locale,
        deps.dashboardUrl,
        deps.platformName,
      );
      const out = group.email
        ? await deps.mail.send({
            to: group.email,
            ...mail,
            event: MAIL_EVENT,
            platformSenderOnly: true,
          })
        : { sent: false };
      if (!out.sent) {
        summary.failed++;
        deps.log(`  creator=${group.creatorId}: email not sent`);
        continue;
      }
      await deps.db.notification.update({
        where: { id: markerId },
        data: {
          data: {
            dedupe_key: DEDUPE_KEY,
            custom_product_ids: productIds,
            locale,
            email_sent: true,
            emailed_at: now().toISOString(),
          },
        },
      });
      summary.sent++;
    } catch (err) {
      summary.failed++;
      // Only the error class: messages may echo row data.
      deps.log(
        `  creator=${group.creatorId}: failed (${err instanceof Error ? err.name : 'Error'})`,
      );
    }
  }

  deps.log(
    `Summary: creators=${summary.creators} products=${summary.products} sent=${summary.sent} skipped=${summary.skipped} failed=${summary.failed}`,
  );
  return summary;
}

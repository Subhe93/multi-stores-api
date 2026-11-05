import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StaticPageType, StoreStatus, StoreType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { sanitizeCreatorHtml } from '../../common/html/creator-html';
import {
  isUniqueViolation,
  uniqueStaticPageSlug,
  withSlugRetry,
} from '../../common/slug/wp-slug';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { MarketsContextService } from '../markets/markets-context.service';
import {
  StorefrontGateService,
  type StorefrontViewer,
} from '../storefront/storefront-gate.service';
import { loadPublicHost } from '../stores/storefront-hosts';
import {
  PLATFORM_ADDRESS,
  PLATFORM_COMPANY,
  PLATFORM_CONTACT_EMAIL,
  PLATFORM_ORG_NUMBER,
} from './platform-seller';
import {
  STORE_LEGAL_KIND,
  STORE_LEGAL_PAGE_SLUG,
  STORE_LEGAL_SLUGS,
  fillStoreTemplate,
  hasTemplate,
  isStoreLegalSlug,
  pickTemplate,
  type StoreLegalSlug,
  type StoreTemplateContext,
  type TemplateLocale,
} from './store-templates/store-templates';
import {
  loadStoreLegalRows,
  pickPageTitle,
  resolveLegalPage,
} from './store-templates/store-legal-resolver';

/** Section key of the builder's rich-text section (web theme registry). */
const RICH_TEXT_SECTION_KEY = 'rich-text';

const DEFAULT_STOREFRONT_URL = 'http://localhost:3003';

/** Store fields the legal reads need. */
const STORE_SELECT = {
  id: true,
  slug: true,
  name: true,
  status: true,
  store_type: true,
  trader_details: true,
  custom_domain: true,
  language_config: {
    select: { primary_locale: true, secondary_locales: true },
  },
} as const;

interface LegalStore {
  id: string;
  slug: string;
  name: string;
  status: StoreStatus;
  store_type: StoreType;
  trader_details: unknown;
  custom_domain: string | null;
  language_config: {
    primary_locale: string;
    secondary_locales: string[];
  } | null;
}

export interface StoreLegalListRow {
  slug: StoreLegalSlug;
  title: string;
  /** MARKETPLACE stores always get 'template' (filled with Namez AB). */
  source: 'store_page' | 'template';
  /** The own page's slug (its `/{page_slug}` URL) when source='store_page'. */
  page_slug: string | null;
}

export type StoreLegalPagePayload =
  | {
      source: 'store_page';
      title: string;
      page_slug: string;
      page_system: 'v2' | 'legacy';
      updated_at: Date;
    }
  | {
      source: 'template';
      title: string;
      content: string;
      /** Locale the template is written in (after fallback). */
      locale: TemplateLocale;
      updated_at: null;
    };

export interface CreatorLegalPageRow {
  slug: StoreLegalSlug;
  kind: StaticPageType;
  title: string;
  state: 'published' | 'draft' | 'none';
  page_id: string | null;
  page_system: 'v2' | 'legacy' | null;
  uses_template: boolean;
  storefront_path: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Store legal pages (plans/store-legal-pages/SPEC.md). On a storefront,
 * `/legal/{slug}` shows the store's own page when it has a published one,
 * else a default template filled with the store's trader details.
 * MARKETPLACE stores (Namez AB is the seller of record) always show the same
 * templates filled with the platform company as the seller; the creator can
 * not override them. The platform's own LegalPage texts (ShopsDoor-merchant
 * terms) are only shown on the platform domain.
 */
@Injectable()
export class StoreLegalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly revalidation: RevalidationService,
    private readonly config: ConfigService,
    // Optional and trailing so lean unit wiring works without them.
    @Optional() private readonly storeApps?: StoreAppsService,
    @Optional() private readonly markets?: MarketsContextService,
    @Optional() private readonly gate?: StorefrontGateService,
  ) {}

  // ── Public storefront reads ─────────────────────────────

  /** GET /storefront/:storeSlug/legal — the 4 rows in fixed order. */
  async storefrontList(
    storeSlug: string,
    opts: StorefrontLegalOptions = {},
  ): Promise<StoreLegalListRow[]> {
    const store = await this.publicStore(storeSlug, opts.viewer);
    const locale = await this.requestLocale(store, opts);
    if (store.store_type === StoreType.MARKETPLACE) {
      return STORE_LEGAL_SLUGS.map((slug) => ({
        slug,
        title: pickTemplate(slug, locale)?.title || slug,
        source: 'template' as const,
        page_slug: null,
      }));
    }
    const rows = await loadStoreLegalRows(this.prisma, store.id);
    return STORE_LEGAL_SLUGS.map((slug) => {
      const resolved = resolveLegalPage(slug, rows);
      const template = pickTemplate(slug, locale)?.title || slug;
      if (resolved.state === 'published' && resolved.page?.slug) {
        return {
          slug,
          title:
            pickPageTitle(
              resolved.page.titles,
              this.titleLocales(store, locale),
            ) || template,
          source: 'store_page' as const,
          page_slug: resolved.page.slug,
        };
      }
      return {
        slug,
        title: template,
        source: 'template' as const,
        page_slug: null,
      };
    });
  }

  /** GET /storefront/:storeSlug/legal/:slug — see StoreLegalPagePayload. */
  async storefrontPage(
    storeSlug: string,
    slug: string,
    opts: StorefrontLegalOptions = {},
  ): Promise<StoreLegalPagePayload> {
    if (!isStoreLegalSlug(slug)) throw this.legalNotFound();
    const store = await this.publicStore(storeSlug, opts.viewer);
    const locale = await this.requestLocale(store, opts);
    if (store.store_type === StoreType.MARKETPLACE) {
      return this.templatePayload(store, slug, locale);
    }
    const rows = await loadStoreLegalRows(this.prisma, store.id);
    const resolved = resolveLegalPage(slug, rows);
    if (
      resolved.state === 'published' &&
      resolved.page?.slug &&
      resolved.system
    ) {
      return {
        source: 'store_page',
        title:
          pickPageTitle(
            resolved.page.titles,
            this.titleLocales(store, locale),
          ) ||
          pickTemplate(slug, locale)?.title ||
          slug,
        page_slug: resolved.page.slug,
        page_system: resolved.system,
        updated_at: resolved.page.updated_at,
      };
    }
    return this.templatePayload(store, slug, locale);
  }

  /** The filled default template of a slug (INDEPENDENT fallback / MARKETPLACE). */
  private async templatePayload(
    store: LegalStore,
    slug: StoreLegalSlug,
    locale: string,
  ): Promise<StoreLegalPagePayload> {
    const template = pickTemplate(slug, locale);
    if (!template) throw this.legalNotFound();
    const ctx = await this.templateContext(store, template.locale);
    return {
      source: 'template',
      title: template.title,
      content: sanitizeCreatorHtml(fillStoreTemplate(template.html, ctx)) ?? '',
      locale: template.locale,
      updated_at: null,
    };
  }

  // ── Creator ─────────────────────────────────────────────

  /** GET /stores/my/legal-pages */
  async creatorList(userId: string): Promise<{
    store_type: StoreType;
    pages: CreatorLegalPageRow[];
  }> {
    const store = await this.ownStore(userId);
    const rows = await loadStoreLegalRows(this.prisma, store.id);
    const primary = store.language_config?.primary_locale || 'en';
    const marketplace = store.store_type === StoreType.MARKETPLACE;
    return {
      store_type: store.store_type,
      pages: STORE_LEGAL_SLUGS.map((slug) => {
        const resolved = resolveLegalPage(slug, rows);
        const title =
          (resolved.page &&
            pickPageTitle(resolved.page.titles, [primary, 'en'])) ||
          pickTemplate(slug, primary)?.title ||
          slug;
        return {
          slug,
          kind: STORE_LEGAL_KIND[slug],
          title,
          state: resolved.state,
          page_id: resolved.page?.id ?? null,
          page_system: resolved.system,
          // MARKETPLACE storefronts always show the platform-seller template,
          // which the creator can not replace: no own page is in play, so
          // uses_template (= "the default template stands in for your own
          // page") stays false; the dashboard shows one info line instead.
          uses_template: !marketplace && resolved.state !== 'published',
          storefront_path: `/legal/${slug}`,
        };
      }),
    };
  }

  /**
   * POST /stores/my/legal-pages/:slug/from-template: a DRAFT v2 STATIC page
   * of the slug's kind with one rich-text section holding the filled
   * template, per store locale that has a template (the primary locale
   * falls back to English). 409 LEGAL_PAGE_EXISTS when a v2 page of the
   * kind exists; 400 LEGAL_PAGES_PLATFORM for MARKETPLACE stores.
   */
  async createFromTemplate(
    userId: string,
    slug: string,
  ): Promise<{ page_id: string }> {
    if (!isStoreLegalSlug(slug)) throw this.legalNotFound();
    const store = await this.ownStore(userId);
    if (store.store_type === StoreType.MARKETPLACE) {
      throw new BadRequestException({
        code: 'LEGAL_PAGES_PLATFORM',
        message: 'Marketplace stores use the platform legal pages',
      });
    }
    const kind = STORE_LEGAL_KIND[slug];
    const existing = await this.existingV2(store.id, kind);
    if (existing) throw this.pageExists(existing.id);

    const primary = store.language_config?.primary_locale || 'en';
    const locales = [
      primary,
      ...(store.language_config?.secondary_locales ?? []).filter(
        (l) => l && l !== primary,
      ),
    ];
    const contents: { locale: string; title: string; html: string }[] = [];
    for (const locale of locales) {
      const template =
        hasTemplate(slug, locale) || locale === primary
          ? pickTemplate(slug, locale)
          : null;
      if (!template) continue;
      const ctx = await this.templateContext(store, template.locale);
      contents.push({
        locale,
        title: template.title,
        html: sanitizeCreatorHtml(fillStoreTemplate(template.html, ctx)) ?? '',
      });
    }

    let pageId: string;
    try {
      pageId = await withSlugRetry(() =>
        this.prisma.$transaction(
          async (tx) => {
            const page = await tx.page.create({
              data: {
                store_id: store.id,
                type: 'STATIC',
                static_kind: kind,
                slug: await uniqueStaticPageSlug(
                  tx,
                  store.id,
                  STORE_LEGAL_PAGE_SLUG[slug],
                ),
                status: 'DRAFT',
                translations: {
                  create: contents.map((c) => ({
                    locale: c.locale,
                    title: c.title,
                  })),
                },
              },
              select: { id: true },
            });
            await tx.pageSection.create({
              data: {
                page_id: page.id,
                section_key: RICH_TEXT_SECTION_KEY,
                sort_order: 0,
                settings: { width: 'normal' },
                translations: {
                  create: contents.map((c) => ({
                    locale: c.locale,
                    content: { html: c.html },
                  })),
                },
              },
            });
            return page.id;
          },
          { timeout: 30_000 },
        ),
      );
    } catch (err) {
      // A concurrent create of the same kind won the (store, type, kind) index.
      if (isUniqueViolation(err)) {
        const winner = await this.existingV2(store.id, kind);
        if (winner) throw this.pageExists(winner.id);
      }
      throw err;
    }
    void this.revalidation.revalidateStoreById(store.id).catch(() => undefined);
    return { page_id: pageId };
  }

  // ── Helpers ─────────────────────────────────────────────

  private legalNotFound(): NotFoundException {
    return new NotFoundException({
      code: 'STORE_LEGAL_PAGE_NOT_FOUND',
      message: 'Legal page not found',
    });
  }

  private storeNotFound(): NotFoundException {
    return new NotFoundException({
      code: 'STOREFRONT_STORE_NOT_FOUND',
      message: 'Store not found',
    });
  }

  private pageExists(pageId: string): ConflictException {
    return new ConflictException({
      code: 'LEGAL_PAGE_EXISTS',
      message: 'A page of this kind already exists',
      page_id: pageId,
    });
  }

  private existingV2(storeId: string, kind: StaticPageType) {
    return this.prisma.page.findFirst({
      where: {
        store_id: storeId,
        type: 'STATIC',
        static_kind: kind,
      },
      select: { id: true },
    });
  }

  /**
   * The store of a public read, with the storefront gate: unknown and
   * SUSPENDED → 404; a non-LIVE store only for its owner / an admin.
   */
  private async publicStore(
    storeSlug: string,
    viewer?: StorefrontViewer | null,
  ): Promise<LegalStore> {
    const store = (await this.prisma.store.findUnique({
      where: { slug: storeSlug },
      select: STORE_SELECT,
    })) as LegalStore | null;
    if (!store || store.status === StoreStatus.SUSPENDED) {
      throw this.storeNotFound();
    }
    const open = this.gate
      ? await this.gate.allows(store, viewer)
      : store.status === StoreStatus.LIVE;
    if (!open) throw this.storeNotFound();
    return store;
  }

  private async ownStore(userId: string): Promise<LegalStore> {
    const store = (await this.prisma.store.findFirst({
      where: { creator: { user_id: userId } },
      select: STORE_SELECT,
    })) as LegalStore | null;
    if (!store) {
      throw new NotFoundException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });
    }
    return store;
  }

  /**
   * Locale of a public read: `?locale=`, else the market's default locale
   * (?market= / ?preview=1, same rules as GET /storefront/:slug), else the
   * store's primary locale.
   */
  private async requestLocale(
    store: LegalStore,
    opts: StorefrontLegalOptions,
  ): Promise<string> {
    const market = this.markets
      ? await (opts.preview && opts.market
          ? this.markets.resolve(store.id, opts.market, { preview: true })
          : this.markets.resolve(store.id, opts.market))
      : null;
    // Kept as sent (e.g. `pt-BR`): every lookup matches case-insensitively.
    const requested = str(opts.locale);
    return (
      requested ||
      market?.defaultLocale ||
      store.language_config?.primary_locale ||
      'en'
    );
  }

  /** Title lookup order of a store page: request locale, primary, en. */
  private titleLocales(store: LegalStore, locale: string): string[] {
    return [locale, store.language_config?.primary_locale || 'en', 'en'];
  }

  /**
   * Placeholder values of a store's templates (see templates.data.ts). The
   * legal name falls back to the store name so the seller is never blank
   * (older stores may lack trader details); optional values are wrapped in
   * `data-if` in the templates. MARKETPLACE stores get the platform company
   * as the trader (platformSellerContext); `seller.is_independent` /
   * `seller.is_platform` pick the matching sentences.
   */
  private async templateContext(
    store: Pick<
      LegalStore,
      'id' | 'slug' | 'name' | 'store_type' | 'trader_details' | 'custom_domain'
    >,
    locale: string,
  ): Promise<StoreTemplateContext> {
    const storeUrl = await this.storeUrl(store);
    if (store.store_type === StoreType.MARKETPLACE) {
      return platformSellerContext(
        { name: str(store.name), url: storeUrl },
        await this.platformContactEmail(),
        locale,
      );
    }
    const t = (store.trader_details ?? {}) as Record<string, unknown>;
    return {
      'trader.legal_name': str(t.legal_name) || str(store.name),
      'trader.org_number': str(t.org_number),
      'trader.vat_number': str(t.vat_number),
      'trader.address': formatTraderAddress(t, locale),
      'trader.email': str(t.support_email),
      'trader.phone': str(t.phone),
      'store.name': str(store.name),
      'store.url': storeUrl,
      'seller.is_independent': '1',
      'seller.is_platform': '',
    };
  }

  /** PlatformConfig.support_email, else the platform's public contact address. */
  private async platformContactEmail(): Promise<string> {
    const cfg = await this.prisma.platformConfig
      .findFirst({ select: { support_email: true } })
      .catch(() => null);
    return str(cfg?.support_email) || PLATFORM_CONTACT_EMAIL;
  }

  /** The store's public origin: its public host, else the slug subdomain. */
  private async storeUrl(
    store: Pick<LegalStore, 'id' | 'slug' | 'custom_domain'>,
  ): Promise<string> {
    const host = await loadPublicHost(
      { prisma: this.prisma, storeApps: this.storeApps ?? null },
      store,
    ).catch(() => null);
    if (host) return `https://${host}`;
    const base = (
      this.config.get<string>('STOREFRONT_URL') || DEFAULT_STOREFRONT_URL
    ).replace(/\/$/, '');
    try {
      const url = new URL(base);
      return `${url.protocol}//${store.slug}.${url.host}`;
    } catch {
      return '';
    }
  }
}

export interface StorefrontLegalOptions {
  locale?: string;
  market?: string;
  preview?: boolean;
  viewer?: StorefrontViewer | null;
}

/**
 * Template values of a MARKETPLACE store: Namez AB is the seller (and the
 * GDPR controller); the store name / URL stay the influencer store's own.
 * VAT number and phone stay empty (no platform fields for them).
 */
export function platformSellerContext(
  store: { name: string; url: string },
  email: string,
  locale: string,
): StoreTemplateContext {
  return {
    'trader.legal_name': PLATFORM_COMPANY,
    'trader.org_number': PLATFORM_ORG_NUMBER,
    'trader.vat_number': '',
    'trader.address': formatTraderAddress({ ...PLATFORM_ADDRESS }, locale),
    'trader.email': email,
    'trader.phone': '',
    'store.name': store.name,
    'store.url': store.url,
    'seller.is_independent': '',
    'seller.is_platform': '1',
  };
}

/**
 * One-line postal address of the trader: line 1, line 2, "postal code
 * city", country name in `locale` (ISO2 code when Intl has no name).
 */
export function formatTraderAddress(
  t: Record<string, unknown>,
  locale: string,
): string {
  const country = str(t.country).toUpperCase();
  let countryName = country;
  if (country) {
    try {
      countryName =
        new Intl.DisplayNames([locale, 'en'], { type: 'region' }).of(country) ||
        country;
    } catch {
      countryName = country;
    }
  }
  const city = [str(t.postal_code), str(t.city)].filter(Boolean).join(' ');
  return [str(t.address_line1), str(t.address_line2), city, countryName]
    .filter(Boolean)
    .join(', ');
}

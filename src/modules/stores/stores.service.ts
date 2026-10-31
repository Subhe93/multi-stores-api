import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma, StoreType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { OrdersService } from '../orders/orders.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { MarketsService } from '../markets/markets.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { toMarketRoute } from '../markets/market-context';
import type { StoreByDomainResponse } from '../markets/market.types';
import { RedirectsService } from '../redirects/redirects.service';
import { isReservedDomain } from '../../common/domains/reserved-hosts';
import { stripBrandFromThemeConfig } from './theme-config';
import { normalizeCheckoutSettingsInput } from './checkout-settings';
import { sanitizeCreatorHtml } from '../../common/html/creator-html';
import {
  CreateStoreDto,
  UpdateStoreDto,
  AdminUpdateStoreDto,
  UpdateThemeDto,
  UpdateThemeSelectionDto,
  UpdateLanguageDto,
} from './dto/store.dto';

// While the markets app is on, hostnames are managed per market (Markets
// page); the legacy custom_domain field is read-only there.
const STORE_CUSTOM_DOMAIN_MANAGED_BY_MARKETS = {
  code: 'STORE_CUSTOM_DOMAIN_MANAGED_BY_MARKETS',
  message: 'Domains are managed in Markets while the markets app is enabled.',
};

@Injectable()
export class StoresService {
  private readonly logger = new Logger(StoresService.name);

  constructor(
    private prisma: PrismaService,
    private readonly revalidation: RevalidationService,
    private readonly ordersService: OrdersService,
    private readonly storeApps: StoreAppsService,
    private readonly markets: MarketsService,
    private readonly marketsContext: MarketsContextService,
    // M4.4 D17 / M5 B18: required (StoresModule imports RedirectsModule).
    private readonly redirects: RedirectsService,
  ) {}

  async create(userId: string, dto: CreateStoreDto) {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
    });
    if (!creator)
      throw new NotFoundException({
        code: 'STORE_CREATOR_PROFILE_NOT_FOUND',
        message: 'Creator profile not found',
      });

    const existing = await this.prisma.store.findUnique({
      where: { slug: dto.slug },
    });
    if (existing)
      throw new ConflictException({
        code: 'STORE_SLUG_TAKEN',
        message: 'Store slug already taken',
      });

    const { primary_locale, secondary_locales, ...storeData } = dto;

    const store = await this.prisma.store.create({
      data: {
        creator_id: creator.id,
        ...storeData,
        ...(storeData.description !== undefined && {
          description: sanitizeCreatorHtml(storeData.description),
        }),
        language_config: {
          create: {
            primary_locale: primary_locale || 'en',
            secondary_locales: secondary_locales || [],
          },
        },
        // Automatically create the mandatory static pages
        static_pages: {
          create: [
            {
              type: 'ABOUT',
              slug: 'about',
              is_required: true,
              sort_order: 1,
              status: 'DRAFT',
            },
            {
              type: 'CONTACT',
              slug: 'contact',
              is_required: true,
              sort_order: 2,
              status: 'DRAFT',
            },
            {
              type: 'PRIVACY_POLICY',
              slug: 'privacy-policy',
              is_required: true,
              sort_order: 3,
              status: 'DRAFT',
            },
            {
              type: 'TERMS',
              slug: 'terms',
              is_required: true,
              sort_order: 4,
              status: 'DRAFT',
            },
            {
              type: 'SHIPPING_POLICY',
              slug: 'shipping-policy',
              is_required: true,
              sort_order: 5,
              status: 'DRAFT',
            },
            {
              type: 'RETURN_POLICY',
              slug: 'return-policy',
              is_required: true,
              sort_order: 6,
              status: 'DRAFT',
            },
          ],
        },
      },
      include: {
        language_config: true,
        static_pages: true,
        creator: { select: { display_name: true, avatar_url: true } },
      },
    });

    // Every store carries a default market (inert until the markets app is
    // enabled), created from the language config + store currency.
    await this.markets.ensureDefaultMarket(store.id);

    return store;
  }

  /** Id of the signed-in creator's store (404 when they have none). */
  async findStoreIdByCreatorUser(userId: string): Promise<string> {
    const store = await this.prisma.store.findFirst({
      where: { creator: { user_id: userId } },
      select: { id: true },
    });
    if (!store)
      throw new NotFoundException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });
    return store.id;
  }

  async findByCreator(userId: string) {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
    });
    if (!creator)
      throw new NotFoundException({
        code: 'STORE_CREATOR_NOT_FOUND',
        message: 'Creator not found',
      });

    const store = await this.prisma.store.findUnique({
      where: { creator_id: creator.id },
      include: {
        language_config: true,
        static_pages: { include: { translations: true } },
        creator: {
          select: { display_name: true, avatar_url: true, bio: true },
        },
      },
    });
    if (!store)
      throw new NotFoundException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });
    return store;
  }

  async findBySlug(slug: string) {
    const store = await this.prisma.store.findUnique({
      where: { slug },
      include: {
        language_config: true,
        static_pages: {
          where: { status: 'PUBLISHED' },
          include: { translations: true },
        },
        creator: {
          select: {
            display_name: true,
            avatar_url: true,
            bio: true,
            cover_url: true,
          },
        },
      },
    });
    if (!store)
      throw new NotFoundException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });
    return store;
  }

  // Lightweight lookup used by the storefront proxy to resolve a custom CNAME
  // (e.g. shop.merchant.com) to its store slug. Returns only the slug so the
  // proxy can rewrite without pulling the full store payload — plus, for a
  // store with the markets app on, the market the host belongs to
  // (M1-DESIGN §3.2; market/markets are absent otherwise).
  async findSlugByCustomDomain(host: string): Promise<StoreByDomainResponse> {
    const res = await this.lookupCustomDomain(host);
    // M4.4 D17: `redirects_version` only when the store has active redirects
    // (cached per store); every other answer is byte-identical.
    const version = await this.redirects.versionFor(res.storeId);
    return version ? { ...res.body, redirects_version: version } : res.body;
  }

  private async lookupCustomDomain(
    host: string,
  ): Promise<{ storeId: string; body: StoreByDomainResponse }> {
    const normalized = host.trim().toLowerCase().split(':')[0];
    const notFound = () =>
      new NotFoundException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });

    // StoreDomain first. A row exists for every migrated custom_domain, so
    // with the app OFF the host is honoured only when it still equals the
    // legacy column (today's semantics); with the app ON the row must be
    // ACTIVE and its market LIVE. A row that is not servable falls through
    // to the legacy lookup below rather than blocking the host.
    const domain = await this.marketsContext.byHostname(normalized);
    if (domain && domain.store.is_active) {
      const defaultMarket = await this.marketsContext.resolve(domain.store_id);
      if (defaultMarket) {
        if (domain.status === 'ACTIVE' && domain.market.status === 'LIVE') {
          const market = await this.marketsContext.resolve(
            domain.store_id,
            domain.market.key,
          );
          const markets =
            (await this.marketsContext.listLive(domain.store_id)) ?? [];
          return {
            storeId: domain.store_id,
            body: {
              slug: domain.store.slug,
              ...(domain.redirect_to
                ? { redirect_to: domain.redirect_to }
                : {}),
              market: toMarketRoute(market ?? defaultMarket),
              markets,
              // M6.1: public host of a default market without its own row.
              custom_domain: domain.store.custom_domain ?? null,
            },
          };
        }
      } else if (domain.store.custom_domain?.toLowerCase() === normalized) {
        return { storeId: domain.store_id, body: { slug: domain.store.slug } };
      }
    }

    const store = await this.prisma.store.findUnique({
      where: { custom_domain: normalized },
      select: { id: true, slug: true, is_active: true },
    });
    if (!store || !store.is_active) throw notFound();
    return { storeId: store.id, body: { slug: store.slug } };
  }

  async update(userId: string, dto: UpdateStoreDto) {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
    });
    if (!creator)
      throw new NotFoundException({
        code: 'STORE_CREATOR_NOT_FOUND',
        message: 'Creator not found',
      });

    if (dto.slug) {
      const conflict = await this.prisma.store.findFirst({
        where: { slug: dto.slug, creator_id: { not: creator.id } },
        select: { id: true },
      });
      if (conflict)
        throw new ConflictException({
          code: 'STORE_SLUG_TAKEN',
          message: 'Store slug already taken',
        });
    }

    const data = normalizeStoreUpdate(dto);

    // Only an independent store owns its presentment currency: it charges on
    // the creator's own connected account. A marketplace order is charged on
    // the platform account and split with transfers, so its currency has to
    // stay the platform's.
    if (data.currency) {
      const current = await this.prisma.store.findUnique({
        where: { creator_id: creator.id },
        select: { store_type: true },
      });
      if (current?.store_type !== StoreType.INDEPENDENT) {
        throw new BadRequestException({
          code: 'STORE_CURRENCY_MARKETPLACE_ONLY',
          message:
            'Only independent stores can set their own currency. Marketplace stores use the platform currency.',
        });
      }
    }

    const own = await this.prisma.store.findUnique({
      where: { creator_id: creator.id },
      select: { id: true },
    });
    if (
      data.custom_domain !== undefined &&
      own &&
      (await this.storeApps.isEnabled(own.id, 'markets'))
    ) {
      throw new BadRequestException(STORE_CUSTOM_DOMAIN_MANAGED_BY_MARKETS);
    }

    if (data.custom_domain) {
      if (isReservedDomain(data.custom_domain)) {
        throw new BadRequestException({
          code: 'STORE_CUSTOM_DOMAIN_RESERVED',
          message: 'This domain is reserved by the platform',
        });
      }
      const conflict = await this.prisma.store.findFirst({
        where: {
          custom_domain: data.custom_domain,
          creator_id: { not: creator.id },
        },
        select: { id: true },
      });
      if (
        conflict ||
        (await this.marketHostTaken(data.custom_domain, own?.id ?? null))
      )
        throw new ConflictException({
          code: 'STORE_CUSTOM_DOMAIN_TAKEN',
          message: 'Custom domain already in use',
        });
    }

    const store = await this.runStoreUpdate(() =>
      this.prisma.store.update({
        where: { creator_id: creator.id },
        data,
        include: { language_config: true },
      }),
    );

    // The default market prices in the store currency (read live through
    // the markets cache), so a currency change drops the cached contexts.
    if (data.currency !== undefined) this.marketsContext.invalidate(store.id);

    await this.revalidation.revalidateStoreBySlug(store.slug);

    return store;
  }

  /**
   * Whether another store already claims `hostname` as a market host that
   * is VERIFIED or ACTIVE (a PENDING row does not block a legacy domain).
   */
  private async marketHostTaken(
    hostname: string,
    ownStoreId: string | null,
  ): Promise<boolean> {
    const row = await this.prisma.storeDomain.findFirst({
      where: {
        hostname,
        status: { in: ['VERIFIED', 'ACTIVE'] },
        ...(ownStoreId ? { store_id: { not: ownStoreId } } : {}),
      },
      select: { id: true },
    });
    return row !== null;
  }

  async findByCreatorId(creatorId: string) {
    const store = await this.prisma.store.findUnique({
      where: { creator_id: creatorId },
      include: {
        language_config: true,
        creator: { select: { display_name: true, avatar_url: true } },
      },
    });
    if (!store)
      throw new NotFoundException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });
    return store;
  }

  // Admin variant: may also change store_type (creators pick it only at creation).
  async adminUpdateByCreatorId(creatorId: string, dto: AdminUpdateStoreDto) {
    const store = await this.prisma.store.findUnique({
      where: { creator_id: creatorId },
      select: { id: true, store_type: true },
    });
    if (!store)
      throw new NotFoundException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });

    const typeChanged =
      Boolean(dto.store_type) && dto.store_type !== store.store_type;
    // The store's own currency only makes sense while it charges on its own
    // account. Clear it on any switch so a later flip back to INDEPENDENT
    // cannot silently re-activate a currency nobody re-confirmed — and so the
    // marketplace phase never carries a stale value.
    if (typeChanged) (dto as UpdateStoreDto).currency = '';

    if (dto.slug) {
      const conflict = await this.prisma.store.findFirst({
        where: { slug: dto.slug, id: { not: store.id } },
        select: { id: true },
      });
      if (conflict)
        throw new ConflictException({
          code: 'STORE_SLUG_TAKEN',
          message: 'Store slug already taken',
        });
    }

    const data = normalizeStoreUpdate(dto);

    // Same rule as the creator path: only an independent store owns its
    // currency. Judged against the type the store will have AFTER this update.
    const effectiveType = dto.store_type ?? store.store_type;
    if (data.currency && effectiveType !== StoreType.INDEPENDENT) {
      throw new BadRequestException({
        code: 'STORE_CURRENCY_MARKETPLACE_ONLY',
        message:
          'Only independent stores can set their own currency. Marketplace stores use the platform currency.',
      });
    }

    if (
      data.custom_domain !== undefined &&
      (await this.storeApps.isEnabled(store.id, 'markets'))
    ) {
      throw new BadRequestException(STORE_CUSTOM_DOMAIN_MANAGED_BY_MARKETS);
    }

    if (data.custom_domain) {
      if (isReservedDomain(data.custom_domain)) {
        throw new BadRequestException({
          code: 'STORE_CUSTOM_DOMAIN_RESERVED',
          message: 'This domain is reserved by the platform',
        });
      }
      const conflict = await this.prisma.store.findFirst({
        where: { custom_domain: data.custom_domain, id: { not: store.id } },
        select: { id: true },
      });
      if (
        conflict ||
        (await this.marketHostTaken(data.custom_domain, store.id))
      )
        throw new ConflictException({
          code: 'STORE_CUSTOM_DOMAIN_TAKEN',
          message: 'Custom domain already in use',
        });
    }

    const updated = await this.runStoreUpdate(() =>
      this.prisma.store.update({
        where: { id: store.id },
        data,
        include: { language_config: true },
      }),
    );

    if (data.currency !== undefined) this.marketsContext.invalidate(store.id);

    // The commission split of an unpaid order is derived from the store type
    // at payment time — but COD orders are never "paid" through Stripe, so
    // without this sweep they would keep the old model's split forever.
    // Paid orders are settled history and are never touched (the recompute
    // itself refuses them).
    if (typeChanged) {
      const unpaid = await this.prisma.order.findMany({
        where: { store_id: store.id, payment_status: { not: 'paid' } },
        select: { id: true },
      });
      for (const order of unpaid) {
        try {
          await this.ordersService.recomputeCommissionForOrder(order.id);
        } catch (err) {
          this.logger.warn(
            `Store type switch: commission recompute failed for order ${order.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      // Apps that need an independent store are switched off on a move away
      // from INDEPENDENT; nothing changes on the way back. The store row is
      // already updated, so a failure here is logged rather than surfaced.
      try {
        await this.storeApps.onStoreTypeChanged(
          store.id,
          dto.store_type as StoreType,
        );
      } catch (err) {
        this.logger.warn(
          `Store type switch: failed to sync store apps: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    await this.revalidation.revalidateStoreBySlug(updated.slug);

    return updated;
  }

  async updateTheme(userId: string, dto: UpdateThemeDto) {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
    });
    if (!creator)
      throw new NotFoundException({
        code: 'STORE_CREATOR_NOT_FOUND',
        message: 'Creator not found',
      });

    const store = await this.prisma.store.update({
      where: { creator_id: creator.id },
      data: { theme_config: dto.theme_config },
    });

    await this.revalidation.revalidateStoreBySlug(store.slug);

    return store;
  }

  async updateThemeSelection(userId: string, dto: UpdateThemeSelectionDto) {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
    });
    if (!creator)
      throw new NotFoundException({
        code: 'STORE_CREATOR_NOT_FOUND',
        message: 'Creator not found',
      });

    const data: {
      theme_key?: string;
      theme_customizations?: Record<string, any>;
      theme_config?: Record<string, any>;
    } = {};
    if (dto.theme_key !== undefined) data.theme_key = dto.theme_key;
    if (dto.theme_customizations !== undefined)
      data.theme_customizations = dto.theme_customizations;

    // Applying a theme as a fresh preset: drop token overrides and strip brand
    // fields from theme_config so the chosen theme's colours/fonts take effect,
    // while keeping non-brand config (socials, contact, SEO, translations, header).
    if (dto.reset_customizations) {
      data.theme_customizations = {};
      const store = await this.prisma.store.findUnique({
        where: { creator_id: creator.id },
      });
      data.theme_config = stripBrandFromThemeConfig(store?.theme_config);
    }

    const store = await this.prisma.store.update({
      where: { creator_id: creator.id },
      data,
    });

    await this.revalidation.revalidateStoreBySlug(store.slug);

    return store;
  }

  // Creator-triggered manual cache flush from the dashboard. Reuses the same
  // revalidation path as automatic triggers, scoped to the caller's own store.
  async flushCache(
    userId: string,
  ): Promise<{ flushed: boolean; slug: string }> {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
    });
    if (!creator)
      throw new NotFoundException({
        code: 'STORE_CREATOR_NOT_FOUND',
        message: 'Creator not found',
      });

    const store = await this.prisma.store.findUnique({
      where: { creator_id: creator.id },
      select: { slug: true },
    });
    if (!store)
      throw new NotFoundException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });

    await this.revalidation.revalidateStoreBySlug(store.slug);
    return { flushed: true, slug: store.slug };
  }

  // Wraps Prisma.store.update so a unique-constraint race (P2002) on slug or
  // custom_domain is surfaced as a clean ConflictException instead of a 500.
  // The pre-flight findFirst checks above narrow the common case, but two
  // concurrent updates can still slip past them and hit the DB constraint.
  private async runStoreUpdate<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const target = Array.isArray(err.meta?.target)
          ? (err.meta?.target as string[]).join(',')
          : typeof err.meta?.target === 'string'
            ? err.meta.target
            : '';
        const isDomain = target.includes('custom_domain');
        throw new ConflictException({
          code: isDomain ? 'STORE_CUSTOM_DOMAIN_TAKEN' : 'STORE_SLUG_TAKEN',
          message: isDomain
            ? 'Custom domain already in use'
            : 'Store slug already taken',
        });
      }
      throw err;
    }
  }

  async updateLanguages(userId: string, dto: UpdateLanguageDto) {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
    });
    if (!creator)
      throw new NotFoundException({
        code: 'STORE_CREATOR_NOT_FOUND',
        message: 'Creator not found',
      });

    const store = await this.prisma.store.findUnique({
      where: { creator_id: creator.id },
    });
    if (!store)
      throw new NotFoundException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });

    // Normalize: the secondary list must never contain the primary locale,
    // duplicates, or empty values — a duplicated primary makes single-language
    // stores render language switchers and breaks translate-target lists.
    const existing = await this.prisma.storeLanguageConfig.findUnique({
      where: { store_id: store.id },
      select: { primary_locale: true },
    });
    const effectivePrimary =
      dto.primary_locale ?? existing?.primary_locale ?? 'en';
    const normalized = {
      ...dto,
      ...(dto.secondary_locales
        ? {
            secondary_locales: Array.from(
              new Set(
                dto.secondary_locales.filter(
                  (l) => l && l !== effectivePrimary,
                ),
              ),
            ),
          }
        : {}),
    };

    const config = await this.prisma.storeLanguageConfig.upsert({
      where: { store_id: store.id },
      update: normalized,
      create: { store_id: store.id, ...normalized },
    });

    // The default market mirrors the store's locales only while the markets
    // app is off; once it is on, the Markets page owns them (L8).
    if (!(await this.storeApps.isEnabled(store.id, 'markets'))) {
      await this.markets.mirrorLanguagesIntoDefault(
        store.id,
        config.primary_locale,
        config.secondary_locales,
      );
    }

    await this.revalidation.revalidateStoreById(store.id);

    return config;
  }
}

// Convert a custom_domain submitted from the dashboard into the canonical form
// stored in DB: trimmed/lowercased, with an empty string treated as "clear it"
// so Prisma stores NULL (the @unique index disallows duplicate empty strings).
// The DTO after normalization: the JSON column takes Prisma's typed null.
type StoreUpdateData = Omit<UpdateStoreDto, 'checkout_settings'> & {
  checkout_settings?: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
};

function normalizeStoreUpdate(dto: UpdateStoreDto): StoreUpdateData {
  let out: StoreUpdateData = dto as StoreUpdateData;
  // "Field was sent" must be judged by value, not hasOwnProperty: the global
  // ValidationPipe (transform: true) materializes EVERY declared DTO property
  // on the instance, so hasOwnProperty is true even for fields the client
  // never sent — which turned every partial store update (e.g. a currency-only
  // save) into a silent NULL-wipe of custom_domain, and vice versa. JSON can't
  // carry undefined, so undefined reliably means "not provided".
  if (dto.custom_domain !== undefined) {
    const raw = (dto.custom_domain ?? '').trim().toLowerCase();
    out = { ...out, custom_domain: raw || null } as StoreUpdateData;
  }
  // An empty currency means "go back to the platform default", which is NULL.
  if (dto.currency !== undefined) {
    const raw = (dto.currency ?? '').trim().toUpperCase();
    out = { ...out, currency: raw || null } as StoreUpdateData;
  }
  // The description is rendered as HTML on the storefront home page.
  if (dto.description !== undefined) {
    out = {
      ...out,
      description: sanitizeCreatorHtml(dto.description),
    } as StoreUpdateData;
  }
  // Checkout behaviour (M5.1): validated here so a bad body is a 400 with a
  // coded error; an all-default object is stored as NULL so the storefront
  // payload of such a store stays byte-identical (G0).
  if (dto.checkout_settings !== undefined) {
    const normalized = normalizeCheckoutSettingsInput(dto.checkout_settings);
    out = {
      ...out,
      checkout_settings: normalized
        ? (normalized as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull,
    };
  }
  // Tracking ids: trimmed; an empty string (or null) clears the id so the
  // storefront stops loading that tracker. GA4 and TikTok ids are stored
  // upper-cased (their canonical form); the DTO accepts either case.
  if (dto.ga4_measurement_id !== undefined) {
    const raw = (dto.ga4_measurement_id ?? '').trim().toUpperCase();
    out = { ...out, ga4_measurement_id: raw || null };
  }
  if (dto.meta_pixel_id !== undefined) {
    const raw = (dto.meta_pixel_id ?? '').trim();
    out = { ...out, meta_pixel_id: raw || null };
  }
  if (dto.tiktok_pixel_id !== undefined) {
    const raw = (dto.tiktok_pixel_id ?? '').trim().toUpperCase();
    out = { ...out, tiktok_pixel_id: raw || null };
  }
  return out;
}

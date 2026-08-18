import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { Prisma, StoreType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { OrdersService } from '../orders/orders.service';
import {
  CreateStoreDto,
  UpdateStoreDto,
  AdminUpdateStoreDto,
  UpdateThemeDto,
  UpdateThemeSelectionDto,
  UpdateLanguageDto,
} from './dto/store.dto';

// Hosts a creator cannot claim as their custom_domain. Mirrors the storefront
// proxy's PLATFORM_HOSTNAMES so an attacker can't register e.g.
// "admin.iwings-digital.com" and intercept platform traffic. Both an exact
// match and any subdomain (`.endsWith('.' + host)`) are blocked.
const RESERVED_HOSTS = (
  process.env.PLATFORM_HOSTS ||
  process.env.NEXT_PUBLIC_PLATFORM_HOSTS ||
  'localhost,iwings-digital.com,www.iwings-digital.com'
)
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

function isReservedDomain(domain: string): boolean {
  return RESERVED_HOSTS.some(
    (host) => domain === host || domain.endsWith('.' + host),
  );
}

@Injectable()
export class StoresService {
  constructor(
    private prisma: PrismaService,
    private readonly revalidation: RevalidationService,
    private readonly ordersService: OrdersService,
  ) {}

  async create(userId: string, dto: CreateStoreDto) {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
    });
    if (!creator) throw new NotFoundException({ code: 'STORE_CREATOR_PROFILE_NOT_FOUND', message: 'Creator profile not found' });

    const existing = await this.prisma.store.findUnique({
      where: { slug: dto.slug },
    });
    if (existing) throw new ConflictException({ code: 'STORE_SLUG_TAKEN', message: 'Store slug already taken' });

    const { primary_locale, secondary_locales, ...storeData } = dto;

    const store = await this.prisma.store.create({
      data: {
        creator_id: creator.id,
        ...storeData,
        language_config: {
          create: {
            primary_locale: primary_locale || 'en',
            secondary_locales: secondary_locales || [],
          },
        },
        // Automatically create the mandatory static pages
        static_pages: {
          create: [
            { type: 'ABOUT', slug: 'about', is_required: true, sort_order: 1, status: 'DRAFT' },
            { type: 'CONTACT', slug: 'contact', is_required: true, sort_order: 2, status: 'DRAFT' },
            { type: 'PRIVACY_POLICY', slug: 'privacy-policy', is_required: true, sort_order: 3, status: 'DRAFT' },
            { type: 'TERMS', slug: 'terms', is_required: true, sort_order: 4, status: 'DRAFT' },
            { type: 'SHIPPING_POLICY', slug: 'shipping-policy', is_required: true, sort_order: 5, status: 'DRAFT' },
            { type: 'RETURN_POLICY', slug: 'return-policy', is_required: true, sort_order: 6, status: 'DRAFT' },
          ],
        },
      },
      include: {
        language_config: true,
        static_pages: true,
        creator: { select: { display_name: true, avatar_url: true } },
      },
    });

    return store;
  }

  async findByCreator(userId: string) {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
    });
    if (!creator) throw new NotFoundException({ code: 'STORE_CREATOR_NOT_FOUND', message: 'Creator not found' });

    const store = await this.prisma.store.findUnique({
      where: { creator_id: creator.id },
      include: {
        language_config: true,
        static_pages: { include: { translations: true } },
        creator: { select: { display_name: true, avatar_url: true, bio: true } },
      },
    });
    if (!store) throw new NotFoundException({ code: 'STORE_NOT_FOUND', message: 'Store not found' });
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
        creator: { select: { display_name: true, avatar_url: true, bio: true, cover_url: true } },
      },
    });
    if (!store) throw new NotFoundException({ code: 'STORE_NOT_FOUND', message: 'Store not found' });
    return store;
  }

  // Lightweight lookup used by the storefront proxy to resolve a custom CNAME
  // (e.g. shop.merchant.com) to its store slug. Returns only the slug so the
  // proxy can rewrite without pulling the full store payload.
  async findSlugByCustomDomain(host: string): Promise<{ slug: string }> {
    const normalized = host.trim().toLowerCase().split(':')[0]!;
    const store = await this.prisma.store.findUnique({
      where: { custom_domain: normalized },
      select: { slug: true, is_active: true },
    });
    if (!store || !store.is_active) {
      throw new NotFoundException({ code: 'STORE_NOT_FOUND', message: 'Store not found' });
    }
    return { slug: store.slug };
  }

  async update(userId: string, dto: UpdateStoreDto) {
    const creator = await this.prisma.creator.findUnique({ where: { user_id: userId } });
    if (!creator) throw new NotFoundException({ code: 'STORE_CREATOR_NOT_FOUND', message: 'Creator not found' });

    if (dto.slug) {
      const conflict = await this.prisma.store.findFirst({
        where: { slug: dto.slug, creator_id: { not: creator.id } },
        select: { id: true },
      });
      if (conflict) throw new ConflictException({ code: 'STORE_SLUG_TAKEN', message: 'Store slug already taken' });
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

    if (data.custom_domain) {
      if (isReservedDomain(data.custom_domain)) {
        throw new BadRequestException({
          code: 'STORE_CUSTOM_DOMAIN_RESERVED',
          message: 'This domain is reserved by the platform',
        });
      }
      const conflict = await this.prisma.store.findFirst({
        where: { custom_domain: data.custom_domain, creator_id: { not: creator.id } },
        select: { id: true },
      });
      if (conflict) throw new ConflictException({ code: 'STORE_CUSTOM_DOMAIN_TAKEN', message: 'Custom domain already in use' });
    }

    const store = await this.runStoreUpdate(() =>
      this.prisma.store.update({
        where: { creator_id: creator.id },
        data,
        include: { language_config: true },
      }),
    );

    await this.revalidation.revalidateStoreBySlug(store.slug);

    return store;
  }

  async findByCreatorId(creatorId: string) {
    const store = await this.prisma.store.findUnique({
      where: { creator_id: creatorId },
      include: {
        language_config: true,
        creator: { select: { display_name: true, avatar_url: true } },
      },
    });
    if (!store) throw new NotFoundException({ code: 'STORE_NOT_FOUND', message: 'Store not found' });
    return store;
  }

  // Admin variant: may also change store_type (creators pick it only at creation).
  async adminUpdateByCreatorId(creatorId: string, dto: AdminUpdateStoreDto) {
    const store = await this.prisma.store.findUnique({
      where: { creator_id: creatorId },
      select: { id: true, store_type: true },
    });
    if (!store) throw new NotFoundException({ code: 'STORE_NOT_FOUND', message: 'Store not found' });

    const typeChanged = Boolean(dto.store_type) && dto.store_type !== store.store_type;
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
      if (conflict) throw new ConflictException({ code: 'STORE_SLUG_TAKEN', message: 'Store slug already taken' });
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
      if (conflict) throw new ConflictException({ code: 'STORE_CUSTOM_DOMAIN_TAKEN', message: 'Custom domain already in use' });
    }

    const updated = await this.runStoreUpdate(() =>
      this.prisma.store.update({
        where: { id: store.id },
        data,
        include: { language_config: true },
      }),
    );

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
          console.error('[StoreTypeSwitch] commission recompute failed for', order.id, err);
        }
      }
    }

    await this.revalidation.revalidateStoreBySlug(updated.slug);

    return updated;
  }

  async updateTheme(userId: string, dto: UpdateThemeDto) {
    const creator = await this.prisma.creator.findUnique({ where: { user_id: userId } });
    if (!creator) throw new NotFoundException({ code: 'STORE_CREATOR_NOT_FOUND', message: 'Creator not found' });

    const store = await this.prisma.store.update({
      where: { creator_id: creator.id },
      data: { theme_config: dto.theme_config },
    });

    await this.revalidation.revalidateStoreBySlug(store.slug);

    return store;
  }

  async updateThemeSelection(userId: string, dto: UpdateThemeSelectionDto) {
    const creator = await this.prisma.creator.findUnique({ where: { user_id: userId } });
    if (!creator) throw new NotFoundException({ code: 'STORE_CREATOR_NOT_FOUND', message: 'Creator not found' });

    const data: { theme_key?: string; theme_customizations?: Record<string, any>; theme_config?: Record<string, any> } = {};
    if (dto.theme_key !== undefined) data.theme_key = dto.theme_key;
    if (dto.theme_customizations !== undefined) data.theme_customizations = dto.theme_customizations;

    // Applying a theme as a fresh preset: drop token overrides and strip brand
    // fields from theme_config so the chosen theme's colours/fonts take effect,
    // while keeping non-brand config (socials, contact, SEO, translations, header).
    if (dto.reset_customizations) {
      data.theme_customizations = {};
      const store = await this.prisma.store.findUnique({ where: { creator_id: creator.id } });
      const cfg = ((store?.theme_config as Record<string, any>) || {});
      const { primaryColor, secondaryColor, fontFamily, typography, ...rest } = cfg;
      void primaryColor; void secondaryColor; void fontFamily; void typography;
      data.theme_config = rest;
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
  async flushCache(userId: string): Promise<{ flushed: boolean; slug: string }> {
    const creator = await this.prisma.creator.findUnique({ where: { user_id: userId } });
    if (!creator) throw new NotFoundException({ code: 'STORE_CREATOR_NOT_FOUND', message: 'Creator not found' });

    const store = await this.prisma.store.findUnique({
      where: { creator_id: creator.id },
      select: { slug: true },
    });
    if (!store) throw new NotFoundException({ code: 'STORE_NOT_FOUND', message: 'Store not found' });

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
          : String(err.meta?.target ?? '');
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
    const creator = await this.prisma.creator.findUnique({ where: { user_id: userId } });
    if (!creator) throw new NotFoundException({ code: 'STORE_CREATOR_NOT_FOUND', message: 'Creator not found' });

    const store = await this.prisma.store.findUnique({ where: { creator_id: creator.id } });
    if (!store) throw new NotFoundException({ code: 'STORE_NOT_FOUND', message: 'Store not found' });

    // Normalize: the secondary list must never contain the primary locale,
    // duplicates, or empty values — a duplicated primary makes single-language
    // stores render language switchers and breaks translate-target lists.
    const existing = await this.prisma.storeLanguageConfig.findUnique({
      where: { store_id: store.id },
      select: { primary_locale: true },
    });
    const effectivePrimary = dto.primary_locale ?? existing?.primary_locale ?? 'en';
    const normalized = {
      ...dto,
      ...(dto.secondary_locales
        ? {
            secondary_locales: Array.from(
              new Set(dto.secondary_locales.filter((l) => l && l !== effectivePrimary)),
            ),
          }
        : {}),
    };

    const config = await this.prisma.storeLanguageConfig.upsert({
      where: { store_id: store.id },
      update: normalized,
      create: { store_id: store.id, ...normalized },
    });

    await this.revalidation.revalidateStoreById(store.id);

    return config;
  }
}

// Convert a custom_domain submitted from the dashboard into the canonical form
// stored in DB: trimmed/lowercased, with an empty string treated as "clear it"
// so Prisma stores NULL (the @unique index disallows duplicate empty strings).
function normalizeStoreUpdate(dto: UpdateStoreDto): UpdateStoreDto {
  let out = dto;
  if (Object.prototype.hasOwnProperty.call(dto, 'custom_domain')) {
    const raw = (dto.custom_domain ?? '').trim().toLowerCase();
    out = { ...out, custom_domain: raw || null } as UpdateStoreDto;
  }
  // An empty currency means "go back to the platform default", which is NULL.
  if (Object.prototype.hasOwnProperty.call(dto, 'currency')) {
    const raw = (dto.currency ?? '').trim().toUpperCase();
    out = { ...out, currency: raw || null } as UpdateStoreDto;
  }
  return out;
}

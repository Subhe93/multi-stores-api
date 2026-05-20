import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import {
  CreateStoreDto,
  UpdateStoreDto,
  UpdateThemeDto,
  UpdateThemeSelectionDto,
  UpdateLanguageDto,
} from './dto/store.dto';

@Injectable()
export class StoresService {
  constructor(
    private prisma: PrismaService,
    private readonly revalidation: RevalidationService,
  ) {}

  async create(userId: string, dto: CreateStoreDto) {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
    });
    if (!creator) throw new NotFoundException('Creator profile not found');

    const existing = await this.prisma.store.findUnique({
      where: { slug: dto.slug },
    });
    if (existing) throw new ConflictException('Store slug already taken');

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
        // إنشاء الصفحات الثابتة الإلزامية تلقائياً
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
    if (!creator) throw new NotFoundException('Creator not found');

    const store = await this.prisma.store.findUnique({
      where: { creator_id: creator.id },
      include: {
        language_config: true,
        static_pages: { include: { translations: true } },
        creator: { select: { display_name: true, avatar_url: true, bio: true } },
      },
    });
    if (!store) throw new NotFoundException('Store not found');
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
    if (!store) throw new NotFoundException('Store not found');
    return store;
  }

  async update(userId: string, dto: UpdateStoreDto) {
    const creator = await this.prisma.creator.findUnique({ where: { user_id: userId } });
    if (!creator) throw new NotFoundException('Creator not found');

    if (dto.slug) {
      const conflict = await this.prisma.store.findFirst({
        where: { slug: dto.slug, creator_id: { not: creator.id } },
        select: { id: true },
      });
      if (conflict) throw new ConflictException('Store slug already taken');
    }

    const store = await this.prisma.store.update({
      where: { creator_id: creator.id },
      data: dto,
      include: { language_config: true },
    });

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
    if (!store) throw new NotFoundException('Store not found');
    return store;
  }

  async adminUpdateByCreatorId(creatorId: string, dto: UpdateStoreDto) {
    const store = await this.prisma.store.findUnique({
      where: { creator_id: creatorId },
      select: { id: true },
    });
    if (!store) throw new NotFoundException('Store not found');

    if (dto.slug) {
      const conflict = await this.prisma.store.findFirst({
        where: { slug: dto.slug, id: { not: store.id } },
        select: { id: true },
      });
      if (conflict) throw new ConflictException('Store slug already taken');
    }

    const updated = await this.prisma.store.update({
      where: { id: store.id },
      data: dto,
      include: { language_config: true },
    });

    await this.revalidation.revalidateStoreBySlug(updated.slug);

    return updated;
  }

  async updateTheme(userId: string, dto: UpdateThemeDto) {
    const creator = await this.prisma.creator.findUnique({ where: { user_id: userId } });
    if (!creator) throw new NotFoundException('Creator not found');

    const store = await this.prisma.store.update({
      where: { creator_id: creator.id },
      data: { theme_config: dto.theme_config },
    });

    await this.revalidation.revalidateStoreBySlug(store.slug);

    return store;
  }

  async updateThemeSelection(userId: string, dto: UpdateThemeSelectionDto) {
    const creator = await this.prisma.creator.findUnique({ where: { user_id: userId } });
    if (!creator) throw new NotFoundException('Creator not found');

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
    if (!creator) throw new NotFoundException('Creator not found');

    const store = await this.prisma.store.findUnique({
      where: { creator_id: creator.id },
      select: { slug: true },
    });
    if (!store) throw new NotFoundException('Store not found');

    await this.revalidation.revalidateStoreBySlug(store.slug);
    return { flushed: true, slug: store.slug };
  }

  async updateLanguages(userId: string, dto: UpdateLanguageDto) {
    const creator = await this.prisma.creator.findUnique({ where: { user_id: userId } });
    if (!creator) throw new NotFoundException('Creator not found');

    const store = await this.prisma.store.findUnique({ where: { creator_id: creator.id } });
    if (!store) throw new NotFoundException('Store not found');

    const config = await this.prisma.storeLanguageConfig.upsert({
      where: { store_id: store.id },
      update: dto,
      create: { store_id: store.id, ...dto },
    });

    await this.revalidation.revalidateStoreById(store.id);

    return config;
  }
}

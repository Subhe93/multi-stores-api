import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateCategoryDto,
  UpdateCategoryDto,
  LinkAttributesDto,
} from './dto/category.dto';
import { sanitizeCreatorHtml } from '../../common/html/creator-html';
import {
  DEFAULT_SLUG_LOCALE,
  findBySlugTolerant,
  resolveSlugBase,
  uniquePlatformCategorySlug,
  withSlugRetry,
} from '../../common/slug/wp-slug';

/**
 * Platform categories are not store content, so their WP slugs use the
 * platform default locale (no store primary locale applies).
 */
const PLATFORM_SLUG_LOCALE = DEFAULT_SLUG_LOCALE;

/** Category descriptions are rendered as HTML on the storefront. */
function sanitizeTranslation<T extends { description?: string | null }>(
  t: T,
): T {
  return t.description === undefined
    ? t
    : { ...t, description: sanitizeCreatorHtml(t.description) };
}

/** Translation names, English first (platform slug fallbacks). */
function namesEnglishFirst(
  translations: readonly { locale: string; name?: string | null }[],
): (string | null | undefined)[] {
  return [
    ...translations.filter((t) => t.locale === PLATFORM_SLUG_LOCALE),
    ...translations.filter((t) => t.locale !== PLATFORM_SLUG_LOCALE),
  ].map((t) => t.name);
}

@Injectable()
export class CategoriesService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateCategoryDto) {
    const { translations, ...data } = dto;
    // WP slug (the English/first name when the slug is empty), unique
    // platform-wide (`-2`, `-3`, ...).
    const { slug: base } = resolveSlugBase({
      candidates: [data.slug, ...namesEnglishFirst(translations)],
      locale: PLATFORM_SLUG_LOCALE,
      prefix: 'category',
    });

    return withSlugRetry(async () =>
      this.prisma.category.create({
        data: {
          ...data,
          slug: await uniquePlatformCategorySlug(this.prisma, base),
          translations: {
            create: translations.map(sanitizeTranslation),
          },
        },
        include: { translations: true },
      }),
    );
  }

  async findAll() {
    return this.prisma.category.findMany({
      where: { parent_id: null },
      include: {
        translations: true,
        children: {
          include: {
            translations: true,
            children: {
              include: { translations: true },
            },
          },
        },
      },
      orderBy: { sort_order: 'asc' },
    });
  }

  async findById(id: string) {
    const category = await this.prisma.category.findUnique({
      where: { id },
      include: {
        translations: true,
        children: { include: { translations: true } },
        attribute_templates: {
          include: {
            template: { include: { translations: true } },
          },
        },
      },
    });

    if (!category)
      throw new NotFoundException({
        code: 'CATEGORY_NOT_FOUND',
        message: 'Category not found',
      });
    return category;
  }

  async findBySlug(slug: string) {
    // WP query context: decode, NFC, lower case; exact match first, then a
    // case-insensitive one for legacy slugs (findBySlugTolerant).
    const category = await findBySlugTolerant(slug, (filter) =>
      this.prisma.category.findFirst({
        where: { slug: filter },
        include: {
          translations: true,
          children: { include: { translations: true } },
          attribute_templates: {
            include: {
              template: { include: { translations: true } },
            },
          },
        },
      }),
    );

    if (!category)
      throw new NotFoundException({
        code: 'CATEGORY_NOT_FOUND',
        message: 'Category not found',
      });
    return category;
  }

  async update(id: string, dto: UpdateCategoryDto) {
    const { translations, slug: sentSlug, ...data } = dto;

    // WP slug on edit: unchanged = kept as stored; else sanitized and made
    // unique platform-wide (this category excluded).
    let slug: string | undefined;
    if (sentSlug !== undefined) {
      const current = await this.prisma.category.findUnique({
        where: { id },
        select: {
          slug: true,
          translations: { select: { locale: true, name: true } },
        },
      });
      const res = resolveSlugBase({
        candidates: [
          sentSlug,
          ...namesEnglishFirst(translations ?? current?.translations ?? []),
        ],
        locale: PLATFORM_SLUG_LOCALE,
        stored: current?.slug,
        prefix: 'category',
        id,
      });
      slug = res.keep
        ? undefined
        : await uniquePlatformCategorySlug(this.prisma, res.slug, id);
    }

    if (translations) {
      // حذف الترجمات القديمة وإنشاء الجديدة
      await this.prisma.categoryTranslation.deleteMany({
        where: { category_id: id },
      });
    }

    return this.prisma.category.update({
      where: { id },
      data: {
        ...data,
        ...(slug !== undefined ? { slug } : {}),
        ...(translations && {
          translations: { create: translations.map(sanitizeTranslation) },
        }),
      },
      include: { translations: true },
    });
  }

  async delete(id: string) {
    return this.prisma.category.delete({ where: { id } });
  }

  async getAttributeTemplates(id: string) {
    const category = await this.prisma.category.findUnique({
      where: { id },
      include: {
        attribute_templates: {
          include: {
            template: { include: { translations: true } },
          },
          orderBy: { template: { sort_order: 'asc' } },
        },
      },
    });

    if (!category)
      throw new NotFoundException({
        code: 'CATEGORY_NOT_FOUND',
        message: 'Category not found',
      });
    return category.attribute_templates.map((cat) => cat.template);
  }

  async linkAttributes(id: string, dto: LinkAttributesDto) {
    // حذف الروابط القديمة
    await this.prisma.categoryAttributeTemplate.deleteMany({
      where: { category_id: id },
    });

    // إنشاء روابط جديدة
    await this.prisma.categoryAttributeTemplate.createMany({
      data: dto.template_ids.map((template_id) => ({
        category_id: id,
        template_id,
      })),
    });

    return this.getAttributeTemplates(id);
  }
}

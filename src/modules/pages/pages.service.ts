import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedirectsService } from '../redirects/redirects.service';
import {
  isRootPageSlugServed,
  resolveSlugBase,
  storeSlugLocale,
  titlesPrimaryFirst,
  uniqueStaticPageSlug,
  withSlugRetry,
} from '../../common/slug/wp-slug';
import { rootPagePath } from '../../common/slug/slug-moves';
import { UserRole } from '@prisma/client';
import {
  CreatePageDto,
  PageTranslationDto,
  UpdatePageDto,
} from './dto/page.dto';
import { sanitizeCreatorHtml } from '../../common/html/creator-html';

/** Legacy page content is rendered as HTML on the storefront. */
function sanitizeTranslation(t: PageTranslationDto): PageTranslationDto {
  return t.content === undefined
    ? t
    : { ...t, content: sanitizeCreatorHtml(t.content) ?? undefined };
}

@Injectable()
export class PagesService {
  constructor(
    private prisma: PrismaService,
    // Old-slug 301s (WP `_wp_old_slug`); optional for positional tests.
    @Optional() private readonly redirects?: RedirectsService,
  ) {}

  async findByStore(storeId: string, userId: string, userRole: UserRole) {
    await this.assertOwnsStore(storeId, userId, userRole);
    return this.prisma.staticPage.findMany({
      where: { store_id: storeId },
      include: {
        translations: true,
        blocks: {
          include: { translations: true },
          orderBy: { sort_order: 'asc' },
        },
      },
      orderBy: { sort_order: 'asc' },
    });
  }

  async findById(id: string, userId: string, userRole: UserRole) {
    const page = await this.prisma.staticPage.findUnique({
      where: { id },
      include: {
        translations: true,
        blocks: {
          include: { translations: true },
          orderBy: { sort_order: 'asc' },
        },
      },
    });
    if (!page)
      throw new NotFoundException({
        code: 'PAGE_LEGACY_NOT_FOUND',
        message: 'Page not found',
      });
    await this.assertOwnsStore(page.store_id, userId, userRole);
    return page;
  }

  async create(
    storeId: string,
    dto: CreatePageDto,
    userId: string,
    userRole: UserRole,
  ) {
    await this.assertOwnsStore(storeId, userId, userRole);
    const { translations, ...data } = dto;

    // WP page slug: sanitized with the store's content locale (the title
    // when the slug is empty, else `page-<id8>`), unique among the store's
    // legacy and v2 pages, reserved and numeric slugs suffixed.
    const locale = await storeSlugLocale(this.prisma, { storeId });
    const { slug: base } = resolveSlugBase({
      candidates: [
        data.slug,
        ...titlesPrimaryFirst(translations ?? [], locale),
      ],
      locale,
      prefix: 'page',
    });
    const created = await withSlugRetry(async () =>
      this.prisma.staticPage.create({
        data: {
          store_id: storeId,
          ...data,
          slug: await uniqueStaticPageSlug(this.prisma, storeId, base),
          ...(translations && {
            translations: { create: translations.map(sanitizeTranslation) },
          }),
        },
        include: { translations: true },
      }),
    );
    await this.releaseLivePagePath(created);
    return created;
  }

  /**
   * A published page serves `/<slug>` again: old-slug / import 301s from
   * that path are switched off (the proxy matches redirects before routing,
   * so they would shadow the page). See RedirectsService.releaseLivePaths.
   */
  private async releaseLivePagePath(page: {
    store_id: string;
    slug: string;
    status: string;
  }): Promise<void> {
    if (!this.redirects || page.status !== 'PUBLISHED' || !page.slug) return;
    await this.redirects.releaseLivePaths(
      page.store_id,
      [rootPagePath(page.slug)],
      { localePrefixes: true },
    );
  }

  async update(
    id: string,
    dto: UpdatePageDto,
    userId: string,
    userRole: UserRole,
  ) {
    await this.assertOwnsPage(id, userId, userRole);
    const { translations, slug: sentSlug, ...data } = dto;

    // WP page slug on edit: unchanged = kept as stored; else sanitized and
    // made unique (this page excluded).
    const current = await this.prisma.staticPage.findUnique({
      where: { id },
      select: { store_id: true, slug: true, status: true },
    });
    let slugBase: string | null = null;
    if (sentSlug !== undefined && current) {
      const locale = await storeSlugLocale(this.prisma, {
        storeId: current.store_id,
      });
      const stored = translations
        ? []
        : await this.prisma.staticPageTranslation.findMany({
            where: { page_id: id },
            select: { locale: true, title: true },
          });
      const res = resolveSlugBase({
        candidates: [
          sentSlug,
          ...titlesPrimaryFirst(translations ?? stored, locale),
        ],
        locale,
        stored: current.slug,
        prefix: 'page',
        id,
      });
      if (!res.keep) slugBase = res.slug;
    }

    if (translations) {
      await this.prisma.staticPageTranslation.deleteMany({
        where: { page_id: id },
      });
    }

    const updated = await withSlugRetry(async () =>
      this.prisma.staticPage.update({
        where: { id },
        data: {
          ...data,
          ...(slugBase !== null && current
            ? {
                slug: await uniqueStaticPageSlug(
                  this.prisma,
                  current.store_id,
                  slugBase,
                  id,
                ),
              }
            : {}),
          ...(translations && {
            translations: { create: translations.map(sanitizeTranslation) },
          }),
        },
        include: { translations: true },
      }),
    );

    // Old-slug 301 when a published page moved and nothing else serves the
    // old path (a v2 page with that slug would).
    if (
      this.redirects &&
      current &&
      current.status === 'PUBLISHED' &&
      updated.slug !== current.slug &&
      !(await isRootPageSlugServed(
        this.prisma,
        current.store_id,
        current.slug,
        {
          staticPageId: id,
        },
      ))
    ) {
      await this.redirects.applySlugChangeRedirects(
        current.store_id,
        [{ from: rootPagePath(current.slug), to: rootPagePath(updated.slug) }],
        undefined,
        { localePrefixes: true },
      );
    }
    await this.releaseLivePagePath(updated);
    return updated;
  }

  async delete(id: string, userId: string, userRole: UserRole) {
    const page = await this.prisma.staticPage.findUnique({ where: { id } });
    if (!page)
      throw new NotFoundException({
        code: 'PAGE_LEGACY_NOT_FOUND',
        message: 'Page not found',
      });
    await this.assertOwnsStore(page.store_id, userId, userRole);
    if (page.is_required)
      throw new NotFoundException({
        code: 'PAGE_LEGACY_CANNOT_DELETE_REQUIRED',
        message: 'Cannot delete required page',
      });

    return this.prisma.staticPage.delete({ where: { id } });
  }

  /**
   * These pages render on the public storefront through dangerouslySetInnerHTML,
   * so an unchecked store id let any creator deface another store and plant
   * script that runs for every visitor on that origin.
   */
  private async assertOwnsPage(
    pageId: string,
    userId: string,
    userRole: UserRole,
  ) {
    const page = await this.prisma.staticPage.findUnique({
      where: { id: pageId },
      select: { store_id: true },
    });
    if (!page)
      throw new NotFoundException({
        code: 'PAGE_LEGACY_NOT_FOUND',
        message: 'Page not found',
      });
    await this.assertOwnsStore(page.store_id, userId, userRole);
  }

  private async assertOwnsStore(
    storeId: string,
    userId: string,
    userRole: UserRole,
  ) {
    if (userRole === UserRole.ADMIN) return;

    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    const store = creator
      ? await this.prisma.store.findUnique({
          where: { id: storeId },
          select: { creator_id: true },
        })
      : null;

    if (!creator || !store || store.creator_id !== creator.id) {
      throw new ForbiddenException({
        code: 'PAGE_LEGACY_FORBIDDEN',
        message: 'This page belongs to another store',
      });
    }
  }
}

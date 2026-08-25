import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PageType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import {
  CreatePageDto,
  CreateSectionDto,
  PublishPageDto,
  ReorderSectionsDto,
  UpdatePageDto,
  UpdateSectionDto,
} from './dto/pages.dto';

/**
 * Default settings of the `product-listing` magic section. Used to seed both
 * the CATALOG_TEMPLATE and the COLLECTION_TEMPLATE on first ensure. Must stay
 * in parity with the section's `defaultSettings` in the web theme definition.
 */
const PRODUCT_LISTING_DEFAULT_SETTINGS = {
  show_hero: true,
  hero_height: 'auto',
  show_count: true,
  show_search: true,
  show_collections: true,
  show_sort: true,
  show_description: true,
  show_back_link: true,
  aspect: 'square',
  columns: 4,
  columns_tablet: 3,
  columns_mobile: 2,
};

@Injectable()
export class PagesV2Service {
  constructor(
    private prisma: PrismaService,
    private readonly revalidation: RevalidationService,
  ) {}

  // ── Helpers ─────────────────────────────────────────────

  /**
   * Resolve the creator's store id and assert ownership.
   * Used by every write endpoint that takes `pageId` so creators can't touch
   * another store's pages.
   */
  private async resolveCreatorStoreId(userId: string): Promise<string> {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    if (!creator) throw new NotFoundException({ code: 'PAGE_CREATOR_NOT_FOUND', message: 'Creator not found' });
    const store = await this.prisma.store.findUnique({
      where: { creator_id: creator.id },
      select: { id: true },
    });
    if (!store) throw new NotFoundException({ code: 'PAGE_STORE_NOT_FOUND', message: 'Store not found' });
    return store.id;
  }

  /**
   * The store's primary CONTENT locale — used to seed default titles for
   * lazily provisioned system pages so they never show up as "Untitled".
   */
  private async storePrimaryLocale(storeId: string): Promise<string> {
    const cfg = await this.prisma.storeLanguageConfig.findFirst({
      where: { store_id: storeId },
      select: { primary_locale: true },
    });
    return cfg?.primary_locale || 'en';
  }

  /**
   * Localized default titles for the provisioned system pages, keyed by
   * page type then locale. Falls back to English for unknown locales.
   */
  private defaultPageTitle(type: PageType, locale: string): string {
    const titles: Partial<Record<PageType, Record<string, string>>> = {
      [PageType.HOME]: {
        en: 'Home', ar: 'الرئيسية', de: 'Startseite', fr: 'Accueil', sv: 'Startsida', tr: 'Ana Sayfa',
      },
      [PageType.PRODUCT_TEMPLATE]: {
        en: 'Product page', ar: 'صفحة المنتج', de: 'Produktseite', fr: 'Page produit', sv: 'Produktsida', tr: 'Ürün sayfası',
      },
      [PageType.HEADER]: {
        en: 'Header', ar: 'الترويسة', de: 'Kopfzeile', fr: 'En-tête', sv: 'Sidhuvud', tr: 'Üst bilgi',
      },
      [PageType.FOOTER]: {
        en: 'Footer', ar: 'التذييل', de: 'Fußzeile', fr: 'Pied de page', sv: 'Sidfot', tr: 'Alt bilgi',
      },
      [PageType.CATALOG_TEMPLATE]: {
        en: 'All products', ar: 'كل المنتجات', de: 'Alle Produkte', fr: 'Tous les produits', sv: 'Alla produkter', tr: 'Tüm ürünler',
      },
      [PageType.COLLECTION_TEMPLATE]: {
        en: 'Collection page', ar: 'صفحة التصنيف', de: 'Kollektionsseite', fr: 'Page de collection', sv: 'Kollektionssida', tr: 'Koleksiyon sayfası',
      },
    };
    const byLocale = titles[type];
    return byLocale?.[locale] || byLocale?.en || 'Untitled';
  }

  private async assertPageBelongsToStore(pageId: string, storeId: string) {
    const page = await this.prisma.page.findUnique({
      where: { id: pageId },
      select: { id: true, store_id: true },
    });
    if (!page) throw new NotFoundException({ code: 'PAGE_NOT_FOUND', message: 'Page not found' });
    if (page.store_id !== storeId) throw new ForbiddenException({ code: 'PAGE_FORBIDDEN', message: 'Not your page' });
  }

  private async assertSectionBelongsToStore(sectionId: string, storeId: string): Promise<{ pageId: string }> {
    const section = await this.prisma.pageSection.findUnique({
      where: { id: sectionId },
      select: { id: true, page_id: true, page: { select: { store_id: true } } },
    });
    if (!section) throw new NotFoundException({ code: 'PAGE_SECTION_NOT_FOUND', message: 'Section not found' });
    if (section.page.store_id !== storeId) throw new ForbiddenException({ code: 'PAGE_SECTION_FORBIDDEN', message: 'Not your section' });
    return { pageId: section.page_id };
  }

  // ── Pages CRUD ──────────────────────────────────────────

  async listByStore(userId: string) {
    const storeId = await this.resolveCreatorStoreId(userId);
    return this.prisma.page.findMany({
      where: { store_id: storeId },
      include: { translations: true },
      orderBy: [{ type: 'asc' }, { sort_order: 'asc' }],
    });
  }

  async getById(userId: string, pageId: string) {
    const storeId = await this.resolveCreatorStoreId(userId);
    await this.assertPageBelongsToStore(pageId, storeId);
    return this.prisma.page.findUnique({
      where: { id: pageId },
      include: {
        translations: true,
        sections: {
          include: { translations: true },
          orderBy: { sort_order: 'asc' },
        },
      },
    });
  }

  async create(userId: string, dto: CreatePageDto) {
    const storeId = await this.resolveCreatorStoreId(userId);

    // Slug rules per page type:
    // - HOME, PRODUCT_TEMPLATE, HEADER, FOOTER, CATALOG_TEMPLATE,
    //   COLLECTION_TEMPLATE: one per store, no slug.
    //   HEADER/FOOTER are storefront-wide chrome — rendered on every page.
    //   CATALOG_TEMPLATE serves /products, COLLECTION_TEMPLATE serves every
    //   /collections/[handle].
    // - STATIC and LANDING: require slug
    const slugless =
      dto.type === PageType.HOME ||
      dto.type === PageType.PRODUCT_TEMPLATE ||
      dto.type === PageType.HEADER ||
      dto.type === PageType.FOOTER ||
      dto.type === PageType.CATALOG_TEMPLATE ||
      dto.type === PageType.COLLECTION_TEMPLATE;
    if (slugless && dto.slug) {
      throw new BadRequestException(`${dto.type} page cannot have a slug`);
    }
    if (!slugless && !dto.slug) {
      throw new BadRequestException({ code: 'PAGE_SLUG_REQUIRED', message: 'slug is required for this page type' });
    }
    if (dto.type === PageType.STATIC && !dto.static_kind) {
      throw new BadRequestException({ code: 'PAGE_STATIC_KIND_REQUIRED', message: 'static_kind is required for STATIC pages' });
    }

    // (store_id, type, static_kind) is unique — catch duplicate singletons early.
    if (slugless) {
      const existing = await this.prisma.page.findFirst({
        where: { store_id: storeId, type: dto.type },
        select: { id: true },
      });
      if (existing) throw new ConflictException(`${dto.type} page already exists`);
    }

    try {
      return await this.prisma.page.create({
        data: {
          store_id: storeId,
          type: dto.type,
          static_kind: dto.static_kind ?? null,
          slug: dto.slug ?? null,
          sort_order: dto.sort_order ?? 0,
          translations: dto.translations
            ? { create: dto.translations.map((t) => ({ ...t })) }
            : undefined,
        },
        include: { translations: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({ code: 'PAGE_SLUG_OR_KIND_EXISTS', message: 'A page with this slug or kind already exists' });
      }
      throw err;
    }
  }

  async update(userId: string, pageId: string, dto: UpdatePageDto) {
    const storeId = await this.resolveCreatorStoreId(userId);
    await this.assertPageBelongsToStore(pageId, storeId);

    const data: Prisma.PageUpdateInput = {};
    if (dto.slug !== undefined) data.slug = dto.slug;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.sort_order !== undefined) data.sort_order = dto.sort_order;
    if (dto.seo !== undefined) data.seo = dto.seo as Prisma.InputJsonValue;

    return this.prisma.$transaction(async (tx) => {
      if (dto.translations) {
        // Upsert per locale; deleteMany + create would invalidate references.
        for (const tr of dto.translations) {
          await tx.pageTranslation.upsert({
            where: { page_id_locale: { page_id: pageId, locale: tr.locale } },
            update: {
              title: tr.title,
              meta_title: tr.meta_title,
              meta_description: tr.meta_description,
            },
            create: {
              page_id: pageId,
              locale: tr.locale,
              title: tr.title,
              meta_title: tr.meta_title,
              meta_description: tr.meta_description,
            },
          });
        }
      }
      return tx.page.update({
        where: { id: pageId },
        data,
        include: { translations: true },
      });
    });
  }

  async delete(userId: string, pageId: string) {
    const storeId = await this.resolveCreatorStoreId(userId);
    await this.assertPageBelongsToStore(pageId, storeId);
    const page = await this.prisma.page.findUnique({
      where: { id: pageId },
      select: { is_required: true, type: true },
    });
    if (
      page?.is_required ||
      page?.type === PageType.HOME ||
      page?.type === PageType.PRODUCT_TEMPLATE ||
      page?.type === PageType.HEADER ||
      page?.type === PageType.FOOTER ||
      page?.type === PageType.CATALOG_TEMPLATE ||
      page?.type === PageType.COLLECTION_TEMPLATE
    ) {
      throw new BadRequestException({ code: 'PAGE_CANNOT_BE_DELETED', message: 'This page cannot be deleted' });
    }
    return this.prisma.page.delete({ where: { id: pageId } });
  }

  /**
   * Lazily provision a HOME page for the creator's store if one does not exist.
   * Used by the dashboard's builder route so creators don't see "page not found"
   * on first visit.
   */
  async ensureHomePage(userId: string) {
    const storeId = await this.resolveCreatorStoreId(userId);
    const existing = await this.prisma.page.findFirst({
      where: { store_id: storeId, type: PageType.HOME },
      include: { translations: true },
    });
    if (existing) return existing;
    const locale = await this.storePrimaryLocale(storeId);
    return this.prisma.page.create({
      data: {
        store_id: storeId,
        type: PageType.HOME,
        slug: null,
        is_required: true,
        translations: {
          create: [{ locale, title: this.defaultPageTitle(PageType.HOME, locale) }],
        },
      },
      include: { translations: true },
    });
  }

  /**
   * Same as ensureHomePage but for the (single) PRODUCT_TEMPLATE per store.
   * v1 supports one template; later phases may scope templates by category.
   *
   * On first creation we seed a sensible default layout so creators don't
   * stare at a blank canvas: gallery + details + add-to-cart + tabs. They can
   * still reorder, remove or extend any of these — the seed is just a starting
   * point.
   */
  async ensureProductTemplate(userId: string) {
    const storeId = await this.resolveCreatorStoreId(userId);
    const existing = await this.prisma.page.findFirst({
      where: { store_id: storeId, type: PageType.PRODUCT_TEMPLATE },
      include: { translations: true },
    });
    if (existing) return existing;

    // Seed with the single full-fidelity `product-page` section so a freshly
    // provisioned template matches the standalone storefront product design
    // 1:1 (gallery + price + bundles + variants + custom fields + shipping +
    // tabs). The older granular magic sections stay registered in the theme
    // for backward-compat with templates published before this change.
    const locale = await this.storePrimaryLocale(storeId);
    return this.prisma.page.create({
      data: {
        store_id: storeId,
        type: PageType.PRODUCT_TEMPLATE,
        slug: null,
        is_required: true,
        translations: {
          create: [{ locale, title: this.defaultPageTitle(PageType.PRODUCT_TEMPLATE, locale) }],
        },
        sections: {
          create: [
            {
              section_key: 'product-page',
              sort_order: 0,
              settings: {
                show_trust_badges: true,
                show_shipping: true,
                show_tabs: true,
                show_tags: true,
                button_style: 'solid',
              } as Prisma.InputJsonValue,
            },
          ],
        },
      },
      include: { translations: true },
    });
  }

  /**
   * Lazy provisioning for the HEADER singleton. Seeds with a header-bar
   * section so the first visit shows something useful (logo + nav placeholder).
   */
  async ensureHeader(userId: string) {
    const storeId = await this.resolveCreatorStoreId(userId);
    const existing = await this.prisma.page.findFirst({
      where: { store_id: storeId, type: PageType.HEADER },
      include: { translations: true },
    });
    if (existing) return existing;

    const locale = await this.storePrimaryLocale(storeId);
    return this.prisma.page.create({
      data: {
        store_id: storeId,
        type: PageType.HEADER,
        slug: null,
        is_required: true,
        translations: {
          create: [{ locale, title: this.defaultPageTitle(PageType.HEADER, locale) }],
        },
        sections: {
          create: [
            {
              section_key: 'header-bar',
              sort_order: 0,
              settings: {
                show_logo: true,
                show_store_name: true,
                show_search: true,
                show_cart: true,
                show_account: true,
                show_locale: true,
                sticky: true,
              } as Prisma.InputJsonValue,
            },
          ],
        },
      },
      include: { translations: true },
    });
  }

  /**
   * Lazy provisioning for the FOOTER singleton. Seeds with a basic footer
   * (link columns + copyright) so the first visit isn't empty.
   */
  async ensureFooter(userId: string) {
    const storeId = await this.resolveCreatorStoreId(userId);
    const existing = await this.prisma.page.findFirst({
      where: { store_id: storeId, type: PageType.FOOTER },
      include: { translations: true },
    });
    if (existing) return existing;

    const locale = await this.storePrimaryLocale(storeId);
    return this.prisma.page.create({
      data: {
        store_id: storeId,
        type: PageType.FOOTER,
        slug: null,
        is_required: true,
        translations: {
          create: [{ locale, title: this.defaultPageTitle(PageType.FOOTER, locale) }],
        },
        sections: {
          create: [
            {
              section_key: 'footer-columns',
              sort_order: 0,
              settings: {} as Prisma.InputJsonValue,
            },
            {
              section_key: 'copyright-bar',
              sort_order: 1,
              settings: {} as Prisma.InputJsonValue,
            },
          ],
        },
      },
      include: { translations: true },
    });
  }

  /**
   * Lazy provisioning for the CATALOG_TEMPLATE singleton (serves /products).
   * Seeds with the single `product-listing` magic section so a freshly
   * provisioned template renders the same catalog body as the hardcoded
   * storefront route. Creators can add regular sections around it.
   */
  async ensureCatalogTemplate(userId: string) {
    return this.ensureListingTemplate(userId, PageType.CATALOG_TEMPLATE);
  }

  /**
   * Lazy provisioning for the COLLECTION_TEMPLATE singleton (serves every
   * /collections/[handle]). Same seed as the catalog template — the section
   * reads the current collection from the route-injected listing context.
   */
  async ensureCollectionTemplate(userId: string) {
    return this.ensureListingTemplate(userId, PageType.COLLECTION_TEMPLATE);
  }

  /**
   * Shared find-or-create for the two listing templates. Both are slugless,
   * required singletons seeded with one `product-listing` section carrying
   * PRODUCT_LISTING_DEFAULT_SETTINGS.
   */
  private async ensureListingTemplate(
    userId: string,
    type: typeof PageType.CATALOG_TEMPLATE | typeof PageType.COLLECTION_TEMPLATE,
  ) {
    const storeId = await this.resolveCreatorStoreId(userId);
    const locale = await this.storePrimaryLocale(storeId);

    // The (store_id, type, static_kind) unique index does not fire for these
    // rows because static_kind is NULL, so two concurrent ensures (double
    // click, two tabs) could both create a singleton. Serialise find-or-create
    // per (store, type) with a transaction-scoped advisory lock.
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${storeId}:${type}`}))`;
      const existing = await tx.page.findFirst({
        where: { store_id: storeId, type },
        include: { translations: true },
        orderBy: { created_at: 'asc' },
      });
      if (existing) return existing;

      return tx.page.create({
        data: {
          store_id: storeId,
          type,
          slug: null,
          is_required: true,
          translations: {
            create: [{ locale, title: this.defaultPageTitle(type, locale) }],
          },
          sections: {
            create: [
              {
                section_key: 'product-listing',
                sort_order: 0,
                settings: { ...PRODUCT_LISTING_DEFAULT_SETTINGS } as Prisma.InputJsonValue,
              },
            ],
          },
        },
        include: { translations: true },
      });
    });
  }

  // ── Sections CRUD ───────────────────────────────────────

  async listSections(userId: string, pageId: string) {
    const storeId = await this.resolveCreatorStoreId(userId);
    await this.assertPageBelongsToStore(pageId, storeId);
    return this.prisma.pageSection.findMany({
      where: { page_id: pageId },
      include: { translations: true },
      orderBy: { sort_order: 'asc' },
    });
  }

  async addSection(userId: string, pageId: string, dto: CreateSectionDto) {
    const storeId = await this.resolveCreatorStoreId(userId);
    await this.assertPageBelongsToStore(pageId, storeId);

    const sortOrder =
      dto.sort_order ??
      ((await this.prisma.pageSection.count({ where: { page_id: pageId } })) ?? 0);

    return this.prisma.pageSection.create({
      data: {
        page_id: pageId,
        section_key: dto.section_key,
        settings: (dto.settings as Prisma.InputJsonValue) ?? {},
        sort_order: sortOrder,
        translations: dto.translations
          ? {
              create: dto.translations.map((t) => ({
                locale: t.locale,
                content: t.content as Prisma.InputJsonValue,
              })),
            }
          : undefined,
      },
      include: { translations: true },
    });
  }

  async updateSection(userId: string, sectionId: string, dto: UpdateSectionDto) {
    const storeId = await this.resolveCreatorStoreId(userId);
    await this.assertSectionBelongsToStore(sectionId, storeId);

    const data: Prisma.PageSectionUpdateInput = {};
    if (dto.settings !== undefined) data.settings = dto.settings as Prisma.InputJsonValue;
    if (dto.sort_order !== undefined) data.sort_order = dto.sort_order;
    if (dto.is_hidden !== undefined) data.is_hidden = dto.is_hidden;

    return this.prisma.$transaction(async (tx) => {
      if (dto.translations) {
        for (const tr of dto.translations) {
          await tx.pageSectionTranslation.upsert({
            where: { section_id_locale: { section_id: sectionId, locale: tr.locale } },
            update: { content: tr.content as Prisma.InputJsonValue },
            create: {
              section_id: sectionId,
              locale: tr.locale,
              content: tr.content as Prisma.InputJsonValue,
            },
          });
        }
      }
      return tx.pageSection.update({
        where: { id: sectionId },
        data,
        include: { translations: true },
      });
    });
  }

  async deleteSection(userId: string, sectionId: string) {
    const storeId = await this.resolveCreatorStoreId(userId);
    await this.assertSectionBelongsToStore(sectionId, storeId);
    return this.prisma.pageSection.delete({ where: { id: sectionId } });
  }

  async reorderSections(userId: string, pageId: string, dto: ReorderSectionsDto) {
    const storeId = await this.resolveCreatorStoreId(userId);
    await this.assertPageBelongsToStore(pageId, storeId);

    // Verify every id actually belongs to this page so a single bad payload
    // can't shuffle sections across pages.
    const owned = await this.prisma.pageSection.findMany({
      where: { id: { in: dto.section_ids }, page_id: pageId },
      select: { id: true },
    });
    if (owned.length !== dto.section_ids.length) {
      throw new BadRequestException({ code: 'PAGE_SECTION_IDS_INVALID', message: 'section_ids contains entries not on this page' });
    }

    await this.prisma.$transaction(
      dto.section_ids.map((id, idx) =>
        this.prisma.pageSection.update({
          where: { id },
          data: { sort_order: idx },
        }),
      ),
    );
    return this.listSections(userId, pageId);
  }

  // ── Publish / versions ─────────────────────────────────

  /**
   * Take a snapshot of the page's sections + per-locale content + translations
   * + seo, then mark it as the live published version.
   */
  async publish(userId: string, pageId: string, dto: PublishPageDto) {
    const storeId = await this.resolveCreatorStoreId(userId);
    await this.assertPageBelongsToStore(pageId, storeId);

    const page = await this.prisma.page.findUnique({
      where: { id: pageId },
      include: {
        translations: true,
        sections: {
          where: { is_hidden: false },
          include: { translations: true },
          orderBy: { sort_order: 'asc' },
        },
      },
    });
    if (!page) throw new NotFoundException({ code: 'PAGE_NOT_FOUND', message: 'Page not found' });

    const snapshot = {
      page: {
        type: page.type,
        static_kind: page.static_kind,
        slug: page.slug,
        seo: page.seo,
        translations: page.translations,
      },
      sections: page.sections.map((s) => ({
        id: s.id,
        section_key: s.section_key,
        settings: s.settings,
        sort_order: s.sort_order,
        translations: s.translations.map((t) => ({ locale: t.locale, content: t.content })),
      })),
    };

    const result = await this.prisma.$transaction(async (tx) => {
      const version = await tx.pageVersion.create({
        data: {
          page_id: pageId,
          label: dto.label ?? null,
          snapshot: snapshot as Prisma.InputJsonValue,
          published_at: new Date(),
        },
      });
      return tx.page.update({
        where: { id: pageId },
        data: {
          status: 'PUBLISHED',
          published_version_id: version.id,
        },
        include: { published_version: true, translations: true },
      });
    });

    // Refresh the storefront cache so the publish is visible within seconds.
    await this.revalidation.revalidateStoreById(storeId);

    return result;
  }

  async listVersions(userId: string, pageId: string) {
    const storeId = await this.resolveCreatorStoreId(userId);
    await this.assertPageBelongsToStore(pageId, storeId);
    return this.prisma.pageVersion.findMany({
      where: { page_id: pageId },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        label: true,
        published_at: true,
        created_at: true,
      },
    });
  }

  /**
   * Restore the working draft (sections + per-locale content + page seo/translations)
   * from a previously-captured version snapshot. Does NOT publish — the creator
   * decides whether to publish after reviewing in the builder.
   */
  async restoreVersion(userId: string, pageId: string, versionId: string) {
    const storeId = await this.resolveCreatorStoreId(userId);
    await this.assertPageBelongsToStore(pageId, storeId);

    const version = await this.prisma.pageVersion.findUnique({
      where: { id: versionId },
      select: { page_id: true, snapshot: true },
    });
    if (!version || version.page_id !== pageId) {
      throw new NotFoundException({ code: 'PAGE_VERSION_NOT_FOUND', message: 'Version not found' });
    }

    const snapshot = version.snapshot as {
      page?: {
        seo?: Record<string, unknown>;
        translations?: Array<{
          locale: string;
          title?: string | null;
          meta_title?: string | null;
          meta_description?: string | null;
        }>;
      };
      sections?: Array<{
        section_key: string;
        settings: Record<string, unknown>;
        sort_order: number;
        translations: Array<{ locale: string; content: Record<string, unknown> }>;
      }>;
    };

    await this.prisma.$transaction(async (tx) => {
      // Wipe current sections — cascades remove their translations.
      await tx.pageSection.deleteMany({ where: { page_id: pageId } });

      // Recreate sections from the snapshot. Use fresh ids so the snapshot
      // itself remains immutable as a history record.
      if (snapshot.sections?.length) {
        for (const s of snapshot.sections) {
          await tx.pageSection.create({
            data: {
              page_id: pageId,
              section_key: s.section_key,
              settings: (s.settings as Prisma.InputJsonValue) ?? {},
              sort_order: s.sort_order,
              translations: {
                create: (s.translations || []).map((t) => ({
                  locale: t.locale,
                  content: t.content as Prisma.InputJsonValue,
                })),
              },
            },
          });
        }
      }

      // Restore page-level seo + translations too — they're part of the snapshot.
      if (snapshot.page) {
        await tx.page.update({
          where: { id: pageId },
          data: {
            seo: (snapshot.page.seo ?? {}) as Prisma.InputJsonValue,
            // Drop the live published pointer back to draft so the storefront
            // continues showing the previously published version until the
            // creator re-publishes this restored draft.
            status: 'DRAFT',
          },
        });
        if (snapshot.page.translations?.length) {
          for (const tr of snapshot.page.translations) {
            await tx.pageTranslation.upsert({
              where: { page_id_locale: { page_id: pageId, locale: tr.locale } },
              update: {
                title: tr.title,
                meta_title: tr.meta_title,
                meta_description: tr.meta_description,
              },
              create: {
                page_id: pageId,
                locale: tr.locale,
                title: tr.title,
                meta_title: tr.meta_title,
                meta_description: tr.meta_description,
              },
            });
          }
        }
      }
    });

    return this.getById(userId, pageId);
  }
}

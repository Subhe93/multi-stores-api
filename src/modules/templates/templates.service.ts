import { Injectable, NotFoundException } from '@nestjs/common';
import { PageType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { findKit, listKitSummaries } from './kits';
import type { Kit, KitPage } from './kits/types';
import { substituteAssets } from './kits/asset-substitution';
import { materialiseKitAssets } from './kit-assets';

const SINGLETON_TYPES: PageType[] = [
  PageType.HOME,
  PageType.HEADER,
  PageType.FOOTER,
  PageType.PRODUCT_TEMPLATE,
];

export interface ImportKitResult {
  kitId: string;
  pagesApplied: number;
  sectionsCreated: number;
  themeApplied: boolean;
  demoDataCreated: boolean;
}

@Injectable()
export class TemplatesService {
  constructor(private prisma: PrismaService) {}

  // ── Catalog ─────────────────────────────────────────────

  listKits() {
    return listKitSummaries();
  }

  getKit(id: string) {
    const kit = findKit(id);
    if (!kit) throw new NotFoundException('Template not found');
    return {
      id: kit.id,
      name: kit.name,
      description: kit.description,
      tags: kit.tags,
      previewImage: kit.previewImage,
      pageCount: kit.pages.length,
      hasDemoData: !!kit.demoData,
    };
  }

  // ── Import ──────────────────────────────────────────────

  /**
   * Apply a kit to the creator's store: set theme, then for each kit page
   * upsert the page and REPLACE its sections with the kit's (seeding per-locale
   * content for every configured store locale). Pages stay DRAFT so the creator
   * reviews before publishing. The replacement is intentional — the dashboard
   * shows a confirmation before calling this.
   */
  async importKit(userId: string, kitId: string, opts: { withDemoData?: boolean }): Promise<ImportKitResult> {
    const kit = findKit(kitId);
    if (!kit) throw new NotFoundException('Template not found');

    const storeId = await this.resolveCreatorStoreId(userId);
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      include: { language_config: true },
    });
    const primary = store?.language_config?.primary_locale || 'en';
    const secondary = store?.language_config?.secondary_locales || [];
    const locales = Array.from(new Set([primary, ...secondary]));

    // Copy the kit's bundled assets into the store's uploads (or generate
    // placeholders for any not yet shipped), producing the "@asset/<key>" → URL
    // map. Filesystem work — done before the DB transaction.
    const assetMap = materialiseKitAssets(kit, storeId);

    const result: ImportKitResult = {
      kitId: kit.id,
      pagesApplied: 0,
      sectionsCreated: 0,
      themeApplied: true,
      demoDataCreated: false,
    };

    await this.prisma.$transaction(async (tx) => {
      // 1. Theme styling (colors + typography).
      await tx.store.update({
        where: { id: storeId },
        data: {
          theme_key: kit.themeKey,
          theme_customizations: kit.themeCustomizations as Prisma.InputJsonValue,
        },
      });

      // 2. Pages + sections.
      const backupLabel = `Before import: ${kit.name.en ?? kit.id}`;
      for (const kitPage of kit.pages) {
        const existingId = await this.findExistingPageId(tx, storeId, kitPage);
        // Snapshot the current page before the destructive replace so the
        // creator can undo the import from the builder's History/restore.
        if (existingId) await this.snapshotPage(tx, existingId, backupLabel);
        const page = await this.upsertPage(tx, storeId, kitPage, existingId);
        await tx.pageSection.deleteMany({ where: { page_id: page.id } });

        let order = 0;
        for (const section of kitPage.sections) {
          const settings = substituteAssets(section.settings ?? {}, assetMap);
          const translations = locales.map((locale) => ({
            locale,
            content: substituteAssets(
              this.resolveContent(kit, section.content, locale),
              assetMap,
            ) as Prisma.InputJsonValue,
          }));
          await tx.pageSection.create({
            data: {
              page_id: page.id,
              section_key: section.section_key,
              sort_order: order++,
              settings: settings as Prisma.InputJsonValue,
              translations: { create: translations },
            },
          });
          result.sectionsCreated++;
        }
        result.pagesApplied++;
      }

      // 3. Optional demo data — create the kit's category + products so the
      //    product sections (collection-products points at the kit's category
      //    slug) look populated. Best-effort: needs a platform category to
      //    exist; the category alone is still created otherwise.
      if (opts.withDemoData && kit.demoData) {
        result.demoDataCreated = await this.createDemoData(tx, kit, storeId, assetMap, locales);
      }
    });

    return result;
  }

  /** Create the kit's demo creator-category and (if a platform category
   *  exists) a few demo products linked to it. Idempotent-ish: if the category
   *  already exists we assume demo data was seeded before and skip products to
   *  avoid duplicates. Returns whether anything was created. */
  private async createDemoData(
    tx: Prisma.TransactionClient,
    kit: Kit,
    storeId: string,
    assetMap: Record<string, string>,
    locales: string[],
  ): Promise<boolean> {
    const demo = kit.demoData;
    if (!demo) return false;

    const store = await tx.store.findUnique({ where: { id: storeId }, select: { creator_id: true } });
    if (!store) return false;
    const creatorId = store.creator_id;

    // Upsert the creator category by (creator_id, slug).
    const existingCat = await tx.creatorCategory.findUnique({
      where: { creator_id_slug: { creator_id: creatorId, slug: demo.category.slug } },
      select: { id: true },
    });
    if (existingCat) return true; // already seeded — don't duplicate products

    const category = await tx.creatorCategory.create({
      data: {
        creator_id: creatorId,
        slug: demo.category.slug,
        match_rule: 'MANUAL',
        match_tags: [],
        is_active: true,
        translations: { create: demo.category.translations.map((t) => ({ locale: t.locale, name: t.name })) },
      },
      select: { id: true },
    });

    // Products require a platform category (Category) — pick any active one.
    // Without one we can't create products, but the category above still helps.
    const platformCategory = await tx.category.findFirst({ where: { is_active: true }, select: { id: true } });
    if (!platformCategory) return true;

    let index = 0;
    for (const p of demo.products) {
      index += 1;
      const baseTitle = p.title.en || `product-${index}`;
      const slug =
        baseTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) +
        '-' + storeId.slice(0, 6);
      const imageUrls = (p.images || [])
        .map((ref) => substituteAssets(ref, assetMap))
        .filter((u): u is string => typeof u === 'string' && u.length > 0);

      await tx.product.create({
        data: {
          creator_id: creatorId,
          category_id: platformCategory.id,
          product_type: 'TRADITIONAL',
          base_price: p.base_price,
          compare_at_price: p.compare_at_price ?? null,
          status: 'PUBLISHED',
          translations: {
            create: locales.map((loc) => ({
              locale: loc,
              title: p.title[loc] ?? p.title[kit.fallbackLocale] ?? baseTitle,
              description: p.description?.[loc] ?? p.description?.[kit.fallbackLocale] ?? '',
              slug, // shared across locales (canonical) — unique per product
            })),
          },
          images: imageUrls.length
            ? { create: imageUrls.map((url, i) => ({ url, sort_order: i })) }
            : undefined,
          creator_categories: { create: [{ creator_category_id: category.id }] },
        },
      });
    }

    return true;
  }

  // ── Helpers ─────────────────────────────────────────────

  /** Resolve per-locale section content with the kit's fallback locale. */
  private resolveContent(
    kit: Kit,
    content: KitPage['sections'][number]['content'],
    locale: string,
  ): Record<string, unknown> {
    if (!content) return {};
    return content[locale] ?? content[kit.fallbackLocale] ?? {};
  }

  /** Resolve the matching page id (singleton by type, STATIC by kind, else by
   *  slug) without mutating anything. */
  private async findExistingPageId(
    tx: Prisma.TransactionClient,
    storeId: string,
    kitPage: KitPage,
  ): Promise<string | null> {
    let row: { id: string } | null;
    if (SINGLETON_TYPES.includes(kitPage.type)) {
      row = await tx.page.findFirst({ where: { store_id: storeId, type: kitPage.type }, select: { id: true } });
    } else if (kitPage.type === PageType.STATIC) {
      row = await tx.page.findFirst({
        where: { store_id: storeId, type: PageType.STATIC, static_kind: kitPage.static_kind ?? null },
        select: { id: true },
      });
    } else {
      row = await tx.page.findFirst({ where: { store_id: storeId, slug: kitPage.slug ?? null }, select: { id: true } });
    }
    return row?.id ?? null;
  }

  /** Capture the page's current sections + content + seo/translations as a
   *  PageVersion restore point (not published). No-op for empty pages. Shape
   *  mirrors PagesV2Service.publish so restoreVersion can rebuild from it. */
  private async snapshotPage(tx: Prisma.TransactionClient, pageId: string, label: string) {
    const page = await tx.page.findUnique({
      where: { id: pageId },
      include: {
        translations: true,
        sections: { include: { translations: true }, orderBy: { sort_order: 'asc' } },
      },
    });
    if (!page || page.sections.length === 0) return;

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

    await tx.pageVersion.create({
      data: { page_id: pageId, label, snapshot: snapshot as Prisma.InputJsonValue, published_at: null },
    });
  }

  /** Create the page if absent (by the pre-resolved id) and upsert its
   *  translations. */
  private async upsertPage(
    tx: Prisma.TransactionClient,
    storeId: string,
    kitPage: KitPage,
    existingId: string | null,
  ) {
    const page =
      (existingId ? { id: existingId } : null) ??
      (await tx.page.create({
        data: {
          store_id: storeId,
          type: kitPage.type,
          static_kind: kitPage.static_kind ?? null,
          slug: kitPage.slug ?? null,
          is_required: SINGLETON_TYPES.includes(kitPage.type),
        },
        select: { id: true },
      }));

    if (kitPage.translations?.length) {
      for (const tr of kitPage.translations) {
        await tx.pageTranslation.upsert({
          where: { page_id_locale: { page_id: page.id, locale: tr.locale } },
          update: { title: tr.title, meta_title: tr.meta_title, meta_description: tr.meta_description },
          create: {
            page_id: page.id,
            locale: tr.locale,
            title: tr.title,
            meta_title: tr.meta_title,
            meta_description: tr.meta_description,
          },
        });
      }
    }

    return page;
  }

  private async resolveCreatorStoreId(userId: string): Promise<string> {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    if (!creator) throw new NotFoundException('Creator not found');
    const store = await this.prisma.store.findUnique({
      where: { creator_id: creator.id },
      select: { id: true },
    });
    if (!store) throw new NotFoundException('Store not found');
    return store.id;
  }
}

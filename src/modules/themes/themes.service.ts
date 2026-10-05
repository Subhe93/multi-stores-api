import { Injectable, NotFoundException } from '@nestjs/common';
import { PageStatus, PageType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { PagesV2Service } from '../pages-v2/pages-v2.service';
import { stripBrandFromThemeConfig } from '../stores/theme-config';
import { findPreset, listPresetSummaries, toSummary } from './presets';
import type {
  ChromeSectionPreset,
  ThemePreset,
  ThemePresetSummary,
} from './presets/types';
import {
  emptyContentKeys,
  generateDefaultContent,
  planChromeSections,
  type GeneratorContext,
} from './apply-chrome';

export interface ApplyThemeChromeResult {
  page_id: string;
  created: boolean;
  sections_updated: number;
  sections_created: number;
  published: boolean;
}

export interface ApplyThemeResult {
  preset_id: string;
  theme_applied: true;
  header: ApplyThemeChromeResult;
  footer: ApplyThemeChromeResult;
  restore_points: number;
}

// Outcome of the in-transaction chrome work, before publishing.
interface ChromePageOutcome {
  page_id: string;
  created: boolean;
  was_published: boolean;
  sections_updated: number;
  sections_created: number;
  restore_point: boolean;
}

@Injectable()
export class ThemesService {
  constructor(
    private prisma: PrismaService,
    private readonly revalidation: RevalidationService,
    private readonly pagesV2: PagesV2Service,
  ) {}

  // ── Catalog ─────────────────────────────────────────────

  listPresets(): ThemePresetSummary[] {
    return listPresetSummaries();
  }

  getPreset(id: string): ThemePresetSummary {
    return toSummary(this.requirePreset(id));
  }

  private requirePreset(id: string): ThemePreset {
    const preset = findPreset(id);
    if (!preset)
      throw new NotFoundException({
        code: 'THEME_NOT_FOUND',
        message: 'Theme not found',
      });
    return preset;
  }

  // ── Apply ───────────────────────────────────────────────

  /**
   * Apply a look-only preset to the creator's store: theme tokens + the
   * layout settings of the HEADER / FOOTER chrome sections. Texts, nav links,
   * images and every other page (HOME, templates, STATIC) are left alone.
   * Existing chrome pages get a restore point first so the creator can undo
   * from the builder's history.
   */
  async apply(
    userId: string,
    presetId: string,
    publish = true,
  ): Promise<ApplyThemeResult> {
    const preset = this.requirePreset(presetId);
    const storeId = await this.resolveCreatorStoreId(userId);

    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { theme_config: true, language_config: true },
    });
    const primary = store?.language_config?.primary_locale || 'en';
    const secondary = store?.language_config?.secondary_locales || [];
    const locales = Array.from(new Set([primary, ...secondary]));

    const themeConfig = stripBrandFromThemeConfig(store?.theme_config);
    const generatorCtx: GeneratorContext = {
      socials: (themeConfig.socials as GeneratorContext['socials']) ?? null,
    };
    const restoreLabel = `Before theme: ${preset.name.en ?? preset.id}`;

    const outcomes = await this.prisma.$transaction(
      async (tx) => {
        // 1. Store look: base theme + tokens (tagged with the preset id so the
        //    dashboard can mark the current preset; the storefront's
        //    mergeTokens ignores unknown keys) + brand-stripped legacy config.
        await tx.store.update({
          where: { id: storeId },
          data: {
            theme_key: preset.base_theme_key,
            theme_customizations: {
              ...preset.theme_customizations,
              preset_id: preset.id,
            } as Prisma.InputJsonValue,
            theme_config: themeConfig as Prisma.InputJsonValue,
          },
        });

        // 2. Chrome pages.
        const header = await this.applyChromePage(
          tx,
          storeId,
          PageType.HEADER,
          preset.header,
          locales,
          generatorCtx,
          restoreLabel,
        );
        const footer = await this.applyChromePage(
          tx,
          storeId,
          PageType.FOOTER,
          preset.footer,
          locales,
          generatorCtx,
          restoreLabel,
        );
        return { header, footer };
      },
      { timeout: 20_000 },
    );

    // 3. Publish: pages that were live stay live with the new look; a page
    //    created here goes live too. DRAFT pages remain DRAFT for review.
    const publishLabel = `Theme: ${preset.name.en ?? preset.id}`;
    const header = await this.finishChromePage(
      userId,
      outcomes.header,
      publish,
      publishLabel,
    );
    const footer = await this.finishChromePage(
      userId,
      outcomes.footer,
      publish,
      publishLabel,
    );

    await this.revalidation.revalidateStoreById(storeId);

    return {
      preset_id: preset.id,
      theme_applied: true,
      header,
      footer,
      restore_points:
        (outcomes.header.restore_point ? 1 : 0) +
        (outcomes.footer.restore_point ? 1 : 0),
    };
  }

  /**
   * Create the chrome page with the preset's sections, or merge the preset's
   * settings into the existing page's sections (see planChromeSections).
   */
  private async applyChromePage(
    tx: Prisma.TransactionClient,
    storeId: string,
    type: typeof PageType.HEADER | typeof PageType.FOOTER,
    presetSections: ChromeSectionPreset[],
    locales: string[],
    ctx: GeneratorContext,
    restoreLabel: string,
  ): Promise<ChromePageOutcome> {
    const emptyKeys = emptyContentKeys(presetSections, ctx);

    // Per-locale generated content for a section we create.
    const translationsFor = (sectionKey: string) =>
      locales.map((locale) => ({
        locale,
        content: generateDefaultContent(sectionKey, locale, ctx)
          .content as Prisma.InputJsonValue,
      }));

    // Serialise with the lazy provisioning in pages-v2 — the unique index
    // doesn't fire for slugless singletons (static_kind is NULL).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${storeId}:${type}`}))`;

    const existing = await tx.page.findFirst({
      where: { store_id: storeId, type },
      orderBy: { created_at: 'asc' },
      select: {
        id: true,
        status: true,
        sections: {
          select: {
            id: true,
            section_key: true,
            settings: true,
            sort_order: true,
            is_hidden: true,
          },
          orderBy: { sort_order: 'asc' },
        },
      },
    });

    if (!existing) {
      const plan = planChromeSections([], presetSections, emptyKeys);
      const page = await tx.page.create({
        data: {
          store_id: storeId,
          type,
          slug: null,
          is_required: true,
          translations: {
            create: locales.map((locale) => ({
              locale,
              title: this.pagesV2.defaultPageTitle(type, locale),
            })),
          },
          sections: {
            create: plan.creates.map((c) => ({
              section_key: c.section_key,
              sort_order: c.sort_order,
              is_hidden: c.hidden,
              settings: c.settings as Prisma.InputJsonValue,
              translations: { create: translationsFor(c.section_key) },
            })),
          },
        },
        select: { id: true },
      });
      return {
        page_id: page.id,
        created: true,
        was_published: false,
        sections_updated: 0,
        sections_created: plan.creates.length,
        restore_point: false,
      };
    }

    // Restore point before touching anything (no-op for an empty page —
    // there is nothing to restore to).
    const restorePoint = await this.snapshotPage(tx, existing.id, restoreLabel);

    const plan = planChromeSections(
      existing.sections.map((s) => ({
        id: s.id,
        section_key: s.section_key,
        settings: (s.settings ?? {}) as Record<string, unknown>,
        sort_order: s.sort_order,
        is_hidden: s.is_hidden,
      })),
      presetSections,
      emptyKeys,
    );

    for (const u of plan.updates) {
      await tx.pageSection.update({
        where: { id: u.id },
        data: {
          settings: u.settings as Prisma.InputJsonValue,
          sort_order: u.sort_order,
          ...(u.is_hidden !== undefined ? { is_hidden: u.is_hidden } : {}),
        },
      });
    }
    for (const c of plan.creates) {
      await tx.pageSection.create({
        data: {
          page_id: existing.id,
          section_key: c.section_key,
          sort_order: c.sort_order,
          is_hidden: c.hidden,
          settings: c.settings as Prisma.InputJsonValue,
          translations: { create: translationsFor(c.section_key) },
        },
      });
    }
    for (const s of plan.untouchedSortOrders) {
      await tx.pageSection.update({
        where: { id: s.id },
        data: {
          sort_order: s.sort_order,
          ...(s.is_hidden !== undefined ? { is_hidden: s.is_hidden } : {}),
        },
      });
    }

    return {
      page_id: existing.id,
      created: false,
      was_published: existing.status === PageStatus.PUBLISHED,
      sections_updated: plan.updates.length,
      sections_created: plan.creates.length,
      restore_point: restorePoint,
    };
  }

  /** Publish when asked and appropriate, then shape the public result. */
  private async finishChromePage(
    userId: string,
    outcome: ChromePageOutcome,
    publish: boolean,
    label: string,
  ): Promise<ApplyThemeChromeResult> {
    const shouldPublish = publish && (outcome.created || outcome.was_published);
    if (shouldPublish) {
      await this.pagesV2.publish(userId, outcome.page_id, { label });
    }
    return {
      page_id: outcome.page_id,
      created: outcome.created,
      sections_updated: outcome.sections_updated,
      sections_created: outcome.sections_created,
      published: shouldPublish,
    };
  }

  /**
   * Capture the page's sections + content + seo/translations as a
   * PageVersion restore point (not published). Shape mirrors
   * PagesV2Service.publish so restoreVersion can rebuild from it. Returns
   * whether a version was written (false for a page without sections).
   */
  private async snapshotPage(
    tx: Prisma.TransactionClient,
    pageId: string,
    label: string,
  ): Promise<boolean> {
    const page = await tx.page.findUnique({
      where: { id: pageId },
      include: {
        translations: true,
        sections: {
          include: { translations: true },
          orderBy: { sort_order: 'asc' },
        },
      },
    });
    if (!page || page.sections.length === 0) return false;

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
        translations: s.translations.map((t) => ({
          locale: t.locale,
          content: t.content,
        })),
      })),
    };

    await tx.pageVersion.create({
      data: {
        page_id: pageId,
        label,
        snapshot: snapshot as Prisma.InputJsonValue,
        published_at: null,
      },
    });
    return true;
  }

  private async resolveCreatorStoreId(userId: string): Promise<string> {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    if (!creator)
      throw new NotFoundException({
        code: 'THEME_CREATOR_NOT_FOUND',
        message: 'Creator not found',
      });
    const store = await this.prisma.store.findUnique({
      where: { creator_id: creator.id },
      select: { id: true },
    });
    if (!store)
      throw new NotFoundException({
        code: 'THEME_STORE_NOT_FOUND',
        message: 'Store not found',
      });
    return store.id;
  }
}

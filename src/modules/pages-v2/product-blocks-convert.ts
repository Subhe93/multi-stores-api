/**
 * "Convert to blocks" for a PRODUCT_TEMPLATE (product layout wave 4, D2).
 *
 * Replaces the monolith `product-page` section with the Classic block tree
 * that looks like today's page:
 *
 *   layout-row (stacks on tablet)
 *     layout-column (sticky on desktop)  -> product-gallery
 *     layout-column                      -> breadcrumb, title, price, short
 *                                           description, promotions, bundles,
 *                                           variants, personalization, buy,
 *                                           trust, shipping (if shown)
 *   product-tabs (if shown)
 *
 * Safety rules:
 * - The monolith is only HIDDEN, never deleted, so the owner can go back.
 * - Nothing is published: the owner previews the draft, then publishes.
 * - Refused when a converted tree of that monolith already exists (marker
 *   `settings._converted_from` on the row), so a double click or a re-run can
 *   never stack two buy forms on one page. Deleting the converted row lets the
 *   owner convert again. Overlapping requests (two tabs, a retry after a
 *   timeout) are serialised by a guarded hide of the monolith: only the
 *   request that actually hides it builds the tree, the other gets a 409.
 * - Refused when the page already holds a visible add-to-cart composite or
 *   product blocks that keep their own state (variants / personalization /
 *   buy), since those must never be combined on one page.
 * - Everything is written in one transaction.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import {
  containersAllowedOnPage,
  orderSectionsAsTree,
  PRODUCT_LAYOUT_APP_KEY,
} from './section-tree';

export const PRODUCT_PAGE_SECTION_KEY = 'product-page';

/** Settings key on the converted row that points at the source monolith. */
export const CONVERTED_FROM_KEY = '_converted_from';

/**
 * Sections that must not share a page with a freshly converted tree: the
 * add-to-cart composite keeps its own options/quantity, and a second set of
 * variants / personalization / buy blocks would show two buy forms.
 */
export const CONVERT_CONFLICT_KEYS: readonly string[] = [
  'add-to-cart',
  'product-variants',
  'product-personalization',
  'product-buy',
];

/** The monolith's distance from the top when its gallery sticks (md:top-24). */
const GALLERY_STICKY_TOP_PX = 96;
/** The monolith's column gap on desktop (lg:gap-14). */
const ROW_GAP_PX = 56;
/** The monolith's spacing between the info blocks (gap-5). */
const INFO_COLUMN_GAP_PX = 20;

export class ConvertProductBlocksDto {
  // The product-page section to convert. Optional: absent = the first
  // visible root product-page of the page.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  section_id?: string;
}

// ── Pure planning (unit-testable) ────────────────────────────────────────

export interface MonolithSection {
  id: string;
  settings: Record<string, unknown> | null;
  translations: { locale: string; content: unknown }[];
}

/** One section to create; `ref`/`parentRef` are plan-local ids. */
export interface PlannedSection {
  ref: string;
  parentRef: string | null;
  section_key: string;
  settings: Record<string, unknown>;
  translations: { locale: string; content: Record<string, unknown> }[];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function pick<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * The Classic block tree for one monolith, in pre-order (parents before
 * children; siblings in display order). Settings map the monolith's options:
 * gallery_aspect -> gallery aspect, button_style -> buy + designer button,
 * trust_badges (per locale) -> product-trust, show_shipping / show_tabs ->
 * whether those blocks exist. The monolith's `_style` moves to the row; the
 * tabs keep its width and hide-on-device choices.
 *
 * `locales` are the locales the new sections get a translation row in: the
 * monolith's own locales (or the store's primary locale when it has none).
 */
export function planClassicProductTree(
  monolith: MonolithSection,
  locales: readonly string[],
): PlannedSection[] {
  const settings = asRecord(monolith.settings);
  const buttonStyle = pick(settings.button_style, ['solid', 'outline'] as const, 'solid');
  const galleryAspect = pick(
    settings.gallery_aspect,
    ['square', 'portrait', 'landscape'] as const,
    'square',
  );
  const showShipping = settings.show_shipping !== false;
  const showTabs = settings.show_tabs !== false;
  const style = asRecord(settings._style);
  const hasStyle = Object.keys(style).length > 0;

  const contentByLocale = new Map<string, Record<string, unknown>>();
  for (const t of monolith.translations) {
    contentByLocale.set(t.locale, asRecord(t.content));
  }
  const emptyTranslations = () => locales.map((locale) => ({ locale, content: {} }));

  const out: PlannedSection[] = [];
  const add = (
    ref: string,
    parentRef: string | null,
    section_key: string,
    s: Record<string, unknown>,
    translations = emptyTranslations(),
  ) => out.push({ ref, parentRef, section_key, settings: s, translations });

  add('row', null, 'layout-row', {
    gap_px: ROW_GAP_PX,
    align: 'stretch',
    child_width: 'fill',
    justify: 'start',
    wrap: false,
    stack_on: 'tablet',
    reverse_on_mobile: false,
    ...(hasStyle ? { _style: style } : {}),
    [CONVERTED_FROM_KEY]: monolith.id,
  });
  add('gallery-col', 'row', 'layout-column', {
    gap_px: 16,
    align: 'stretch',
    sticky_desktop: true,
    sticky_top_px: GALLERY_STICKY_TOP_PX,
    _layout: { span: { desktop: 1 } },
  });
  add('gallery', 'gallery-col', 'product-gallery', {
    layout: 'classic',
    aspect: galleryAspect,
    enable_zoom: true,
  });
  add('info-col', 'row', 'layout-column', {
    gap_px: INFO_COLUMN_GAP_PX,
    align: 'stretch',
    sticky_desktop: false,
    sticky_top_px: 24,
    _layout: { span: { desktop: 1 } },
  });
  add('breadcrumb', 'info-col', 'product-breadcrumb', { show_current: true });
  add('title', 'info-col', 'product-title', { show_collection: true, show_vendor: true });
  add('price', 'info-col', 'product-price', {
    show_compare_at: true,
    show_savings: true,
    show_unit_price: true,
    show_sku: true,
  });
  add('short-description', 'info-col', 'product-short-description', {});
  add('promotions', 'info-col', 'product-promotions', { show_end_date: true });
  add('bundles', 'info-col', 'product-bundles', {});
  // The personalization app's before-variants fields sit above the picker,
  // as in the monolith; the block renders nothing when a product has none.
  add('personalization-before', 'info-col', 'product-personalization', {
    placement: 'before_variants',
    show_heading: true,
    button_style: buttonStyle,
  });
  add('variants', 'info-col', 'product-variants', {});
  // Always present next to variants/buy: it holds the piece-one option and
  // the designer form.
  add('personalization', 'info-col', 'product-personalization', {
    placement: 'after_variants',
    show_heading: true,
    button_style: buttonStyle,
  });
  add('buy', 'info-col', 'product-buy', {
    button_style: buttonStyle,
    show_quantity: true,
    sticky_on_mobile: false,
  });
  add(
    'trust',
    'info-col',
    'product-trust',
    { columns: '2' },
    locales.map((locale) => {
      const badges = contentByLocale.get(locale)?.trust_badges;
      return {
        locale,
        content: Array.isArray(badges) ? { trust_badges: badges } : {},
      };
    }),
  );
  if (showShipping) {
    add('shipping', 'info-col', 'product-shipping', { show_heading: true });
  }
  if (showTabs) {
    const tabStyle: Record<string, unknown> = {};
    if (style.width !== undefined) tabStyle.width = style.width;
    if (style.hide_on !== undefined) tabStyle.hide_on = style.hide_on;
    add('tabs', null, 'product-tabs', {
      show_description: true,
      show_specifications: true,
      show_faqs: true,
      show_shipping: false,
      show_returns: false,
      ...(Object.keys(tabStyle).length > 0 ? { _style: tabStyle } : {}),
    });
  }
  return out;
}

// ── Service ──────────────────────────────────────────────────────────────

type SectionRow = {
  id: string;
  parent_id: string | null;
  section_key: string;
  settings: Prisma.JsonValue;
  sort_order: number;
  is_hidden: boolean;
  translations: { locale: string; content: Prisma.JsonValue }[];
};

@Injectable()
export class ProductBlocksConvertService {
  constructor(
    private readonly prisma: PrismaService,
    // Per-store `product_layout` app. Global module, always injected in the
    // app; when absent (positional tests) the flag reads as off.
    @Optional() private readonly storeApps?: StoreAppsService,
  ) {}

  /**
   * Whether the store's `product_layout` app is in effect. Fails closed like
   * PagesV2Service: an unknown app state or a missing StoreAppsService
   * counts as off, so this write path is gated like POST sections / PUT tree.
   */
  private async layoutBlocksEnabled(storeId: string): Promise<boolean> {
    if (!this.storeApps) return false;
    const on = await this.storeApps.enabledOrUnknown(
      storeId,
      PRODUCT_LAYOUT_APP_KEY,
    );
    return on === true;
  }

  private async resolveCreatorStoreId(userId: string): Promise<string> {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    if (!creator)
      throw new NotFoundException({
        code: 'PAGE_CREATOR_NOT_FOUND',
        message: 'Creator not found',
      });
    const store = await this.prisma.store.findUnique({
      where: { creator_id: creator.id },
      select: { id: true },
    });
    if (!store)
      throw new NotFoundException({
        code: 'PAGE_STORE_NOT_FOUND',
        message: 'Store not found',
      });
    return store.id;
  }

  /**
   * Converts the page's product-page section into the Classic block tree
   * (see the file header). Returns the page's full section list in tree
   * order. Draft only: the published version is untouched.
   */
  async convert(userId: string, pageId: string, dto: ConvertProductBlocksDto = {}) {
    const storeId = await this.resolveCreatorStoreId(userId);
    const page = await this.prisma.page.findUnique({
      where: { id: pageId },
      select: { id: true, store_id: true, type: true },
    });
    if (!page)
      throw new NotFoundException({ code: 'PAGE_NOT_FOUND', message: 'Page not found' });
    if (page.store_id !== storeId)
      throw new ForbiddenException({ code: 'PAGE_FORBIDDEN', message: 'Not your page' });
    if (page.type !== 'PRODUCT_TEMPLATE' || !containersAllowedOnPage(page.type))
      throw new BadRequestException({
        code: 'PRODUCT_BLOCKS_NOT_PRODUCT_TEMPLATE',
        message: 'Only the product template can be converted to blocks',
      });
    if (!(await this.layoutBlocksEnabled(storeId)))
      throw new ForbiddenException({
        code: 'PRODUCT_LAYOUT_DISABLED',
        message: 'Product blocks are not enabled for this store',
      });

    await this.prisma.$transaction(async (tx) => {
      const rows = (await tx.pageSection.findMany({
        where: { page_id: pageId },
        include: { translations: true },
        orderBy: { sort_order: 'asc' },
      })) as unknown as SectionRow[];
      const ordered = orderSectionsAsTree(rows);

      const hasConvertedTree = (monolithId: string) =>
        rows.some((r) => asRecord(r.settings)[CONVERTED_FROM_KEY] === monolithId);
      const isMonolith = (r: SectionRow) => r.section_key === PRODUCT_PAGE_SECTION_KEY;
      // An explicit section, else the first visible monolith, else the first
      // monolith that was already converted (reported as such below).
      const monolith = dto.section_id
        ? ordered.find((r) => r.id === dto.section_id && isMonolith(r))
        : (ordered.find((r) => isMonolith(r) && !r.is_hidden) ??
          ordered.find((r) => isMonolith(r) && hasConvertedTree(r.id)));
      if (!monolith)
        throw new BadRequestException({
          code: 'PRODUCT_PAGE_SECTION_NOT_FOUND',
          message: 'No visible product page section to convert',
        });
      if (hasConvertedTree(monolith.id))
        throw new ConflictException({
          code: 'PRODUCT_BLOCKS_ALREADY_CONVERTED',
          message: 'This product page was already converted to blocks',
        });
      if (monolith.is_hidden)
        throw new BadRequestException({
          code: 'PRODUCT_PAGE_SECTION_NOT_FOUND',
          message: 'No visible product page section to convert',
        });
      if (monolith.parent_id)
        throw new BadRequestException({
          code: 'PRODUCT_PAGE_SECTION_NESTED',
          message: 'Move the product page section to the top level first',
        });
      const visibleIds = new Set(
        ordered.filter((r) => !r.is_hidden).map((r) => r.id),
      );
      const conflict = rows.find(
        (r) => visibleIds.has(r.id) && CONVERT_CONFLICT_KEYS.includes(r.section_key),
      );
      if (conflict)
        throw new ConflictException({
          code: 'PRODUCT_BLOCKS_CONFLICT',
          message: `The page already has a visible ${conflict.section_key} section`,
          section_id: conflict.id,
        });

      // Locales: the monolith's own; a monolith without any gets the store's
      // primary content locale so every new section has its row.
      let locales = [...new Set(monolith.translations.map((t) => t.locale))];
      if (locales.length === 0) {
        const cfg = await tx.storeLanguageConfig.findFirst({
          where: { store_id: storeId },
          select: { primary_locale: true },
        });
        locales = [cfg?.primary_locale || 'en'];
      }
      const plan = planClassicProductTree(
        {
          id: monolith.id,
          settings: asRecord(monolith.settings),
          translations: monolith.translations,
        },
        locales,
      );

      // 1. Hide the monolith (never deleted), as a guarded claim: only the
      //    request that flips is_hidden false -> true may build the tree.
      //    Two overlapping requests both pass the checks above (each reads
      //    in its own READ COMMITTED snapshot); in Postgres the second one
      //    waits on the row lock, re-checks `is_hidden` and gets count 0.
      const claimed = await tx.pageSection.updateMany({
        where: { id: monolith.id, is_hidden: false },
        data: { is_hidden: true },
      });
      if (claimed.count !== 1)
        throw new ConflictException({
          code: 'PRODUCT_BLOCKS_ALREADY_CONVERTED',
          message: 'This product page was already converted to blocks',
        });

      // 2. Create the tree, parents first. Children get sibling-scoped
      //    orders; root entries are placed by the renumbering below.
      const idOf = new Map<string, string>();
      const nextChildIndex = new Map<string, number>();
      const newRootIds: string[] = [];
      for (const p of plan) {
        const parentId = p.parentRef ? (idOf.get(p.parentRef) ?? null) : null;
        let sortOrder = 0;
        if (p.parentRef) {
          sortOrder = nextChildIndex.get(p.parentRef) ?? 0;
          nextChildIndex.set(p.parentRef, sortOrder + 1);
        }
        const created = await tx.pageSection.create({
          data: {
            page_id: pageId,
            parent_id: parentId,
            section_key: p.section_key,
            settings: p.settings as Prisma.InputJsonValue,
            sort_order: sortOrder,
            translations: {
              create: p.translations.map((t) => ({
                locale: t.locale,
                content: t.content as Prisma.InputJsonValue,
              })),
            },
          },
          select: { id: true },
        });
        idOf.set(p.ref, created.id);
        if (!p.parentRef) newRootIds.push(created.id);
      }

      // 3. Root order: the new roots right after the (hidden) monolith.
      const roots = rows
        .filter((r) => (r.parent_id ?? null) === null)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((r) => r.id);
      roots.splice(roots.indexOf(monolith.id) + 1, 0, ...newRootIds);
      const oldOrder = new Map(rows.map((r) => [r.id, r.sort_order]));
      for (let i = 0; i < roots.length; i++) {
        if (oldOrder.get(roots[i]) === i) continue;
        await tx.pageSection.update({
          where: { id: roots[i] },
          data: { sort_order: i },
        });
      }
    });

    const after = await this.prisma.pageSection.findMany({
      where: { page_id: pageId },
      include: { translations: true },
      orderBy: { sort_order: 'asc' },
    });
    return orderSectionsAsTree(after);
  }
}

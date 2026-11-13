/**
 * "Convert to blocks" for a PRODUCT_TEMPLATE (product layout wave 4, D2).
 *
 * Replaces the monolith `product-page` section with the Classic block tree
 * that looks like today's page:
 *
 *   product-breadcrumb (full width, above both columns)
 *   layout-row (two columns from 768px, stacks on mobile)
 *     layout-column (sticky from 768px)  -> product-gallery
 *     layout-column                      -> title, price, short description,
 *                                           promotions, bundles, divider,
 *                                           variants, personalization,
 *                                           divider, buy,
 *                                           trust, shipping (if shown)
 *   product-tabs (if shown)
 *
 * Geometry = the monolith's (ProductPageMagic + ProductDetailClient): page
 * padding py-8 lg:py-10, breadcrumb mb-6 lg:mb-8, grid md:grid-cols-2 with
 * gap-8 lg:gap-14, gallery md:sticky md:top-24, info gap-5, tabs
 * mt-12 lg:mt-16. Section `_style` padding carries the vertical spacing
 * (its tablet breakpoint is < 1024px = below Tailwind's lg); the page
 * bottom sits on the row, so it stays when the storefront hides tabs that
 * render nothing. The monolith's own `_style` is split over the roots.
 *
 * Safety rules:
 * - The monolith is only HIDDEN, never deleted, so the owner can go back.
 * - Nothing is published: the owner previews the draft, then publishes.
 * - Refused when a converted tree of that monolith already exists (marker
 *   `settings._converted_from` on every root: breadcrumb, row, tabs), so a
 *   double click or a re-run can never stack two buy forms on one page.
 *   Deleting all of those roots lets the owner convert again (trees from
 *   before 2026-11-13 carry the marker on the row only and hold the
 *   breadcrumb inside it: delete the row and the root tabs that follow it).
 * - Refused when the monolith's `_style` holds something three separate
 *   roots cannot reproduce (radius, background image, animation).
 *   Overlapping requests (two tabs, a retry after a
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
import { SECTION_READ_ORDER } from './page-snapshot';
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
/** The monolith's gap below 1024px (gap-8): between columns, and once stacked. */
const ROW_GAP_TABLET_PX = 32;
/** The monolith's spacing between the info blocks (gap-5). */
const INFO_COLUMN_GAP_PX = 20;

/**
 * The monolith's thin info-column divider (`border-t border-gray-100`: a 1px
 * box whose top border is the line) as a `spacer` section: 1px tall with its
 * 1px rule centred, so it takes the same room and draws the same line at the
 * same spot. #f3f4f6 = Tailwind v4 gray-100. The column's gap puts 20px on
 * either side, like gap-5. Same settings as the dashboard's Classic preset.
 */
export const CLASSIC_DIVIDER_SETTINGS = {
  height_px: 1,
  show_divider: true,
  divider_style: 'solid',
  divider_color: '#f3f4f6',
};

/**
 * Vertical spacing of the monolith as section padding (desktop >= 1024px,
 * tablet = below 1024px, mobile inherits tablet). Same values as the
 * dashboard's Classic preset (multi-stores-dashboard/src/lib/productBlocksPreset.ts).
 */
// Page top (py-8 lg:py-10) + breadcrumb bottom margin (mb-6 lg:mb-8).
export const CLASSIC_BREADCRUMB_PADDING = {
  desktop: { top: 40, bottom: 32 },
  tablet: { top: 32, bottom: 24 },
};
// Page bottom (py-8 lg:py-10), always on the row: the storefront hides a root
// product block that renders nothing (tabs of a product without description,
// specifications or FAQs), and the page must then still end like the
// monolith's.
export const CLASSIC_ROW_PADDING = {
  desktop: { bottom: 40 },
  tablet: { bottom: 32 },
};
// Tabs top margin (mt-12 lg:mt-16) minus the row's page bottom above it, then
// the page bottom again: 40 + 24 = 64 and 32 + 16 = 48 between the columns and
// the tabs, like the monolith.
export const CLASSIC_TABS_PADDING = {
  desktop: { top: 24, bottom: 40 },
  tablet: { top: 16, bottom: 32 },
};

// ── Monolith `_style` ────────────────────────────────────────────────────
//
// The monolith's `_style` wraps the whole page (breadcrumb, columns, tabs),
// with py-8 lg:py-10 inside it. The Classic tree has three roots instead, so
// the style is split the way it rendered: top spacing on the breadcrumb,
// bottom spacing on the last root, left/right spacing and the copyable
// properties on every root. Spacing is added to the Classic padding per side
// and breakpoint (same cascade as the storefront's sectionStyle.ts).

type StyleBp = 'desktop' | 'tablet' | 'mobile';
type StyleSide = 'top' | 'right' | 'bottom' | 'left';
type SidesPx = Partial<Record<StyleSide, number>>;
type ResponsiveSidesPx = Partial<Record<StyleBp, SidesPx>>;

const STYLE_BPS: readonly StyleBp[] = ['desktop', 'tablet', 'mobile'];
const STYLE_SIDES: readonly StyleSide[] = ['top', 'right', 'bottom', 'left'];
/** Same token table as the storefront (sectionStyle.ts SPACE_PX). */
const SPACE_PX: Record<string, number> = { none: 0, xs: 8, sm: 16, md: 32, lg: 64, xl: 96 };

/** Properties copied unchanged to every root (they read the same on each). */
const COPIED_STYLE_KEYS = ['width', 'hide_on', 'text_color', 'background', 'background_color'] as const;
/** Spacing properties, split per side (see above). */
const SPACING_STYLE_KEYS = new Set([
  'padding',
  'margin',
  'padding_top',
  'padding_bottom',
  'margin_top',
  'margin_bottom',
]);
/** Background-image fields: inert unless `background` is 'image' (refused). */
const INERT_STYLE_KEYS = new Set([
  'background_image',
  'background_overlay_color',
  'background_overlay_opacity',
]);

/** One breakpoint's value of a responsive style value (bare = desktop), as the storefront reads it. */
function styleAt(value: unknown, bp: StyleBp): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) return (value as Record<string, unknown>)[bp];
  return bp === 'desktop' ? value : undefined;
}

function responsiveValues(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'object' && !Array.isArray(value)) return Object.values(value as Record<string, unknown>);
  return [value];
}

/**
 * `_style` keys of a monolith that the split cannot reproduce on three
 * separate roots: a corner radius or a background image would show three
 * times, an entrance animation would run three times, and unknown keys are
 * not guessed at. Empty = the style converts faithfully.
 */
export function unsupportedMonolithStyleKeys(style: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(style)) {
    if (value === undefined || value === null) continue;
    if (SPACING_STYLE_KEYS.has(key) || INERT_STYLE_KEYS.has(key)) continue;
    if (key === 'background') {
      if (responsiveValues(value).includes('image')) out.push(key);
      continue;
    }
    if ((COPIED_STYLE_KEYS as readonly string[]).includes(key)) continue;
    if (key === 'radius' && responsiveValues(value).every((v) => v === 'none' || v === undefined || v === null)) continue;
    if (key === 'animate' && (value === 'none' || value === '')) continue;
    out.push(key);
  }
  return out;
}

/** Pixel value of one side at one breakpoint as written (undefined = no rule). */
function ownSidePx(style: Record<string, unknown>, prop: 'padding' | 'margin', side: StyleSide, bp: StyleBp): number | undefined {
  const sides = styleAt(style[prop], bp);
  const v = sides && typeof sides === 'object' ? (sides as Record<string, unknown>)[side] : undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') return SPACE_PX[v] ?? 0;
  if (v !== undefined && v !== null) return undefined;
  // Legacy top/bottom tokens, read only when the new side is absent; a
  // desktop 'none' emits no rule (the storefront skips it).
  if (side !== 'top' && side !== 'bottom') return undefined;
  const token = styleAt(style[`${prop}_${side}`], bp);
  if (typeof token !== 'string') return undefined;
  if (bp === 'desktop' && token === 'none') return undefined;
  return SPACE_PX[token] ?? 0;
}

/** Effective pixels per breakpoint after the mobile -> tablet -> desktop cascade. */
function cascadePx(own: (bp: StyleBp) => number | undefined): Record<StyleBp, number | undefined> {
  const desktop = own('desktop');
  const tablet = own('tablet') ?? desktop;
  const mobile = own('mobile') ?? tablet;
  return { desktop, tablet, mobile };
}

/**
 * Responsive sides written back in the new `{ desktop, tablet, mobile }`
 * shape, emitting a breakpoint's side only where it differs from the wider
 * one (the cascade fills in the rest). Undefined when nothing is set.
 */
function sumSpacing(
  parts: Array<(side: StyleSide, bp: StyleBp) => number | undefined>,
): ResponsiveSidesPx | undefined {
  const out: ResponsiveSidesPx = {};
  for (const side of STYLE_SIDES) {
    const eff = parts.map((part) => cascadePx((bp) => part(side, bp)));
    let wider: number | undefined;
    for (const bp of STYLE_BPS) {
      const values = eff.map((e) => e[bp]).filter((v): v is number => v !== undefined);
      const total = values.length ? values.reduce((a, b) => a + b, 0) : undefined;
      if (total !== undefined && total !== wider) (out[bp] ??= {})[side] = total;
      wider = total;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** Reader for a fixed Classic padding constant. */
function classicPart(padding: ResponsiveSidesPx) {
  return (side: StyleSide, bp: StyleBp) => padding[bp]?.[side];
}

/** Reader for the owner's spacing, limited to the given sides. */
function ownerPart(style: Record<string, unknown>, prop: 'padding' | 'margin', sides: readonly StyleSide[]) {
  return (side: StyleSide, bp: StyleBp) => (sides.includes(side) ? ownSidePx(style, prop, side, bp) : undefined);
}

/**
 * `_style` of each Classic root for a monolith style: `classic` padding plus
 * the owner's spacing on `sides`, and the copyable properties.
 */
function rootStyle(
  owner: Record<string, unknown>,
  classic: ResponsiveSidesPx | null,
  sides: readonly StyleSide[],
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const key of COPIED_STYLE_KEYS) {
    if (owner[key] !== undefined && owner[key] !== null) out[key] = JSON.parse(JSON.stringify(owner[key])) as unknown;
  }
  const padding = sumSpacing([
    ...(classic ? [classicPart(classic)] : []),
    ownerPart(owner, 'padding', sides),
  ]);
  if (padding) out.padding = padding;
  const margin = sumSpacing([ownerPart(owner, 'margin', sides)]);
  if (margin) out.margin = margin;
  return Object.keys(out).length ? out : undefined;
}

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
 * whether those blocks exist. Each root gets the monolith's vertical spacing
 * as padding, and the monolith's own `_style` is split over the roots (see
 * rootStyle; the caller refuses styles unsupportedMonolithStyleKeys reports).
 * Owner bottom spacing sits on the tabs when they exist: a product whose
 * tabs render nothing then ends with the Classic page bottom only.
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

  const contentByLocale = new Map<string, Record<string, unknown>>();
  for (const t of monolith.translations) {
    contentByLocale.set(t.locale, asRecord(t.content));
  }
  const emptyTranslations = () => locales.map((locale) => ({ locale, content: {} }));

  // The monolith's own style, split over the three roots (see rootStyle):
  // its top spacing above the breadcrumb, its bottom spacing below the last
  // root, its left/right spacing and copyable properties on all of them.
  const lastIsTabs = showTabs;
  const breadcrumbStyle = rootStyle(style, CLASSIC_BREADCRUMB_PADDING, ['top', 'left', 'right']);
  const rowStyle = rootStyle(
    style,
    CLASSIC_ROW_PADDING,
    lastIsTabs ? ['left', 'right'] : ['bottom', 'left', 'right'],
  );
  const tabsStyle = rootStyle(style, CLASSIC_TABS_PADDING, ['bottom', 'left', 'right']);

  const out: PlannedSection[] = [];
  const add = (
    ref: string,
    parentRef: string | null,
    section_key: string,
    s: Record<string, unknown>,
    translations = emptyTranslations(),
  ) => out.push({ ref, parentRef, section_key, settings: s, translations });

  // Full width above both columns, like the monolith's breadcrumb.
  // Every root carries the marker, so a re-run is refused until all of them
  // are gone, and a cleanup can find each root of one conversion.
  add('breadcrumb', null, 'product-breadcrumb', {
    show_current: true,
    ...(breadcrumbStyle ? { _style: breadcrumbStyle } : {}),
    [CONVERTED_FROM_KEY]: monolith.id,
  });
  add('row', null, 'layout-row', {
    gap_px: ROW_GAP_PX,
    gap_tablet_px: ROW_GAP_TABLET_PX,
    align: 'stretch',
    child_width: 'fill',
    justify: 'start',
    wrap: false,
    // md:grid-cols-2: side by side from 768px, stacked below.
    stack_on: 'mobile',
    reverse_on_mobile: false,
    ...(rowStyle ? { _style: rowStyle } : {}),
    [CONVERTED_FROM_KEY]: monolith.id,
  });
  add('gallery-col', 'row', 'layout-column', {
    gap_px: 16,
    align: 'stretch',
    sticky_desktop: true,
    sticky_top_px: GALLERY_STICKY_TOP_PX,
    // md:sticky: sticks wherever the columns sit side by side.
    sticky_from: 'tablet',
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
    sticky_from: 'desktop',
    _layout: { span: { desktop: 1 } },
  });
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
  // The monolith's first divider: always shown, after promotions / bundles
  // (which render nothing when a product has none).
  add('divider-variants', 'info-col', 'spacer', { ...CLASSIC_DIVIDER_SETTINGS });
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
  // The monolith's second divider: always shown, above quantity + add to cart.
  add('divider-buy', 'info-col', 'spacer', { ...CLASSIC_DIVIDER_SETTINGS });
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
    add('tabs', null, 'product-tabs', {
      show_description: true,
      show_specifications: true,
      show_faqs: true,
      show_shipping: false,
      show_returns: false,
      ...(tabsStyle ? { _style: tabsStyle } : {}),
      [CONVERTED_FROM_KEY]: monolith.id,
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
      // Same read order as the builder list and the publish snapshot, so
      // `ordered` is the order the owner sees (ties included).
      const rows = (await tx.pageSection.findMany({
        where: { page_id: pageId },
        include: { translations: true },
        orderBy: SECTION_READ_ORDER,
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
          message:
            'This product page was already converted to blocks. Delete the converted sections (breadcrumb, row, tabs) to convert again',
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
      const unsupportedStyle = unsupportedMonolithStyleKeys(
        asRecord(asRecord(monolith.settings)._style),
      );
      if (unsupportedStyle.length > 0)
        throw new BadRequestException({
          code: 'PRODUCT_BLOCKS_STYLE_UNSUPPORTED',
          message: `The product page section's style cannot be split over blocks: ${unsupportedStyle.join(', ')}. Clear these style settings first`,
          keys: unsupportedStyle,
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

      // 3. Root order: the new roots right after the (hidden) monolith, in
      //    the roots' display order (`ordered`: canonical read order + tree
      //    walk, exactly as getById and the snapshot order them). Every root
      //    is renumbered 0..n-1, so tied or gapped orders from before cannot
      //    move a new root past an older one afterwards.
      const roots = ordered
        .filter((r) => (r.parent_id ?? null) === null)
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
      orderBy: SECTION_READ_ORDER,
    });
    return orderSectionsAsTree(after);
  }
}

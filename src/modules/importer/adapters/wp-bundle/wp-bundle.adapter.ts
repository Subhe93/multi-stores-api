import type {
  NAttribute,
  NAttributeTerm,
  NCategory,
  NIssue,
  NMediaRef,
  NormalizedCatalog,
  NProduct,
  NProductAttribute,
  NProductStatus,
  NShipping,
  NTag,
  NVariation,
  SourceCapabilities,
} from '../../model/normalized';
import {
  ExternalRefKind,
  normalizeSiteHost,
  refFactory,
} from '../../model/external-ref';
import { stripShortcodes } from '../../model/clean';
import type { BundleReader } from '../bundle-reader';
import {
  AdapterLoadContext,
  CATALOG_LIMITS,
  ImportAdapterError,
  ImportSourceView,
  SourceAdapter,
} from '../source-adapter';
import { MediaRefResolver } from './media-refs';
import { maybeUnserialize } from './php-unserialize';
import {
  decodeOption,
  loadWpTables,
  metaOf,
  MetaBag,
  WpPost,
  WpTables,
  WpTermTaxonomy,
} from './wp-tables';
import {
  buildAcfIndex,
  AcfIndex,
  detectAcfVideos,
  detectFaq,
  detectTermCard,
  isAcfReferenceKey,
} from './detectors/acf';
import { detectIwings, IWINGS_META_KEYS } from './detectors/iwings';
import {
  buildTemplates,
  detectNppProduct,
  nppDisplaySettings,
  nppTemplateId,
  NPP_PRODUCT_META_PREFIX,
} from './detectors/npp';
import { detectPpom, PPOM_META_KEYS } from './detectors/ppom';
import {
  detectSeo,
  primaryCategoryId,
  rankMathSettings,
  RANK_MATH_PRODUCT_KEYS,
} from './detectors/rank-math';
import {
  swatchType,
  termColor,
  termImageId,
  wvsSettings,
} from './detectors/wvs';
import { SHIPPING_METHOD_OPTION_RE } from './bundle-schema';
import { buildPages } from './pages';

/**
 * WordPress export bundle → NormalizedCatalog (M4.4 §5.1 `wp-bundle.adapter.ts`).
 * Pure apart from reading the bundle; no database, no network.
 */

const DEFAULT_BASES = {
  product: 'product',
  category: 'product-category',
  tag: 'product-tag',
};
const DEFAULT_UPLOADS_PATH = '/wp-content/uploads/';

/** Meta keys the adapter maps (everything else is "unmapped" unless ignored). */
const HANDLED_PRODUCT_META = new Set<string>([
  '_sku',
  '_price',
  '_regular_price',
  '_sale_price',
  '_sale_price_dates_from',
  '_sale_price_dates_to',
  '_tax_status',
  '_tax_class',
  '_manage_stock',
  '_stock',
  '_stock_status',
  '_weight',
  '_thumbnail_id',
  '_product_image_gallery',
  '_product_attributes',
  '_upsell_ids',
  '_wp_old_slug',
  'total_sales',
  ...IWINGS_META_KEYS,
  ...PPOM_META_KEYS,
  ...RANK_MATH_PRODUCT_KEYS,
]);

/** Known-ignore list (§5.1, §12.4 item 6): plugin sync data, Woo internals, editor locks. */
const IGNORED_META_PATTERNS: RegExp[] = [
  /^fb_/,
  /^_wc_gla_/,
  /^_wc_facebook_/,
  /^rank_math_analytic_/,
  /^rank_math_schema_/,
  /^rank_math_(seo_score|contentai_score|internal_links_processed|primary_(?!product_cat$))/,
  /^_edit_/,
  /^_wp_old_date$/,
  /^_(backorders|download_expiry|download_limit|downloadable|virtual|sold_individually|product_version|wc_average_rating|wc_review_count|wc_rating_count|last_change_time|low_stock_amount|default_attributes|children|product_url|button_text)$/,
  /^_wvs_product_attributes$/,
];

export const WP_BUNDLE_CAPABILITIES_V1: SourceCapabilities = {
  products: true,
  variations: true,
  categories: true,
  category_seo: true,
  category_order: true,
  swatches: true,
  variation_cards: true,
  personalization_flags: true,
  npp_templates: true,
  old_slugs: true,
  shipping: true,
  tax_settings: true,
  product_seo: true,
  original_images: true,
};

function int(v: string | null | undefined, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function num(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v.trim() === '') return null;
  const n = Number(v.trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function trimSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, '');
}

function unixToIso(v: string | null | undefined): string | undefined {
  const n = num(v);
  if (n === null || n <= 0) return undefined;
  return new Date(n * 1000).toISOString();
}

function parseVersionsTxt(text: string | null): { wp?: string; wc?: string } {
  if (!text) return {};
  const out: { wp?: string; wc?: string } = {};
  const wp = /wordpress\s*:\s*([0-9][\w.-]*)/i.exec(text);
  const wc = /woocommerce[^:\n]*:\s*([0-9][\w.-]*)/i.exec(text);
  if (wp) out.wp = wp[1];
  if (wc) out.wc = wc[1];
  return out;
}

const PRODUCT_STATUSES: readonly NProductStatus[] = [
  'publish',
  'draft',
  'private',
  'pending',
  'future',
];

interface Ctx {
  tables: WpTables;
  host: string;
  ref: (kind: ExternalRefKind, id: string | number) => string;
  media: MediaRefResolver;
  acf: AcfIndex;
  issues: NIssue[];
  collator: Intl.Collator;
  /** taxonomy → slug → raw term name */
  termNames: Map<string, Map<string, string>>;
  /** taxonomy → slug → rank in the attribute's term order */
  termRank: Map<string, Map<string, number>>;
  categoryIds: Set<number>;
}

// ---------------------------------------------------------------------------
// Taxonomies
// ---------------------------------------------------------------------------

function ttOfTaxonomy(tables: WpTables, taxonomy: string): WpTermTaxonomy[] {
  return [...tables.termTaxonomy.values()].filter(
    (t) => t.taxonomy === taxonomy,
  );
}

function buildCategories(ctx: Ctx): NCategory[] {
  const { tables, ref, collator } = ctx;
  const rows = ttOfTaxonomy(tables, 'product_cat');
  type Node = {
    tt: WpTermTaxonomy;
    cat: Omit<NCategory, 'depth' | 'path' | 'sibling_rank'>;
    children: Node[];
  };
  const nodes = new Map<number, Node>();
  for (const tt of rows) {
    const term = tables.terms.get(tt.term_id);
    if (!term) {
      ctx.issues.push({
        level: 'warn',
        code: 'W_TERM_MISSING',
        message: `product_cat term ${tt.term_id} has no terms row; skipped`,
      });
      continue;
    }
    const tm = metaOf(tables.termmeta, term.term_id);
    const ext = ref('product_cat', term.term_id);
    nodes.set(term.term_id, {
      tt,
      children: [],
      cat: {
        ext_id: ext,
        source_id: String(term.term_id),
        parent_ext_id: null,
        slug: term.slug,
        name: term.name,
        description_html: tt.description,
        order_key: [
          int(tm.first('order')),
          term.term_order,
          term.name,
          term.term_id,
        ],
        thumbnail: ctx.media.fromAttachment(tm.first('thumbnail_id'), {
          external_ref: ext,
        }),
        count: tt.count,
        seo: detectSeo(tm),
      },
    });
  }
  const roots: Node[] = [];
  for (const node of nodes.values()) {
    const parent = node.tt.parent > 0 ? nodes.get(node.tt.parent) : undefined;
    if (node.tt.parent > 0 && !parent) {
      ctx.issues.push({
        level: 'warn',
        code: 'W_CATEGORY_PARENT_MISSING',
        message: `Category ${node.cat.slug} has parent ${node.tt.parent} that is not in the bundle; imported as a root`,
        external_ref: node.cat.ext_id,
      });
    }
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const cmp = (a: Node, b: Node) => {
    const [ao, at, an, ai] = a.cat.order_key;
    const [bo, bt, bn, bi] = b.cat.order_key;
    return ao - bo || at - bt || collator.compare(an, bn) || ai - bi;
  };
  const out: NCategory[] = [];
  const visited = new Set<number>();
  const walk = (
    list: Node[],
    depth: number,
    path: string[],
    parentExt: string | null,
  ) => {
    list.sort(cmp).forEach((n, i) => {
      if (visited.has(n.cat.order_key[3])) return;
      visited.add(n.cat.order_key[3]);
      const p = [...path, n.cat.slug];
      out.push({
        ...n.cat,
        parent_ext_id: parentExt,
        depth,
        path: p,
        sibling_rank: i,
      });
      walk(n.children, depth + 1, p, n.cat.ext_id);
    });
  };
  walk(roots, 0, [], null);
  // Cycles leave unvisited nodes: import them as roots.
  const cyclic = [...nodes.values()].filter(
    (n) => !visited.has(n.cat.order_key[3]),
  );
  if (cyclic.length) {
    ctx.issues.push({
      level: 'warn',
      code: 'W_CATEGORY_CYCLE',
      message: `${cyclic.length} categories form a parent cycle; imported as roots`,
    });
    walk(cyclic, 0, [], null);
  }
  return out;
}

function sortTerms(
  terms: (NAttributeTerm & { term_id: number })[],
  orderby: string,
  collator: Intl.Collator,
) {
  const byName = (a: NAttributeTerm, b: NAttributeTerm) =>
    collator.compare(a.name, b.name);
  return terms.sort((a, b) => {
    switch (orderby) {
      case 'name':
        return byName(a, b) || a.term_id - b.term_id;
      case 'name_num': {
        const na = Number.parseFloat(a.name);
        const nb = Number.parseFloat(b.name);
        return (
          (Number.isFinite(na) && Number.isFinite(nb) ? na - nb : 0) ||
          byName(a, b) ||
          a.term_id - b.term_id
        );
      }
      case 'id':
        return a.term_id - b.term_id;
      default: // menu_order
        return a.order - b.order || a.term_id - b.term_id;
    }
  });
}

function buildAttributes(ctx: Ctx): NAttribute[] {
  const { tables, ref, collator } = ctx;
  const known = new Map(
    tables.attributeTaxonomies.map((a) => [`pa_${a.name}`, a]),
  );
  const taxonomies = new Set<string>(known.keys());
  for (const tt of tables.termTaxonomy.values()) {
    if (tt.taxonomy.startsWith('pa_') && !taxonomies.has(tt.taxonomy)) {
      taxonomies.add(tt.taxonomy);
      ctx.issues.push({
        level: 'warn',
        code: 'W_ATTRIBUTE_TAXONOMY_UNKNOWN',
        message: `Terms exist for ${tt.taxonomy} but the attribute is not in attribute_taxonomies`,
      });
    }
  }
  const out: NAttribute[] = [];
  for (const taxonomy of taxonomies) {
    const def = known.get(taxonomy);
    const terms: (NAttributeTerm & { term_id: number })[] = [];
    for (const tt of ttOfTaxonomy(tables, taxonomy)) {
      const term = tables.terms.get(tt.term_id);
      if (!term) continue;
      const tm = metaOf(tables.termmeta, term.term_id);
      const ext = ref('term', term.term_id);
      const t: NAttributeTerm & { term_id: number } = {
        term_id: term.term_id,
        ext_id: ext,
        slug: term.slug,
        name: term.name,
        order: int(tm.first('order')),
      };
      const color = termColor(tm);
      if (color) t.color = color;
      const imageId = termImageId(tm);
      if (imageId) {
        const img = ctx.media.fromAttachment(imageId, { external_ref: ext });
        if (img) t.image = img;
      }
      const card = detectTermCard(tm);
      if (card) t.card = card;
      terms.push(t);
    }
    const orderby = def?.orderby ?? 'menu_order';
    sortTerms(terms, orderby, collator);
    const names = new Map<string, string>();
    const rank = new Map<string, number>();
    const cleanTerms: NAttributeTerm[] = terms.map(
      ({ term_id: _id, ...t }, i) => {
        names.set(t.slug, t.name);
        rank.set(t.slug, i);
        return t;
      },
    );
    ctx.termNames.set(taxonomy, names);
    ctx.termRank.set(taxonomy, rank);
    out.push({
      ext_id: ref(
        'attribute',
        def ? def.id : taxonomy.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64),
      ),
      taxonomy,
      label: def?.label || taxonomy,
      swatch_type: def ? swatchType(def.type) : null,
      terms: cleanTerms,
      orderby,
    });
  }
  return out.sort((a, b) => a.taxonomy.localeCompare(b.taxonomy));
}

function buildTags(ctx: Ctx): NTag[] {
  return ttOfTaxonomy(ctx.tables, 'product_tag')
    .map((tt) => {
      const term = ctx.tables.terms.get(tt.term_id);
      if (!term) return null;
      return {
        ext_id: ctx.ref('product_tag', term.term_id),
        source_id: String(term.term_id),
        slug: term.slug,
        name: term.name,
        description_html: tt.description,
        count: tt.count,
      } satisfies NTag;
    })
    .filter((t): t is NTag => t !== null)
    .sort((a, b) => Number(a.source_id) - Number(b.source_id));
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

interface RawProductAttribute {
  name?: unknown;
  value?: unknown;
  position?: unknown;
  is_visible?: unknown;
  is_variation?: unknown;
  is_taxonomy?: unknown;
}

function productTerms(
  ctx: Ctx,
  objectId: number,
): Map<string, { term_id: number; slug: string; order: number }[]> {
  const out = new Map<
    string,
    { term_id: number; slug: string; order: number }[]
  >();
  for (const rel of ctx.tables.relationships.get(objectId) ?? []) {
    const tt = ctx.tables.termTaxonomy.get(rel.tt_id);
    if (!tt) continue;
    const term = ctx.tables.terms.get(tt.term_id);
    if (!term) continue;
    const list = out.get(tt.taxonomy) ?? [];
    list.push({
      term_id: term.term_id,
      slug: term.slug,
      order: rel.term_order,
    });
    out.set(tt.taxonomy, list);
  }
  return out;
}

function boolish(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'yes';
}

function buildProductAttributes(
  ctx: Ctx,
  meta: MetaBag,
  terms: Map<string, { term_id: number; slug: string; order: number }[]>,
  ext: string,
  attributesByTaxonomy: Map<string, NAttribute>,
): NProductAttribute[] {
  const raw = meta.first('_product_attributes');
  if (!raw) return [];
  const parsed = maybeUnserialize(raw);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
    ctx.issues.push({
      level: 'warn',
      code: 'W_PRODUCT_ATTRIBUTES_UNREADABLE',
      message: '_product_attributes could not be read',
      external_ref: ext,
    });
    return [];
  }
  // Source order only breaks `position` ties; JS key order is fine for that.
  const v = parsed.value as unknown;
  const entries: [string, RawProductAttribute][] = Array.isArray(v)
    ? v.map((x, i) => {
        const a = x as RawProductAttribute;
        return [typeof a?.name === 'string' ? a.name : String(i), a];
      })
    : Object.entries(v as Record<string, RawProductAttribute>);
  const out: NProductAttribute[] = [];
  for (const [key, a] of entries) {
    if (!a || typeof a !== 'object') continue;
    const isTax = boolish(a.is_taxonomy);
    const name = typeof a.name === 'string' && a.name ? a.name : key;
    let values: string[];
    let label: string;
    if (isTax) {
      const rank = ctx.termRank.get(name) ?? new Map<string, number>();
      values = (terms.get(name) ?? [])
        .map((t) => t.slug)
        .sort(
          (x, y) =>
            (rank.get(x) ?? Number.MAX_SAFE_INTEGER) -
            (rank.get(y) ?? Number.MAX_SAFE_INTEGER),
        );
      label = attributesByTaxonomy.get(name)?.label ?? name;
    } else {
      values = (typeof a.value === 'string' ? a.value : '')
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);
      label = name;
    }
    out.push({
      key: isTax ? name : key,
      label,
      position:
        typeof a.position === 'number'
          ? a.position
          : int(typeof a.position === 'string' ? a.position : '0'),
      visible: boolish(a.is_visible),
      variation: boolish(a.is_variation),
      values,
      is_taxonomy: isTax,
    });
  }
  return out.sort((x, y) => x.position - y.position);
}

function stockOf(meta: MetaBag): NProduct['stock'] {
  return {
    manage: (meta.first('_manage_stock') ?? '') === 'yes',
    qty: num(meta.first('_stock')),
    status: meta.first('_stock_status') ?? 'instock',
  };
}

function buildVariations(
  ctx: Ctx,
  product: WpPost,
  children: WpPost[],
  attrs: NProductAttribute[],
): NVariation[] {
  const varAttrs = attrs.filter((a) => a.variation);
  return children
    .map((p) => {
      const meta = metaOf(ctx.tables.postmeta, p.id);
      const ext = ctx.ref('variation', p.id);
      const vattrs: Record<string, string | null> = {};
      for (const a of varAttrs) {
        const val = meta.first(`attribute_${a.key}`);
        vattrs[a.key] =
          val === undefined || val === null || val === '' ? null : val;
      }
      const thumb = int(meta.first('_thumbnail_id'));
      const price: NVariation['price'] = {
        regular: num(meta.first('_regular_price')),
        sale: num(meta.first('_sale_price')),
        current: num(meta.first('_price')),
      };
      // Sale window of the variation (same keys as on a simple product).
      const saleFrom = unixToIso(meta.first('_sale_price_dates_from'));
      const saleTo = unixToIso(meta.first('_sale_price_dates_to'));
      if (saleFrom) price.sale_from = saleFrom;
      if (saleTo) price.sale_to = saleTo;
      const v: NVariation = {
        ext_id: ext,
        source_id: String(p.id),
        status: p.status,
        menu_order: p.menu_order,
        attrs: vattrs,
        price,
        sku: meta.str('_sku'),
        stock: stockOf(meta),
      };
      if (thumb > 0)
        v.image = ctx.media.fromAttachment(thumb, { external_ref: ext });
      return v;
    })
    .sort(
      (a, b) =>
        a.menu_order - b.menu_order ||
        Number(a.source_id) - Number(b.source_id),
    );
}

function unmappedMetaKeys(meta: MetaBag, consumedAcf: Set<string>): string[] {
  const out: string[] = [];
  for (const key of meta.keys()) {
    if (
      HANDLED_PRODUCT_META.has(key) ||
      key.startsWith(NPP_PRODUCT_META_PREFIX)
    )
      continue;
    if (consumedAcf.has(key)) continue;
    if (IGNORED_META_PATTERNS.some((re) => re.test(key))) continue;
    if (isAcfReferenceKey(meta, key)) continue;
    const values = meta.all(key);
    if (
      values.every(
        (v) => v === null || v.trim() === '' || v === '0' || v === 'a:0:{}',
      )
    )
      continue;
    out.push(key);
  }
  return out.sort();
}

function buildProducts(
  ctx: Ctx,
  attributes: NAttribute[],
): { products: NProduct[]; linkedTemplates: Map<number, string[]> } {
  const { tables, ref } = ctx;
  const attributesByTaxonomy = new Map(attributes.map((a) => [a.taxonomy, a]));
  const childrenOf = new Map<number, WpPost[]>();
  for (const p of tables.posts.values()) {
    if (p.type !== 'product_variation') continue;
    const list = childrenOf.get(p.parent) ?? [];
    list.push(p);
    childrenOf.set(p.parent, list);
  }
  const productPosts = [...tables.posts.values()]
    .filter((p) => p.type === 'product')
    .sort((a, b) => a.id - b.id);
  const productIds = new Set(productPosts.map((p) => p.id));
  for (const [parent, list] of childrenOf) {
    if (!productIds.has(parent)) {
      ctx.issues.push({
        level: 'warn',
        code: 'W_VARIATION_ORPHAN',
        message: `${list.length} variations of missing product ${parent} were skipped`,
      });
    }
  }
  const consumedAcf = new Set<string>(['hint_1', 'hint_2', 'hint_3']);
  for (const f of ctx.acf.productFields) {
    if (f.type === 'wysiwyg' || f.type === 'repeater' || /video/i.test(f.name))
      consumedAcf.add(f.name);
  }
  const linkedTemplates = new Map<number, string[]>();
  const products: NProduct[] = [];

  for (const post of productPosts) {
    const ext = ref('product', post.id);
    if (!(PRODUCT_STATUSES as readonly string[]).includes(post.status)) {
      ctx.issues.push({
        level: 'warn',
        code: 'W_PRODUCT_STATUS_UNSUPPORTED',
        message: `Product ${post.id} has status "${post.status}"; skipped`,
        external_ref: ext,
      });
      continue;
    }
    const meta = metaOf(tables.postmeta, post.id);
    const terms = productTerms(ctx, post.id);
    const typeSlug = terms.get('product_type')?.[0]?.slug ?? '';
    const children = childrenOf.get(post.id) ?? [];
    const sourceType = typeSlug || (children.length ? 'variable' : 'simple');
    if (!typeSlug) {
      ctx.issues.push({
        level: 'info',
        code: 'W_PRODUCT_TYPE_INFERRED',
        message: `Product ${post.id} has no product_type term; inferred "${sourceType}"`,
        external_ref: ext,
      });
    }
    const type: NProduct['type'] =
      sourceType === 'simple' || sourceType === 'variable'
        ? sourceType
        : 'other';

    const attrs = buildProductAttributes(
      ctx,
      meta,
      terms,
      ext,
      attributesByTaxonomy,
    );
    const variations =
      type === 'variable' ? buildVariations(ctx, post, children, attrs) : [];
    if (type !== 'variable' && children.length) {
      ctx.issues.push({
        level: 'warn',
        code: 'W_VARIATION_ON_NON_VARIABLE',
        message: `${children.length} variations ignored on ${sourceType} product ${post.id}`,
        external_ref: ext,
      });
    }

    let price: NProduct['price'];
    if (type === 'variable') {
      const prices = meta
        .all('_price')
        .map((v) => num(v))
        .concat(variations.map((v) => v.price.current))
        .filter((n): n is number => n !== null);
      price = {
        regular: null,
        sale: null,
        current: prices.length ? Math.min(...prices) : null,
      };
    } else {
      price = {
        regular: num(meta.first('_regular_price')),
        sale: num(meta.first('_sale_price')),
        current: num(meta.first('_price')),
      };
      const from = unixToIso(meta.first('_sale_price_dates_from'));
      const to = unixToIso(meta.first('_sale_price_dates_to'));
      if (from) price.sale_from = from;
      if (to) price.sale_to = to;
    }

    // Images: featured first, then the gallery; one row per attachment.
    const imageIds: number[] = [];
    const thumb = int(meta.first('_thumbnail_id'));
    if (thumb > 0) imageIds.push(thumb);
    for (const part of (meta.first('_product_image_gallery') ?? '').split(
      ',',
    )) {
      const id = int(part.trim());
      if (id > 0 && !imageIds.includes(id)) imageIds.push(id);
    }
    const images = imageIds
      .map((id) => ctx.media.fromAttachment(id, { external_ref: ext }))
      .filter((m): m is NMediaRef => m !== null);

    const catTerms = (terms.get('product_cat') ?? []).filter((t) =>
      ctx.categoryIds.has(t.term_id),
    );
    const category_ext_ids = catTerms.map((t) => ref('product_cat', t.term_id));
    const primaryId = primaryCategoryId(meta);
    const primary_category_ext_id =
      primaryId && ctx.categoryIds.has(primaryId)
        ? ref('product_cat', primaryId)
        : null;
    const tag_ext_ids = (terms.get('product_tag') ?? []).map((t) =>
      ref('product_tag', t.term_id),
    );
    const shipping_class_slug =
      terms.get('product_shipping_class')?.[0]?.slug ?? null;

    const upsellRaw = meta.first('_upsell_ids');
    const upsellParsed = upsellRaw ? maybeUnserialize(upsellRaw) : null;
    const upsellList =
      upsellParsed?.ok &&
      upsellParsed.value &&
      typeof upsellParsed.value === 'object'
        ? Object.values(upsellParsed.value as object)
        : [];
    const upsell_ext_ids = upsellList
      .map((x) => int(String(x)))
      .filter((n) => n > 0)
      .map((n) => ref('product', n));

    const seoAll = detectSeo(meta);
    const seo: NProduct['seo'] = {};
    if (seoAll.title !== undefined) seo.title = seoAll.title;
    if (seoAll.description !== undefined) seo.description = seoAll.description;
    if (seoAll.focus_keyword !== undefined)
      seo.focus_keyword = seoAll.focus_keyword;
    if (seoAll.robots) seo.robots = seoAll.robots;

    const videos = [
      ...detectAcfVideos(meta, ctx.acf),
      ...stripShortcodes(post.content).videos,
      ...stripShortcodes(post.excerpt).videos,
    ];

    const termName = (taxonomy: string, slug: string) =>
      ctx.termNames.get(taxonomy)?.get(slug);
    const personalization = [
      ...detectIwings(meta, attrs, termName),
      ...detectPpom(meta, tables.ppom),
    ];
    const designer = detectNppProduct(meta, tables, ref);
    if (designer?.enabled) {
      const tid = nppTemplateId(meta);
      const list = linkedTemplates.get(tid) ?? [];
      list.push(ext);
      linkedTemplates.set(tid, list);
    } else if (
      designer &&
      designer.template_ext_id &&
      !tables.posts.has(nppTemplateId(meta))
    ) {
      ctx.issues.push({
        level: 'warn',
        code: 'W_TEMPLATE_MISSING',
        message: `Product ${post.id} links NPP template ${nppTemplateId(meta)} that is not in the bundle`,
        external_ref: ext,
      });
    }

    const old = meta
      .all('_wp_old_slug')
      .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
      .filter((s, i, arr) => arr.indexOf(s) === i);

    const taxStatus = meta.first('_tax_status');
    products.push({
      ext_id: ext,
      source_id: String(post.id),
      type,
      source_type: sourceType,
      status: post.status as NProductStatus,
      slug: post.name,
      old_slugs: old,
      title: post.title,
      content_html: post.content,
      excerpt_html: post.excerpt,
      sku: meta.str('_sku'),
      price,
      tax: {
        status:
          taxStatus === 'shipping' || taxStatus === 'none'
            ? taxStatus
            : 'taxable',
        class: meta.first('_tax_class') ?? '',
      },
      stock: stockOf(meta),
      weight: num(meta.first('_weight')),
      images,
      category_ext_ids,
      primary_category_ext_id,
      tag_ext_ids,
      shipping_class_slug,
      menu_order: post.menu_order,
      upsell_ext_ids,
      attributes: attrs,
      variations,
      seo,
      extras: { faq: detectFaq(meta, ctx.acf), videos: [...new Set(videos)] },
      personalization,
      designer,
      total_sales: int(meta.first('total_sales')),
      unmapped_meta_keys: unmappedMetaKeys(meta, consumedAcf),
    });
  }
  return { products, linkedTemplates };
}

// ---------------------------------------------------------------------------
// Shipping (bundle v1, task 4.4.1)
// ---------------------------------------------------------------------------

function buildShipping(ctx: Ctx): NShipping {
  const { tables, ref } = ctx;
  const classes = ttOfTaxonomy(tables, 'product_shipping_class')
    .map((tt) => tables.terms.get(tt.term_id))
    .filter((t): t is NonNullable<typeof t> => !!t)
    .map((t) => ({
      ext_id: ref('shipping_class', t.term_id),
      slug: t.slug,
      name: t.name,
    }));
  if (!tables.shipping) {
    ctx.issues.push({
      level: 'warn',
      code: 'W_SHIPPING_NOT_IN_BUNDLE',
      message:
        'The bundle has no shipping tables; the shipping phase will be skipped',
    });
    return { classes, zones: [], zones_available: false };
  }
  const settingsFor = (
    methodId: string,
    instanceId: number,
  ): Record<string, unknown> => {
    for (const [name, raw] of tables.options) {
      const m = SHIPPING_METHOD_OPTION_RE.exec(name);
      if (
        !m ||
        m[1] !== methodId ||
        Number(m[2]) !== instanceId ||
        raw === null
      )
        continue;
      const v = maybeUnserialize(raw);
      if (
        v.ok &&
        v.value &&
        typeof v.value === 'object' &&
        !Array.isArray(v.value)
      )
        return v.value as Record<string, unknown>;
    }
    return {};
  };
  const zoneRows = [...tables.shipping.zones];
  if (
    tables.shipping.methods.some((m) => m.zone_id === 0) &&
    !zoneRows.some((z) => z.zone_id === 0)
  ) {
    // WooCommerce's "Locations not covered by your other zones" has no zones row.
    zoneRows.push({
      zone_id: 0,
      zone_name: 'Locations not covered by your other zones',
      zone_order: Number.MAX_SAFE_INTEGER,
    });
  }
  const zones = zoneRows
    .sort((a, b) => a.zone_order - b.zone_order || a.zone_id - b.zone_id)
    .map((z) => ({
      ext_id: ref('shipping_zone', z.zone_id),
      name: z.zone_name,
      order: z.zone_order,
      locations: tables
        .shipping!.locations.filter((l) => l.zone_id === z.zone_id)
        .map((l) => {
          const type = (
            ['country', 'state', 'postcode', 'continent'] as const
          ).find((t) => t === l.type);
          if (!type) {
            ctx.issues.push({
              level: 'warn',
              code: 'W_SHIPPING_LOCATION_UNSUPPORTED',
              message: `Zone ${z.zone_id}: location type "${l.type}"`,
            });
          }
          return { type: type ?? 'postcode', code: l.code };
        }),
      methods: tables
        .shipping!.methods.filter((m) => m.zone_id === z.zone_id)
        .sort((a, b) => a.method_order - b.method_order)
        .map((m) => ({
          instance_id: String(m.instance_id),
          method_id: m.method_id,
          enabled: m.is_enabled,
          order: m.method_order,
          settings: settingsFor(m.method_id, m.instance_id),
        })),
    }));
  return { classes, zones, zones_available: true };
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface BuildCatalogExtras {
  /** Contents of a legacy `versions.txt`, when present. */
  versionsText?: string | null;
}

export function buildCatalogFromTables(
  tables: WpTables,
  source: ImportSourceView,
  extras: BuildCatalogExtras = {},
): NormalizedCatalog {
  const host = normalizeSiteHost(source.site_host);
  const aliases = (source.host_aliases ?? [])
    .map((h) => normalizeSiteHost(h))
    .filter((h) => h !== host);
  const ref = refFactory(host);
  const issues: NIssue[] = [...tables.issues];
  const settings = source.settings ?? {};

  if (tables.manifest?.site_url) {
    try {
      const mHost = normalizeSiteHost(
        new URL(tables.manifest.site_url).hostname,
      );
      if (mHost !== host && !aliases.includes(mHost)) {
        issues.push({
          level: 'warn',
          code: 'W_SITE_HOST_MISMATCH',
          message: `Bundle site ${mHost} differs from the source host ${host}`,
        });
      }
    } catch {
      /* ignore malformed site_url */
    }
  }

  const uploadsPath = settings.uploads_path ?? DEFAULT_UPLOADS_PATH;
  const uploads_base = `https://${host}/${trimSlashes(uploadsPath)}/`;
  const locale =
    tables.manifest?.locale ??
    (tables.options.get('WPLANG') || null) ??
    settings.locale ??
    null;
  const resolvedLocale = locale || settings.locale || null;
  let collatorLocale = 'en';
  try {
    collatorLocale =
      Intl.Collator.supportedLocalesOf([
        (resolvedLocale ?? 'en').replace('_', '-'),
      ])[0] ?? 'en';
  } catch {
    collatorLocale = 'en';
  }

  const permalinks = decodeOption(tables, 'woocommerce_permalinks') as
    | Record<string, unknown>
    | undefined;
  const pick = (k: string): string | undefined => {
    const v = permalinks?.[k];
    return typeof v === 'string' && v.trim() ? trimSlashes(v) : undefined;
  };
  const bases = {
    product:
      pick('product_base') ??
      (settings.product_base
        ? trimSlashes(settings.product_base)
        : DEFAULT_BASES.product),
    category:
      pick('category_base') ??
      (settings.category_base
        ? trimSlashes(settings.category_base)
        : DEFAULT_BASES.category),
    tag:
      pick('tag_base') ??
      (settings.tag_base ? trimSlashes(settings.tag_base) : DEFAULT_BASES.tag),
  };

  const currencyOpt = tables.options.get('woocommerce_currency');
  const pit = tables.options.get('woocommerce_prices_include_tax');

  const ctx: Ctx = {
    tables,
    host,
    ref,
    media: new MediaRefResolver(
      tables,
      host,
      aliases,
      uploads_base,
      ref,
      issues,
    ),
    acf: buildAcfIndex(tables),
    issues,
    collator: new Intl.Collator(collatorLocale),
    termNames: new Map(),
    termRank: new Map(),
    categoryIds: new Set(
      ttOfTaxonomy(tables, 'product_cat').map((t) => t.term_id),
    ),
  };

  const categories = buildCategories(ctx);
  const attributes = buildAttributes(ctx);
  const tags = buildTags(ctx);
  const { products, linkedTemplates } = buildProducts(ctx, attributes);
  const templates = buildTemplates(
    tables,
    ctx.media,
    ref,
    linkedTemplates,
    issues,
  );
  const shipping = buildShipping(ctx);
  // M5 B17: pages / posts (bundle v1 with content post types; else absent).
  const pages = buildPages(tables, ref, issues);

  const variationCount = products.reduce((n, p) => n + p.variations.length, 0);
  if (
    products.length > CATALOG_LIMITS.products ||
    variationCount > CATALOG_LIMITS.variations ||
    categories.length > CATALOG_LIMITS.categories
  ) {
    throw new ImportAdapterError(
      'IMPORT_BUNDLE_TOO_LARGE',
      'The catalog exceeds the import limits',
      {
        products: products.length,
        variations: variationCount,
        categories: categories.length,
      },
    );
  }

  const rankMath = rankMathSettings(tables);
  const wvs = wvsSettings(tables);
  const npp = nppDisplaySettings(tables);
  const v1 = tables.format_version === 1;

  return {
    meta: {
      kind: 'WP_BUNDLE',
      format_version: tables.format_version,
      site_host: host,
      uploads_base,
      currency:
        (currencyOpt && currencyOpt.trim()) || settings.currency || null,
      prices_include_tax: pit === 'yes' ? true : pit === 'no' ? false : null,
      ...((tables.options.get('woocommerce_weight_unit') ?? '').trim()
        ? {
            weight_unit: tables.options.get('woocommerce_weight_unit')!.trim(),
          }
        : {}),
      locale: resolvedLocale,
      bases,
      versions: v1
        ? {
            ...(tables.manifest?.wp_version
              ? { wp: tables.manifest.wp_version }
              : {}),
            ...(tables.manifest?.wc_version
              ? { wc: tables.manifest.wc_version }
              : {}),
          }
        : parseVersionsTxt(extras.versionsText ?? null),
      ...(tables.manifest?.exported_at
        ? { exported_at: tables.manifest.exported_at }
        : {}),
    },
    capabilities: {
      ...WP_BUNDLE_CAPABILITIES_V1,
      shipping: shipping.zones_available,
      tax_settings: v1 && tables.options.has('woocommerce_prices_include_tax'),
      original_images: v1,
    },
    categories,
    tags,
    attributes,
    products,
    shipping,
    templates,
    store_settings: {
      ...(rankMath ? { rank_math: rankMath } : {}),
      ...(wvs ? { wvs } : {}),
      ...(npp ? { npp_display: npp } : {}),
    },
    issues,
    ...(pages.length ? { pages } : {}),
  };
}

export class WpBundleAdapter implements SourceAdapter {
  readonly kind = 'WP_BUNDLE' as const;

  capabilities(): SourceCapabilities {
    return { ...WP_BUNDLE_CAPABILITIES_V1 };
  }

  async load(ctx: AdapterLoadContext): Promise<NormalizedCatalog> {
    if (!ctx.bundle)
      throw new ImportAdapterError(
        'IMPORT_BUNDLE_MISSING_FILE',
        'No bundle was provided',
      );
    if (ctx.signal?.aborted)
      throw new ImportAdapterError('IMPORT_RUN_CANCELLED', 'Cancelled');
    const tables = await loadWpTables(ctx.bundle);
    if (ctx.signal?.aborted)
      throw new ImportAdapterError('IMPORT_RUN_CANCELLED', 'Cancelled');
    const versionsText = await readOptional(ctx.bundle, 'versions.txt');
    const catalog = buildCatalogFromTables(tables, ctx.source, {
      versionsText,
    });
    for (const issue of catalog.issues) {
      if (issue.level !== 'info')
        ctx.log?.(issue.code, issue.message, issue.data);
    }
    return catalog;
  }
}

async function readOptional(
  bundle: BundleReader,
  name: string,
): Promise<string | null> {
  return (await bundle.has(name))
    ? bundle.readText(name, { maxBytes: 64 * 1024 })
    : null;
}

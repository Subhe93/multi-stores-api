/**
 * Filters and facets of GET /storefront/:slug/products (opt-in). Pure: no
 * Prisma, no Nest. The service reads light rows of every product that
 * matches the base list (store, status, collection, search, market) and
 * hands them here; this module applies the shopper's filters and counts
 * the values of each facet.
 *
 * Query parameters (every one optional; none ever answers 400):
 * - `collection`, `type`, `color`, `size`: comma lists (or repeated keys).
 *   Values are matched by `facetKey` (trimmed, lower case, commas and runs
 *   of spaces folded). Several values of one facet are OR, facets are AND.
 * - `price_min`, `price_max`: the listed price (store or market currency,
 *   as `base_price` in the payload), inclusive. Swapped when reversed.
 * - `in_stock=1`: only products that can be bought (with option filters:
 *   a variant of the chosen colour / size that can be bought).
 * - `facets=1`: the paged answer carries `facets`.
 *
 * Counting is disjunctive (Shopify style): the counts of a facet apply every
 * OTHER active filter, so ticking a second colour shows what it adds.
 */

const MAX_VALUES = 30;
const MAX_VALUE_LENGTH = 80;
const PRICE_RE = /^\d{1,9}(\.\d{1,2})?$/;

/** Words that mark a colour option (seller-typed option names). */
export const COLOR_WORDS = [
  'color',
  'colour',
  'färg',
  'farg',
  'farbe',
  'couleur',
  'renk',
  'kleur',
  'colore',
  'لون',
];
/** Words that mark a size option. */
export const SIZE_WORDS = [
  'size',
  'storlek',
  'größe',
  'groesse',
  'grosse',
  'taille',
  'beden',
  'talla',
  'maat',
  'مقاس',
  'قياس',
];

export const isColorName = (name: string) =>
  COLOR_WORDS.some((w) => name.toLowerCase().includes(w));
export const isSizeName = (name: string) =>
  SIZE_WORDS.some((w) => name.toLowerCase().includes(w));

/** Match key of a facet value ("Navy Blue " and "navy  blue" are one value). */
export function facetKey(value: string): string {
  return value
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ');
}

export interface FacetFilters {
  collection: string[];
  type: string[];
  color: string[];
  size: string[];
  price_min?: number;
  price_max?: number;
  in_stock: boolean;
}

export interface FacetQuery {
  filters: FacetFilters;
  /** `facets=1`: the paged answer carries the facet counts. */
  facets: boolean;
  /** Any filter or `facets=1`: the list takes the faceted path. */
  engaged: boolean;
}

function toList(raw: unknown): string[] {
  const parts: string[] = [];
  const push = (v: unknown) => {
    if (typeof v !== 'string') return;
    for (const p of v.split(',')) parts.push(p);
  };
  if (Array.isArray(raw)) raw.forEach(push);
  else push(raw);
  const out: string[] = [];
  for (const p of parts) {
    const key = facetKey(p);
    if (!key || key.length > MAX_VALUE_LENGTH || out.includes(key)) continue;
    out.push(key);
    if (out.length >= MAX_VALUES) break;
  }
  return out;
}

function firstOf(raw: unknown): unknown {
  return Array.isArray(raw) ? (raw as unknown[])[0] : raw;
}

function toPrice(raw: unknown): number | undefined {
  const v = firstOf(raw);
  if (typeof v === 'number')
    return Number.isFinite(v) && v >= 0 ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return PRICE_RE.test(s) ? Number(s) : undefined;
}

const isOne = (raw: unknown) => {
  const v = firstOf(raw);
  return v === '1' || v === 1 || v === 'true' || v === true;
};

export function normalizeFacetQuery(raw: {
  collection?: unknown;
  type?: unknown;
  color?: unknown;
  size?: unknown;
  price_min?: unknown;
  price_max?: unknown;
  in_stock?: unknown;
  facets?: unknown;
}): FacetQuery {
  let price_min = toPrice(raw.price_min);
  let price_max = toPrice(raw.price_max);
  if (
    price_min !== undefined &&
    price_max !== undefined &&
    price_min > price_max
  ) {
    [price_min, price_max] = [price_max, price_min];
  }
  const filters: FacetFilters = {
    collection: toList(raw.collection),
    type: toList(raw.type),
    color: toList(raw.color),
    size: toList(raw.size),
    ...(price_min !== undefined ? { price_min } : {}),
    ...(price_max !== undefined ? { price_max } : {}),
    in_stock: isOne(raw.in_stock),
  };
  const facets = isOne(raw.facets);
  return { filters, facets, engaged: facets || hasActiveFilter(filters) };
}

export function hasActiveFilter(f: FacetFilters): boolean {
  return (
    f.collection.length > 0 ||
    f.type.length > 0 ||
    f.color.length > 0 ||
    f.size.length > 0 ||
    f.price_min !== undefined ||
    f.price_max !== undefined ||
    f.in_stock
  );
}

// ── Rows ──────────────────────────────────────────────────

/** One variant of a listed product, reduced to what filters read. */
export interface FacetVariant {
  color?: string;
  size?: string;
  /** Active and not sold out (unknown stock counts as in stock). */
  ok: boolean;
}

/** One listed product (own `p` or imported `cp`), reduced for filtering. */
export interface FacetRow {
  kind: 'p' | 'cp';
  id: string;
  created_at: Date;
  /** Listed price (market price when a market applies). */
  price: number;
  title?: string;
  category_id: string | null;
  /** Ids of every collection / tag row the product is linked to. */
  links: string[];
  /** The product can be bought (any variant, or the product itself). */
  in_stock: boolean;
  variants: FacetVariant[];
  /** Display label per colour key, as the seller typed it. */
  colorLabels: Map<string, string>;
  sizeLabels: Map<string, string>;
  /** Seller-set swatch colours per colour key. */
  swatches: Map<string, [string] | [string, string]>;
}

/** What the reader of a product row gives the row builder. */
export interface RawFacetSource {
  kind: 'p' | 'cp';
  id: string;
  created_at: Date;
  price: number;
  title?: string;
  category_id: string | null;
  links: string[];
  track_inventory: boolean;
  stock_quantity: number | null | undefined;
  /** Active variants (inactive ones are dropped by the caller or here). */
  variants: {
    options: unknown;
    stock_quantity: number | null | undefined;
    is_active?: boolean | null;
  }[];
  variant_option_config: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

interface OptionConfig {
  name: string;
  style?: unknown;
  colorMap?: unknown;
  dualColorMap?: unknown;
}

function readConfigs(raw: unknown): OptionConfig[] {
  const out: OptionConfig[] = [];
  if (Array.isArray(raw)) {
    for (const c of raw) {
      if (isRecord(c) && typeof c.name === 'string' && c.name) {
        out.push(c as unknown as OptionConfig);
      }
    }
  } else if (isRecord(raw)) {
    for (const [name, c] of Object.entries(raw)) {
      if (isRecord(c)) out.push({ ...(c as object), name } as OptionConfig);
    }
  }
  return out;
}

/** Option names of the colour and the size option of one product. */
function optionNames(
  variants: RawFacetSource['variants'],
  configs: OptionConfig[],
): { color?: string; size?: string } {
  const names: string[] = [];
  for (const v of variants) {
    if (!isRecord(v.options)) continue;
    for (const k of Object.keys(v.options))
      if (!names.includes(k)) names.push(k);
  }
  const styledColor = configs.find(
    (c) => c.style === 'color' && names.includes(c.name),
  )?.name;
  return {
    color: styledColor ?? names.find(isColorName),
    size: names.find((n) => isSizeName(n) && n !== styledColor),
  };
}

/** Build the filter row of one product. */
export function toFacetRow(src: RawFacetSource): FacetRow {
  const active = src.variants.filter((v) => v.is_active !== false);
  const configs = readConfigs(src.variant_option_config);
  const names = optionNames(active, configs);
  const colorLabels = new Map<string, string>();
  const sizeLabels = new Map<string, string>();
  const swatches = new Map<string, [string] | [string, string]>();
  const colorConfig = names.color
    ? configs.find((c) => c.name === names.color)
    : undefined;

  const variants: FacetVariant[] = active.map((v) => {
    const opts = isRecord(v.options) ? v.options : {};
    const out: FacetVariant = {
      ok: (v.stock_quantity ?? 999) > 0,
    };
    const c = names.color ? opts[names.color] : undefined;
    if (typeof c === 'string' && c.trim()) {
      const key = facetKey(c);
      out.color = key;
      if (!colorLabels.has(key)) colorLabels.set(key, c.trim());
      if (!swatches.has(key) && colorConfig) {
        const dual = isRecord(colorConfig.dualColorMap)
          ? colorConfig.dualColorMap[c]
          : undefined;
        const single = isRecord(colorConfig.colorMap)
          ? colorConfig.colorMap[c]
          : undefined;
        if (
          Array.isArray(dual) &&
          typeof dual[0] === 'string' &&
          typeof dual[1] === 'string'
        ) {
          swatches.set(key, [dual[0], dual[1]]);
        } else if (typeof single === 'string' && single) {
          swatches.set(key, [single]);
        }
      }
    }
    const s = names.size ? opts[names.size] : undefined;
    if (typeof s === 'string' && s.trim()) {
      const key = facetKey(s);
      out.size = key;
      if (!sizeLabels.has(key)) sizeLabels.set(key, s.trim());
    }
    return out;
  });

  // Same rule as the product card: with variants, sold out when none can be
  // bought; without, only a tracked stock at zero or below is sold out.
  const in_stock =
    variants.length > 0
      ? variants.some((v) => v.ok)
      : !(
          src.track_inventory === true &&
          typeof src.stock_quantity === 'number' &&
          src.stock_quantity <= 0
        );

  return {
    kind: src.kind,
    id: src.id,
    created_at: src.created_at,
    price: src.price,
    title: src.title,
    category_id: src.category_id,
    links: src.links,
    in_stock,
    variants,
    colorLabels,
    sizeLabels,
    swatches,
  };
}

// ── Facet definitions ─────────────────────────────────────

/** A public collection the `collection` facet offers. */
export interface FacetCollection {
  id: string;
  slug: string;
  parent_id: string | null;
  sort_order: number;
  /** 'MANUAL' or 'TAGS' (any other value reads as MANUAL). */
  match_rule: string;
  match_tags: string[];
  label: string;
}

/** A platform category (the `type` facet). */
export interface FacetCategory {
  id: string;
  slug: string;
  label: string;
}

export interface FacetValue {
  value: string;
  label: string;
  count: number;
}

export interface FacetsAnswer {
  collection: (FacetValue & { parent: string | null })[];
  type: FacetValue[];
  color: (FacetValue & { swatch?: string; swatch2?: string })[];
  size: FacetValue[];
  /** Lowest and highest listed price under the other filters (null = none). */
  price: { min: number; max: number } | null;
  /** Products that can be bought under the other filters. */
  in_stock: { count: number };
}

type Dim = 'collection' | 'type' | 'color' | 'size' | 'price' | 'in_stock';

export interface FacetEngineInput {
  rows: FacetRow[];
  filters: FacetFilters;
  collections: FacetCollection[];
  categories: FacetCategory[];
}

function memberOf(row: FacetRow, c: FacetCollection): boolean {
  if (c.match_rule === 'TAGS') {
    return c.match_tags.some((t) => row.links.includes(t));
  }
  return row.links.includes(c.id);
}

/**
 * Filter the rows, and (with `withFacets`) count each facet's values. The
 * matched rows keep the input order; the caller sorts them.
 */
export function runFacets(
  input: FacetEngineInput,
  withFacets: boolean,
): { matched: FacetRow[]; facets?: FacetsAnswer } {
  const { rows, filters, collections, categories } = input;
  const selColl = collections.filter((c) =>
    filters.collection.includes(facetKey(c.slug)),
  );
  const catSlugById = new Map(categories.map((c) => [c.id, facetKey(c.slug)]));
  const colorSet = new Set(filters.color);
  const sizeSet = new Set(filters.size);
  // A requested value nobody carries still filters (and matches nothing).
  const collActive = filters.collection.length > 0;

  const passCollection = (r: FacetRow) =>
    !collActive || selColl.some((c) => memberOf(r, c));
  const passType = (r: FacetRow) =>
    filters.type.length === 0 ||
    (r.category_id !== null &&
      filters.type.includes(catSlugById.get(r.category_id) ?? ''));
  const passPrice = (r: FacetRow) =>
    (filters.price_min === undefined || r.price >= filters.price_min) &&
    (filters.price_max === undefined || r.price <= filters.price_max);

  /** Variant-level match of colour, size and stock, each one optional. */
  const variantMatch = (
    useColor: boolean,
    useSize: boolean,
    useStock: boolean,
    v: FacetVariant,
  ) =>
    (!useColor || (v.color !== undefined && colorSet.has(v.color))) &&
    (!useSize || (v.size !== undefined && sizeSet.has(v.size))) &&
    (!useStock || v.ok);
  const passOptions = (
    r: FacetRow,
    useColor: boolean,
    useSize: boolean,
    useStock: boolean,
  ) => {
    if (!useColor && !useSize) return !useStock || r.in_stock;
    return r.variants.some((v) => variantMatch(useColor, useSize, useStock, v));
  };

  const colorOn = colorSet.size > 0;
  const sizeOn = sizeSet.size > 0;
  const stockOn = filters.in_stock;

  /** Every filter except `skip`. */
  const passAll = (r: FacetRow, skip?: Dim) =>
    (skip === 'collection' || passCollection(r)) &&
    (skip === 'type' || passType(r)) &&
    (skip === 'price' || passPrice(r)) &&
    passOptions(
      r,
      skip !== 'color' && colorOn,
      skip !== 'size' && sizeOn,
      skip !== 'in_stock' && stockOn,
    );

  const matched = rows.filter((r) => passAll(r));
  if (!withFacets) return { matched };

  // collection
  const collCounts = new Map<string, number>();
  const collBase = new Map<string, number>();
  const exceptColl = rows.filter((r) => passAll(r, 'collection'));
  for (const c of collections) {
    collBase.set(c.id, rows.filter((r) => memberOf(r, c)).length);
    collCounts.set(c.id, exceptColl.filter((r) => memberOf(r, c)).length);
  }
  const slugById = new Map(collections.map((c) => [c.id, facetKey(c.slug)]));
  const collection = [...collections]
    .filter((c) => (collBase.get(c.id) ?? 0) > 0)
    .sort(
      (a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label),
    )
    .map((c) => ({
      value: facetKey(c.slug),
      label: c.label,
      count: collCounts.get(c.id) ?? 0,
      parent: c.parent_id ? (slugById.get(c.parent_id) ?? null) : null,
    }));

  // type (only when the catalogue spans two or more categories)
  const baseCats = new Set(
    rows.map((r) => r.category_id).filter((x): x is string => !!x),
  );
  const exceptType = rows.filter((r) => passAll(r, 'type'));
  const type =
    baseCats.size < 2
      ? []
      : categories
          .filter((c) => baseCats.has(c.id))
          .map((c) => ({
            value: facetKey(c.slug),
            label: c.label,
            count: exceptType.filter((r) => r.category_id === c.id).length,
          }))
          .sort((a, b) => a.label.localeCompare(b.label));

  // colour and size: per row, the values a variant offers under the
  // other option and stock filters.
  const optionFacet = (dim: 'color' | 'size') => {
    const counts = new Map<string, number>();
    const labels = new Map<string, string>();
    const swatches = new Map<string, [string] | [string, string]>();
    for (const r of rows) {
      const ls = dim === 'color' ? r.colorLabels : r.sizeLabels;
      for (const [k, l] of ls) if (!labels.has(k)) labels.set(k, l);
      if (dim === 'color') {
        for (const [k, s] of r.swatches)
          if (!swatches.has(k)) swatches.set(k, s);
      }
      if (!passAll(r, dim)) continue;
      const seen = new Set<string>();
      for (const v of r.variants) {
        const key = dim === 'color' ? v.color : v.size;
        if (key === undefined || seen.has(key)) continue;
        if (
          !variantMatch(
            dim !== 'color' && colorOn,
            dim !== 'size' && sizeOn,
            stockOn,
            v,
          )
        )
          continue;
        seen.add(key);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return { counts, labels, swatches };
  };
  const c = optionFacet('color');
  const color = [...c.labels]
    .map(([value, label]) => {
      const sw = c.swatches.get(value);
      return {
        value,
        label,
        count: c.counts.get(value) ?? 0,
        ...(sw ? { swatch: sw[0], ...(sw[1] ? { swatch2: sw[1] } : {}) } : {}),
      };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const s = optionFacet('size');
  const size = [...s.labels]
    .map(([value, label]) => ({
      value,
      label,
      count: s.counts.get(value) ?? 0,
    }))
    .sort((a, b) => compareSizes(a.label, b.label));

  // price
  const exceptPrice = rows.filter((r) => passAll(r, 'price'));
  const price = exceptPrice.length
    ? {
        min: Math.min(...exceptPrice.map((r) => r.price)),
        max: Math.max(...exceptPrice.map((r) => r.price)),
      }
    : null;

  // availability
  const inStock = rows.filter(
    (r) => passAll(r, 'in_stock') && passOptions(r, colorOn, sizeOn, true),
  ).length;

  return {
    matched,
    facets: {
      collection,
      type,
      color,
      size,
      price,
      in_stock: { count: inStock },
    },
  };
}

// ── Size order ────────────────────────────────────────────

const LETTER_RANK: Record<string, number> = {
  xxxs: 0,
  '3xs': 0,
  xxs: 1,
  '2xs': 1,
  xs: 2,
  s: 3,
  m: 4,
  l: 5,
  xl: 6,
  xxl: 7,
  '2xl': 7,
  xxxl: 8,
  '3xl': 8,
  '4xl': 9,
  '5xl': 10,
};

const WORD_SIZES: Record<string, string> = {
  small: 's',
  medium: 'm',
  large: 'l',
  'one size': 'os',
  onesize: 'os',
};

/**
 * Size order: letter sizes (XS…5XL), then numeric sizes ascending, then
 * the rest alphabetically; "one size" last among the letters.
 */
export function compareSizes(a: string, b: string): number {
  const rank = (v: string): [number, number, string] => {
    const k = v.trim().toLowerCase();
    const word = WORD_SIZES[k] ?? k;
    if (word in LETTER_RANK) return [0, LETTER_RANK[word], k];
    if (word === 'os') return [0, 99, k];
    const n = parseFloat(k.replace(',', '.'));
    if (/^\d/.test(k) && Number.isFinite(n)) return [1, n, k];
    return [2, 0, k];
  };
  const [ga, ra, ka] = rank(a);
  const [gb, rb, kb] = rank(b);
  return ga - gb || ra - rb || ka.localeCompare(kb);
}

import { hashOf, money } from './hash';

/**
 * Canonical "managed fields" of target rows (M4.4 D6). The same functions
 * hash what the importer wrote (`applied_hash`) and what is in the database
 * now; a difference means the merchant edited the entity. Stock levels are
 * left out on purpose (orders change them).
 */

export interface ProductStateRows {
  product: {
    status: string;
    product_type: string;
    customization_type: string | null;
    base_price: unknown;
    compare_at_price: unknown;
    sku: string | null;
    track_inventory: boolean;
    weight: unknown;
    tax_exempt: boolean;
    category_id: string;
    variant_option_config: unknown;
    shipping_profile_id: string | null;
  };
  translation: {
    title: string;
    slug: string;
    description: string;
    short_description: string | null;
    meta_title: string | null;
    meta_desc: string | null;
  } | null;
  variants: {
    id: string;
    external_ref: string | null;
    sku: string | null;
    price_adjustment: unknown;
    compare_at_price: unknown;
    is_active: boolean;
    options: unknown;
  }[];
  images: {
    url: string;
    alt_text: string | null;
    sort_order: number;
    is_featured: boolean;
    variant_id?: string | null;
  }[];
  tags: { tag: string }[];
  faqs: { sort_order: number; question: string; answer: string }[];
}

export function productState(rows: ProductStateRows): unknown {
  const p = rows.product;
  return {
    status: p.status,
    product_type: p.product_type,
    customization_type: p.customization_type ?? null,
    base_price: money(p.base_price),
    compare_at_price: money(p.compare_at_price),
    sku: p.sku ?? null,
    track_inventory: p.track_inventory,
    weight: money(p.weight),
    tax_exempt: p.tax_exempt,
    category_id: p.category_id,
    variant_option_config: p.variant_option_config ?? null,
    shipping_profile_id: p.shipping_profile_id ?? null,
    translation: rows.translation
      ? {
          title: rows.translation.title,
          slug: rows.translation.slug,
          description: rows.translation.description,
          short_description: rows.translation.short_description ?? null,
          meta_title: rows.translation.meta_title ?? null,
          meta_desc: rows.translation.meta_desc ?? null,
        }
      : null,
    variants: rows.variants
      .map((v) => ({
        key: v.external_ref ?? `id:${v.id}`,
        sku: v.sku ?? null,
        price_adjustment: money(v.price_adjustment),
        compare_at_price: money(v.compare_at_price),
        is_active: v.is_active,
        options: v.options ?? null,
      }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    images: rows.images
      .filter((i) => !i.variant_id)
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order || (a.url < b.url ? -1 : 1))
      .map((i) => [i.url, i.alt_text ?? null, i.is_featured]),
    tags: rows.tags.map((t) => t.tag).sort(),
    faqs: rows.faqs
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((f) => [f.question, f.answer]),
  };
}

export const productStateHash = (rows: ProductStateRows): string =>
  hashOf(productState(rows));

export interface CategoryStateRows {
  category: {
    slug: string;
    parent_id: string | null;
    sort_order: number;
    is_active: boolean;
    noindex_when_empty: boolean;
    thumbnail_url: string | null;
  };
  translation: {
    name: string;
    description: string | null;
    meta_title: string | null;
    meta_desc: string | null;
  } | null;
}

export function categoryStateHash(rows: CategoryStateRows): string {
  const c = rows.category;
  const t = rows.translation;
  return hashOf({
    slug: c.slug,
    parent_id: c.parent_id ?? null,
    sort_order: c.sort_order,
    is_active: c.is_active,
    noindex_when_empty: c.noindex_when_empty,
    thumbnail_url: c.thumbnail_url ?? null,
    translation: t
      ? {
          name: t.name,
          description: t.description ?? null,
          meta_title: t.meta_title ?? null,
          meta_desc: t.meta_desc ?? null,
        }
      : null,
  });
}

export function shippingProfileStateHash(row: { name: string }): string {
  return hashOf({ name: row.name });
}

export function shippingZoneStateHash(row: {
  name: string;
  countries: string[];
  base_cost: unknown;
  per_item_cost: unknown;
  free_threshold: unknown;
  estimated_days_min: number;
  estimated_days_max: number;
}): string {
  return hashOf({
    name: row.name,
    countries: [...row.countries].sort(),
    base_cost: money(row.base_cost),
    per_item_cost: money(row.per_item_cost),
    free_threshold: money(row.free_threshold),
    days: [row.estimated_days_min, row.estimated_days_max],
  });
}

export function shippingMethodStateHash(row: {
  name: string;
  type: string;
  base_cost: unknown;
  per_item_cost: unknown;
  free_threshold: unknown;
  estimated_days_min: number;
  estimated_days_max: number;
  is_active: boolean;
  sort_order: number;
}): string {
  return hashOf({
    name: row.name,
    type: row.type,
    base_cost: money(row.base_cost),
    per_item_cost: money(row.per_item_cost),
    free_threshold: money(row.free_threshold),
    days: [row.estimated_days_min, row.estimated_days_max],
    is_active: row.is_active,
    sort_order: row.sort_order,
  });
}

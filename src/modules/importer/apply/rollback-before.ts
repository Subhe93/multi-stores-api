import { ImportEntityStatus, ProductStatus, type Prisma } from '@prisma/client';
import type { CategoryBefore } from './apply-categories';
import type { LedgerBefore } from './apply-context';
import type { ProductBefore } from './apply-products';

/**
 * Shape checks of the `before` images stored in `ImportRunItem.before`
 * (M5 B18: replaces the unchecked `as` casts in rollback.ts). A JSON value
 * that does not have the expected shape answers null; the rollback then
 * records a SKIP ("invalid before image") instead of writing garbage.
 */

type Json = Prisma.JsonValue | null | undefined;

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isOptStr = (v: unknown): v is string | null =>
  v === null || v === undefined || typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isNum = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

export function parseRedirectBefore(
  v: Json,
): { to_path: string; status_code: number; is_active: boolean } | null {
  if (!isObj(v)) return null;
  if (!isStr(v.to_path) || !isNum(v.status_code) || !isBool(v.is_active))
    return null;
  return {
    to_path: v.to_path,
    status_code: v.status_code,
    is_active: v.is_active,
  };
}

/** `{status_only: <ProductStatus>}` written by `on_source_removed`. */
export function parseStatusOnlyBefore(v: Json): ProductStatus | null {
  if (!isObj(v) || !('status_only' in v)) return null;
  const s = v.status_only;
  return isStr(s) && (Object.values(ProductStatus) as string[]).includes(s)
    ? (s as ProductStatus)
    : null;
}

function parseLedgerBefore(v: unknown): LedgerBefore | null | undefined {
  if (v === null || v === undefined) return null;
  if (!isObj(v)) return undefined;
  if (
    !isStr(v.source_hash) ||
    !isOptStr(v.applied_hash) ||
    !isStr(v.status) ||
    !(Object.values(ImportEntityStatus) as string[]).includes(v.status) ||
    !isBool(v.created_by_import) ||
    !isStr(v.first_run_id) ||
    !isStr(v.last_run_id) ||
    !isOptStr(v.target_id)
  )
    return undefined;
  return {
    source_hash: v.source_hash,
    applied_hash: v.applied_hash ?? null,
    status: v.status as ImportEntityStatus,
    created_by_import: v.created_by_import,
    first_run_id: v.first_run_id,
    last_run_id: v.last_run_id,
    target_id: v.target_id ?? null,
  };
}

export function parseProductBefore(v: Json): ProductBefore | null {
  if (!isObj(v) || !isObj(v.state)) return null;
  const s = v.state;
  const p = s.product;
  if (
    !isObj(p) ||
    !isStr(p.status) ||
    !isStr(p.product_type) ||
    !isOptStr(p.customization_type) ||
    !isOptStr(p.sku) ||
    !isBool(p.track_inventory) ||
    !isBool(p.tax_exempt) ||
    !isStr(p.category_id) ||
    !isOptStr(p.shipping_profile_id)
  )
    return null;
  type State = ProductBefore['state'];
  let translation: State['translation'] = null;
  const t = s.translation;
  if (t !== null && t !== undefined) {
    if (
      !isObj(t) ||
      !isStr(t.title) ||
      !isStr(t.slug) ||
      !isStr(t.description) ||
      !isOptStr(t.short_description) ||
      !isOptStr(t.meta_title) ||
      !isOptStr(t.meta_desc)
    )
      return null;
    translation = {
      title: t.title,
      slug: t.slug,
      description: t.description,
      short_description: t.short_description ?? null,
      meta_title: t.meta_title ?? null,
      meta_desc: t.meta_desc ?? null,
    };
  }
  if (
    !Array.isArray(s.variants) ||
    !Array.isArray(s.images) ||
    !Array.isArray(s.tags) ||
    !Array.isArray(s.faqs) ||
    !Array.isArray(v.links)
  )
    return null;
  const variants: State['variants'] = [];
  for (const x of s.variants) {
    if (
      !isObj(x) ||
      !isStr(x.id) ||
      !isOptStr(x.external_ref) ||
      !isOptStr(x.sku) ||
      !isBool(x.is_active)
    )
      return null;
    variants.push({
      id: x.id,
      external_ref: x.external_ref ?? null,
      sku: x.sku ?? null,
      price_adjustment: x.price_adjustment,
      compare_at_price: x.compare_at_price,
      is_active: x.is_active,
      options: x.options,
    });
  }
  const images: State['images'] = [];
  for (const x of s.images) {
    if (
      !isObj(x) ||
      !isStr(x.url) ||
      !isOptStr(x.alt_text) ||
      !isNum(x.sort_order) ||
      !isBool(x.is_featured) ||
      !isOptStr(x.variant_id)
    )
      return null;
    images.push({
      url: x.url,
      alt_text: x.alt_text ?? null,
      sort_order: x.sort_order,
      is_featured: x.is_featured,
      variant_id: x.variant_id ?? null,
    });
  }
  const tags: State['tags'] = [];
  for (const x of s.tags) {
    if (!isObj(x) || !isStr(x.tag)) return null;
    tags.push({ tag: x.tag });
  }
  const faqs: State['faqs'] = [];
  for (const x of s.faqs) {
    if (
      !isObj(x) ||
      !isNum(x.sort_order) ||
      !isStr(x.question) ||
      !isStr(x.answer)
    )
      return null;
    faqs.push({
      sort_order: x.sort_order,
      question: x.question,
      answer: x.answer,
    });
  }
  const links: ProductBefore['links'] = [];
  for (const l of v.links) {
    if (!isObj(l) || !isStr(l.creator_category_id) || !isNum(l.sort_order))
      return null;
    links.push({
      creator_category_id: l.creator_category_id,
      sort_order: l.sort_order,
    });
  }
  const ledger = parseLedgerBefore(v.ledger);
  if (ledger === undefined) return null;
  if (!isOptStr(v.weight_unit)) return null;
  return {
    state: {
      product: {
        status: p.status,
        product_type: p.product_type,
        customization_type: p.customization_type ?? null,
        base_price: p.base_price,
        compare_at_price: p.compare_at_price,
        sku: p.sku ?? null,
        track_inventory: p.track_inventory,
        weight: p.weight,
        tax_exempt: p.tax_exempt,
        category_id: p.category_id,
        variant_option_config: p.variant_option_config,
        shipping_profile_id: p.shipping_profile_id ?? null,
      },
      translation,
      variants,
      images,
      tags,
      faqs,
    },
    weight_unit: v.weight_unit ?? null,
    links,
    ledger,
  };
}

export function parseCategoryBefore(v: Json): CategoryBefore | null {
  if (!isObj(v) || !isObj(v.category)) return null;
  const c = v.category;
  if (
    !isStr(c.slug) ||
    !isOptStr(c.parent_id) ||
    !isNum(c.sort_order) ||
    !isBool(c.is_active) ||
    !isBool(c.noindex_when_empty) ||
    !isOptStr(c.thumbnail_url) ||
    !isOptStr(c.external_ref)
  )
    return null;
  let translation: CategoryBefore['translation'] = null;
  const t = v.translation;
  if (t !== null && t !== undefined) {
    if (
      !isObj(t) ||
      !isStr(t.name) ||
      !isOptStr(t.description) ||
      !isOptStr(t.meta_title) ||
      !isOptStr(t.meta_desc)
    )
      return null;
    translation = {
      name: t.name,
      description: t.description ?? null,
      meta_title: t.meta_title ?? null,
      meta_desc: t.meta_desc ?? null,
    };
  }
  const ledger = parseLedgerBefore(v.ledger);
  if (ledger === undefined) return null;
  return {
    category: {
      slug: c.slug,
      parent_id: c.parent_id ?? null,
      sort_order: c.sort_order,
      is_active: c.is_active,
      noindex_when_empty: c.noindex_when_empty,
      thumbnail_url: c.thumbnail_url ?? null,
      external_ref: c.external_ref ?? null,
    },
    translation,
    ledger,
  };
}

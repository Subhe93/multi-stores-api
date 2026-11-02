import { cleanText } from '../model/clean';
import type { NormalizedCatalog, NTag } from '../model/normalized';
import { platformSlug } from './slug';

/**
 * WooCommerce `product_tag` term → INTERNAL `CreatorCategory` row ("tag",
 * tags rename 2026-11-02): external_ref `woo:<host>:product_tag:<id>`, the
 * cleaned term name in the store's primary locale, a WP-rule slug, no
 * parent, never a storefront page. Legacy `ProductTag` rows are no longer
 * written by the importer.
 */
export interface MappedTag {
  ref: string;
  source_id: string;
  slug: string;
  name: string;
  /** Catalog order (stable sort_order of the INTERNAL rows). */
  sort_order: number;
}

export function mapTag(t: NTag, index: number): MappedTag {
  return {
    ref: t.ext_id,
    source_id: t.source_id,
    slug: platformSlug(t.slug, `tag-${t.source_id}`),
    name: cleanText(t.name),
    sort_order: index,
  };
}

export function mapTags(catalog: NormalizedCatalog): MappedTag[] {
  return catalog.tags.map((t, i) => mapTag(t, i));
}

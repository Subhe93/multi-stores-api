import {
  cleanText,
  htmlToPlainText,
  resolveSeoTemplate,
  stripShortcodes,
  type HtmlSanitizer,
} from '../model/clean';
import type {
  NCategory,
  NMediaRef,
  NormalizedCatalog,
} from '../model/normalized';
import { platformSlug } from './slug';

/**
 * Category → `CreatorCategory` (+ primary-locale translation) mapping
 * (M4.4 §4.2, D24, U7): every category, in catalog order (parents first,
 * siblings in D24 order), active, with Rank Math SEO and the
 * `noindex_when_empty` flag from `noindex_empty_taxonomies`.
 */

export interface MappedCategory {
  ref: string;
  source_id: string;
  parent_ref: string | null;
  slug: string;
  name: string;
  description: string | null;
  meta_title: string | null;
  meta_desc: string | null;
  sort_order: number;
  is_active: true;
  noindex_when_empty: boolean;
  thumbnail: NMediaRef | null;
  depth: number;
  path: string[];
}

function nullIfEmpty(s: string | null | undefined): string | null {
  const t = (s ?? '').trim();
  return t === '' ? null : t;
}

export function mapCategory(
  c: NCategory,
  catalog: NormalizedCatalog,
  sanitizer: HtmlSanitizer,
): MappedCategory {
  const rm = catalog.store_settings.rank_math ?? {};
  const name = cleanText(c.name);
  const description = nullIfEmpty(
    sanitizer.sanitize(stripShortcodes(c.description_html ?? '').html),
  );
  const vars = {
    term: name,
    title: name,
    sep: rm.sep ?? '-',
    sitename: rm.site_name ?? '',
    term_description: htmlToPlainText(c.description_html),
  };
  return {
    ref: c.ext_id,
    source_id: c.source_id,
    parent_ref: c.parent_ext_id,
    slug: platformSlug(c.slug),
    name,
    description,
    meta_title: c.seo.title
      ? nullIfEmpty(resolveSeoTemplate(c.seo.title, vars))
      : null,
    meta_desc: c.seo.description
      ? nullIfEmpty(resolveSeoTemplate(c.seo.description, vars))
      : null,
    sort_order: c.sibling_rank,
    is_active: true,
    noindex_when_empty: rm.noindex_empty_taxonomies === true,
    thumbnail:
      c.thumbnail && !c.thumbnail.missing && c.thumbnail.url
        ? c.thumbnail
        : null,
    depth: c.depth,
    path: c.path.map(platformSlug),
  };
}

export function mapCategories(
  catalog: NormalizedCatalog,
  sanitizer: HtmlSanitizer,
): MappedCategory[] {
  return catalog.categories.map((c) => mapCategory(c, catalog, sanitizer));
}

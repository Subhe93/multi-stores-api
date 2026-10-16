import type { NCategorySeo, NStoreSettings } from '../../../model/normalized';
import { maybeUnserialize } from '../php-unserialize';
import { decodeOption, MetaBag, WpTables } from '../wp-tables';

/** Rank Math SEO meta on products / terms and the global title settings (Discovery C §1.2, §4.4, §7.1). */

export const RANK_MATH_PRODUCT_KEYS = [
  'rank_math_title',
  'rank_math_description',
  'rank_math_focus_keyword',
  'rank_math_robots',
  'rank_math_canonical_url',
  'rank_math_primary_product_cat',
] as const;

function nonEmpty(meta: MetaBag, key: string): string | undefined {
  const v = meta.first(key);
  return v !== undefined && v !== null && v.trim() !== '' ? v : undefined;
}

function robots(meta: MetaBag): string[] | undefined {
  const raw = meta.first('rank_math_robots');
  if (raw === undefined || raw === null || raw.trim() === '') return undefined;
  const m = maybeUnserialize(raw);
  const v = m.ok ? m.value : raw;
  const list = Array.isArray(v)
    ? v
    : typeof v === 'object' && v
      ? Object.values(v)
      : [v];
  const out = list.map((x) => String(x)).filter(Boolean);
  return out.length ? out : undefined;
}

export function detectSeo(meta: MetaBag): NCategorySeo {
  const seo: NCategorySeo = {};
  const title = nonEmpty(meta, 'rank_math_title');
  const description = nonEmpty(meta, 'rank_math_description');
  const focus = nonEmpty(meta, 'rank_math_focus_keyword');
  const canonical = nonEmpty(meta, 'rank_math_canonical_url');
  const r = robots(meta);
  if (title !== undefined) seo.title = title;
  if (description !== undefined) seo.description = description;
  if (focus !== undefined) seo.focus_keyword = focus;
  if (r) seo.robots = r;
  if (canonical !== undefined) seo.canonical = canonical;
  return seo;
}

/** `rank_math_primary_product_cat` (0 / empty = none). */
export function primaryCategoryId(meta: MetaBag): number | null {
  const n = Number.parseInt(
    meta.first('rank_math_primary_product_cat') ?? '',
    10,
  );
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function rankMathSettings(
  tables: WpTables,
): NStoreSettings['rank_math'] | undefined {
  const titles = decodeOption(tables, 'rank-math-options-titles');
  if (!titles || typeof titles !== 'object' || Array.isArray(titles))
    return undefined;
  const t = titles as Record<string, unknown>;
  const s = (k: string): string | undefined => {
    const v = t[k];
    return typeof v === 'string' ? v : undefined;
  };
  const out: NonNullable<NStoreSettings['rank_math']> = {};
  if (s('noindex_empty_taxonomies') !== undefined)
    out.noindex_empty_taxonomies = s('noindex_empty_taxonomies') === 'on';
  if (s('pt_product_title') !== undefined)
    out.product_title_tpl = s('pt_product_title');
  if (s('pt_product_description') !== undefined)
    out.product_description_tpl = s('pt_product_description');
  if (s('tax_product_cat_title') !== undefined)
    out.category_title_tpl = s('tax_product_cat_title');
  if (s('title_separator') !== undefined) out.sep = s('title_separator');
  if (s('website_name') !== undefined) out.site_name = s('website_name');
  return out;
}

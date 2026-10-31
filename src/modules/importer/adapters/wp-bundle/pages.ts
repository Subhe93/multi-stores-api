import type { NIssue, NPage, NProductStatus } from '../../model/normalized';
import { platformSlug } from '../../mapping/slug';
import { CONTENT_POST_TYPES } from './bundle-schema';
import { detectSeo } from './detectors/rank-math';
import { metaOf, WpPost, WpTables, WpTermTaxonomy } from './wp-tables';

/**
 * WordPress pages and blog posts of a bundle v1 → `NPage[]` (M5 B17). Pure:
 * paths are computed the way WordPress builds permalinks, so the redirect
 * planner can map every old URL without asking the site.
 */

const STATUSES: readonly NProductStatus[] = [
  'publish',
  'draft',
  'private',
  'pending',
  'future',
];

/** `YYYY-MM-DD HH:MM:SS` → its parts (zero-padded strings), or null. */
function dateParts(
  date: string,
): Record<
  'year' | 'monthnum' | 'day' | 'hour' | 'minute' | 'second',
  string
> | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/.exec(
    date,
  );
  if (!m || m[1] === '0000') return null;
  return {
    year: m[1],
    monthnum: m[2],
    day: m[3],
    hour: m[4] ?? '00',
    minute: m[5] ?? '00',
    second: m[6] ?? '00',
  };
}

function int(v: string | null | undefined): number {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : 0;
}

export interface PagePathSettings {
  /** `permalink_structure`; empty = plain `?p=` links. */
  permalink_structure: string;
  /** `category_base` (default `category`). */
  category_base: string;
  /** `page_on_front` when `show_on_front` is `page`, else 0. */
  front_page_id: number;
}

export function pagePathSettings(tables: WpTables): PagePathSettings {
  const str = (name: string): string => (tables.options.get(name) ?? '').trim();
  const showOnFront = str('show_on_front');
  return {
    permalink_structure: str('permalink_structure'),
    category_base: str('category_base').replace(/^\/+|\/+$/g, '') || 'category',
    front_page_id: showOnFront === 'page' ? int(str('page_on_front')) : 0,
  };
}

/** Slug path of the first `category` term of a post (parents first), WordPress style. */
function postCategoryPath(tables: WpTables, postId: number): string {
  const rels = tables.relationships.get(postId) ?? [];
  const terms = rels
    .map((r) => tables.termTaxonomy.get(r.tt_id))
    .filter((tt): tt is WpTermTaxonomy => !!tt && tt.taxonomy === 'category')
    .sort((a, b) => a.term_id - b.term_id);
  const first = terms[0];
  if (!first) return 'uncategorized';
  const chain: string[] = [];
  let cur: WpTermTaxonomy | undefined = first;
  const seen = new Set<number>();
  while (cur && !seen.has(cur.term_id)) {
    seen.add(cur.term_id);
    chain.unshift(tables.terms.get(cur.term_id)?.slug ?? '');
    cur = cur.parent ? tables.termTaxonomyByTerm.get(cur.parent) : undefined;
  }
  return chain.filter(Boolean).join('/') || 'uncategorized';
}

/**
 * Public path of a post from `permalink_structure`. Returns null when a token
 * cannot be resolved (`%author%`: users are never exported).
 */
export function postPath(
  tables: WpTables,
  post: WpPost,
  settings: PagePathSettings,
): string | null {
  const structure = settings.permalink_structure || '';
  if (!structure) return `/?p=${post.id}`;
  const d = dateParts(post.date);
  let unresolved = false;
  const out = structure.replace(/%([a-z_]+)%/g, (_m, token: string) => {
    switch (token) {
      case 'postname':
        return post.name;
      case 'post_id':
        return String(post.id);
      case 'category':
        return postCategoryPath(tables, post.id);
      case 'year':
      case 'monthnum':
      case 'day':
      case 'hour':
      case 'minute':
      case 'second':
        if (!d) unresolved = true;
        return d ? d[token] : '';
      default:
        unresolved = true;
        return '';
    }
  });
  if (unresolved) return null;
  // WordPress adds the trailing slash only when the structure ends with one.
  return normalizePath(out, structure.endsWith('/'));
}

/** `/a//b/` → `/a/b/`; adds the trailing slash when `trailing`. */
function normalizePath(p: string, trailing: boolean): string {
  let path = '/' + p.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  if (trailing && !path.endsWith('/')) path += '/';
  return path;
}

/** Nested page path: ancestor slugs first (only ancestors that are pages themselves). */
function pagePath(tables: WpTables, page: WpPost): string {
  const chain: string[] = [page.name];
  const seen = new Set<number>([page.id]);
  let parentId = page.parent;
  while (parentId > 0 && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = tables.posts.get(parentId);
    if (!parent || parent.type !== 'page') break;
    chain.unshift(parent.name);
    parentId = parent.parent;
  }
  return normalizePath(chain.filter(Boolean).join('/'), true);
}

/**
 * Builds the pages/posts of the bundle. Published ones only (the export
 * already filters; a hand-made bundle may carry drafts, which are kept with
 * their status so the planner can leave them out). Returns an empty list
 * when the bundle has no content post types (legacy export).
 */
export function buildPages(
  tables: WpTables,
  ref: (kind: 'page' | 'post', id: number) => string,
  issues: NIssue[],
): NPage[] {
  const settings = pagePathSettings(tables);
  const out: NPage[] = [];
  const posts = [...tables.posts.values()]
    .filter((p) => CONTENT_POST_TYPES.includes(p.type))
    .sort((a, b) => a.id - b.id);
  for (const post of posts) {
    const kind = post.type as 'page' | 'post';
    const status = (
      STATUSES.includes(post.status as NProductStatus) ? post.status : 'draft'
    ) as NProductStatus;
    const extRef = ref(kind, post.id);
    let path: string | null;
    if (kind === 'page') {
      path = settings.front_page_id === post.id ? '/' : pagePath(tables, post);
    } else {
      path = postPath(tables, post, settings);
      if (path === null) {
        issues.push({
          level: 'warn',
          code: 'W_CONTENT_PATH_UNKNOWN',
          message: `post ${post.id} (${post.name}): the permalink structure "${settings.permalink_structure}" uses a token the bundle cannot resolve; no redirect will be planned`,
          external_ref: extRef,
        });
        continue;
      }
    }
    const meta = metaOf(tables.postmeta, post.id);
    const seo = detectSeo(meta);
    const parent =
      kind === 'page' && post.parent > 0 && tables.posts.get(post.parent)
        ? ref('page', post.parent)
        : null;
    out.push({
      ref: extRef,
      source_id: String(post.id),
      kind,
      // WP stores non-ASCII slugs percent-encoded: decode like every
      // imported slug, or the page is unreachable on the storefront.
      slug: platformSlug(post.name, `page-${post.id}`),
      path,
      title: post.title,
      excerpt: post.excerpt,
      html: post.content,
      status,
      parent_ref: parent,
      published_at: post.date,
      modified_at: post.modified,
      seo: {
        ...(seo.title !== undefined ? { meta_title: seo.title } : {}),
        ...(seo.description !== undefined
          ? { meta_desc: seo.description }
          : {}),
        noindex: (seo.robots ?? []).includes('noindex'),
      },
    });
  }
  return out;
}

/** Whether a bundle exported content post types at all (for the capabilities). */
export function hasContentPosts(tables: WpTables): boolean {
  for (const p of tables.posts.values())
    if (CONTENT_POST_TYPES.includes(p.type)) return true;
  return false;
}

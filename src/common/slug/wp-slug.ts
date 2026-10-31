import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import {
  SLUG_MAX_BYTES,
  WP_RESERVED_SLUGS,
  encodeSlugForUrl,
  encodedLength,
  normalizeSlugForLookup,
  sanitizeTitle,
  uniqueSlug,
} from '@multi-stores/core/slug';
import type { PrismaService } from '../../prisma/prisma.service';
import { SUPPORTED_LOCALES } from '../../modules/markets/market.types';

/*
 * WordPress slug rules for every URL slug the API writes
 * (plans/slug-wp-rules/PLAN.md, WP-SLUG-SPEC.md §5, §7, §10).
 *
 * - Sanitizing: `sanitizeTitle` (WP sanitize_title, save context) with the
 *   store's PRIMARY content locale (StoreLanguageConfig.primary_locale) as the
 *   WP site locale. Per-locale translation slugs use the store primary locale
 *   too, exactly as WP uses one site locale for every post.
 * - Unchanged slugs: a slug the client sends back unchanged is kept as stored.
 *   Re-sanitizing a stored decoded slug can change it (`straße` -> `strase`),
 *   while WP is stable because it re-saves the encoded form.
 * - Empty result: WP falls back to the object id. Ours: the next candidate
 *   (the title, then other-locale slugs/titles, see each caller), else
 *   `<prefix>-<first 8 hex of the id>` (`idFallbackSlug`).
 * - Uniqueness: `uniqueSlug` (`-2`, `-3`, ...), scoped like the storefront
 *   lookup of the entity (see the `unique*Slug` helpers).
 */

export type SlugDb = Prisma.TransactionClient | PrismaService;

/** Content locale used when a store has no language config. */
export const DEFAULT_SLUG_LOCALE = 'en';

/**
 * Root storefront segments a page slug must not shadow (M6.6). Mirrors
 * RESERVED_SLUGS in the web's `[pageSlug]` route plus the root files the
 * proxy serves. Re-exported by pages-v2.service as RESERVED_PAGE_SLUGS.
 */
export const ROOT_ROUTE_RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'products',
  'collections',
  'cart',
  'checkout',
  'auth',
  'account',
  'legal',
  'p',
  'api',
  'market-not-found',
  'builder-preview',
  'robots.txt',
  'sitemap.xml',
  'favicon.ico',
]);

/**
 * Reserved list of root page slugs (legacy StaticPage + v2 STATIC/LANDING):
 * WP feeds/embed, the storefront routes, and the locale codes the proxy reads
 * as a `/<locale>/…` prefix. Compared against the sanitized slug.
 */
export const PAGE_RESERVED_SLUGS: readonly string[] = Object.freeze([
  ...WP_RESERVED_SLUGS,
  ...ROOT_ROUTE_RESERVED_SLUGS,
  ...SUPPORTED_LOCALES,
]);

/** True when a root page slug is reserved (after sanitizing, so `Cart` counts). */
export function isReservedPageSlug(slug: string): boolean {
  return PAGE_RESERVED_SLUGS.includes(slug.toLowerCase());
}

/** The store's primary content locale (the WP site locale of its slugs). */
export async function storeSlugLocale(
  db: SlugDb,
  by: { storeId?: string | null; creatorId?: string | null },
): Promise<string> {
  if (!by.storeId && !by.creatorId) return DEFAULT_SLUG_LOCALE;
  const store = await db.store.findUnique({
    where: by.storeId ? { id: by.storeId } : { creator_id: by.creatorId! },
    select: { language_config: { select: { primary_locale: true } } },
  });
  return store?.language_config?.primary_locale || DEFAULT_SLUG_LOCALE;
}

/** First non-empty `sanitizeTitle` result among `candidates`, or ''. */
export function slugFromCandidates(
  candidates: ReadonlyArray<string | null | undefined>,
  locale: string,
): string {
  for (const c of candidates) {
    if (typeof c !== 'string' || !c.trim()) continue;
    const s = sanitizeTitle(c, { locale });
    if (s) return s;
  }
  return '';
}

/** WP's id fallback: `<prefix>-<first 8 hex of the id>` (a fresh id when unknown). */
export function idFallbackSlug(prefix: string, id?: string | null): string {
  const hex = (id || randomUUID()).replace(/[^0-9a-f]/gi, '').toLowerCase();
  return `${prefix}-${hex.slice(0, 8) || '0'}`;
}

/**
 * Slug base for a write: the stored slug when the client sent it back
 * unchanged, else the first usable candidate, else the id fallback.
 * `keep` is true when the stored slug is kept as is (no uniqueness check
 * needed: it already passed one when it was written).
 */
export function resolveSlugBase(opts: {
  candidates: ReadonlyArray<string | null | undefined>;
  locale: string;
  stored?: string | null;
  prefix: string;
  id?: string | null;
}): { slug: string; keep: boolean } {
  const first = opts.candidates[0];
  if (opts.stored && typeof first === 'string' && first === opts.stored) {
    return { slug: opts.stored, keep: true };
  }
  const s = slugFromCandidates(opts.candidates, opts.locale);
  if (s && opts.stored && s === opts.stored) return { slug: s, keep: true };
  return { slug: s || idFallbackSlug(opts.prefix, opts.id), keep: false };
}

/**
 * Whether a stored slug is what the WP rule would store for it. A stored
 * decoded slug is re-sanitized in its encoded form (WP's stable form), so
 * `straße` or `kläder` (imported from WP) count as valid.
 */
export function isWpSlug(
  stored: string | null | undefined,
  locale: string,
): boolean {
  if (!stored) return false;
  if (encodedLength(stored) > SLUG_MAX_BYTES) return false;
  return sanitizeTitle(encodeSlugForUrl(stored), { locale }) === stored;
}

/** Incoming slug of a storefront lookup in its stored form (decode, NFC, lower case). */
export function lookupSlug(raw: string): string {
  return normalizeSlugForLookup(raw);
}

/**
 * Prisma `slug` filters of a storefront lookup, tried in order until one
 * finds a row: first an exact match on the stored form (and its NFD
 * spelling, for legacy rows saved un-normalized), then, only when that
 * missed, a case-insensitive match, so legacy slugs with capitals that older
 * edit screens accepted stay reachable. New slugs are always lower case and
 * NFC, so the fallback query runs only for legacy rows or real 404s.
 */
export function slugLookupFilters(
  raw: string,
): [Prisma.StringFilter, Prisma.StringFilter] {
  const nfc = lookupSlug(raw);
  const forms = [...new Set([nfc, nfc.normalize('NFD')])];
  return [
    forms.length === 1 ? { equals: nfc } : { in: forms },
    { equals: nfc, mode: 'insensitive' },
  ];
}

/**
 * Runs a storefront lookup with the exact filter, then (only on a miss) with
 * the case-insensitive one (slugLookupFilters).
 */
export async function findBySlugTolerant<T>(
  raw: string,
  find: (slug: Prisma.StringFilter) => Promise<T | null>,
): Promise<T | null> {
  const [exact, insensitive] = slugLookupFilters(raw);
  return (await find(exact)) ?? (await find(insensitive));
}

/** Public path segment of a slug (percent-encoded, lowercase hex like WP permalinks). */
export function slugPathSegment(slug: string): string {
  return encodeSlugForUrl(slug);
}

/** True for a Prisma unique-constraint violation. */
export function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

/**
 * Runs a slug write; on a unique-constraint race (P2002) runs it once more,
 * so `fn` recomputes the unique slug against the row that won the race.
 */
export async function withSlugRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return fn();
  }
}

// ── Uniqueness domains ─────────────────────────────────────────────────────

/** Who owns a product slug: the storefront resolves `/products/<slug>` per creator. */
export interface ProductSlugOwner {
  creatorId?: string | null;
  providerId?: string | null;
}

/** Slug owner of a product row (creator first, then provider; neither = platform). */
export function productSlugOwner(p: {
  creator_id?: string | null;
  provider_id?: string | null;
}): ProductSlugOwner {
  return p.creator_id
    ? { creatorId: p.creator_id }
    : { providerId: p.provider_id ?? null };
}

/**
 * Unique product slug. Domain = what `/products/<slug>` resolves
 * (storefront productBySlugQuery): every translation slug, in any locale and
 * any status, of the creator's own products AND custom products. The product
 * being written is excluded, so its locales may share one slug. Provider
 * products (no storefront URL of their own) are unique per provider, and
 * products without an owner among themselves.
 * `alsoTaken` holds slugs already handed out in the same batch.
 */
export async function uniqueProductSlug(
  db: SlugDb,
  owner: ProductSlugOwner,
  base: string,
  exclude: { productId?: string | null; customProductId?: string | null } = {},
  alsoTaken: ReadonlySet<string> = new Set(),
): Promise<string> {
  return uniqueSlug(base, async (slug) => {
    if (alsoTaken.has(slug)) return true;
    if (owner.creatorId) {
      const [own, custom] = await Promise.all([
        db.productTranslation.findFirst({
          where: {
            slug,
            product: {
              creator_id: owner.creatorId,
              ...(exclude.productId ? { id: { not: exclude.productId } } : {}),
            },
          },
          select: { id: true },
        }),
        db.customProductTranslation.findFirst({
          where: {
            slug,
            custom_product: {
              creator_id: owner.creatorId,
              ...(exclude.customProductId
                ? { id: { not: exclude.customProductId } }
                : {}),
            },
          },
          select: { id: true },
        }),
      ]);
      return !!own || !!custom;
    }
    const own = await db.productTranslation.findFirst({
      where: {
        slug,
        product: {
          provider_id: owner.providerId ?? null,
          creator_id: null,
          ...(exclude.productId ? { id: { not: exclude.productId } } : {}),
        },
      },
      select: { id: true },
    });
    return !!own;
  });
}

/**
 * Unique collection slug. Domain = the DB constraint (creator_id, slug); the
 * storefront `?creator_category=<slug>` filter resolves the same way. Like
 * WP hierarchical terms, `<slug>-<parent>`, `<slug>-<parent>-<grandparent>`
 * are tried before `-N`; terms have no reserved list.
 */
export async function uniqueCollectionSlug(
  db: SlugDb,
  creatorId: string,
  base: string,
  ancestorSlugs: readonly string[],
  excludeId?: string | null,
): Promise<string> {
  const alt: string[] = [];
  let acc = base;
  for (const a of ancestorSlugs) {
    acc = `${acc}-${a}`;
    alt.push(acc);
  }
  return uniqueSlug(
    base,
    async (slug) =>
      !!(await db.creatorCategory.findFirst({
        where: {
          creator_id: creatorId,
          slug,
          ...(excludeId ? { id: { not: excludeId } } : {}),
        },
        select: { id: true },
      })),
    { reserved: [], alt },
  );
}

/**
 * Unique v2 page slug (STATIC/LANDING, served at `/<slug>`). Domain = the DB
 * constraint (store_id, slug) of v2 pages. Legacy StaticPage slugs are NOT in
 * it: upgrading a legacy page to v2 reuses its slug on purpose and the v2 page
 * wins at `/<slug>` (storefront getStore / getPublishedPage).
 */
export async function uniqueV2PageSlug(
  db: SlugDb,
  storeId: string,
  base: string,
  excludeId?: string | null,
): Promise<string> {
  return uniqueSlug(
    base,
    async (slug) =>
      !!(await db.page.findFirst({
        where: {
          store_id: storeId,
          slug,
          ...(excludeId ? { id: { not: excludeId } } : {}),
        },
        select: { id: true },
      })),
    { reserved: PAGE_RESERVED_SLUGS, numericNeedsSuffix: true },
  );
}

/**
 * Unique legacy StaticPage slug. Domain = legacy pages of the store (DB
 * constraint) plus v2 page slugs, because a v2 page would shadow a new legacy
 * page at `/<slug>`.
 */
export async function uniqueStaticPageSlug(
  db: SlugDb,
  storeId: string,
  base: string,
  excludeId?: string | null,
): Promise<string> {
  return uniqueSlug(
    base,
    async (slug) => {
      const [legacy, v2] = await Promise.all([
        db.staticPage.findFirst({
          where: {
            store_id: storeId,
            slug,
            ...(excludeId ? { id: { not: excludeId } } : {}),
          },
          select: { id: true },
        }),
        db.page.findFirst({
          where: { store_id: storeId, slug },
          select: { id: true },
        }),
      ]);
      return !!legacy || !!v2;
    },
    { reserved: PAGE_RESERVED_SLUGS, numericNeedsSuffix: true },
  );
}

/** Unique platform Category slug (global `@unique`, not served on store URLs). */
export async function uniquePlatformCategorySlug(
  db: SlugDb,
  base: string,
  excludeId?: string | null,
): Promise<string> {
  return uniqueSlug(
    base,
    async (slug) =>
      !!(await db.category.findFirst({
        where: { slug, ...(excludeId ? { id: { not: excludeId } } : {}) },
        select: { id: true },
      })),
    { reserved: [] },
  );
}

/**
 * Whether `/<slug>` is still served by a root page of the store other than
 * the excluded ones: a v2 STATIC/LANDING page with a published snapshot or a
 * PUBLISHED legacy StaticPage (storefront getPublishedPage / getPage). An
 * old-slug redirect from a served path would shadow that page.
 */
export async function isRootPageSlugServed(
  db: SlugDb,
  storeId: string,
  slug: string,
  exclude: { pageId?: string | null; staticPageId?: string | null } = {},
): Promise<boolean> {
  const [v2, legacy] = await Promise.all([
    db.page.findFirst({
      where: {
        store_id: storeId,
        slug,
        published_version_id: { not: null },
        ...(exclude.pageId ? { id: { not: exclude.pageId } } : {}),
      },
      select: { id: true },
    }),
    db.staticPage.findFirst({
      where: {
        store_id: storeId,
        slug,
        status: 'PUBLISHED',
        ...(exclude.staticPageId ? { id: { not: exclude.staticPageId } } : {}),
      },
      select: { id: true },
    }),
  ]);
  return !!v2 || !!legacy;
}

/** Translation titles with the store's primary locale first (slug fallbacks). */
export function titlesPrimaryFirst(
  translations: readonly { locale: string; title?: string | null }[],
  locale: string,
): (string | null | undefined)[] {
  return [
    ...translations.filter((t) => t.locale === locale),
    ...translations.filter((t) => t.locale !== locale),
  ].map((t) => t.title);
}

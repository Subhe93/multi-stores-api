/**
 * Pure planning half of legacy-slugs-fix.ts (no database access): snapshot
 * types, CLI parsing, which stored slugs break the WordPress slug rules
 * (plans/slug-wp-rules/prod-slug-inventory.sql reasons `dashes`,
 * `uppercase`, `duplicate`, plus blank slugs), the repaired slug of each,
 * the old-slug 301 moves of published products, the fingerprint and the
 * report.
 *
 * Rules (plans/slug-wp-rules/PLAN.md §5, §6, §8):
 * - Sanitizer locale = the store's primary content locale (the WP site
 *   locale), `en` for provider products, as the app does (wp-slug.ts).
 * - Blank slug (`''` or only dashes): sanitizeTitle(title), else the EN
 *   title, else `product-<id8>`.
 * - Edge / doubled dashes or uppercase: the collapsed slug (the stored slug
 *   re-sanitized in its encoded form) unless the title-derived slug contains
 *   it as a subsequence (same words, letters an old slugify dropped:
 *   `frn` -> `fran`), then the title-derived slug. A slug the merchant chose
 *   unlike the title is only collapsed, never replaced.
 * - Duplicates in a lookup domain (what `/products/<slug>` resolves: own +
 *   custom products of one creator, every locale, as uniqueProductSlug and
 *   the inventory; provider products per provider): the PUBLISHED entity
 *   keeps the slug (oldest first when several are), the others get `-2`,
 *   `-3`, ... (WP uniqueSlug).
 * - Uniqueness: uniqueSlug against every slug other entities of the domain
 *   hold now or are planned to hold (old slugs stay taken, so a new slug
 *   never lands on a path that a 301 of this run starts from).
 * - 301s: only PUBLISHED entities of an existing store, via productSlugMoves
 *   (unprefixed + `/<locale>/` forms, the app's rule), minus old slugs that
 *   another entity of the domain still serves after the fix. The first move
 *   of a path in a store wins (the entities are processed keeper first).
 * - Platform categories (`--include-categories`): lower-cased / collapsed via
 *   sanitizeTitle, unique globally; never a redirect (not on store URLs).
 */
import { createHash } from 'crypto';
import {
  encodeSlugForUrl,
  sanitizeTitle,
  uniqueSlug,
} from '@multi-stores/core/slug';
import {
  productSlugMoves,
  productPath,
  type LocaleSlug,
  type PathMove,
} from '../../src/common/slug/slug-moves';

// ── Snapshot ────────────────────────────────────────────────────────────────

export type EntityKind = 'product' | 'custom_product';

export interface SnapTranslation {
  id: string;
  locale: string;
  title: string;
  slug: string;
}

export interface SnapStore {
  id: string;
  slug: string;
  primary_locale: string;
}

/** An own product or custom product with all of its translations. */
export interface SnapEntity {
  kind: EntityKind;
  id: string;
  creator_id: string | null;
  provider_id: string | null;
  /** The creator's store (null for provider products or a creator without one). */
  store: SnapStore | null;
  status: string;
  /** ISO timestamp (the older PUBLISHED entity keeps a duplicate slug). */
  created_at: string;
  translations: SnapTranslation[];
}

export interface SnapCategory {
  id: string;
  slug: string;
  is_active: boolean;
  /** Translation names, EN first (fallback when the slug sanitizes to ''). */
  names: string[];
}

export interface Snapshot {
  entities: SnapEntity[];
  /** Platform categories; empty unless `--include-categories`. */
  categories: SnapCategory[];
}

// ── Plan ────────────────────────────────────────────────────────────────────

export type Reason = 'blank' | 'dashes' | 'uppercase' | 'duplicate';

export interface PlannedChange {
  entity: EntityKind | 'category';
  /** Entity id (product / custom product / category). */
  id: string;
  /** Translation row id written (category id for categories). */
  row_id: string;
  store_slug: string | null;
  locale: string | null;
  status: string;
  old_slug: string;
  new_slug: string;
  reasons: Reason[];
  redirect: boolean;
}

export interface StoreMoves {
  store_id: string;
  store_slug: string;
  moves: PathMove[];
}

export interface Plan {
  changes: PlannedChange[];
  redirects: StoreMoves[];
  counts: {
    product: number;
    custom_product: number;
    category: number;
    with_redirect: number;
    redirect_moves: number;
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export interface Options {
  mode: 'dry-run' | 'apply';
  fingerprint: string | null;
  onlyStore: string | null;
  includeCategories: boolean;
}

export function parseArgs(argv: string[]): Options {
  const out: Options = {
    mode: 'dry-run',
    fingerprint: null,
    onlyStore: null,
    includeCategories: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (flag: string): string => {
      if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (a === '--dry-run') out.mode = 'dry-run';
    else if (a === '--apply') out.mode = 'apply';
    else if (a === '--include-categories') out.includeCategories = true;
    else if (a === '--only-store' || a.startsWith('--only-store='))
      out.onlyStore = value('--only-store').trim() || null;
    else if (a === '--fingerprint' || a.startsWith('--fingerprint='))
      out.fingerprint = value('--fingerprint').trim() || null;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (out.mode === 'apply' && !out.fingerprint)
    throw new Error('--apply needs --fingerprint=<hash> from a dry run');
  return out;
}

// ── Rules ───────────────────────────────────────────────────────────────────

const DEFAULT_LOCALE = 'en';

/** Reasons a slug breaks the rule by itself (duplicates are found per domain). */
export function slugReasons(slug: string): Reason[] {
  if (/^-*$/.test(slug)) return ['blank'];
  const out: Reason[] = [];
  if (/(^-|-$|--)/.test(slug)) out.push('dashes');
  if (slug !== slug.toLowerCase()) out.push('uppercase');
  return out;
}

/** True when every character of `needle` appears in `hay` in order. */
export function isSubsequence(needle: string, hay: string): boolean {
  const n = [...needle];
  let i = 0;
  for (const ch of hay) {
    if (i < n.length && ch === n[i]) i++;
  }
  return i === n.length;
}

function idFallback(prefix: string, id: string): string {
  const hex = id.replace(/[^0-9a-f]/gi, '').toLowerCase();
  return `${prefix}-${hex.slice(0, 8) || '0'}`;
}

/** The stored slug re-sanitized in its stable (encoded) form: lower case, dashes collapsed. */
export function collapseSlug(slug: string, locale: string): string {
  return sanitizeTitle(encodeSlugForUrl(slug), { locale });
}

/**
 * Base of the repaired slug (before uniqueness).
 * `enTitle` is the entity's EN translation title (blank fallback).
 */
export function repairBase(opts: {
  slug: string;
  title: string;
  enTitle: string | null;
  locale: string;
  reasons: readonly Reason[];
  prefix: string;
  id: string;
}): string {
  const fromTitle = sanitizeTitle(opts.title || '', { locale: opts.locale });
  if (opts.reasons.includes('blank')) {
    return (
      fromTitle ||
      sanitizeTitle(opts.enTitle || '', { locale: opts.locale }) ||
      idFallback(opts.prefix, opts.id)
    );
  }
  if (opts.reasons.includes('dashes') || opts.reasons.includes('uppercase')) {
    const collapsed = collapseSlug(opts.slug, opts.locale);
    if (fromTitle && (!collapsed || isSubsequence(collapsed, fromTitle)))
      return fromTitle;
    return collapsed || idFallback(opts.prefix, opts.id);
  }
  return opts.slug; // duplicate only: suffixed by uniqueSlug
}

function domainOf(e: SnapEntity): string {
  return e.creator_id ? `cr:${e.creator_id}` : `prov:${e.provider_id ?? '-'}`;
}

const entityKey = (e: Pick<SnapEntity, 'kind' | 'id'>) => `${e.kind}:${e.id}`;

/** Keeper order of a duplicate: PUBLISHED first, then oldest, then kind, then id. */
function rankCompare(a: SnapEntity, b: SnapEntity): number {
  const pa = a.status === 'PUBLISHED' ? 0 : 1;
  const pb = b.status === 'PUBLISHED' ? 0 : 1;
  if (pa !== pb) return pa - pb;
  if (a.created_at !== b.created_at)
    return a.created_at < b.created_at ? -1 : 1;
  if (a.kind !== b.kind) return a.kind === 'product' ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ── Planner ─────────────────────────────────────────────────────────────────

export async function buildPlan(snap: Snapshot): Promise<Plan> {
  const changes: PlannedChange[] = [];
  const movesByStore = new Map<string, StoreMoves>();

  // Group entities per lookup domain.
  const domains = new Map<string, SnapEntity[]>();
  for (const e of snap.entities) {
    const d = domainOf(e);
    const list = domains.get(d) ?? [];
    list.push(e);
    domains.set(d, list);
  }

  for (const d of [...domains.keys()].sort()) {
    const entities = [...domains.get(d)!].sort(rankCompare);

    // Occupancy: slug -> entities holding it (now or planned).
    const occupied = new Map<string, Set<string>>();
    const occupy = (slug: string, key: string) => {
      const set = occupied.get(slug) ?? new Set<string>();
      set.add(key);
      occupied.set(slug, set);
    };
    for (const e of entities)
      for (const t of e.translations) occupy(t.slug, entityKey(e));
    const takenByOther = (slug: string, key: string) =>
      [...(occupied.get(slug) ?? [])].some((k) => k !== key);

    // Duplicates: the first entity (rank order) holding a slug keeps it.
    const keeperOf = new Map<string, string>();
    for (const e of entities)
      for (const t of e.translations)
        if (!keeperOf.has(t.slug)) keeperOf.set(t.slug, entityKey(e));

    const after = new Map<string, LocaleSlug[]>();
    const entityChanges = new Map<string, PlannedChange[]>();

    for (const e of entities) {
      const key = entityKey(e);
      const locale = e.store?.primary_locale || DEFAULT_LOCALE;
      const enTitle =
        e.translations.find((t) => t.locale.toLowerCase() === 'en')?.title ??
        null;
      const translations = [...e.translations].sort((a, b) =>
        a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0,
      );
      const result: LocaleSlug[] = [];
      for (const t of translations) {
        const reasons = slugReasons(t.slug);
        if (keeperOf.get(t.slug) !== key && !reasons.includes('blank'))
          reasons.push('duplicate');
        if (!reasons.length) {
          result.push({ locale: t.locale, slug: t.slug });
          continue;
        }
        const base = repairBase({
          slug: t.slug,
          title: t.title,
          enTitle,
          locale,
          reasons,
          prefix: 'product',
          id: e.id,
        });
        const next = await uniqueSlug(base, (c) => takenByOther(c, key));
        occupy(next, key);
        result.push({ locale: t.locale, slug: next });
        if (next === t.slug) continue;
        const change: PlannedChange = {
          entity: e.kind,
          id: e.id,
          row_id: t.id,
          store_slug: e.store?.slug ?? null,
          locale: t.locale,
          status: e.status,
          old_slug: t.slug,
          new_slug: next,
          reasons,
          redirect: false,
        };
        changes.push(change);
        const list = entityChanges.get(key) ?? [];
        list.push(change);
        entityChanges.set(key, list);
      }
      after.set(key, result);
    }

    // 301s of published entities whose old slug nobody serves any more.
    const liveAfter = new Map<string, Set<string>>();
    for (const [key, list] of after)
      for (const t of list) {
        const set = liveAfter.get(t.slug) ?? new Set<string>();
        set.add(key);
        liveAfter.set(t.slug, set);
      }
    for (const e of entities) {
      const key = entityKey(e);
      const changed = entityChanges.get(key);
      if (!changed || !e.store || e.status !== 'PUBLISHED') continue;
      const before = e.translations
        .map((t) => ({ locale: t.locale, slug: t.slug }))
        .filter(
          (t) => ![...(liveAfter.get(t.slug) ?? [])].some((k) => k !== key),
        );
      const moves = productSlugMoves({
        primaryLocale: e.store.primary_locale || DEFAULT_LOCALE,
        before,
        after: after.get(key)!,
      });
      if (!moves.length) continue;
      const bucket = movesByStore.get(e.store.id) ?? {
        store_id: e.store.id,
        store_slug: e.store.slug,
        moves: [],
      };
      movesByStore.set(e.store.id, bucket);
      const taken = new Set(bucket.moves.map((m) => m.from));
      const kept = moves.filter((m) => !taken.has(m.from));
      bucket.moves.push(...kept);
      const froms = new Set(kept.map((m) => m.from));
      for (const c of changed)
        c.redirect =
          froms.has(productPath(c.old_slug)) ||
          (!!c.locale && froms.has(productPath(c.old_slug, c.locale)));
    }
  }

  // Platform categories: global unique slug, no redirect.
  const catOccupied = new Map<string, Set<string>>();
  for (const c of snap.categories) {
    const set = catOccupied.get(c.slug) ?? new Set<string>();
    set.add(c.id);
    catOccupied.set(c.slug, set);
  }
  const cats = [...snap.categories].sort((a, b) =>
    a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : a.id < b.id ? -1 : 1,
  );
  for (const c of cats) {
    const reasons = slugReasons(c.slug);
    if (!reasons.length) continue;
    const collapsed = collapseSlug(c.slug, DEFAULT_LOCALE);
    const base =
      collapsed ||
      c.names
        .map((n) => sanitizeTitle(n || '', { locale: DEFAULT_LOCALE }))
        .find(Boolean) ||
      idFallback('category', c.id);
    const next = await uniqueSlug(
      base,
      (s) => [...(catOccupied.get(s) ?? [])].some((id) => id !== c.id),
      { reserved: [] },
    );
    const set = catOccupied.get(next) ?? new Set<string>();
    set.add(c.id);
    catOccupied.set(next, set);
    if (next === c.slug) continue;
    changes.push({
      entity: 'category',
      id: c.id,
      row_id: c.id,
      store_slug: null,
      locale: null,
      status: c.is_active ? 'ACTIVE' : 'INACTIVE',
      old_slug: c.slug,
      new_slug: next,
      reasons,
      redirect: false,
    });
  }

  const redirects = [...movesByStore.values()]
    .filter((s) => s.moves.length)
    .sort((a, b) => (a.store_slug < b.store_slug ? -1 : 1));
  return {
    changes,
    redirects,
    counts: {
      product: changes.filter((c) => c.entity === 'product').length,
      custom_product: changes.filter((c) => c.entity === 'custom_product')
        .length,
      category: changes.filter((c) => c.entity === 'category').length,
      with_redirect: changes.filter((c) => c.redirect).length,
      redirect_moves: redirects.reduce((n, s) => n + s.moves.length, 0),
    },
  };
}

export function isNoop(plan: Plan): boolean {
  return plan.changes.length === 0;
}

/** sha256 (first 16 hex) of the sorted planned changes and 301 moves. */
export function fingerprint(plan: Plan): string {
  const lines = [
    ...plan.changes.map((c) =>
      [
        'c',
        c.entity,
        c.row_id,
        c.locale ?? '',
        c.old_slug,
        c.new_slug,
        c.redirect ? 1 : 0,
      ].join('\t'),
    ),
    ...plan.redirects.flatMap((s) =>
      s.moves.map((m) => ['r', s.store_id, m.from, m.to].join('\t')),
    ),
  ].sort();
  return createHash('sha256')
    .update(lines.join('\n'))
    .digest('hex')
    .slice(0, 16);
}

/** Report: one line per change (no titles; ids shortened to 8 characters). */
export function renderPlan(plan: Plan): string {
  if (isNoop(plan)) return 'Nothing to fix.';
  const head = [
    'store',
    'entity',
    'id8',
    'locale',
    'status',
    'old → new',
    'redirect',
  ];
  const rows = [...plan.changes]
    .sort(
      (a, b) =>
        (a.store_slug ?? '~').localeCompare(b.store_slug ?? '~') ||
        a.entity.localeCompare(b.entity) ||
        a.old_slug.localeCompare(b.old_slug) ||
        (a.locale ?? '').localeCompare(b.locale ?? ''),
    )
    .map((c) => [
      c.store_slug ?? '-',
      c.entity,
      c.id.slice(0, 8),
      c.locale ?? '-',
      c.status,
      `${c.old_slug} → ${c.new_slug}  [${c.reasons.join(',')}]`,
      c.redirect ? 'yes' : 'no',
    ]);
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => [...r[i]].length)),
  );
  const fmt = (r: string[]) =>
    r
      .map((v, i) =>
        i === r.length - 1 ? v : v + ' '.repeat(widths[i] - [...v].length),
      )
      .join('  ');
  const c = plan.counts;
  return [
    fmt(head),
    ...rows.map(fmt),
    '',
    `Totals: ${plan.changes.length} slugs (product ${c.product}, custom_product ${c.custom_product}, category ${c.category}); ` +
      `${c.with_redirect} with a 301, ${c.redirect_moves} redirect paths in ${plan.redirects.length} stores`,
  ].join('\n');
}

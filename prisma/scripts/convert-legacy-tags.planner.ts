/**
 * Pure planning half of convert-legacy-tags.ts (no database access): the
 * snapshot types, CLI argument parsing, the per-tag decision (reuse an
 * INTERNAL row by name or create one), the links to add, the smart
 * collections (`match_rule = TAGS`) whose legacy string `match_tags` become
 * INTERNAL row ids, the plan fingerprint and the masked report.
 *
 * See plans/tags-rename/PLAN.md (section C1 and D).
 */
import { createHash } from 'crypto';
import { slugFromCandidates } from '../../src/common/slug/wp-slug';

// ── Snapshot (what the loader reads from the database) ──────────────────────

export interface SnapStore {
  id: string;
  slug: string;
  creator_id: string;
  primary_locale: string;
}

/** An own product of the creator with its legacy ProductTag strings. */
export interface SnapProduct {
  id: string;
  title: string;
  tags: string[];
}

/** A custom product of the creator; its tags are the base product's. */
export interface SnapCustomProduct {
  id: string;
  base_product_id: string;
  title: string;
  tags: string[];
}

/** An existing INTERNAL CreatorCategory row (tag) of the creator. */
export interface SnapInternalRow {
  id: string;
  slug: string;
  /** Primary-locale name, null when that translation is missing. */
  name: string | null;
}

export interface SnapLink {
  owner_id: string;
  creator_category_id: string;
  sort_order: number;
}

/** A `match_rule = TAGS` collection and its stored `match_tags` values. */
export interface SnapTagsCollection {
  id: string;
  slug: string;
  match_tags: string[];
}

export interface Snapshot {
  store: SnapStore;
  products: SnapProduct[];
  custom_products: SnapCustomProduct[];
  internal_rows: SnapInternalRow[];
  /** Every collection slug of the creator (PUBLIC and INTERNAL). */
  all_slugs: string[];
  /** Highest sort_order among the creator's root rows (-1 when none). */
  max_root_sort_order: number;
  product_links: SnapLink[];
  custom_product_links: SnapLink[];
  tags_collections: SnapTagsCollection[];
}

// ── Plan ────────────────────────────────────────────────────────────────────

export interface PlannedTag {
  /** Grouping key: trimmed, lower-cased tag string. */
  key: string;
  /** Display name: the most common original spelling (tie = first seen). */
  name: string;
  action: 'REUSE' | 'CREATE';
  /** Existing INTERNAL row id (REUSE) or null (CREATE). */
  id: string | null;
  /** Slug of the row to create (CREATE only; WP rules, `-2` when taken). */
  slug: string | null;
  sort_order: number | null;
  product_ids: string[];
  custom_product_ids: string[];
}

export interface PlannedLink {
  kind: 'product' | 'custom_product';
  owner_id: string;
  tag_key: string;
  sort_order: number;
}

export interface PlannedCollection {
  id: string;
  slug: string;
  before: string[];
  /** INTERNAL ids, or `new:<key>` for a row this plan creates. */
  after: string[];
}

export interface Plan {
  store: SnapStore;
  tags: PlannedTag[];
  links: PlannedLink[];
  collections: PlannedCollection[];
  counts: {
    products_with_tags: number;
    custom_products_with_tags: number;
    distinct_tags: number;
    tags_reused: number;
    tags_created: number;
    links_existing: number;
    links_to_add: number;
    collections_to_convert: number;
  };
}

export interface Options {
  store: string | null;
  mode: 'dry-run' | 'apply';
  fingerprint: string | null;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): Options {
  const out: Options = { store: null, mode: 'dry-run', fingerprint: null };
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
    else if (a === '--store' || a.startsWith('--store='))
      out.store = value('--store').trim();
    else if (a === '--fingerprint' || a.startsWith('--fingerprint='))
      out.fingerprint = value('--fingerprint').trim();
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!out.store) throw new Error('--store <slug> is required');
  return out;
}

// ── Planner ─────────────────────────────────────────────────────────────────

export const tagKey = (raw: string): string => raw.trim().toLowerCase();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Group {
  key: string;
  spellings: Map<string, number>;
  first: string;
  product_ids: Set<string>;
  custom_product_ids: Set<string>;
}

function groupTags(snap: Snapshot): Map<string, Group> {
  const groups = new Map<string, Group>();
  const touch = (raw: string): Group | null => {
    const key = tagKey(raw);
    if (!key) return null;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        spellings: new Map(),
        first: raw.trim(),
        product_ids: new Set(),
        custom_product_ids: new Set(),
      };
      groups.set(key, g);
    }
    const spelled = raw.trim();
    g.spellings.set(spelled, (g.spellings.get(spelled) ?? 0) + 1);
    return g;
  };
  for (const p of snap.products)
    for (const t of p.tags) touch(t)?.product_ids.add(p.id);
  for (const cp of snap.custom_products)
    for (const t of cp.tags) touch(t)?.custom_product_ids.add(cp.id);
  // Legacy strings of smart collections need a row too, even when no
  // product carries them any more (the rule must keep pointing somewhere).
  const internalIds = new Set(snap.internal_rows.map((r) => r.id));
  for (const c of snap.tags_collections)
    for (const v of c.match_tags)
      if (!(UUID_RE.test(v) && internalIds.has(v))) touch(v);
  return groups;
}

function bestSpelling(g: Group): string {
  let best = g.first;
  let n = -1;
  for (const [s, count] of g.spellings) {
    if (count > n) {
      best = s;
      n = count;
    }
  }
  return best;
}

function firstFreeSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const s = `${base}-${n}`;
    if (!taken.has(s)) return s;
  }
  throw new Error(`no free slug for ${base}`);
}

export function buildPlan(snap: Snapshot): Plan {
  const groups = [...groupTags(snap).values()].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  const byName = new Map<string, SnapInternalRow>();
  for (const r of [...snap.internal_rows].sort((a, b) =>
    a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0,
  )) {
    const k = tagKey(r.name ?? '');
    if (k && !byName.has(k)) byName.set(k, r);
  }
  const taken = new Set(snap.all_slugs);
  let nextSort = snap.max_root_sort_order + 1;
  const tags: PlannedTag[] = [];
  let created = 0;
  for (const g of groups) {
    const name = bestSpelling(g);
    const existing = byName.get(g.key);
    if (existing) {
      tags.push({
        key: g.key,
        name,
        action: 'REUSE',
        id: existing.id,
        slug: null,
        sort_order: null,
        product_ids: [...g.product_ids].sort(),
        custom_product_ids: [...g.custom_product_ids].sort(),
      });
      continue;
    }
    const base =
      slugFromCandidates([name], snap.store.primary_locale) ||
      `tag-${++created}`;
    const slug = firstFreeSlug(base, taken);
    taken.add(slug);
    tags.push({
      key: g.key,
      name,
      action: 'CREATE',
      id: null,
      slug,
      sort_order: nextSort++,
      product_ids: [...g.product_ids].sort(),
      custom_product_ids: [...g.custom_product_ids].sort(),
    });
  }

  // Links to add: skip existing ones; sort_order appended per owner.
  const linkKey = (owner: string, cc: string) => `${owner}|${cc}`;
  const have = {
    product: new Set(
      snap.product_links.map((l) => linkKey(l.owner_id, l.creator_category_id)),
    ),
    custom_product: new Set(
      snap.custom_product_links.map((l) =>
        linkKey(l.owner_id, l.creator_category_id),
      ),
    ),
  };
  const maxSort = new Map<string, number>();
  for (const l of [...snap.product_links, ...snap.custom_product_links]) {
    const k = `${l.owner_id}`;
    maxSort.set(k, Math.max(maxSort.get(k) ?? -1, l.sort_order));
  }
  const links: PlannedLink[] = [];
  let existing = 0;
  const addLinks = (
    kind: PlannedLink['kind'],
    owners: string[],
    t: PlannedTag,
  ) => {
    for (const owner of owners) {
      // A REUSE row may already be linked; a CREATE row never is.
      if (t.id && have[kind].has(linkKey(owner, t.id))) {
        existing++;
        continue;
      }
      const sort = (maxSort.get(owner) ?? -1) + 1;
      maxSort.set(owner, sort);
      links.push({ kind, owner_id: owner, tag_key: t.key, sort_order: sort });
    }
  };
  for (const t of tags) {
    addLinks('product', t.product_ids, t);
    addLinks('custom_product', t.custom_product_ids, t);
  }

  // Smart collections: legacy strings → INTERNAL ids.
  const internalIds = new Set(snap.internal_rows.map((r) => r.id));
  const tagByKey = new Map(tags.map((t) => [t.key, t]));
  const collections: PlannedCollection[] = [];
  for (const c of snap.tags_collections) {
    const after: string[] = [];
    let changed = false;
    for (const v of c.match_tags) {
      if (UUID_RE.test(v) && internalIds.has(v)) {
        if (!after.includes(v)) after.push(v);
        continue;
      }
      const t = tagByKey.get(tagKey(v));
      if (!t) continue; // empty string
      const ref = t.id ?? `new:${t.key}`;
      if (!after.includes(ref)) after.push(ref);
      changed = true;
    }
    if (changed)
      collections.push({ id: c.id, slug: c.slug, before: c.match_tags, after });
  }

  return {
    store: snap.store,
    tags,
    links,
    collections,
    counts: {
      products_with_tags: snap.products.filter((p) =>
        p.tags.some((t) => tagKey(t)),
      ).length,
      custom_products_with_tags: snap.custom_products.filter((p) =>
        p.tags.some((t) => tagKey(t)),
      ).length,
      distinct_tags: tags.length,
      tags_reused: tags.filter((t) => t.action === 'REUSE').length,
      tags_created: tags.filter((t) => t.action === 'CREATE').length,
      links_existing: existing,
      links_to_add: links.length,
      collections_to_convert: collections.length,
    },
  };
}

/** True when the plan writes nothing (second run after --apply). */
export function isNoop(plan: Plan): boolean {
  return (
    plan.counts.tags_created === 0 &&
    plan.counts.links_to_add === 0 &&
    plan.counts.collections_to_convert === 0
  );
}

export function fingerprint(plan: Plan): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        store: plan.store.id,
        tags: plan.tags,
        links: plan.links,
        collections: plan.collections,
      }),
    )
    .digest('hex')
    .slice(0, 16);
}

// ── Report ──────────────────────────────────────────────────────────────────

/** Product titles are masked (first 3 characters + length); tag names are the subject of the review and printed as they are. */
export function maskTitle(title: string): string {
  const t = title.trim();
  if (!t) return '(untitled)';
  return `${t.slice(0, 3)}…(${t.length})`;
}

export function renderPlan(
  plan: Plan,
  titles: Map<string, string>,
  opts: { maxLinks?: number } = {},
): string {
  const lines: string[] = [];
  const c = plan.counts;
  lines.push(
    `Store ${plan.store.slug} (${plan.store.id.slice(0, 8)}…), locale ${plan.store.primary_locale}`,
  );
  lines.push(
    `Products with legacy tags: ${c.products_with_tags} own, ${c.custom_products_with_tags} custom; distinct tags: ${c.distinct_tags}`,
  );
  lines.push('');
  lines.push('Tags:');
  for (const t of plan.tags) {
    const owners = t.product_ids.length + t.custom_product_ids.length;
    lines.push(
      t.action === 'REUSE'
        ? `  REUSE  "${t.name}" → existing tag ${t.id!.slice(0, 8)}… (${owners} products)`
        : `  CREATE "${t.name}" slug=${t.slug} sort=${t.sort_order} (${owners} products)`,
    );
  }
  lines.push('');
  lines.push(
    `Links: ${c.links_to_add} to add, ${c.links_existing} already present`,
  );
  const max = opts.maxLinks ?? 50;
  for (const l of plan.links.slice(0, max)) {
    const title = titles.get(l.owner_id) ?? '';
    lines.push(
      `  + ${l.kind} ${l.owner_id.slice(0, 8)}… ${maskTitle(title)} ← "${l.tag_key}" (sort ${l.sort_order})`,
    );
  }
  if (plan.links.length > max)
    lines.push(`  … ${plan.links.length - max} more`);
  lines.push('');
  lines.push(
    `Smart collections (TAGS rule) to convert: ${c.collections_to_convert}`,
  );
  for (const col of plan.collections)
    lines.push(
      `  ${col.slug} (${col.id.slice(0, 8)}…): [${col.before.join(', ')}] → [${col.after.join(', ')}]`,
    );
  lines.push('');
  lines.push(
    `Summary: tags reuse=${c.tags_reused} create=${c.tags_created}; links add=${c.links_to_add}; collections=${c.collections_to_convert}`,
  );
  return lines.join('\n');
}

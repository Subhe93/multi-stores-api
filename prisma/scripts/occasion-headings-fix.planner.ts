/**
 * Pure planning half of occasion-headings-fix.ts (no database access): the
 * snapshot types, CLI argument parsing, the per-page selection, the content
 * edits (section translations AND the published PageVersion snapshot), the
 * plan fingerprint and the report.
 *
 * Background (2026-11-10, Namez request): occasion landing pages generated
 * by the occasion conversion carried a `collection-products` heading ("Our
 * picks" / "Våra favoriter" / …) and a `rich-text` heading ("About these
 * gifts" / "Om dessa presenter" / …). The preset now emits no heading at
 * all: the only heading of the page is the hero; the products block gets a
 * small plain `subheading` ("Find your favourite" / "Hitta din favorit")
 * instead. This planner applies the same change to pages that already exist.
 *
 * Selection (per store, pages of type LANDING only):
 *   - the page's visible sections (is_hidden = false, what the publish
 *     snapshot carries), in sort order, are a prefix of length >= 2 of the
 *     dashboard preset hero-banner, collection-products, rich-text,
 *     faq-list; any other shape is skipped and listed as "other shape"
 *   - a heading in a locale the old preset never wrote (no entry in
 *     OLD_PRESET_HEADINGS) is kept ("heading in an unmapped locale kept")
 *   - at least one edit applies, where an edit is:
 *       collection-products content.heading === OLD products heading of
 *         that locale  → delete heading; set subheading = preset text of
 *         the locale unless a non-empty subheading already exists (kept)
 *       rich-text content.heading === OLD about heading of that locale
 *         → delete heading
 *     A heading that differs from the old preset text (owner edited it) is
 *     never touched and reported as "custom heading kept".
 *
 * The same rules run over the section translation rows (live draft) and
 * over the published snapshot `PageVersion.snapshot` (what the storefront
 * renders), each on its own content, so the storefront changes without a
 * republish and the draft matches. The snapshot is edited in place (no new
 * version row). A page without a published version gets the translation
 * edits only.
 */
import { createHash } from 'crypto';
import {
  OCCASION_PRESET_KEYS,
  occasionPresetText,
} from '../../src/modules/occasion-conversion/occasion-preset';

// ── Old preset text ─────────────────────────────────────────────────────────

/**
 * Headings the OLD preset wrote (occasion-preset.ts before 2026-11-10 and
 * the dashboard preset `occasion-page` of that time). Only an exact match is
 * converted.
 */
export const OLD_PRESET_HEADINGS: Record<
  string,
  { products: string; about: string }
> = {
  en: { products: 'Our picks', about: 'About these gifts' },
  ar: { products: 'مختاراتنا', about: 'عن هذه الهدايا' },
  sv: { products: 'Våra favoriter', about: 'Om dessa presenter' },
  tr: { products: 'Seçtiklerimiz', about: 'Bu hediyeler hakkında' },
  de: { products: 'Unsere Auswahl', about: 'Über diese Geschenke' },
  fr: { products: 'Notre sélection', about: 'À propos de ces cadeaux' },
};

// ── Snapshot (what the loader reads from the database) ──────────────────────

export interface SnapStore {
  id: string;
  slug: string;
}

export type Content = Record<string, unknown>;

export interface SnapTranslation {
  locale: string;
  content: Content;
}

/** A visible (is_hidden = false) PageSection row of the live draft with its per-locale content. */
export interface SnapSection {
  id: string;
  section_key: string;
  sort_order: number;
  translations: SnapTranslation[];
}

/**
 * The published PageVersion.snapshot as `buildPublishSnapshot()`
 * (src/modules/pages-v2/pages-v2.service.ts) writes it: `page` metadata and
 * the visible `sections` in order, each with `translations[{locale,
 * content}]`. Only `sections[].section_key` and
 * `sections[].translations[].content` are read or changed here; everything
 * else is carried through untouched.
 */
export interface PublishedSnapshot {
  page?: unknown;
  sections?: Array<{
    section_key: string;
    translations?: SnapTranslation[];
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface SnapPage {
  id: string;
  slug: string | null;
  /** Visible sections of the live draft (is_hidden = false), ordered by sort_order. */
  sections: SnapSection[];
  /** The published version, null for an unpublished draft. */
  published_version: { id: string; snapshot: PublishedSnapshot } | null;
}

export interface Snapshot {
  store: SnapStore;
  /** Pages of the store with type LANDING. */
  pages: SnapPage[];
}

// ── Plan ────────────────────────────────────────────────────────────────────

export interface PlannedTranslationEdit {
  section_id: string;
  section_key: string;
  locale: string;
  /** Full content to store (the row's content with the edit applied). */
  content_after: Content;
}

export interface PlannedSnapshotEdit {
  version_id: string;
  /** Full snapshot to store (the version's snapshot with the edits applied). */
  snapshot_after: PublishedSnapshot;
  /** Locales touched inside the snapshot, per section key. */
  touched: Array<{ section_key: string; locale: string }>;
}

export type KeepReason =
  | 'custom_heading'
  | 'unmapped_locale'
  | 'subheading_exists';

export interface KeptNote {
  where: 'draft' | 'snapshot';
  section_key: string;
  locale: string;
  reason: KeepReason;
}

export interface PlannedPage {
  id: string;
  slug: string | null;
  translation_edits: PlannedTranslationEdit[];
  snapshot_edit: PlannedSnapshotEdit | null;
  kept: KeptNote[];
  /** True when the page is published but its snapshot is not preset-shaped. */
  snapshot_shape_mismatch: boolean;
}

export interface Plan {
  store: SnapStore;
  /** Preset-shaped pages with at least one edit. */
  pages: PlannedPage[];
  /** LANDING pages whose section keys are not the occasion shape. */
  skipped_other_shape: Array<{
    id: string;
    slug: string | null;
    keys: string[];
  }>;
  counts: {
    pages_scanned: number;
    pages_preset_shaped: number;
    pages_matched: number;
    pages_already_converted: number;
    drafts_without_version: number;
    snapshots_to_edit: number;
    snapshots_skipped_shape: number;
    translations_to_edit: number;
    /** Translation rows + snapshot entries edited, per locale. */
    per_locale: Record<string, number>;
    custom_headings_kept: number;
    unmapped_locale_kept: number;
    subheadings_kept: number;
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

// ── Rules ───────────────────────────────────────────────────────────────────

/**
 * Section keys of the dashboard `occasion-page` preset: the server preset
 * (OCCASION_PRESET_KEYS) plus the optional `faq-list` block the dashboard
 * adds last.
 */
export const OCCASION_SHAPE_KEYS = [
  ...OCCASION_PRESET_KEYS,
  'faq-list',
] as const;

/** True when `keys` is hero-banner, collection-products[, rich-text[, faq-list]]. */
export function isPresetShape(keys: string[]): boolean {
  if (keys.length < 2 || keys.length > OCCASION_SHAPE_KEYS.length) return false;
  return keys.every((k, i) => k === OCCASION_SHAPE_KEYS[i]);
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export interface ContentDecision {
  /** Content after the edit, or null when nothing changes. */
  after: Content | null;
  kept: KeepReason[];
}

/**
 * The edit for one section's content in one locale. Headings that are not
 * the old preset text are left alone.
 */
export function decideContent(
  sectionKey: string,
  locale: string,
  content: Content,
): ContentDecision {
  const old = OLD_PRESET_HEADINGS[locale];
  const heading = str(content.heading);
  const kept: KeepReason[] = [];
  if (heading === null) return { after: null, kept };

  if (sectionKey !== 'collection-products' && sectionKey !== 'rich-text')
    return { after: null, kept };
  if (!old) {
    kept.push('unmapped_locale');
    return { after: null, kept };
  }

  if (sectionKey === 'collection-products') {
    if (heading !== old.products) {
      kept.push('custom_heading');
      return { after: null, kept };
    }
    const after: Content = { ...content };
    delete after.heading;
    const existing = str(content.subheading);
    if (existing && existing.trim()) kept.push('subheading_exists');
    else after.subheading = occasionPresetText(locale).products_subheading;
    return { after, kept };
  }

  if (heading !== old.about) {
    kept.push('custom_heading');
    return { after: null, kept };
  }
  const after: Content = { ...content };
  delete after.heading;
  return { after, kept };
}

// ── Planner ─────────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function planPage(page: SnapPage): PlannedPage {
  const out: PlannedPage = {
    id: page.id,
    slug: page.slug,
    translation_edits: [],
    snapshot_edit: null,
    kept: [],
    snapshot_shape_mismatch: false,
  };

  // Live draft rows.
  for (const s of page.sections) {
    for (const t of s.translations) {
      const content = isObject(t.content) ? t.content : {};
      const d = decideContent(s.section_key, t.locale, content);
      for (const reason of d.kept)
        out.kept.push({
          where: 'draft',
          section_key: s.section_key,
          locale: t.locale,
          reason,
        });
      if (d.after)
        out.translation_edits.push({
          section_id: s.id,
          section_key: s.section_key,
          locale: t.locale,
          content_after: d.after,
        });
    }
  }

  // Published snapshot, edited on its own content.
  const pv = page.published_version;
  if (pv) {
    const snap = pv.snapshot;
    const sections = Array.isArray(snap?.sections) ? snap.sections : [];
    if (!isObject(snap) || !isPresetShape(sections.map((s) => s.section_key))) {
      out.snapshot_shape_mismatch = true;
    } else {
      const touched: PlannedSnapshotEdit['touched'] = [];
      const nextSections = sections.map((s) => {
        const translations = Array.isArray(s.translations)
          ? s.translations
          : [];
        const nextTranslations = translations.map((t) => {
          const content = isObject(t.content) ? t.content : {};
          const d = decideContent(s.section_key, t.locale, content);
          for (const reason of d.kept)
            out.kept.push({
              where: 'snapshot',
              section_key: s.section_key,
              locale: t.locale,
              reason,
            });
          if (!d.after) return t;
          touched.push({ section_key: s.section_key, locale: t.locale });
          return { ...t, content: d.after };
        });
        return { ...s, translations: nextTranslations };
      });
      if (touched.length)
        out.snapshot_edit = {
          version_id: pv.id,
          snapshot_after: { ...snap, sections: nextSections },
          touched,
        };
    }
  }
  return out;
}

export function buildPlan(snap: Snapshot): Plan {
  const counts: Plan['counts'] = {
    pages_scanned: snap.pages.length,
    pages_preset_shaped: 0,
    pages_matched: 0,
    pages_already_converted: 0,
    drafts_without_version: 0,
    snapshots_to_edit: 0,
    snapshots_skipped_shape: 0,
    translations_to_edit: 0,
    per_locale: {},
    custom_headings_kept: 0,
    unmapped_locale_kept: 0,
    subheadings_kept: 0,
  };
  const pages: PlannedPage[] = [];
  const skipped: Plan['skipped_other_shape'] = [];
  for (const page of snap.pages) {
    const keys = page.sections.map((s) => s.section_key);
    if (!isPresetShape(keys)) {
      skipped.push({ id: page.id, slug: page.slug, keys });
      continue;
    }
    counts.pages_preset_shaped++;
    const planned = planPage(page);
    const hasEdit =
      planned.translation_edits.length > 0 || planned.snapshot_edit !== null;
    // Kept notes of a page that needs no edit at all are still reported
    // (an owner-edited heading is "kept" either way).
    for (const k of planned.kept) {
      if (k.reason === 'custom_heading') counts.custom_headings_kept++;
      else if (k.reason === 'unmapped_locale') counts.unmapped_locale_kept++;
      else counts.subheadings_kept++;
    }
    if (!hasEdit) {
      if (planned.kept.length === 0) counts.pages_already_converted++;
      continue;
    }
    counts.pages_matched++;
    if (!page.published_version) counts.drafts_without_version++;
    if (planned.snapshot_shape_mismatch) counts.snapshots_skipped_shape++;
    if (planned.snapshot_edit) counts.snapshots_to_edit++;
    counts.translations_to_edit += planned.translation_edits.length;
    const bump = (locale: string) => {
      counts.per_locale[locale] = (counts.per_locale[locale] ?? 0) + 1;
    };
    for (const e of planned.translation_edits) bump(e.locale);
    for (const t of planned.snapshot_edit?.touched ?? []) bump(t.locale);
    pages.push(planned);
  }
  return { store: snap.store, pages, skipped_other_shape: skipped, counts };
}

/** True when the plan writes nothing (second run after --apply). */
export function isNoop(plan: Plan): boolean {
  return plan.pages.length === 0;
}

export function fingerprint(plan: Plan): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        store: plan.store.id,
        pages: plan.pages.map((p) => ({
          id: p.id,
          translation_edits: p.translation_edits,
          snapshot: p.snapshot_edit && {
            version_id: p.snapshot_edit.version_id,
            snapshot_after: p.snapshot_edit.snapshot_after,
          },
        })),
      }),
    )
    .digest('hex')
    .slice(0, 16);
}

// ── Report ──────────────────────────────────────────────────────────────────

/**
 * Page slugs and the preset strings are printed; an owner's custom heading
 * is never printed (only the fact that it is kept).
 */
export function renderPlan(plan: Plan): string {
  const c = plan.counts;
  const lines: string[] = [];
  lines.push(`Store ${plan.store.slug} (${plan.store.id.slice(0, 8)}…)`);
  lines.push(
    `Landing pages scanned: ${c.pages_scanned}; occasion-shaped: ${c.pages_preset_shaped}; matched: ${c.pages_matched}; already converted: ${c.pages_already_converted}`,
  );
  lines.push(
    `Edits: ${c.translations_to_edit} section translations, ${c.snapshots_to_edit} published snapshots (in place); drafts without a published version: ${c.drafts_without_version}; snapshots skipped (other shape): ${c.snapshots_skipped_shape}`,
  );
  const locales = Object.keys(c.per_locale).sort();
  lines.push(
    `Per locale: ${
      locales.length
        ? locales.map((l) => `${l}=${c.per_locale[l]}`).join(', ')
        : '(none)'
    }`,
  );
  lines.push(
    `Kept: ${c.custom_headings_kept} custom headings, ${c.unmapped_locale_kept} headings in an unmapped locale, ${c.subheadings_kept} existing subheadings`,
  );
  if (plan.skipped_other_shape.length) {
    lines.push('');
    lines.push(
      `Skipped (other shape): ${plan.skipped_other_shape.length} landing pages`,
    );
    for (const p of plan.skipped_other_shape)
      lines.push(
        `  /${p.slug ?? '(no slug)'} (${p.id.slice(0, 8)}…): [${p.keys.join(', ') || '-'}]`,
      );
  }
  lines.push('');
  lines.push('Pages:');
  for (const p of plan.pages) {
    const draft = p.translation_edits
      .map((e) => `${e.section_key}:${e.locale}`)
      .join(' ');
    const snap = p.snapshot_edit
      ? `snapshot ${p.snapshot_edit.version_id.slice(0, 8)}… [${p.snapshot_edit.touched
          .map((t) => `${t.section_key}:${t.locale}`)
          .join(' ')}]`
      : p.snapshot_shape_mismatch
        ? 'snapshot SKIPPED (other shape)'
        : 'no published version';
    lines.push(
      `  /${p.slug ?? '(no slug)'} (${p.id.slice(0, 8)}…): draft [${draft || '-'}]; ${snap}`,
    );
    for (const k of p.kept)
      lines.push(
        `    kept ${k.where} ${k.section_key}:${k.locale} — ${
          k.reason === 'custom_heading'
            ? 'custom heading kept'
            : k.reason === 'unmapped_locale'
              ? 'heading in an unmapped locale kept'
              : 'existing subheading kept'
        }`,
      );
  }
  return lines.join('\n');
}

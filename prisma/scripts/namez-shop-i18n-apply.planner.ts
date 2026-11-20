/**
 * Pure half of namez-shop-i18n-apply.ts (no database, no Nest): record
 * validation, the merge of the translator files, the per-entity plan
 * (additive by default), the fingerprint, the restore plan and the report.
 *
 * Background (2026-11-20): namez.shop is the second market (`eu`, default
 * locale en, extra locales de + fr) of the store namez-se. Translators wrote
 * en/de/fr (and a few sv) texts as flat records
 * `{type, id, field, locale, value, ...helper keys}` in translations-A/B/C.json
 * (client-stores/namez/namez-shop-i18n). This planner turns them into
 * per-entity before/after states; the runner writes the after states through
 * the real services.
 *
 * Rules per record (one locale of one field):
 *   - current value empty (no row, null, '' or {})  → "set"
 *   - current value equal (key-order independent)   → "unchanged"
 *   - current value non-empty and different         → "conflict" (skipped),
 *     or "overwrite" with --overwrite
 *   - target missing / incomplete new row           → "error" (skipped)
 *   - page whose draft differs from its published version → "blocked"
 *     (a publish would release those edits too), unless
 *     --publish-draft-changes
 * Values of locales that no record names are never changed: replace-all
 * writes (products, FAQs, custom fields, stories, theme, add-ons) carry
 * every other row over as it is.
 */
import { createHash } from 'crypto';

// ── Records ─────────────────────────────────────────────────────────────────

export const RECORD_TYPES = [
  'product',
  'option_card',
  'story',
  'custom_field',
  'faq',
  'collection',
  'page',
  'page_section',
  'menu_item',
  'designer_element',
  'designer_addon',
  'store_theme_translation',
  'shipping_method',
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

/** Translator spellings that mean the same record type. */
export const TYPE_ALIASES: Record<string, RecordType> = {
  page_translation: 'page',
};

export interface TranslationRecord {
  type: RecordType;
  id: string;
  field: string;
  locale: string;
  value: unknown;
  page_id?: string;
  menu_id?: string;
  template_id?: string;
  product_id?: string;
  option?: string;
  value_key?: string;
  context?: string;
}

const PRODUCT_FIELDS = [
  'title',
  'slug',
  'description',
  'short_description',
  'meta_title',
  'meta_desc',
] as const;
const COLLECTION_FIELDS = [
  'name',
  'description',
  'long_description',
  'meta_title',
  'meta_desc',
] as const;
const PAGE_FIELDS = ['title', 'meta_title', 'meta_description'] as const;
const CUSTOM_FIELD_FIELDS = [
  'label',
  'placeholder',
  'option_labels',
  'display_label',
  'sublabel',
  'note',
  'help_text',
] as const;
const THEME_FIELDS = [
  'name',
  'metaTitle',
  'description',
  'metaDescription',
] as const;

const LOCALE_RE = /^[a-z]{2}$/;
const DESIGNER_FIELD_RE = /^elements\.([^.]+)\.(label|placeholder)$/;
const ADDON_FIELD_RE = /^addons\.([a-z0-9][a-z0-9_-]{0,31})\.label$/;
const SECTION_FIELD_RE = /^[a-z][a-z0-9_]*$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates one raw record; returns the normalized record or a reason. */
export function validateRecord(
  raw: unknown,
): { ok: true; record: TranslationRecord } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: 'not an object' };
  const type = (TYPE_ALIASES[raw.type as string] ?? raw.type) as RecordType;
  if (!RECORD_TYPES.includes(type))
    return { ok: false, reason: `unknown type ${String(raw.type)}` };
  const str = (k: string) =>
    typeof raw[k] === 'string' && (raw[k] as string).trim() !== '';
  if (!str('id')) return { ok: false, reason: 'id missing' };
  if (!str('field')) return { ok: false, reason: 'field missing' };
  if (typeof raw.locale !== 'string' || !LOCALE_RE.test(raw.locale))
    return { ok: false, reason: `bad locale ${String(raw.locale)}` };
  const field = raw.field as string;
  const value = raw.value;
  const needString = () =>
    typeof value === 'string' && value.trim() !== ''
      ? null
      : 'value must be a non-empty string';
  let problem: string | null = null;
  switch (type) {
    case 'product':
      problem = (PRODUCT_FIELDS as readonly string[]).includes(field)
        ? needString()
        : `field ${field}`;
      if (!problem && field === 'slug' && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value as string))
        problem = 'slug must be lowercase ASCII words joined by hyphens';
      break;
    case 'option_card':
      problem = ['label', 'sublabel', 'badge', 'ribbon'].includes(field)
        ? needString()
        : `field ${field}`;
      if (!problem && (!str('option') || !str('value_key')))
        problem = 'option and value_key are required';
      break;
    case 'story':
      problem = ['quote', 'subtitle'].includes(field)
        ? needString()
        : `field ${field}`;
      if (!problem && !str('product_id')) problem = 'product_id is required';
      break;
    case 'custom_field':
      if (!(CUSTOM_FIELD_FIELDS as readonly string[]).includes(field))
        problem = `field ${field}`;
      else if (field === 'option_labels')
        problem =
          isRecord(value) &&
          Object.keys(value).length > 0 &&
          Object.values(value).every((v) => typeof v === 'string' && v !== '')
            ? null
            : 'option_labels must be a non-empty {option: label} object';
      else problem = needString();
      break;
    case 'faq':
      problem = ['question', 'answer'].includes(field)
        ? needString()
        : `field ${field}`;
      break;
    case 'collection':
      problem = (COLLECTION_FIELDS as readonly string[]).includes(field)
        ? needString()
        : `field ${field}`;
      break;
    case 'page':
      problem = (PAGE_FIELDS as readonly string[]).includes(field)
        ? needString()
        : `field ${field}`;
      break;
    case 'page_section':
      if (field === 'content')
        problem =
          isRecord(value) && Object.keys(value).length > 0
            ? null
            : 'content must be a non-empty object';
      else
        problem = SECTION_FIELD_RE.test(field)
          ? needString()
          : `field ${field}`;
      break;
    case 'menu_item':
      problem = field === 'label_i18n' ? needString() : `field ${field}`;
      break;
    case 'designer_element':
      problem = DESIGNER_FIELD_RE.test(field) ? needString() : `field ${field}`;
      if (!problem && !str('template_id')) problem = 'template_id is required';
      break;
    case 'designer_addon':
      problem = ADDON_FIELD_RE.test(field) ? needString() : `field ${field}`;
      break;
    case 'store_theme_translation':
      problem = (THEME_FIELDS as readonly string[]).includes(field)
        ? needString()
        : `field ${field}`;
      break;
    case 'shipping_method':
      problem = field === 'translations' ? needString() : `field ${field}`;
      break;
  }
  if (problem) return { ok: false, reason: problem };
  const record: TranslationRecord = {
    type,
    id: raw.id as string,
    field,
    locale: raw.locale,
    value,
  };
  for (const k of [
    'page_id',
    'menu_id',
    'template_id',
    'product_id',
    'option',
    'value_key',
    'context',
  ] as const) {
    if (typeof raw[k] === 'string') record[k] = raw[k] as string;
  }
  return { ok: true, record };
}

/** Identity of a record: one locale of one field of one target. */
export function recordKey(r: TranslationRecord): string {
  return [
    r.type,
    r.id,
    r.option ?? '',
    r.value_key ?? '',
    r.field,
    r.locale,
  ].join('|');
}

export interface MergeResult {
  records: TranslationRecord[];
  /** Same key, same value in two files (kept once). */
  duplicates: { key: string; sources: string[] }[];
  /** Same key, different values: the merge fails. */
  conflicts: { key: string; sources: string[] }[];
  invalid: { source: string; index: number; reason: string }[];
  perSource: Record<string, number>;
}

/** Merges the translator files; a key with two different values is a conflict. */
export function mergeRecordSets(
  sets: { source: string; records: unknown }[],
): MergeResult {
  const out: MergeResult = {
    records: [],
    duplicates: [],
    conflicts: [],
    invalid: [],
    perSource: {},
  };
  const seen = new Map<string, { source: string; record: TranslationRecord }>();
  for (const set of sets) {
    if (!Array.isArray(set.records)) {
      out.invalid.push({ source: set.source, index: -1, reason: 'not an array' });
      continue;
    }
    out.perSource[set.source] = set.records.length;
    set.records.forEach((raw, index) => {
      const v = validateRecord(raw);
      if (!v.ok) {
        out.invalid.push({ source: set.source, index, reason: v.reason });
        return;
      }
      const key = recordKey(v.record);
      const prev = seen.get(key);
      if (!prev) {
        seen.set(key, { source: set.source, record: v.record });
        out.records.push(v.record);
        return;
      }
      const entry = { key, sources: [prev.source, set.source] };
      if (stableStringify(prev.record.value) === stableStringify(v.record.value))
        out.duplicates.push(entry);
      else out.conflicts.push(entry);
    });
  }
  return out;
}

// ── Snapshot (current state, read by the runner) ────────────────────────────

export interface ProductRow {
  locale: string;
  title: string;
  slug: string;
  description: string;
  short_description: string | null;
  meta_title: string | null;
  meta_desc: string | null;
}

export interface StoryState {
  id: string;
  kind: string;
  url: string;
  poster_url: string | null;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  name: string;
  rating: number | null;
  verified: boolean;
  autoplay: boolean;
  loop: boolean;
  translations: { locale: string; quote: string; subtitle: string | null }[];
}

export interface CustomFieldRow {
  locale: string;
  label: string;
  placeholder: string | null;
  option_labels: Record<string, string> | null;
  display_label: string | null;
  sublabel: string | null;
  note: string | null;
  help_text: string | null;
  help_image_url: string | null;
  messages: unknown;
}

export interface FaqRow {
  locale: string;
  question: string;
  answer: string;
}

export interface CollectionRow {
  locale: string;
  name: string;
  description: string | null;
  long_description: string | null;
  meta_title: string | null;
  meta_desc: string | null;
}

export interface PageRow {
  locale: string;
  title: string | null;
  meta_title: string | null;
  meta_description: string | null;
}

export interface SectionState {
  id: string;
  section_key: string;
  translations: { locale: string; content: Record<string, unknown> }[];
}

export interface PageState {
  id: string;
  slug: string | null;
  type: string;
  translations: PageRow[];
  sections: SectionState[];
}

export interface MenuNode {
  id: string;
  kind: string;
  resource_id: string | null;
  label: string;
  label_i18n: Record<string, string>;
  url: string;
  open_in_new_tab: boolean;
  children: MenuNode[];
}

export interface SnapPage extends PageState {
  /** The page has a published version. */
  published: boolean;
  /** Draft vs published differences before this run (empty = they match). */
  draft_diff: string[];
}

export interface Snapshot {
  store: { id: string; slug: string; primary_locale: string };
  products: Record<
    string,
    {
      id: string;
      translations: ProductRow[];
      variant_option_config: unknown;
      stories: StoryState[];
    }
  >;
  custom_fields: Record<
    string,
    { id: string; product_id: string; translations: CustomFieldRow[] }
  >;
  faqs: Record<string, { id: string; product_id: string; translations: FaqRow[] }>;
  collections: Record<string, { id: string; translations: CollectionRow[] }>;
  pages: Record<string, SnapPage>;
  menus: Record<string, { id: string; items: MenuNode[] }>;
  designer_templates: Record<
    string,
    {
      id: string;
      current_version_id: string | null;
      spec: unknown;
      /** DRAFT | PUBLISHED | ARCHIVED; absent in offline snapshots (= published). */
      status?: string;
    }
  >;
  designer_addons: Record<string, { product_id: string; addons: unknown }>;
  theme_config: Record<string, unknown> | null;
  shipping_methods: Record<
    string,
    { id: string; name: string; translations: Record<string, string> | null }
  >;
}

// ── Entity states (what a write sends / a backup keeps) ─────────────────────

export const ENTITY_KINDS = [
  'product',
  'product_options',
  'product_stories',
  'custom_field',
  'faq',
  'collection',
  'page',
  'menu',
  'designer_template',
  'designer_addons',
  'store_theme',
  'shipping_method',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export type EntityState =
  | { kind: 'product'; translations: ProductRow[] }
  | { kind: 'product_options'; variant_option_config: unknown }
  | { kind: 'product_stories'; stories: StoryState[] }
  | { kind: 'custom_field'; product_id: string; translations: CustomFieldRow[] }
  | { kind: 'faq'; product_id: string; translations: FaqRow[] }
  | { kind: 'collection'; translations: CollectionRow[] }
  | { kind: 'page'; page: PageState }
  | { kind: 'menu'; items: MenuNode[] }
  | { kind: 'designer_template'; current_version_id: string | null; spec: unknown }
  | { kind: 'designer_addons'; addons: unknown }
  | { kind: 'store_theme'; theme_config: Record<string, unknown> }
  | { kind: 'shipping_method'; translations: Record<string, string> | null };

/** Entity kind + id a record writes to (page sections: their page). */
export function entityOf(
  r: TranslationRecord,
  sectionPage: Map<string, string>,
  menuOfItem: Map<string, string>,
  storeId: string,
): { kind: EntityKind; id: string } | null {
  switch (r.type) {
    case 'product':
      return { kind: 'product', id: r.id };
    case 'option_card':
      return { kind: 'product_options', id: r.id };
    case 'story':
      return r.product_id ? { kind: 'product_stories', id: r.product_id } : null;
    case 'custom_field':
      return { kind: 'custom_field', id: r.id };
    case 'faq':
      return { kind: 'faq', id: r.id };
    case 'collection':
      return { kind: 'collection', id: r.id };
    case 'page':
      return { kind: 'page', id: r.id };
    case 'page_section': {
      const page = sectionPage.get(r.id) ?? null;
      return page ? { kind: 'page', id: page } : null;
    }
    case 'menu_item': {
      const menu = menuOfItem.get(r.id) ?? r.menu_id ?? null;
      return menu ? { kind: 'menu', id: menu } : null;
    }
    case 'designer_element':
      return r.template_id ? { kind: 'designer_template', id: r.template_id } : null;
    case 'designer_addon':
      return { kind: 'designer_addons', id: r.id };
    case 'store_theme_translation':
      return { kind: 'store_theme', id: storeId };
    case 'shipping_method':
      return { kind: 'shipping_method', id: r.id };
  }
}

/** The current state of an entity from the snapshot, or null when missing. */
export function stateFromSnapshot(
  snap: Snapshot,
  kind: EntityKind,
  id: string,
): EntityState | null {
  switch (kind) {
    case 'product': {
      const p = snap.products[id];
      return p ? { kind, translations: clone(p.translations) } : null;
    }
    case 'product_options': {
      const p = snap.products[id];
      return p
        ? { kind, variant_option_config: clone(p.variant_option_config ?? null) }
        : null;
    }
    case 'product_stories': {
      const p = snap.products[id];
      return p ? { kind, stories: clone(p.stories) } : null;
    }
    case 'custom_field': {
      const f = snap.custom_fields[id];
      return f
        ? { kind, product_id: f.product_id, translations: clone(f.translations) }
        : null;
    }
    case 'faq': {
      const f = snap.faqs[id];
      return f
        ? { kind, product_id: f.product_id, translations: clone(f.translations) }
        : null;
    }
    case 'collection': {
      const c = snap.collections[id];
      return c ? { kind, translations: clone(c.translations) } : null;
    }
    case 'page': {
      const p = snap.pages[id];
      if (!p) return null;
      const { published: _p, draft_diff: _d, ...page } = p;
      void _p;
      void _d;
      return { kind, page: clone(page) };
    }
    case 'menu': {
      const m = snap.menus[id];
      return m ? { kind, items: clone(m.items) } : null;
    }
    case 'designer_template': {
      const t = snap.designer_templates[id];
      return t
        ? { kind, current_version_id: t.current_version_id, spec: clone(t.spec) }
        : null;
    }
    case 'designer_addons': {
      const a = snap.designer_addons[id];
      return a ? { kind, addons: clone(a.addons) } : null;
    }
    case 'store_theme':
      return id === snap.store.id
        ? { kind, theme_config: clone(snap.theme_config ?? {}) }
        : null;
    case 'shipping_method': {
      const m = snap.shipping_methods[id];
      return m ? { kind, translations: clone(m.translations) } : null;
    }
  }
}

/**
 * State reduced to what a write changes and a restore compares: rows sorted
 * by locale, the designer version id left out (a new version gets a new id).
 */
export function comparableState(state: EntityState): unknown {
  const byLocale = <T extends { locale: string }>(rows: T[]) =>
    [...rows].sort((a, b) => (a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0));
  switch (state.kind) {
    case 'product':
    case 'custom_field':
    case 'faq':
    case 'collection':
      return { ...state, translations: byLocale(state.translations as { locale: string }[]) };
    case 'product_stories':
      return {
        kind: state.kind,
        stories: state.stories.map((s) => ({ ...s, translations: byLocale(s.translations) })),
      };
    case 'page':
      return {
        kind: state.kind,
        translations: byLocale(state.page.translations),
        sections: [...state.page.sections]
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .map((s) => ({ id: s.id, translations: byLocale(s.translations) })),
      };
    case 'designer_template':
      return { kind: state.kind, spec: state.spec };
    default:
      return state;
  }
}

export function statesEqual(a: EntityState, b: EntityState): boolean {
  return stableStringify(comparableState(a)) === stableStringify(comparableState(b));
}

// ── Plan ────────────────────────────────────────────────────────────────────

export type RecordStatus =
  | 'set'
  | 'overwrite'
  | 'unchanged'
  | 'conflict'
  | 'blocked'
  | 'error';

export interface RecordOutcome {
  key: string;
  type: RecordType;
  locale: string;
  status: RecordStatus;
  detail?: string;
  current?: unknown;
  value?: unknown;
}

export interface EntityChange {
  kind: EntityKind;
  id: string;
  before: EntityState;
  after: EntityState;
  /** Records that change this entity. */
  writes: number;
  /** Page only: publish after the write (false: never published, draft only). */
  publish?: boolean;
}

export interface PlanOptions {
  overwrite: boolean;
  publishDraftChanges: boolean;
  /** Restrict to these record types (empty = all). */
  onlyTypes: RecordType[];
}

export interface Plan {
  store: { id: string; slug: string };
  changes: EntityChange[];
  outcomes: RecordOutcome[];
  warnings: string[];
  /** Page id → draft differences of pages that were blocked. */
  blocked_pages: Record<string, string[]>;
}

const isEmpty = (v: unknown): boolean =>
  v === undefined ||
  v === null ||
  (typeof v === 'string' && v.trim() === '') ||
  (isRecord(v) && Object.keys(v).length === 0);

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** The status of writing `value` over `current`. */
function decide(
  current: unknown,
  value: unknown,
  overwrite: boolean,
): 'set' | 'unchanged' | 'conflict' | 'overwrite' {
  if (isEmpty(current)) return 'set';
  if (stableStringify(current) === stableStringify(value)) return 'unchanged';
  return overwrite ? 'overwrite' : 'conflict';
}

/** Row of `locale` in `rows`, created by `make` when missing (flagged as new). */
function rowFor<T extends { locale: string }>(
  rows: T[],
  locale: string,
  make: () => T,
  created: Set<string>,
): T {
  let row = rows.find((r) => r.locale === locale);
  if (!row) {
    row = make();
    rows.push(row);
    created.add(locale);
  }
  return row;
}

/** Depth-first search of an object tree for `{id: <id>}` (designer elements). */
function findById(node: unknown, id: string): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findById(n, id);
      if (hit) return hit;
    }
    return null;
  }
  if (!isRecord(node)) return null;
  if (node.id === id) return node;
  for (const v of Object.values(node)) {
    if (typeof v === 'object' && v !== null) {
      const hit = findById(v, id);
      if (hit) return hit;
    }
  }
  return null;
}

function findMenuNode(nodes: MenuNode[], id: string): MenuNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findMenuNode(n.children ?? [], id);
    if (hit) return hit;
  }
  return null;
}

function collectMenuIds(nodes: MenuNode[], into: Map<string, string>, menuId: string) {
  for (const n of nodes) {
    into.set(n.id, menuId);
    collectMenuIds(n.children ?? [], into, menuId);
  }
}

/** Applies the records of ONE entity to a copy of its state. */
function applyRecords(
  snap: Snapshot,
  state: EntityState,
  records: TranslationRecord[],
  opts: PlanOptions,
  outcome: (r: TranslationRecord, status: RecordStatus, extra?: Partial<RecordOutcome>) => void,
  warn: (msg: string) => void,
): EntityState {
  const after = clone(state);
  // Locales whose row this run creates: required columns are checked at the end.
  const created = new Set<string>();
  const pending: { r: TranslationRecord; status: RecordStatus; current: unknown }[] = [];
  const write = (
    r: TranslationRecord,
    current: unknown,
    assign: () => void,
  ) => {
    const status = decide(current, r.value, opts.overwrite);
    if (status === 'set' || status === 'overwrite') assign();
    pending.push({ r, status, current });
  };

  switch (after.kind) {
    case 'product':
      for (const r of records) {
        const row = rowFor(
          after.translations,
          r.locale,
          () => ({
            locale: r.locale,
            title: '',
            slug: '',
            description: '',
            short_description: null,
            meta_title: null,
            meta_desc: null,
          }),
          created,
        );
        const f = r.field as keyof ProductRow;
        write(r, row[f], () => ((row as unknown as Record<string, unknown>)[f] = r.value));
      }
      break;
    case 'product_options': {
      const config = Array.isArray(after.variant_option_config)
        ? (after.variant_option_config as Record<string, unknown>[])
        : null;
      for (const r of records) {
        const opt = config?.find((o) => o.name === r.option);
        const values = Array.isArray(opt?.values) ? (opt!.values as unknown[]) : [];
        if (!opt || !values.includes(r.value_key)) {
          outcome(r, 'error', { detail: `option "${r.option}" / value "${r.value_key}" not found` });
          continue;
        }
        if (!isRecord(opt.valueMeta)) opt.valueMeta = {};
        const metaMap = opt.valueMeta as Record<string, Record<string, unknown>>;
        if (!isRecord(metaMap[r.value_key!])) metaMap[r.value_key!] = {};
        const meta = metaMap[r.value_key!];
        if (!isRecord(meta.i18n)) meta.i18n = {};
        const i18n = meta.i18n as Record<string, Record<string, unknown>>;
        if (!isRecord(i18n[r.locale])) i18n[r.locale] = {};
        const loc = i18n[r.locale];
        write(r, loc[r.field], () => (loc[r.field] = r.value));
      }
      break;
    }
    case 'product_stories':
      for (const r of records) {
        const story = after.stories.find((s) => s.id === r.id);
        if (!story) {
          outcome(r, 'error', { detail: `story ${r.id} not found on product` });
          continue;
        }
        let row = story.translations.find((t) => t.locale === r.locale);
        if (!row) {
          row = { locale: r.locale, quote: '', subtitle: null };
          story.translations.push(row);
        }
        const target = row;
        const f = r.field as 'quote' | 'subtitle';
        write(r, target[f], () => (target[f] = r.value as string));
      }
      break;
    case 'custom_field':
      for (const r of records) {
        const row = rowFor(
          after.translations,
          r.locale,
          () => ({
            locale: r.locale,
            label: '',
            placeholder: null,
            option_labels: null,
            display_label: null,
            sublabel: null,
            note: null,
            help_text: null,
            help_image_url: null,
            messages: null,
          }),
          created,
        );
        if (r.field === 'option_labels') {
          // Per option key: missing keys are added, differing keys conflict.
          const cur = isRecord(row.option_labels) ? row.option_labels : {};
          const val = r.value as Record<string, string>;
          const statuses = Object.keys(val).map((k) =>
            decide(cur[k], val[k], opts.overwrite),
          );
          const status: RecordStatus = statuses.includes('conflict')
            ? 'conflict'
            : statuses.includes('overwrite')
              ? 'overwrite'
              : statuses.includes('set')
                ? 'set'
                : 'unchanged';
          if (status === 'set' || status === 'overwrite')
            row.option_labels = { ...cur, ...val };
          pending.push({ r, status, current: row.option_labels });
        } else {
          const f = r.field as keyof CustomFieldRow;
          write(r, row[f], () => ((row as unknown as Record<string, unknown>)[f] = r.value));
        }
      }
      break;
    case 'faq':
      for (const r of records) {
        const row = rowFor(
          after.translations,
          r.locale,
          () => ({ locale: r.locale, question: '', answer: '' }),
          created,
        );
        const f = r.field as 'question' | 'answer';
        write(r, row[f], () => (row[f] = r.value as string));
      }
      break;
    case 'collection':
      for (const r of records) {
        const row = rowFor(
          after.translations,
          r.locale,
          () => ({
            locale: r.locale,
            name: '',
            description: null,
            long_description: null,
            meta_title: null,
            meta_desc: null,
          }),
          created,
        );
        const f = r.field as keyof CollectionRow;
        write(r, row[f], () => ((row as unknown as Record<string, unknown>)[f] = r.value));
      }
      break;
    case 'page': {
      const page = after.page;
      // Section rows this run creates: their copied texts are not "current".
      const newRows = new Set<string>();
      // Whole-content records first, then single keys (they may build on them).
      const ordered = [
        ...records.filter((r) => r.type === 'page_section' && r.field === 'content'),
        ...records.filter((r) => !(r.type === 'page_section' && r.field === 'content')),
      ];
      for (const r of ordered) {
        if (r.type === 'page') {
          const row = rowFor(
            page.translations,
            r.locale,
            () => ({ locale: r.locale, title: null, meta_title: null, meta_description: null }),
            new Set<string>(),
          );
          const f = r.field as keyof PageRow;
          write(r, row[f], () => ((row as unknown as Record<string, unknown>)[f] = r.value));
          continue;
        }
        const section = page.sections.find((s) => s.id === r.id);
        if (!section) {
          outcome(r, 'error', { detail: `section ${r.id} not on page ${page.id}` });
          continue;
        }
        const source =
          section.translations.find((t) => t.locale === snap.store.primary_locale) ??
          section.translations[0];
        let row = section.translations.find((t) => t.locale === r.locale);
        if (r.field === 'content') {
          const value = r.value as Record<string, unknown>;
          if (source) {
            const a = Object.keys(source.content).sort().join(',');
            const b = Object.keys(value).sort().join(',');
            if (a !== b)
              warn(
                `section ${r.id} (${section.section_key}) ${r.locale}: keys differ from ${source.locale} (${b} vs ${a})`,
              );
          }
          write(r, row?.content, () => {
            if (row) row.content = clone(value);
            else {
              section.translations.push({ locale: r.locale, content: clone(value) });
              newRows.add(`${section.id}|${r.locale}`);
            }
          });
          continue;
        }
        if (!row) {
          if (!source) {
            outcome(r, 'error', { detail: `section ${r.id} has no content to copy` });
            continue;
          }
          // A new locale row starts as a full copy of the primary-locale
          // content (links, ids, images); the records replace its texts.
          row = { locale: r.locale, content: clone(source.content) };
          section.translations.push(row);
          newRows.add(`${section.id}|${r.locale}`);
        }
        const target = row;
        if (newRows.has(`${section.id}|${r.locale}`)) {
          target.content[r.field] = r.value;
          pending.push({ r, status: 'set', current: undefined });
          continue;
        }
        write(r, target.content[r.field], () => (target.content[r.field] = r.value));
      }
      break;
    }
    case 'menu':
      for (const r of records) {
        const node = findMenuNode(after.items, r.id);
        if (!node) {
          outcome(r, 'error', { detail: `menu item ${r.id} not found` });
          continue;
        }
        if (!isRecord(node.label_i18n)) node.label_i18n = {};
        write(r, node.label_i18n[r.locale], () => (node.label_i18n[r.locale] = r.value as string));
      }
      break;
    case 'designer_template':
      for (const r of records) {
        const m = DESIGNER_FIELD_RE.exec(r.field)!;
        const el = findById(isRecord(after.spec) ? after.spec.surfaces : null, m[1]);
        if (!el) {
          outcome(r, 'error', { detail: `element ${m[1]} not in the current template version` });
          continue;
        }
        if (after.current_version_id && r.id !== after.current_version_id)
          warn(
            `designer template ${r.template_id}: records were written for version ${r.id}, the current version is ${after.current_version_id} (element ${m[1]} found, applied to the current version)`,
          );
        if (!isRecord(el[m[2]])) el[m[2]] = {};
        const map = el[m[2]] as Record<string, unknown>;
        write(r, map[r.locale], () => (map[r.locale] = r.value));
      }
      break;
    case 'designer_addons':
      for (const r of records) {
        const key = ADDON_FIELD_RE.exec(r.field)![1];
        const items =
          isRecord(after.addons) && Array.isArray(after.addons.items)
            ? (after.addons.items as Record<string, unknown>[])
            : [];
        const item = items.find((i) => i.key === key);
        if (!item) {
          outcome(r, 'error', { detail: `add-on "${key}" not found` });
          continue;
        }
        if (!isRecord(item.label)) item.label = {};
        const label = item.label as Record<string, unknown>;
        write(r, label[r.locale], () => (label[r.locale] = r.value));
      }
      break;
    case 'store_theme':
      for (const r of records) {
        const tc = after.theme_config;
        if (!isRecord(tc.translations)) tc.translations = {};
        const tr = tc.translations as Record<string, Record<string, unknown>>;
        if (!isRecord(tr[r.locale])) tr[r.locale] = {};
        const loc = tr[r.locale];
        write(r, loc[r.field], () => (loc[r.field] = r.value));
      }
      break;
    case 'shipping_method':
      for (const r of records) {
        const map = { ...(after.translations ?? {}) };
        write(r, map[r.locale], () => {
          map[r.locale] = r.value as string;
          after.translations = map;
        });
      }
      break;
  }

  // A newly created locale row must carry the columns the table requires.
  const required: Partial<Record<EntityKind, string[]>> = {
    product: ['title', 'slug', 'description'],
    custom_field: ['label'],
    faq: ['question', 'answer'],
    collection: ['name'],
  };
  const need = required[after.kind];
  const broken = new Set<string>();
  if (need && 'translations' in after && Array.isArray(after.translations)) {
    for (const locale of created) {
      const row = (after.translations as unknown as Record<string, unknown>[]).find(
        (t) => t.locale === locale,
      )!;
      const missing = need.filter((k) => isEmpty(row[k]));
      if (missing.length) {
        broken.add(locale);
        (after as { translations: unknown[] }).translations = (
          after.translations as unknown as Record<string, unknown>[]
        ).filter((t) => t.locale !== locale);
        warn(`${after.kind} ${records[0]?.id ?? ''} ${locale}: new row lacks ${missing.join(', ')}; row skipped`);
      }
    }
  }
  for (const p of pending) {
    if (broken.has(p.r.locale)) outcome(p.r, 'error', { detail: 'new row incomplete' });
    else
      outcome(p.r, p.status, {
        ...(p.status === 'conflict' || p.status === 'overwrite'
          ? { current: p.current, value: p.r.value }
          : {}),
      });
  }
  return after;
}

/** Builds the plan: one EntityChange per entity a record really changes. */
export function buildPlan(
  snap: Snapshot,
  records: TranslationRecord[],
  opts: PlanOptions,
): Plan {
  const plan: Plan = {
    store: { id: snap.store.id, slug: snap.store.slug },
    changes: [],
    outcomes: [],
    warnings: [],
    blocked_pages: {},
  };
  const sectionPage = new Map<string, string>();
  for (const p of Object.values(snap.pages))
    for (const s of p.sections) sectionPage.set(s.id, p.id);
  const menuOfItem = new Map<string, string>();
  for (const m of Object.values(snap.menus)) collectMenuIds(m.items, menuOfItem, m.id);

  const outcome = (
    r: TranslationRecord,
    status: RecordStatus,
    extra: Partial<RecordOutcome> = {},
  ) =>
    plan.outcomes.push({ key: recordKey(r), type: r.type, locale: r.locale, status, ...extra });
  const warn = (m: string) => plan.warnings.push(m);

  // Group by entity, keeping file order within a group.
  const groups = new Map<string, { kind: EntityKind; id: string; records: TranslationRecord[] }>();
  for (const r of records) {
    if (opts.onlyTypes.length && !opts.onlyTypes.includes(r.type)) continue;
    const e = entityOf(r, sectionPage, menuOfItem, snap.store.id);
    if (!e) {
      outcome(r, 'error', { detail: 'target not found (section / menu item / product id)' });
      continue;
    }
    const key = `${e.kind}:${e.id}`;
    if (!groups.has(key)) groups.set(key, { ...e, records: [] });
    groups.get(key)!.records.push(r);
  }

  for (const g of groups.values()) {
    const before = stateFromSnapshot(snap, g.kind, g.id);
    if (!before) {
      for (const r of g.records)
        outcome(r, 'error', { detail: `${g.kind} ${g.id} not found in store ${snap.store.slug}` });
      continue;
    }
    if (g.kind === 'designer_template') {
      // A translation is written as a new version and published, which would
      // also publish a template the owner keeps unpublished (status DRAFT /
      // ARCHIVED with a version): refused.
      const status = snap.designer_templates[g.id].status;
      if (status !== undefined && status !== 'PUBLISHED') {
        for (const r of g.records)
          outcome(r, 'blocked', { detail: `designer template ${g.id} is ${status}; publishing a new version would publish it` });
        continue;
      }
    }
    if (g.kind === 'page') {
      const page = snap.pages[g.id];
      if (page.published && page.draft_diff.length && !opts.publishDraftChanges) {
        plan.blocked_pages[g.id] = page.draft_diff;
        for (const r of g.records)
          outcome(r, 'blocked', { detail: `page ${page.slug ?? page.type}: unpublished draft edits` });
        continue;
      }
    }
    const local: RecordOutcome[] = [];
    const after = applyRecords(
      snap,
      before,
      g.records,
      opts,
      (r, status, extra = {}) =>
        local.push({ key: recordKey(r), type: r.type, locale: r.locale, status, ...extra }),
      warn,
    );
    plan.outcomes.push(...local);
    const writes = local.filter((o) => o.status === 'set' || o.status === 'overwrite').length;
    if (!writes || statesEqual(before, after)) continue;
    const change: EntityChange = { kind: g.kind, id: g.id, before, after, writes };
    if (g.kind === 'page') {
      change.publish = snap.pages[g.id].published;
      if (!change.publish)
        warn(`page ${snap.pages[g.id].slug ?? g.id} was never published: draft written, not published`);
    }
    plan.changes.push(change);
  }
  return plan;
}

export function isNoop(plan: Plan): boolean {
  return plan.changes.length === 0;
}

export function fingerprint(plan: Plan): string {
  return createHash('sha256')
    .update(
      stableStringify({
        store: plan.store.id,
        changes: plan.changes.map((c) => ({
          kind: c.kind,
          id: c.id,
          after: comparableState(c.after),
          publish: c.publish ?? null,
        })),
      }),
    )
    .digest('hex')
    .slice(0, 16);
}

// ── Restore ─────────────────────────────────────────────────────────────────

export interface BackupEntity {
  kind: EntityKind;
  id: string;
  before: EntityState;
  /** State read back right after the write (planned state until then). */
  after: EntityState;
  publish?: boolean;
}

export interface BackupFile {
  format: 'namez-shop-i18n-backup/1';
  store: { id: string; slug: string };
  created_at: string;
  fingerprint: string;
  options: PlanOptions;
  entities: BackupEntity[];
  /** Entities whose write completed (in order). */
  applied: string[];
  /**
   * Entities whose write threw part-way (at most one: the run stops there).
   * A service call may have written some of its rows, so the restore treats
   * it like an applied entity (its `after` is the state read back).
   */
  failed?: string[];
}

export interface RestorePlan {
  store: { id: string; slug: string };
  changes: EntityChange[];
  /** Already equal to the backed-up state. */
  unchanged: string[];
  /** Changed after the apply (skipped unless --force). */
  drifted: string[];
  missing: string[];
  /**
   * Pages whose draft has edits that are not published (made after the
   * apply): a restore publishes the page, which would release them too.
   * Skipped unless --publish-draft-changes.
   */
  blocked: { key: string; diff: string[] }[];
}

/**
 * Inverse of an apply: every entity of the backup goes back to its `before`
 * state. An entity that changed again after the apply is skipped unless
 * `force` (a restore must not clobber later edits by accident).
 */
export function buildRestorePlan(
  backup: BackupFile,
  current: (kind: EntityKind, id: string) => EntityState | null,
  force: boolean,
  pageDraftDiff: (id: string) => string[] = () => [],
  publishDraftChanges = false,
): RestorePlan {
  const out: RestorePlan = {
    store: backup.store,
    changes: [],
    unchanged: [],
    drifted: [],
    missing: [],
    blocked: [],
  };
  const applied = new Set([...backup.applied, ...(backup.failed ?? [])]);
  for (const e of backup.entities) {
    const key = `${e.kind}:${e.id}`;
    const now = current(e.kind, e.id);
    if (!now) {
      out.missing.push(key);
      continue;
    }
    if (statesEqual(now, e.before)) {
      out.unchanged.push(key);
      continue;
    }
    if (!statesEqual(now, e.after) && !force) {
      out.drifted.push(key);
      continue;
    }
    if (!applied.has(key) && !force) {
      // Planned but never written (the apply stopped before it), yet not at
      // the `before` state either: treat like a later edit.
      out.drifted.push(key);
      continue;
    }
    const publish = e.kind === 'page' ? (e.publish ?? true) : undefined;
    if (publish && !publishDraftChanges) {
      const diff = pageDraftDiff(e.id);
      if (diff.length) {
        out.blocked.push({ key, diff });
        continue;
      }
    }
    out.changes.push({
      kind: e.kind,
      id: e.id,
      before: now,
      after: e.before,
      writes: 1,
      ...(e.kind === 'page' ? { publish: e.publish ?? true } : {}),
    });
  }
  return out;
}

export function restoreFingerprint(plan: RestorePlan): string {
  return fingerprint({
    store: plan.store,
    changes: plan.changes,
    outcomes: [],
    warnings: [],
    blocked_pages: {},
  });
}

// ── Locale diff helpers (used by the runner's writers) ──────────────────────

/** Locales whose row differs between two row lists, and locales only in `from`. */
export function rowLocaleDiff<T extends { locale: string }>(
  from: T[],
  to: T[],
): { changed: string[]; removed: string[] } {
  const f = new Map(from.map((r) => [r.locale, stableStringify(r)]));
  const t = new Map(to.map((r) => [r.locale, stableStringify(r)]));
  return {
    changed: [...t.keys()].filter((l) => f.get(l) !== t.get(l)),
    removed: [...f.keys()].filter((l) => !t.has(l)),
  };
}

/** Page diff: page-translation locales and per-section locales to write or remove. */
export function pageDiff(from: PageState, to: PageState) {
  const translations = rowLocaleDiff(from.translations, to.translations);
  const sections: { id: string; changed: string[]; removed: string[] }[] = [];
  for (const s of to.sections) {
    const old = from.sections.find((x) => x.id === s.id);
    const d = rowLocaleDiff(old?.translations ?? [], s.translations);
    if (d.changed.length || d.removed.length) sections.push({ id: s.id, ...d });
  }
  return { translations, sections };
}

// ── Draft vs published (pages) ──────────────────────────────────────────────

interface SnapshotLike {
  page?: { slug?: unknown; seo?: unknown; translations?: Record<string, unknown>[] };
  sections?: {
    id: string;
    parent_id?: string | null;
    section_key: string;
    settings?: unknown;
    sort_order?: number;
    translations?: { locale: string; content: unknown }[];
  }[];
}

function comparableSnapshot(s: SnapshotLike) {
  const byLocale = (a: { locale?: unknown }, b: { locale?: unknown }) =>
    String(a.locale) < String(b.locale) ? -1 : String(a.locale) > String(b.locale) ? 1 : 0;
  return {
    page: {
      slug: s.page?.slug ?? null,
      seo: s.page?.seo ?? null,
      translations: (s.page?.translations ?? [])
        .map((t) => {
          const { id: _i, page_id: _p, created_at: _c, updated_at: _u, ...rest } = t;
          void _i;
          void _p;
          void _c;
          void _u;
          return rest;
        })
        .sort(byLocale),
    },
    sections: new Map(
      (s.sections ?? []).map((x) => [
        x.id,
        {
          parent_id: x.parent_id ?? null,
          section_key: x.section_key,
          settings: x.settings ?? null,
          sort_order: x.sort_order,
          translations: (x.translations ?? [])
            .map((t) => ({ locale: t.locale, content: t.content }))
            .sort(byLocale),
        },
      ]),
    ),
  };
}

/**
 * Differences between the draft (as a publish would snapshot it) and the
 * published snapshot. Empty when they match. Same rules as the cookie/privacy
 * ops script (namez-cookie-privacy-pages.js).
 */
export function draftDiff(draft: SnapshotLike, published: SnapshotLike | null): string[] {
  if (!published) return [];
  const d = comparableSnapshot(draft);
  const l = comparableSnapshot(published);
  const out: string[] = [];
  for (const k of ['slug', 'seo', 'translations'] as const)
    if (stableStringify(d.page[k]) !== stableStringify(l.page[k])) out.push(`page ${k} differs`);
  for (const [id, s] of d.sections) {
    const p = l.sections.get(id);
    if (!p) {
      out.push(`section ${s.section_key} ${id} is visible in the draft but not published`);
      continue;
    }
    const changed = (['parent_id', 'section_key', 'settings', 'sort_order', 'translations'] as const).filter(
      (k) => stableStringify(s[k]) !== stableStringify(p[k]),
    );
    if (changed.length) out.push(`section ${s.section_key} ${id}: ${changed.join(', ')} differ`);
  }
  for (const [id, p] of l.sections)
    if (!d.sections.has(id)) out.push(`section ${p.section_key} ${id} is published but hidden or deleted in the draft`);
  return out;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export interface Options {
  mode: 'dry-run' | 'apply';
  store: string | null;
  file: string | null;
  backupDir: string | null;
  restore: string | null;
  fingerprint: string | null;
  overwrite: boolean;
  publishDraftChanges: boolean;
  force: boolean;
  onlyTypes: RecordType[];
  merge: string[];
  out: string | null;
  snapshot: string | null;
  dumpSnapshot: string | null;
  verbose: boolean;
}

export function parseArgs(argv: string[]): Options {
  const o: Options = {
    mode: 'dry-run',
    store: null,
    file: null,
    backupDir: null,
    restore: null,
    fingerprint: null,
    overwrite: false,
    publishDraftChanges: false,
    force: false,
    onlyTypes: [],
    merge: [],
    out: null,
    snapshot: null,
    dumpSnapshot: null,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const value = (): string => {
      if (eq > 0) return a.slice(eq + 1).trim();
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`);
      return next.trim();
    };
    switch (flag) {
      case '--dry-run':
        o.mode = 'dry-run';
        break;
      case '--apply':
        o.mode = 'apply';
        break;
      case '--overwrite':
        o.overwrite = true;
        break;
      case '--publish-draft-changes':
        o.publishDraftChanges = true;
        break;
      case '--force':
        o.force = true;
        break;
      case '--verbose':
        o.verbose = true;
        break;
      case '--store':
        o.store = value();
        break;
      case '--file':
        o.file = value();
        break;
      case '--backup-dir':
        o.backupDir = value();
        break;
      case '--restore':
        o.restore = value();
        break;
      case '--fingerprint':
        o.fingerprint = value();
        break;
      case '--out':
        o.out = value();
        break;
      case '--snapshot':
        o.snapshot = value();
        break;
      case '--dump-snapshot':
        o.dumpSnapshot = value();
        break;
      case '--merge':
        o.merge = value()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--only-types': {
        const types = value()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((t) => TYPE_ALIASES[t] ?? t);
        const bad = types.filter((t) => !RECORD_TYPES.includes(t as RecordType));
        if (bad.length) throw new Error(`--only-types: unknown ${bad.join(', ')}`);
        o.onlyTypes = types as RecordType[];
        break;
      }
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (o.merge.length) {
    if (!o.out) throw new Error('--merge needs --out=<translations.json>');
    return o;
  }
  if (o.restore && o.file) throw new Error('--restore and --file are exclusive');
  if (!o.restore && !o.file) throw new Error('--file=<translations.json> (or --restore=<backup>) is required');
  if (!o.store) throw new Error('--store <slug> is required');
  if (o.mode === 'apply' && o.snapshot) throw new Error('--snapshot is for offline dry runs only');
  return o;
}

// ── Report ──────────────────────────────────────────────────────────────────

const STATUSES: RecordStatus[] = ['set', 'overwrite', 'unchanged', 'conflict', 'blocked', 'error'];

const short = (v: unknown, n = 90): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const flat = (s ?? '').replace(/\s+/g, ' ');
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/** Per record type × status counts. */
export function summarize(plan: Plan): Record<string, Record<RecordStatus, number>> {
  const out: Record<string, Record<RecordStatus, number>> = {};
  for (const o of plan.outcomes) {
    out[o.type] ??= { set: 0, overwrite: 0, unchanged: 0, conflict: 0, blocked: 0, error: 0 };
    out[o.type][o.status]++;
  }
  return out;
}

export function renderPlan(plan: Plan, verbose = false): string {
  const lines: string[] = [];
  lines.push(`Store ${plan.store.slug} (${plan.store.id})`);
  lines.push('');
  lines.push('Records per type:');
  const sum = summarize(plan);
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  lines.push(`  ${pad('type', 26)}${STATUSES.map((s) => pad(s, 11)).join('')}`);
  const total: Record<RecordStatus, number> = { set: 0, overwrite: 0, unchanged: 0, conflict: 0, blocked: 0, error: 0 };
  for (const t of Object.keys(sum).sort()) {
    lines.push(`  ${pad(t, 26)}${STATUSES.map((s) => pad(sum[t][s], 11)).join('')}`);
    for (const s of STATUSES) total[s] += sum[t][s];
  }
  lines.push(`  ${pad('TOTAL', 26)}${STATUSES.map((s) => pad(total[s], 11)).join('')}`);
  lines.push('');
  const perKind: Record<string, { entities: number; publishes: number }> = {};
  for (const c of plan.changes) {
    perKind[c.kind] ??= { entities: 0, publishes: 0 };
    perKind[c.kind].entities++;
    if (c.publish) perKind[c.kind].publishes++;
  }
  lines.push('Writes per entity kind:');
  if (!plan.changes.length) lines.push('  (none)');
  for (const k of Object.keys(perKind).sort())
    lines.push(
      `  ${pad(k, 20)}${perKind[k].entities} entit${perKind[k].entities === 1 ? 'y' : 'ies'}` +
        (k === 'page' ? `, ${perKind[k].publishes} publish(es)` : ''),
    );
  const list = (status: RecordStatus, title: string, withValues: boolean) => {
    const hits = plan.outcomes.filter((o) => o.status === status);
    if (!hits.length) return;
    lines.push('');
    lines.push(`${title} (${hits.length}):`);
    for (const o of hits) {
      lines.push(`  ${o.key}${o.detail ? `  — ${o.detail}` : ''}`);
      if (withValues) {
        lines.push(`      current: ${short(o.current)}`);
        lines.push(`      new:     ${short(o.value)}`);
      }
    }
  };
  list('error', 'ERRORS (skipped)', false);
  list('conflict', 'CONFLICTS (existing value differs; skipped, --overwrite writes them)', true);
  list('overwrite', 'OVERWRITES (existing value replaced)', true);
  const blockedTemplates = plan.outcomes.filter(
    (o) => o.status === 'blocked' && o.type === 'designer_element',
  );
  if (blockedTemplates.length) {
    lines.push('');
    lines.push(`BLOCKED DESIGNER RECORDS (template not published; skipped) (${blockedTemplates.length}):`);
    for (const d of new Set(blockedTemplates.map((o) => o.detail))) lines.push(`  ${d}`);
  }
  if (Object.keys(plan.blocked_pages).length) {
    lines.push('');
    lines.push('BLOCKED PAGES (draft differs from published; --publish-draft-changes releases those edits too):');
    for (const [id, diff] of Object.entries(plan.blocked_pages)) {
      lines.push(`  page ${id}`);
      for (const d of diff) lines.push(`    - ${d}`);
    }
  }
  if (plan.warnings.length) {
    lines.push('');
    lines.push(`Warnings (${plan.warnings.length}):`);
    for (const w of plan.warnings) lines.push(`  - ${w}`);
  }
  if (verbose) {
    lines.push('');
    lines.push('Entities to write:');
    for (const c of plan.changes)
      lines.push(`  ${c.kind} ${c.id}: ${c.writes} record(s)${c.kind === 'page' ? (c.publish ? ', publish' : ', draft only') : ''}`);
  }
  return lines.join('\n');
}

export function renderRestorePlan(plan: RestorePlan): string {
  const lines = [`Restore for store ${plan.store.slug} (${plan.store.id})`];
  lines.push(`  to restore: ${plan.changes.length}`);
  for (const c of plan.changes) lines.push(`    ${c.kind}:${c.id}`);
  lines.push(`  already at the backed-up state: ${plan.unchanged.length}`);
  if (plan.drifted.length) {
    lines.push(`  CHANGED AFTER THE APPLY (skipped; --force restores them anyway): ${plan.drifted.length}`);
    for (const k of plan.drifted) lines.push(`    ${k}`);
  }
  if (plan.missing.length) {
    lines.push(`  missing now: ${plan.missing.length}`);
    for (const k of plan.missing) lines.push(`    ${k}`);
  }
  if (plan.blocked.length) {
    lines.push(
      `  BLOCKED PAGES (unpublished draft edits; --publish-draft-changes releases them too): ${plan.blocked.length}`,
    );
    for (const b of plan.blocked) {
      lines.push(`    ${b.key}`);
      for (const d of b.diff) lines.push(`      - ${d}`);
    }
  }
  return lines.join('\n');
}

// ── Utils ───────────────────────────────────────────────────────────────────

/** JSON with object keys sorted at every level (jsonb does not keep key order). */
export function stableStringify(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

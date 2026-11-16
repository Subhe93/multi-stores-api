/**
 * Pure planning half of `platform-email-templates-sync.ts` (no Prisma import
 * so it can be unit-tested): compares the platform default email templates
 * (`NotificationTemplate`, one row per event, per-locale JSON) with the
 * current defaults (prisma/platform-email-templates.ts) and decides, per
 * event, locale and field (subject / body_html / body_text), what to write.
 *
 * SAFE MERGE (default) — per field of a locale:
 *   - no row for the event               -> create the row with every locale
 *   - field missing or empty             -> add the default            (add)
 *   - equals the current default         -> nothing                    (same)
 *   - equals a known OLD default of that
 *     event + locale + field             -> replace with the default   (replace-old)
 *   - anything else                      -> keep, it looks admin-edited (keep-edited)
 * `--force` turns keep-edited into replace-forced for the selected events.
 *
 * Comparison ignores CRLF vs LF and leading / trailing whitespace only.
 * Locales the defaults do not define are never touched. `enabled` is never
 * written on an existing row. Store-level templates are not part of the
 * plan at all.
 */
import { createHash } from 'crypto';

// ── Types ───────────────────────────────────────────────────────────────────

export const TEMPLATE_FIELDS = ['subject', 'body_html', 'body_text'] as const;
export type TemplateField = (typeof TEMPLATE_FIELDS)[number];

export interface TemplateText {
  subject: string;
  body_html: string;
  body_text: string;
}
/** event -> locale -> texts */
export type TemplateSet = Record<string, Record<string, TemplateText>>;

/** A `NotificationTemplate` row as read from the database. */
export interface DbTemplateRow {
  event: string;
  subject: unknown;
  body_html: unknown;
  body_text: unknown;
  enabled?: boolean;
}

export interface KnownOldSet {
  label: string;
  texts: TemplateSet;
}

export interface Options {
  mode: 'dry-run' | 'apply';
  force: boolean;
  /** null = every event the defaults define. */
  events: string[] | null;
  fingerprint: string | null;
}

export type FieldStatus =
  | 'same'
  | 'add'
  | 'replace-old'
  | 'replace-forced'
  | 'keep-edited';

export interface FieldPlan {
  field: TemplateField;
  status: FieldStatus;
  /** Which old generation the stored text equals (replace-old only). */
  oldLabel?: string;
  /**
   * Placeholders of the default that the STORED text does not use (only for
   * a stored, differing text), e.g. `items_html`.
   */
  missingPlaceholders: string[];
}

export type LocaleState =
  | 'missing' // no text at all for this locale
  | 'same' // every field equals the default
  | 'update' // at least one field is added / replaced, none kept
  | 'kept' // at least one field looks admin-edited and is kept
  | 'forced'; // at least one admin-edited field is overwritten (--force)

export interface LocalePlan {
  locale: string;
  state: LocaleState;
  fields: FieldPlan[];
}

export interface EventPlan {
  event: string;
  rowMissing: boolean;
  locales: LocalePlan[];
  /** Locales stored in the row that the defaults do not define (untouched). */
  extraLocales: string[];
  action: 'create' | 'update' | 'none';
  /** The three columns to write (complete JSON per column), or null. */
  next: Record<TemplateField, Record<string, unknown>> | null;
}

export interface Plan {
  force: boolean;
  events: EventPlan[];
}

// ── Arguments ───────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): Options {
  const out: Options = {
    mode: 'dry-run',
    force: false,
    events: null,
    fingerprint: null,
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
    else if (a === '--force') out.force = true;
    else if (a === '--events' || a.startsWith('--events=')) {
      const list = value('--events')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length === 0)
        throw new Error('--events needs at least one event');
      out.events = [...new Set(list)];
    } else if (a === '--fingerprint' || a.startsWith('--fingerprint='))
      out.fingerprint = value('--fingerprint').trim();
    // Read by scripts/ops/backup-dir.js from process.argv.
    else if (a.startsWith('--backup-dir=')) continue;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

/** The events of this run, in the order of the defaults. */
export function selectEvents(defaults: TemplateSet, opts: Options): string[] {
  const all = Object.keys(defaults);
  if (!opts.events) return all;
  const unknown = opts.events.filter((e) => !all.includes(e));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown event(s): ${unknown.join(', ')}. Known: ${all.join(', ')}`,
    );
  }
  return all.filter((e) => opts.events!.includes(e));
}

// ── Rules ───────────────────────────────────────────────────────────────────

/** Comparison form: CRLF -> LF, outer whitespace dropped. */
export function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

/** Variable names a template uses ({{var}}, {{#if var}}, {{#unless var}}). */
export function placeholdersOf(text: string): string[] {
  const out = new Set<string>();
  const re = /\{\{\s*(?:#if\s+|#unless\s+)?(\w+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.add(m[1]);
  return [...out];
}

/** Placeholders of `wanted` that `stored` does not use. */
export function missingPlaceholders(stored: string, wanted: string): string[] {
  const have = new Set(placeholdersOf(stored));
  return placeholdersOf(wanted).filter((v) => !have.has(v));
}

const asObject = (json: unknown): Record<string, unknown> =>
  json && typeof json === 'object' && !Array.isArray(json)
    ? (json as Record<string, unknown>)
    : {};

/** Label of the old generation whose text equals `stored`, or null. */
function matchKnownOld(
  knownOld: KnownOldSet[],
  event: string,
  locale: string,
  field: TemplateField,
  stored: string,
): string | null {
  for (const set of knownOld) {
    const old = set.texts[event]?.[locale]?.[field];
    if (typeof old === 'string' && normalize(old) === stored) return set.label;
  }
  return null;
}

function planField(
  event: string,
  locale: string,
  field: TemplateField,
  storedRaw: unknown,
  wanted: string,
  knownOld: KnownOldSet[],
  force: boolean,
): FieldPlan {
  const none: string[] = [];
  if (storedRaw === undefined || storedRaw === null || storedRaw === '')
    return { field, status: 'add', missingPlaceholders: none };
  // A non-string value is not something this script understands: never
  // overwrite it silently.
  if (typeof storedRaw !== 'string') {
    return {
      field,
      status: force ? 'replace-forced' : 'keep-edited',
      missingPlaceholders: placeholdersOf(wanted),
    };
  }
  const stored = normalize(storedRaw);
  if (stored === '') return { field, status: 'add', missingPlaceholders: none };
  if (stored === normalize(wanted))
    return { field, status: 'same', missingPlaceholders: none };
  const missing = missingPlaceholders(storedRaw, wanted);
  const oldLabel = matchKnownOld(knownOld, event, locale, field, stored);
  if (oldLabel)
    return {
      field,
      status: 'replace-old',
      oldLabel,
      missingPlaceholders: missing,
    };
  return {
    field,
    status: force ? 'replace-forced' : 'keep-edited',
    missingPlaceholders: missing,
  };
}

function localeState(fields: FieldPlan[]): LocaleState {
  const has = (s: FieldStatus) => fields.some((f) => f.status === s);
  if (fields.every((f) => f.status === 'add')) return 'missing';
  if (fields.every((f) => f.status === 'same')) return 'same';
  if (has('keep-edited')) return 'kept';
  if (has('replace-forced')) return 'forced';
  return 'update';
}

const WRITES: ReadonlySet<FieldStatus> = new Set([
  'add',
  'replace-old',
  'replace-forced',
]);

export function planEvent(
  event: string,
  wanted: Record<string, TemplateText>,
  row: DbTemplateRow | null,
  knownOld: KnownOldSet[],
  force: boolean,
): EventPlan {
  const stored: Record<TemplateField, Record<string, unknown>> = {
    subject: asObject(row?.subject),
    body_html: asObject(row?.body_html),
    body_text: asObject(row?.body_text),
  };
  // Start from the stored JSON so untouched locales (and key order) survive.
  const next: Record<TemplateField, Record<string, unknown>> = {
    subject: { ...stored.subject },
    body_html: { ...stored.body_html },
    body_text: { ...stored.body_text },
  };
  let writes = 0;
  const locales: LocalePlan[] = Object.keys(wanted).map((locale) => {
    const fields = TEMPLATE_FIELDS.map((field) => {
      const fp = planField(
        event,
        locale,
        field,
        stored[field][locale],
        wanted[locale][field],
        knownOld,
        force,
      );
      if (WRITES.has(fp.status)) {
        next[field][locale] = wanted[locale][field];
        writes++;
      }
      return fp;
    });
    return { locale, state: localeState(fields), fields };
  });
  const storedLocales = new Set(
    TEMPLATE_FIELDS.flatMap((f) => Object.keys(stored[f])),
  );
  const extraLocales = [...storedLocales].filter((l) => !(l in wanted)).sort();
  const action = !row ? 'create' : writes > 0 ? 'update' : 'none';
  return {
    event,
    rowMissing: !row,
    locales,
    extraLocales,
    action,
    next: action === 'none' ? null : next,
  };
}

export function buildPlan(
  defaults: TemplateSet,
  rows: DbTemplateRow[],
  knownOld: KnownOldSet[],
  opts: Options,
): Plan {
  const byEvent = new Map(rows.map((r) => [r.event, r]));
  return {
    force: opts.force,
    events: selectEvents(defaults, opts).map((event) =>
      planEvent(
        event,
        defaults[event],
        byEvent.get(event) ?? null,
        knownOld,
        opts.force,
      ),
    ),
  };
}

export function isNoop(plan: Plan): boolean {
  return plan.events.every((e) => e.action === 'none');
}

/** Hash of everything the plan would write; ties --apply to a dry run. */
export function fingerprint(plan: Plan): string {
  const h = createHash('sha256');
  h.update(plan.force ? 'force' : 'merge');
  for (const e of plan.events) {
    if (e.action === 'none') continue;
    h.update(`\n${e.event}\t${e.action}\t${JSON.stringify(e.next)}`);
  }
  return h.digest('hex').slice(0, 16);
}

// ── Report ──────────────────────────────────────────────────────────────────

const STATUS_TEXT: Record<FieldStatus, string> = {
  same: 'same as default',
  add: 'missing -> add',
  'replace-old': 'old default -> replace',
  'replace-forced': 'differs (admin-edited?) -> OVERWRITE (--force)',
  'keep-edited':
    'differs, not a known old default -> KEEP (looks admin-edited)',
};

const LOCALE_TEXT: Record<LocaleState, string> = {
  missing: 'MISSING LOCALE -> add',
  same: 'ok (same as default)',
  update: 'UPDATE',
  kept: 'KEPT (looks admin-edited; use --force to overwrite)',
  forced: 'OVERWRITE (--force)',
};

export interface PlanCounts {
  rowsCreated: number;
  rowsUpdated: number;
  rowsUntouched: number;
  localesAdded: number;
  localesUpdated: number;
  localesKept: number;
  localesForced: number;
  fieldsWritten: number;
  fieldsKept: number;
}

export function countPlan(plan: Plan): PlanCounts {
  const c: PlanCounts = {
    rowsCreated: 0,
    rowsUpdated: 0,
    rowsUntouched: 0,
    localesAdded: 0,
    localesUpdated: 0,
    localesKept: 0,
    localesForced: 0,
    fieldsWritten: 0,
    fieldsKept: 0,
  };
  for (const e of plan.events) {
    if (e.action === 'create') c.rowsCreated++;
    else if (e.action === 'update') c.rowsUpdated++;
    else c.rowsUntouched++;
    for (const l of e.locales) {
      if (l.state === 'missing') c.localesAdded++;
      else if (l.state === 'update') c.localesUpdated++;
      else if (l.state === 'kept') c.localesKept++;
      else if (l.state === 'forced') c.localesForced++;
      for (const f of l.fields) {
        if (WRITES.has(f.status)) c.fieldsWritten++;
        else if (f.status === 'keep-edited') c.fieldsKept++;
      }
    }
  }
  return c;
}

/**
 * Human report. Template texts are never printed, only states and
 * placeholder names.
 */
export function renderPlan(plan: Plan, mode: 'dry-run' | 'apply'): string {
  const lines: string[] = [];
  lines.push(
    `Platform email templates sync (${mode}, ${plan.force ? 'FORCE: overwrite everything' : 'safe merge'})`,
  );
  lines.push(
    'Table: NotificationTemplate (platform defaults only; store templates are not read or written)',
  );
  for (const e of plan.events) {
    lines.push('');
    const head = e.rowMissing
      ? 'ROW MISSING -> create (enabled)'
      : e.action === 'update'
        ? 'update'
        : 'no change';
    lines.push(`${e.event}: ${head}`);
    for (const l of e.locales) {
      lines.push(`  ${l.locale}: ${LOCALE_TEXT[l.state]}`);
      // A fully missing or fully equal locale needs no per-field detail.
      if (l.state === 'missing' || l.state === 'same') continue;
      for (const f of l.fields) {
        const old = f.oldLabel ? ` [${f.oldLabel}]` : '';
        const miss =
          f.missingPlaceholders.length > 0
            ? `; stored text lacks {{${f.missingPlaceholders.join('}}, {{')}}}`
            : '';
        lines.push(`    ${f.field}: ${STATUS_TEXT[f.status]}${old}${miss}`);
      }
    }
    if (e.extraLocales.length > 0)
      lines.push(
        `  other locales in the row (untouched): ${e.extraLocales.join(', ')}`,
      );
  }
  const c = countPlan(plan);
  lines.push('');
  lines.push(
    `Summary: rows create ${c.rowsCreated}, update ${c.rowsUpdated}, untouched ${c.rowsUntouched}; ` +
      `locales add ${c.localesAdded}, update ${c.localesUpdated}, kept as admin-edited ${c.localesKept}, ` +
      `overwritten by --force ${c.localesForced}; fields written ${c.fieldsWritten}, kept ${c.fieldsKept}.`,
  );
  const kept = plan.events.flatMap((e) =>
    e.locales
      .filter((l) => l.state === 'kept')
      .map((l) => `${e.event}/${l.locale}`),
  );
  if (kept.length > 0) {
    lines.push(
      `Kept because they look admin-edited (${kept.length}): ${kept.join(', ')}`,
    );
    const lacking = plan.events.flatMap((e) =>
      e.locales.flatMap((l) =>
        l.fields
          .filter(
            (f) =>
              f.status === 'keep-edited' && f.missingPlaceholders.length > 0,
          )
          .map(
            (f) =>
              `${e.event}/${l.locale}/${f.field} lacks {{${f.missingPlaceholders.join('}}, {{')}}}`,
          ),
      ),
    );
    if (lacking.length > 0) {
      lines.push('Kept texts that lack placeholders of the default:');
      for (const x of lacking) lines.push(`  ${x}`);
    }
  }
  return lines.join('\n');
}

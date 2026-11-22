/**
 * M159 Namez option labels: pure plan / restore logic of
 * namez-option-labels-apply.ts (no Prisma, no Nest, no I/O).
 *
 * Input file (client material, outside git), keyed by the canonical
 * (primary-locale, Swedish) option names and values:
 *   {
 *     "meta":   { "store": "namez-se", "locales": ["de", "en"], ... },
 *     "names":  { "Färg": { "de": "Farbe", "en": "Colour" } },
 *     "values": { "Färg": { "Svart": { "de": "Schwarz", "en": "Black" } } },
 *     "overrides": { "<sv slug or product id>": { "names": {...}, "values": {...} } }
 *   }
 * A label equal to the canonical text means "keep the canonical text" (it
 * counts as covered, and is not stored).
 *
 * Plan rules:
 * - per product with options and per locale: wanted labels = file + the
 *   product's overrides, restricted to the live option set;
 * - a live name / value without an entry for a locale is `missing` (fails
 *   the plan unless --allow-missing);
 * - a product without a translation row of the locale is `missingRow` (no
 *   row is created; labels need the translated title);
 * - a stored label that differs from the wanted one is a conflict (kept)
 *   unless --overwrite; stored labels the file does not name are kept;
 * - idempotent: a second run plans nothing.
 */
import { createHash } from 'crypto';
import {
  normalizeVariantOptionLabels,
  pruneVariantOptionLabels,
  readVariantOptionLabels,
  sameVariantOptionLabels,
  type OptionSet,
  type VariantOptionLabels,
} from '../../src/common/catalog/variant-option-labels';

export type LocaleMap = Record<string, string>;

export interface LabelsFile {
  meta?: { store?: string; locales?: string[]; [k: string]: unknown };
  names: Record<string, LocaleMap>;
  values: Record<string, Record<string, LocaleMap>>;
  overrides?: Record<
    string,
    {
      names?: Record<string, LocaleMap>;
      values?: Record<string, Record<string, LocaleMap>>;
    }
  >;
}

export interface SnapProduct {
  id: string;
  /** Primary-locale slug (overrides may name it). */
  slug: string | null;
  /** Option name -> values (every variant plus the option config). */
  options: Record<string, string[]>;
  /** Existing translation rows: locale -> stored labels (null = none). */
  rows: Record<string, VariantOptionLabels | null>;
}

export interface Snapshot {
  store: { id: string; slug: string; primary_locale: string };
  products: SnapProduct[];
}

export interface PlanOptions {
  locales: string[];
  overwrite: boolean;
  allowMissing: boolean;
}

export interface Change {
  product_id: string;
  slug: string | null;
  locale: string;
  before: VariantOptionLabels | null;
  after: VariantOptionLabels | null;
}

export interface Plan {
  store: Snapshot['store'];
  locales: string[];
  changes: Change[];
  unchanged: number;
  missing: {
    product_id: string;
    slug: string | null;
    locale: string;
    path: string;
  }[];
  missingRow: { product_id: string; slug: string | null; locale: string }[];
  conflicts: {
    product_id: string;
    slug: string | null;
    locale: string;
    path: string;
    current: string;
    wanted: string;
  }[];
  skippedPrimary: boolean;
}

export interface BackupFile {
  format: 'namez-option-labels-backup/1';
  store: { id: string; slug: string };
  created_at: string;
  fingerprint: string;
  entities: Change[];
  applied: string[];
  failed?: string[];
}

export interface Options {
  mode: 'dry-run' | 'apply';
  file: string | null;
  store: string | null;
  fingerprint: string | null;
  backupDir: string | null;
  restore: string | null;
  snapshot: string | null;
  dumpSnapshot: string | null;
  locales: string[];
  overwrite: boolean;
  allowMissing: boolean;
  force: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Shape check of the input file; returns the issues (empty = valid). */
export function validateLabelsFile(raw: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(raw)) return ['file: not an object'];
  const localeMap = (v: unknown, path: string) => {
    if (!isRecord(v)) {
      issues.push(`${path}: not an object`);
      return;
    }
    for (const [l, s] of Object.entries(v)) {
      if (typeof s !== 'string' || !s.trim())
        issues.push(`${path}.${l}: not a non-empty string`);
    }
  };
  const block = (b: unknown, path: string) => {
    if (b === undefined) return;
    if (!isRecord(b)) {
      issues.push(`${path}: not an object`);
      return;
    }
    if (b.names !== undefined) {
      if (!isRecord(b.names)) issues.push(`${path}.names: not an object`);
      else
        for (const [n, m] of Object.entries(b.names))
          localeMap(m, `${path}.names.${n}`);
    }
    if (b.values !== undefined) {
      if (!isRecord(b.values)) issues.push(`${path}.values: not an object`);
      else
        for (const [n, vals] of Object.entries(b.values)) {
          if (!isRecord(vals))
            issues.push(`${path}.values.${n}: not an object`);
          else
            for (const [v, m] of Object.entries(vals))
              localeMap(m, `${path}.values.${n}.${v}`);
        }
    }
  };
  block({ names: raw.names ?? {}, values: raw.values ?? {} }, 'file');
  if (raw.overrides !== undefined) {
    if (!isRecord(raw.overrides)) issues.push('file.overrides: not an object');
    else
      for (const [k, o] of Object.entries(raw.overrides))
        block(o, `file.overrides.${k}`);
  }
  return issues;
}

function optionSetOf(p: SnapProduct): OptionSet {
  return new Map(Object.entries(p.options).map(([n, vs]) => [n, new Set(vs)]));
}

/** Plan of one store snapshot against the labels file. */
export function buildPlan(
  snap: Snapshot,
  file: LabelsFile,
  opts: PlanOptions,
): Plan {
  const plan: Plan = {
    store: snap.store,
    locales: opts.locales,
    changes: [],
    unchanged: 0,
    missing: [],
    missingRow: [],
    conflicts: [],
    skippedPrimary: false,
  };
  const primaryBase = snap.store.primary_locale.split(/[-_]/)[0].toLowerCase();
  const locales = opts.locales.filter((l) => {
    const primary = l.split(/[-_]/)[0].toLowerCase() === primaryBase;
    if (primary) plan.skippedPrimary = true;
    return !primary;
  });
  const products = [...snap.products].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  for (const p of products) {
    const names = Object.keys(p.options);
    if (names.length === 0) continue;
    const ov =
      (p.slug && file.overrides?.[p.slug]) || file.overrides?.[p.id] || {};
    const nameLabel = (name: string, l: string) =>
      ov.names?.[name]?.[l] ?? file.names?.[name]?.[l];
    const valueLabel = (name: string, value: string, l: string) =>
      ov.values?.[name]?.[value]?.[l] ?? file.values?.[name]?.[value]?.[l];

    for (const l of locales) {
      // Wanted labels for every live key (undefined = no entry).
      const wanted: {
        path: string;
        kind: 'n' | 'v';
        name: string;
        value?: string;
        label: string | undefined;
      }[] = [];
      for (const name of names) {
        wanted.push({
          path: `names.${name}`,
          kind: 'n',
          name,
          label: nameLabel(name, l),
        });
        for (const value of p.options[name]) {
          wanted.push({
            path: `values.${name}.${value}`,
            kind: 'v',
            name,
            value,
            label: valueLabel(name, value, l),
          });
        }
      }
      for (const w of wanted) {
        if (w.label === undefined)
          plan.missing.push({
            product_id: p.id,
            slug: p.slug,
            locale: l,
            path: w.path,
          });
      }
      if (!(l in p.rows)) {
        if (
          wanted.some(
            (w) =>
              w.label !== undefined && w.label.trim() !== (w.value ?? w.name),
          )
        ) {
          plan.missingRow.push({ product_id: p.id, slug: p.slug, locale: l });
        }
        continue;
      }
      const current = readVariantOptionLabels(p.rows[l]);
      const merged: {
        names: Record<string, string>;
        values: Record<string, Record<string, string>>;
      } = {
        names: { ...(current?.names ?? {}) },
        values: Object.fromEntries(
          Object.entries(current?.values ?? {}).map(([n, m]) => [n, { ...m }]),
        ),
      };
      for (const w of wanted) {
        if (w.label === undefined) continue;
        const canonical = w.kind === 'n' ? w.name : w.value!;
        const target = w.label.trim();
        const stored =
          w.kind === 'n'
            ? merged.names[w.name]
            : merged.values[w.name]?.[w.value!];
        const storedShown = stored ?? canonical;
        if (storedShown === target) continue;
        if (stored !== undefined && !opts.overwrite) {
          plan.conflicts.push({
            product_id: p.id,
            slug: p.slug,
            locale: l,
            path: w.path,
            current: stored,
            wanted: target,
          });
          continue;
        }
        if (w.kind === 'n') {
          if (target === canonical) delete merged.names[w.name];
          else merged.names[w.name] = target;
        } else {
          const m = (merged.values[w.name] ??= {});
          if (target === canonical) delete m[w.value!];
          else m[w.value!] = target;
        }
      }
      // The same normalizer as the service, so the planned value is exactly
      // what will be stored (idempotence); stale keys are pruned.
      const { labels: after } = normalizeVariantOptionLabels(
        pruneForSet(merged, optionSetOf(p)),
        optionSetOf(p),
      );
      if (sameVariantOptionLabels(current, after)) {
        plan.unchanged += 1;
        continue;
      }
      plan.changes.push({
        product_id: p.id,
        slug: p.slug,
        locale: l,
        before: current,
        after,
      });
    }
  }
  return plan;
}

/** Drops keys outside the option set (the normalizer would flag them). */
function pruneForSet(
  l: {
    names: Record<string, string>;
    values: Record<string, Record<string, string>>;
  },
  set: OptionSet,
): VariantOptionLabels {
  const names = Object.fromEntries(
    Object.entries(l.names).filter(([n]) => set.has(n)),
  );
  const values: Record<string, Record<string, string>> = {};
  for (const [n, m] of Object.entries(l.values)) {
    const known = set.get(n);
    if (!known) continue;
    const inner = Object.fromEntries(
      Object.entries(m).filter(([v]) => known.has(v)),
    );
    if (Object.keys(inner).length) values[n] = inner;
  }
  return { names, values };
}

/** True when the plan may be applied (no missing labels unless allowed). */
export function planBlocked(
  plan: Plan,
  opts: Pick<PlanOptions, 'allowMissing'>,
): boolean {
  return plan.missing.length > 0 && !opts.allowMissing;
}

export function fingerprint(plan: {
  store: { id: string };
  changes: Change[];
}): string {
  return createHash('sha256')
    .update(
      stableStringify({
        store: plan.store.id,
        changes: plan.changes.map((c) => ({
          id: c.product_id,
          locale: c.locale,
          after: c.after ?? null,
        })),
      }),
    )
    .digest('hex')
    .slice(0, 16);
}

export interface RestorePlan {
  store: { id: string; slug: string };
  changes: Change[];
  drifted: { product_id: string; locale: string }[];
  missingRow: { product_id: string; locale: string }[];
}

/**
 * Puts every entity of a backup back to its `before` labels. An entity whose
 * stored labels are no longer the backup's `after` (changed again since) is
 * skipped as drifted unless `force`.
 */
export function buildRestorePlan(
  backup: BackupFile,
  snap: Snapshot,
  force: boolean,
): RestorePlan {
  const byId = new Map(snap.products.map((p) => [p.id, p]));
  const plan: RestorePlan = {
    store: backup.store,
    changes: [],
    drifted: [],
    missingRow: [],
  };
  for (const e of backup.entities) {
    const p = byId.get(e.product_id);
    if (!p || !(e.locale in p.rows)) {
      plan.missingRow.push({ product_id: e.product_id, locale: e.locale });
      continue;
    }
    const now = readVariantOptionLabels(p.rows[e.locale]);
    if (sameVariantOptionLabels(now, e.before)) continue;
    if (!sameVariantOptionLabels(now, e.after) && !force) {
      plan.drifted.push({ product_id: e.product_id, locale: e.locale });
      continue;
    }
    // Options renamed since the apply: their old labels cannot be stored.
    const target = pruneVariantOptionLabels(e.before, optionSetOf(p));
    plan.changes.push({
      product_id: e.product_id,
      slug: e.slug,
      locale: e.locale,
      before: now,
      after: target,
    });
  }
  return plan;
}

/** Changes grouped per product: `{ productId: { locale: labels | null } }`. */
export function writesByProduct(
  changes: Change[],
): Map<string, Record<string, VariantOptionLabels | null>> {
  const out = new Map<string, Record<string, VariantOptionLabels | null>>();
  for (const c of changes) {
    const m = out.get(c.product_id) ?? {};
    m[c.locale] = c.after;
    out.set(c.product_id, m);
  }
  return out;
}

export function renderPlan(plan: Plan): string {
  const lines: string[] = [];
  lines.push(
    `Store ${plan.store.slug} (${plan.store.id}), primary ${plan.store.primary_locale}; locales ${plan.locales.join(', ')}`,
  );
  if (plan.skippedPrimary)
    lines.push(
      '  (the primary locale is skipped: its option names are canonical)',
    );
  lines.push(
    `Changes: ${plan.changes.length}   unchanged rows: ${plan.unchanged}`,
  );
  for (const c of plan.changes) {
    const n = Object.keys(c.after?.names ?? {}).length;
    const v = Object.values(c.after?.values ?? {}).reduce(
      (s, m) => s + Object.keys(m).length,
      0,
    );
    lines.push(
      `  ${c.slug ?? c.product_id} [${c.locale}] -> ${n} name label(s), ${v} value label(s)${c.before ? ' (replaces stored labels)' : ''}`,
    );
  }
  if (plan.missingRow.length) {
    lines.push(
      `No translation row (not created; add the translated title first): ${plan.missingRow.length}`,
    );
    for (const m of plan.missingRow)
      lines.push(`  ${m.slug ?? m.product_id} [${m.locale}]`);
  }
  if (plan.conflicts.length) {
    lines.push(
      `Conflicts (stored label kept; --overwrite replaces): ${plan.conflicts.length}`,
    );
    for (const c of plan.conflicts)
      lines.push(
        `  ${c.slug ?? c.product_id} [${c.locale}] ${c.path}: "${c.current}" vs "${c.wanted}"`,
      );
  }
  if (plan.missing.length) {
    lines.push(
      `MISSING labels in the file (the plan fails unless --allow-missing): ${plan.missing.length}`,
    );
    for (const m of plan.missing)
      lines.push(`  ${m.slug ?? m.product_id} [${m.locale}] ${m.path}`);
  }
  return lines.join('\n');
}

export function renderRestorePlan(plan: RestorePlan): string {
  const lines = [
    `Restore for store ${plan.store.slug}: ${plan.changes.length} row(s)`,
  ];
  for (const c of plan.changes)
    lines.push(
      `  ${c.slug ?? c.product_id} [${c.locale}] -> ${c.after ? 'previous labels' : 'no labels'}`,
    );
  if (plan.drifted.length) {
    lines.push(
      `Changed since the apply (skipped; --force restores anyway): ${plan.drifted.length}`,
    );
    for (const d of plan.drifted) lines.push(`  ${d.product_id} [${d.locale}]`);
  }
  if (plan.missingRow.length) {
    lines.push(`Row gone (skipped): ${plan.missingRow.length}`);
    for (const d of plan.missingRow)
      lines.push(`  ${d.product_id} [${d.locale}]`);
  }
  return lines.join('\n');
}

export function parseArgs(argv: string[]): Options {
  const o: Options = {
    mode: 'dry-run',
    file: null,
    store: null,
    fingerprint: null,
    backupDir: null,
    restore: null,
    snapshot: null,
    dumpSnapshot: null,
    locales: [],
    overwrite: false,
    allowMissing: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const value = (): string => {
      if (eq > 0) return a.slice(eq + 1).trim();
      const next = argv[++i];
      if (next === undefined || next.startsWith('--'))
        throw new Error(`${flag} needs a value`);
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
      case '--allow-missing':
        o.allowMissing = true;
        break;
      case '--force':
        o.force = true;
        break;
      case '--file':
        o.file = value();
        break;
      case '--store':
        o.store = value();
        break;
      case '--fingerprint':
        o.fingerprint = value();
        break;
      case '--backup-dir':
        o.backupDir = value();
        break;
      case '--restore':
        o.restore = value();
        break;
      case '--snapshot':
        o.snapshot = value();
        break;
      case '--dump-snapshot':
        o.dumpSnapshot = value();
        break;
      case '--locales':
        o.locales = value()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      default:
        throw new Error(`Unknown option ${a}`);
    }
  }
  if (!o.store) throw new Error('--store=<slug> is required');
  if (!o.restore && !o.file)
    throw new Error(
      '--file=<option-labels.json> (or --restore=<backup.json>) is required',
    );
  return o;
}

export function stableStringify(value: unknown): string {
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

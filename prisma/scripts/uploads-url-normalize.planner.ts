/**
 * Pure planning half of `uploads-url-normalize.ts` (no Prisma import so it
 * can be unit-tested): the inventory of every DB column / JSON blob holding
 * public upload references (plans/s3-storage/INVENTORY.md §2), the per-row
 * rewrite, the fingerprint and the masked report. `storage-migrate.ts` reads
 * the same column inventory for its orphan report.
 */
import { createHash } from 'crypto';
import {
  DEFAULT_UPLOAD_HOSTS,
  extractUploadKey,
  hostOf,
  normalizeUploadUrl,
  normalizeUploadUrlsInJson,
  scanUploadKeys,
} from '../../src/common/uploads/upload-url';

// ── Column inventory ────────────────────────────────────────────────────────

/**
 * `model` is the Prisma client delegate name, `column` the field. `url`
 * columns hold one value (rewritten only when the WHOLE value is an upload
 * URL of our host, so free-text `value` columns are safe); `json` columns are
 * deep-walked and embedded URLs inside strings are rewritten too.
 */
export interface UploadRefColumn {
  model: string;
  column: string;
  kind: 'url' | 'json';
}

export const UPLOAD_REF_COLUMNS: readonly UploadRefColumn[] = [
  { model: 'productImage', column: 'url', kind: 'url' },
  { model: 'customProductImage', column: 'url', kind: 'url' },
  { model: 'provider', column: 'logo_url', kind: 'url' },
  { model: 'creator', column: 'avatar_url', kind: 'url' },
  { model: 'creator', column: 'cover_url', kind: 'url' },
  { model: 'user', column: 'avatar_url', kind: 'url' },
  { model: 'creatorCategory', column: 'thumbnail_url', kind: 'url' },
  { model: 'category', column: 'icon', kind: 'url' },
  { model: 'orderCustomFieldValue', column: 'file_url', kind: 'url' },
  { model: 'orderCustomFieldValue', column: 'value', kind: 'url' },
  { model: 'customProductFieldValue', column: 'file_url', kind: 'url' },
  { model: 'customProductFieldValue', column: 'value', kind: 'url' },
  { model: 'orderItem', column: 'customer_design_url', kind: 'url' },
  { model: 'orderProductionCheck', column: 'file_url', kind: 'url' },
  { model: 'cartItem', column: 'custom_fields', kind: 'json' },
  { model: 'page', column: 'seo', kind: 'json' },
  { model: 'pageSection', column: 'settings', kind: 'json' },
  { model: 'pageSectionTranslation', column: 'content', kind: 'json' },
  { model: 'pageBlock', column: 'settings', kind: 'json' },
  { model: 'pageBlockTranslation', column: 'content', kind: 'json' },
  { model: 'pageVersion', column: 'snapshot', kind: 'json' },
  { model: 'customFieldTranslation', column: 'help_image_url', kind: 'url' },
  { model: 'productCustomField', column: 'ui', kind: 'json' },
  { model: 'personalizationFieldTemplate', column: 'definition', kind: 'json' },
  { model: 'store', column: 'theme_customizations', kind: 'json' },
  { model: 'store', column: 'theme_config', kind: 'json' },
  // Relative today by contract; listed so the orphan report sees them and a
  // stray absolute value is still normalised.
  { model: 'store', column: 'logo_url', kind: 'url' },
  { model: 'store', column: 'favicon_url', kind: 'url' },
  { model: 'storeLegalProfile', column: 'logo_url', kind: 'url' },
  { model: 'customerUpload', column: 'preview_url', kind: 'url' },
  { model: 'importMedia', column: 'public_url', kind: 'url' },
];

/** Private-storage keys (orphan report of the private / invoices scopes). */
export interface PrivateKeyColumn {
  model: string;
  column: string;
  /** `key` = the value is the key; `print_files` = JSON `[{key}]`. */
  kind: 'key' | 'print_files';
  scope: 'private' | 'invoices';
}

export const PRIVATE_KEY_COLUMNS: readonly PrivateKeyColumn[] = [
  {
    model: 'customerUpload',
    column: 'original_key',
    kind: 'key',
    scope: 'private',
  },
  {
    model: 'designAsset',
    column: 'private_key',
    kind: 'key',
    scope: 'private',
  },
  {
    model: 'designAsset',
    column: 'preview_key',
    kind: 'key',
    scope: 'private',
  },
  { model: 'design', column: 'proof_key', kind: 'key', scope: 'private' },
  { model: 'design', column: 'proof_back_key', kind: 'key', scope: 'private' },
  {
    model: 'orderItemDesign',
    column: 'proof_key',
    kind: 'key',
    scope: 'private',
  },
  {
    model: 'orderItemDesign',
    column: 'proof_back_key',
    kind: 'key',
    scope: 'private',
  },
  {
    model: 'orderItemDesign',
    column: 'print_files',
    kind: 'print_files',
    scope: 'private',
  },
  { model: 'importRun', column: 'bundle_key', kind: 'key', scope: 'private' },
  { model: 'importRun', column: 'snapshot_key', kind: 'key', scope: 'private' },
  {
    model: 'importMedia',
    column: 'private_key',
    kind: 'key',
    scope: 'private',
  },
  { model: 'invoice', column: 'pdf_path', kind: 'key', scope: 'invoices' },
];

export function columnLabel(c: { model: string; column: string }): string {
  return `${c.model}.${c.column}`;
}

/** Object keys (`uploads/...`) referenced by one column value, any host. */
export function referencedMediaKeys(
  c: UploadRefColumn,
  value: unknown,
): string[] {
  if (value === null || value === undefined) return [];
  if (c.kind === 'url') {
    if (typeof value !== 'string') return [];
    const key = extractUploadKey(value);
    return key ? [key] : [];
  }
  return scanUploadKeys(
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

/** Private keys referenced by one column value. */
export function referencedPrivateKeys(
  c: PrivateKeyColumn,
  value: unknown,
): string[] {
  if (value === null || value === undefined) return [];
  if (c.kind === 'key') {
    return typeof value === 'string' && value.trim() ? [value.trim()] : [];
  }
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const f of value) {
    const k = (f as { key?: unknown })?.key;
    if (typeof k === 'string' && k.trim()) out.push(k.trim());
  }
  return out;
}

// ── Hosts ───────────────────────────────────────────────────────────────────

/**
 * Hosts whose absolute URLs are rewritten: `--hosts`, plus `PUBLIC_API_URL`
 * and `API_PUBLIC_ORIGINS` from the environment, plus `localhost:3001`.
 */
export function resolveHosts(
  flagHosts: readonly string[],
  env: Record<string, string | undefined>,
): string[] {
  const out = new Set<string>(DEFAULT_UPLOAD_HOSTS);
  const add = (raw: string | undefined) => {
    for (const part of (raw ?? '').split(',')) {
      const h = hostOf(part);
      if (h) out.add(h);
    }
  };
  for (const h of flagHosts) add(h);
  add(env.PUBLIC_API_URL);
  add(env.API_PUBLIC_ORIGINS);
  return [...out].sort();
}

// ── Plan ────────────────────────────────────────────────────────────────────

export interface RowChange {
  model: string;
  column: string;
  id: string;
  /** New value (string for url columns, JSON value for json columns). */
  next: unknown;
  /** Number of URL occurrences rewritten in this row. */
  occurrences: number;
}

export interface ColumnStats {
  model: string;
  column: string;
  kind: 'url' | 'json';
  rows_scanned: number;
  rows_to_change: number;
  occurrences: number;
  /** Hosts seen in absolute upload URLs that were NOT rewritten (foreign). */
  foreign_hosts: Record<string, number>;
}

export interface Plan {
  hosts: string[];
  columns: ColumnStats[];
  changes: RowChange[];
}

export function newColumnStats(c: UploadRefColumn): ColumnStats {
  return {
    model: c.model,
    column: c.column,
    kind: c.kind,
    rows_scanned: 0,
    rows_to_change: 0,
    occurrences: 0,
    foreign_hosts: {},
  };
}

const ANY_ABSOLUTE_RE = /https?:\/\/([^/?#\s"'<>)]+)\/uploads\//gi;

/** Rewrite of one row; null when nothing changes. Updates `stats`. */
export function planRow(
  c: UploadRefColumn,
  id: string,
  value: unknown,
  hosts: readonly string[],
  stats: ColumnStats,
): RowChange | null {
  stats.rows_scanned++;
  if (value === null || value === undefined) return null;

  // Foreign-host bookkeeping (report only).
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.includes('/uploads/')) {
    const known = new Set(hosts.map((h) => h.toLowerCase()));
    for (const m of text.matchAll(ANY_ABSOLUTE_RE)) {
      const h = m[1].toLowerCase();
      if (!known.has(h))
        stats.foreign_hosts[h] = (stats.foreign_hosts[h] ?? 0) + 1;
    }
  } else {
    return null;
  }

  if (c.kind === 'url') {
    if (typeof value !== 'string') return null;
    const next = normalizeUploadUrl(value, hosts);
    if (next === value) return null;
    stats.rows_to_change++;
    stats.occurrences++;
    return { model: c.model, column: c.column, id, next, occurrences: 1 };
  }

  const r = normalizeUploadUrlsInJson(value, hosts);
  if (r.changed === 0) return null;
  stats.rows_to_change++;
  stats.occurrences += r.changed;
  return {
    model: c.model,
    column: c.column,
    id,
    next: r.value,
    occurrences: r.changed,
  };
}

/**
 * sha256 over the canonical planned set: hosts + every (model, column, id,
 * sha256(new value)) sorted. First 16 hex characters are shown; --apply
 * re-plans inside the transaction and aborts when it differs.
 */
export function fingerprint(plan: Plan): string {
  const items = plan.changes
    .map(
      (ch) =>
        `${ch.model}|${ch.column}|${ch.id}|${createHash('sha256')
          .update(
            typeof ch.next === 'string' ? ch.next : JSON.stringify(ch.next),
          )
          .digest('hex')}`,
    )
    .sort();
  return createHash('sha256')
    .update(JSON.stringify({ hosts: [...plan.hosts].sort(), items }))
    .digest('hex')
    .slice(0, 16);
}

export function isNoop(plan: Plan): boolean {
  return plan.changes.length === 0;
}

/** Masked report: counts per column, never a customer file name or row value. */
export function renderPlan(plan: Plan, mode: 'dry-run' | 'apply'): string {
  const L: string[] = [];
  L.push(`uploads-url-normalize (${mode})`);
  L.push(`hosts rewritten to relative: ${plan.hosts.join(', ')}`);
  L.push('');
  const w = Math.max(...plan.columns.map((c) => columnLabel(c).length), 10);
  L.push(
    `${'column'.padEnd(w)}  ${'kind'.padEnd(4)}  ${'scanned'.padStart(9)}  ${'rows'.padStart(7)}  ${'urls'.padStart(7)}`,
  );
  let rows = 0;
  let urls = 0;
  const foreign: Record<string, number> = {};
  for (const c of plan.columns) {
    rows += c.rows_to_change;
    urls += c.occurrences;
    for (const [h, n] of Object.entries(c.foreign_hosts))
      foreign[h] = (foreign[h] ?? 0) + n;
    L.push(
      `${columnLabel(c).padEnd(w)}  ${c.kind.padEnd(4)}  ${String(c.rows_scanned).padStart(9)}  ${String(c.rows_to_change).padStart(7)}  ${String(c.occurrences).padStart(7)}`,
    );
  }
  L.push('');
  L.push(`rows to update: ${rows}   url occurrences: ${urls}`);
  const fh = Object.entries(foreign).sort((a, b) => b[1] - a[1]);
  if (fh.length) {
    L.push(
      `absolute upload URLs of OTHER hosts left untouched (add with --hosts if they are ours): ` +
        fh.map(([h, n]) => `${h} (${n})`).join(', '),
    );
  }
  L.push(`fingerprint: ${fingerprint(plan)}`);
  return L.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export interface Options {
  mode: 'dry-run' | 'apply';
  fingerprint: string | null;
  hosts: string[];
  /** Restrict to these `model.column` labels (debugging). */
  only: string[];
  batch: number;
}

export function parseArgs(argv: string[]): Options {
  const out: Options = {
    mode: 'dry-run',
    fingerprint: null,
    hosts: [],
    only: [],
    batch: 1000,
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
    else if (a === '--fingerprint' || a.startsWith('--fingerprint='))
      out.fingerprint = value('--fingerprint').trim().toLowerCase();
    else if (a === '--hosts' || a.startsWith('--hosts='))
      out.hosts.push(
        ...value('--hosts')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    else if (a === '--only' || a.startsWith('--only='))
      out.only.push(
        ...value('--only')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    else if (a === '--batch' || a.startsWith('--batch=')) {
      out.batch = Number(value('--batch'));
      if (!Number.isInteger(out.batch) || out.batch < 1)
        throw new Error('--batch must be a positive integer');
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (out.mode === 'apply' && !out.fingerprint) {
    throw new Error(
      '--apply requires --fingerprint=<hash printed by the dry run>',
    );
  }
  for (const label of out.only) {
    if (!UPLOAD_REF_COLUMNS.some((c) => columnLabel(c) === label)) {
      throw new Error(`--only: unknown column ${label}`);
    }
  }
  return out;
}

/**
 * Pure planning half of `platform-links-rewrite.ts` (no Prisma import so it
 * can be unit-tested): the inventory of every DB column / JSON blob that may
 * hold a creator-entered PLATFORM link, the host rewrite rules, the per-row
 * rewrite, the fingerprint and the masked report.
 *
 * Domain move (plans/domain-move/PLAN.md): content saved while the platform
 * lived on the OLD apex may carry absolute links to it —
 * `https://<slug>.<old apex>/...`, `https://<old apex>/...`, the old
 * dashboard host, rarely the old API host. Those become the new hosts.
 *
 * Rules (`RewriteRules`), applied per URL occurrence inside text:
 *   - exact hosts first (`dash`, `api`): `ms-dash.<old>` → `app.<new>`;
 *   - then the apex rule: the host IS the old apex, or ENDS WITH `.<old apex>`
 *     (one or more labels, so `www.` and `<slug>--<key>` previews are covered),
 *     suffix replaced, labels kept;
 *   - a look-alike host (`notiwings-digital.com`, `iwings-digital.com.evil.io`)
 *     never matches: the host is captured whole and compared whole;
 *   - `/uploads/...` URLs on the old API host are left to
 *     `uploads-url-normalize.ts` (reported, not rewritten here).
 * Scheme, port, path, query and fragment are kept as they are.
 */
import { createHash } from 'crypto';

// ── Column inventory ────────────────────────────────────────────────────────

/**
 * `model` is the Prisma client delegate name, `column` the field. `text`
 * columns hold one string (a URL, HTML or plain text) and every embedded
 * occurrence is rewritten; `json` columns are deep-walked and every string
 * leaf is treated the same way, key order preserved.
 */
export interface LinkColumn {
  model: string;
  column: string;
  kind: 'text' | 'json';
}

export const LINK_COLUMNS: readonly LinkColumn[] = [
  // Navigation
  { model: 'menuItem', column: 'url', kind: 'text' },
  // Builder v2 pages (sections / blocks / versions / SEO canonical)
  { model: 'page', column: 'seo', kind: 'json' },
  { model: 'pageSection', column: 'settings', kind: 'json' },
  { model: 'pageSectionTranslation', column: 'content', kind: 'json' },
  { model: 'pageBlock', column: 'settings', kind: 'json' },
  { model: 'pageBlockTranslation', column: 'content', kind: 'json' },
  { model: 'pageVersion', column: 'snapshot', kind: 'json' },
  // Legacy static pages and legal pages (HTML per locale)
  { model: 'staticPageTranslation', column: 'content', kind: 'text' },
  { model: 'legalPage', column: 'content', kind: 'json' },
  // Store theme (header/footer links, announcement bar, social links)
  { model: 'store', column: 'theme_customizations', kind: 'json' },
  { model: 'store', column: 'theme_config', kind: 'json' },
  // E-mail templates (platform defaults + per-store overrides)
  { model: 'notificationTemplate', column: 'body_html', kind: 'json' },
  { model: 'notificationTemplate', column: 'body_text', kind: 'json' },
  { model: 'storeNotificationTemplate', column: 'body_html', kind: 'json' },
  { model: 'storeNotificationTemplate', column: 'body_text', kind: 'json' },
  // Rich-text descriptions
  { model: 'productTranslation', column: 'description', kind: 'text' },
  { model: 'categoryTranslation', column: 'description', kind: 'text' },
  { model: 'creatorCategoryTranslation', column: 'description', kind: 'text' },
  {
    model: 'creatorCategoryTranslation',
    column: 'long_description',
    kind: 'text',
  },
  { model: 'customProductTranslation', column: 'description', kind: 'text' },
  { model: 'promotionTranslation', column: 'description', kind: 'text' },
  // Legal profile website (printed on invoices)
  { model: 'storeLegalProfile', column: 'website', kind: 'text' },
];

/**
 * Deliberately NOT covered (documented for the runbook):
 *  - `Order.hostname`, `KustomCheckoutSession.hostname`: the host an order
 *    was placed on (history; old-order mail links are served by nginx 301);
 *  - `Store.custom_domain`, `StoreDomain.hostname`: merchant domains;
 *  - `Invoice.snapshot`, `OrderItemDesign.*`, `ImportRunItem.*`: frozen
 *    legal / order copies;
 *  - `ProductImage.url`, `ProductVideo.url` / `poster_url`,
 *    `ProductStory.url` / `poster_url` and every other
 *    media column (video urls are uploads or YouTube/Vimeo watch URLs): absolute
 *    `/uploads/` URLs are relativised by `uploads-url-normalize.ts`;
 *  - `ImportMedia.source_url`, `ImportSource.*`: foreign (source shop) URLs;
 *  - `Store.checkout_settings`, `Promotion.conditions`, `CartItem.*`: no
 *    platform links by contract.
 */
export const SKIPPED_COLUMNS: readonly string[] = [
  'order.hostname',
  'kustomCheckoutSession.hostname',
  'store.custom_domain',
  'storeDomain.hostname',
  'invoice.snapshot',
  'orderItemDesign.*',
  'importRunItem.*',
  'productImage.url (media: uploads-url-normalize.ts)',
  'productVideo.url (media / external watch URL: uploads-url-normalize.ts)',
  'productVideo.poster_url (media: uploads-url-normalize.ts)',
  'productStory.url (media / external watch URL: uploads-url-normalize.ts)',
  'productStory.poster_url (media: uploads-url-normalize.ts)',
  'productStoryTranslation.* (plain-text testimonials, no platform links)',
  'importMedia.source_url',
  'store.checkout_settings',
  'promotion.conditions',
  'cartItem.custom_fields',
];

export function columnLabel(c: { model: string; column: string }): string {
  return `${c.model}.${c.column}`;
}

// ── Rules ───────────────────────────────────────────────────────────────────

export interface HostPair {
  from: string;
  to: string;
}

export interface RewriteRules {
  /** Old apex → new apex (`<labels>.<from>` and the bare `<from>`). */
  apex: HostPair;
  /** Old dashboard host → new (exact). */
  dash: HostPair | null;
  /** Old API host → new (exact; `/uploads/` paths are skipped). */
  api: HostPair | null;
}

/** Lower-case hostname (no scheme, port, path); throws on an empty value. */
export function normalizeHost(value: string, flag: string): string {
  const v = value.trim().toLowerCase();
  const m = /^(?:https?:\/\/)?([a-z0-9.-]+)(?::\d+)?\/?$/.exec(v);
  if (!m || !m[1].includes('.') || m[1].startsWith('.') || m[1].endsWith('.'))
    throw new Error(`${flag}: not a hostname: ${value}`);
  return m[1];
}

/** Counters of one rewrite pass (report only; never a row value). */
export interface RewriteStats {
  /** URL occurrences rewritten per rule. */
  apex: number;
  dash: number;
  api: number;
  /** `/uploads/` URLs on the old API host left to uploads-url-normalize. */
  media_skipped: number;
}

export function newRewriteStats(): RewriteStats {
  return { apex: 0, dash: 0, api: 0, media_skipped: 0 };
}

/**
 * One absolute URL inside text: scheme, host, then everything up to a
 * delimiter that cannot be part of a URL in HTML / JSON / plain text. The
 * host group is the WHOLE host label sequence, so a look-alike never
 * matches by suffix.
 */
const URL_RE = /(https?:\/\/)([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?=[:/?#"'\s<>)\]\\,;]|$)([^\s"'<>)\]\\,;]*)/gi;

/** New host for `host` under the rules, or null when it is not an old platform host. */
export function mapHost(
  host: string,
  rules: RewriteRules,
  path: string,
  stats: RewriteStats,
): string | null {
  const h = host.toLowerCase();
  if (rules.dash && h === rules.dash.from) {
    stats.dash++;
    return rules.dash.to;
  }
  if (rules.api && h === rules.api.from) {
    if (/^(?::\d+)?\/uploads\//i.test(path)) {
      stats.media_skipped++;
      return null;
    }
    stats.api++;
    return rules.api.to;
  }
  const { from, to } = rules.apex;
  if (h === from) {
    stats.apex++;
    return to;
  }
  if (h.endsWith(`.${from}`)) {
    stats.apex++;
    return `${h.slice(0, -from.length)}${to}`;
  }
  return null;
}

/** Every embedded old-platform URL in `text` rewritten; count of occurrences. */
export function rewriteText(
  text: string,
  rules: RewriteRules,
  stats: RewriteStats = newRewriteStats(),
): { text: string; changed: number } {
  if (typeof text !== 'string' || !text.includes('://')) {
    return { text, changed: 0 };
  }
  let changed = 0;
  const out = text.replace(
    URL_RE,
    (whole, scheme: string, host: string, rest: string) => {
      const next = mapHost(host, rules, rest, stats);
      if (next === null) return whole;
      changed++;
      return `${scheme}${next}${rest}`;
    },
  );
  return { text: out, changed };
}

/**
 * Deep copy of a JSON value with every string leaf passed through
 * `rewriteText`. Object key order and non-string leaves are preserved so an
 * unchanged document serialises identically.
 */
export function rewriteJson<T>(
  value: T,
  rules: RewriteRules,
  stats: RewriteStats = newRewriteStats(),
): { value: T; changed: number } {
  let changed = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = rewriteText(v, rules, stats);
      changed += r.changed;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(inner);
      }
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, changed };
}

// ── Plan ────────────────────────────────────────────────────────────────────

export interface RowChange {
  model: string;
  column: string;
  id: string;
  /** New value (string for text columns, JSON value for json columns). */
  next: unknown;
  occurrences: number;
}

export interface ColumnStats {
  model: string;
  column: string;
  kind: 'text' | 'json';
  rows_scanned: number;
  rows_to_change: number;
  occurrences: number;
  media_skipped: number;
}

export interface Plan {
  rules: RewriteRules;
  columns: ColumnStats[];
  changes: RowChange[];
  totals: RewriteStats;
}

export function newColumnStats(c: LinkColumn): ColumnStats {
  return {
    model: c.model,
    column: c.column,
    kind: c.kind,
    rows_scanned: 0,
    rows_to_change: 0,
    occurrences: 0,
    media_skipped: 0,
  };
}

export function newPlan(rules: RewriteRules): Plan {
  return { rules, columns: [], changes: [], totals: newRewriteStats() };
}

/** Rewrite of one row; null when nothing changes. Updates `stats` and `plan.totals`. */
export function planRow(
  plan: Plan,
  c: LinkColumn,
  id: string,
  value: unknown,
  stats: ColumnStats,
): RowChange | null {
  stats.rows_scanned++;
  if (value === null || value === undefined) return null;
  const rowStats = newRewriteStats();

  let next: unknown;
  let occurrences: number;
  if (c.kind === 'text') {
    if (typeof value !== 'string') return null;
    const r = rewriteText(value, plan.rules, rowStats);
    next = r.text;
    occurrences = r.changed;
  } else {
    const r = rewriteJson(value, plan.rules, rowStats);
    next = r.value;
    occurrences = r.changed;
  }

  stats.media_skipped += rowStats.media_skipped;
  plan.totals.media_skipped += rowStats.media_skipped;
  if (occurrences === 0) return null;
  stats.rows_to_change++;
  stats.occurrences += occurrences;
  plan.totals.apex += rowStats.apex;
  plan.totals.dash += rowStats.dash;
  plan.totals.api += rowStats.api;
  return { model: c.model, column: c.column, id, next, occurrences };
}

/**
 * sha256 over the canonical planned set: rules + every (model, column, id,
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
    .update(JSON.stringify({ rules: plan.rules, items }))
    .digest('hex')
    .slice(0, 16);
}

export function isNoop(plan: Plan): boolean {
  return plan.changes.length === 0;
}

/** Masked report: counts per column, never a row value or a store name. */
export function renderPlan(plan: Plan, mode: 'dry-run' | 'apply'): string {
  const L: string[] = [];
  const { apex, dash, api } = plan.rules;
  L.push(`platform-links-rewrite (${mode})`);
  L.push(`apex:      *.${apex.from} / ${apex.from}  ->  *.${apex.to} / ${apex.to}`);
  L.push(`dashboard: ${dash ? `${dash.from}  ->  ${dash.to}` : '(none)'}`);
  L.push(`api:       ${api ? `${api.from}  ->  ${api.to}  (/uploads/ skipped)` : '(none)'}`);
  L.push('');
  const w = Math.max(...plan.columns.map((c) => columnLabel(c).length), 10);
  L.push(
    `${'column'.padEnd(w)}  ${'kind'.padEnd(4)}  ${'scanned'.padStart(9)}  ${'rows'.padStart(7)}  ${'urls'.padStart(7)}`,
  );
  let rows = 0;
  let urls = 0;
  for (const c of plan.columns) {
    rows += c.rows_to_change;
    urls += c.occurrences;
    L.push(
      `${columnLabel(c).padEnd(w)}  ${c.kind.padEnd(4)}  ${String(c.rows_scanned).padStart(9)}  ${String(c.rows_to_change).padStart(7)}  ${String(c.occurrences).padStart(7)}`,
    );
  }
  L.push('');
  L.push(`rows to update: ${rows}   url occurrences: ${urls}`);
  L.push(
    `by rule: apex ${plan.totals.apex}, dashboard ${plan.totals.dash}, api ${plan.totals.api}`,
  );
  if (plan.totals.media_skipped > 0) {
    L.push(
      `media URLs on the old API host left to uploads-url-normalize.ts: ${plan.totals.media_skipped}`,
    );
  }
  L.push(`fingerprint: ${fingerprint(plan)}`);
  return L.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export interface Options {
  mode: 'dry-run' | 'apply';
  fingerprint: string | null;
  rules: RewriteRules;
  /** Restrict to these `model.column` labels (debugging). */
  only: string[];
  batch: number;
}

export function parseArgs(argv: string[]): Options {
  const raw: Record<string, string> = {};
  const out = {
    mode: 'dry-run' as 'dry-run' | 'apply',
    fingerprint: null as string | null,
    only: [] as string[],
    batch: 1000,
  };
  const VALUE_FLAGS = [
    '--from',
    '--to',
    '--dash-from',
    '--dash-to',
    '--api-from',
    '--api-to',
    '--fingerprint',
    '--only',
    '--batch',
  ];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') {
      out.mode = 'dry-run';
      continue;
    }
    if (a === '--apply') {
      out.mode = 'apply';
      continue;
    }
    const flag = VALUE_FLAGS.find((f) => a === f || a.startsWith(`${f}=`));
    if (!flag) throw new Error(`Unknown argument: ${a}`);
    let value: string;
    if (a.startsWith(`${flag}=`)) value = a.slice(flag.length + 1);
    else {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      value = next;
    }
    if (flag === '--only') {
      out.only.push(
        ...value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (flag === '--batch') {
      out.batch = Number(value);
      if (!Number.isInteger(out.batch) || out.batch < 1)
        throw new Error('--batch must be a positive integer');
    } else if (flag === '--fingerprint') {
      out.fingerprint = value.trim().toLowerCase();
    } else raw[flag] = value;
  }

  if (!raw['--from'] || !raw['--to'])
    throw new Error('--from=<old apex> and --to=<new apex> are required');
  const apex = {
    from: normalizeHost(raw['--from'], '--from'),
    to: normalizeHost(raw['--to'], '--to'),
  };
  if (apex.from === apex.to) throw new Error('--from and --to are the same host');
  const pair = (
    fromFlag: string,
    toFlag: string,
  ): HostPair | null => {
    const from = raw[fromFlag];
    const to = raw[toFlag];
    if (!from && !to) return null;
    if (!from || !to)
      throw new Error(`${fromFlag} and ${toFlag} must be given together`);
    return {
      from: normalizeHost(from, fromFlag),
      to: normalizeHost(to, toFlag),
    };
  };
  const rules: RewriteRules = {
    apex,
    dash: pair('--dash-from', '--dash-to'),
    api: pair('--api-from', '--api-to'),
  };

  if (out.mode === 'apply' && !out.fingerprint) {
    throw new Error(
      '--apply requires --fingerprint=<hash printed by the dry run>',
    );
  }
  for (const label of out.only) {
    if (!LINK_COLUMNS.some((c) => columnLabel(c) === label)) {
      throw new Error(`--only: unknown column ${label}`);
    }
  }
  return { ...out, rules };
}

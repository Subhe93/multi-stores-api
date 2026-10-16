import type { BundleReader } from '../bundle-reader';
import { BundleReadError } from '../bundle-reader';
import type { NIssue } from '../../model/normalized';
import {
  BUNDLE_TABLES,
  BundleManifest,
  BundleTableName,
  isAllowedOption,
  MANIFEST_FILE,
  parseManifest,
  RANK_MATH_GENERAL_ALLOWED_KEYS,
  TableSpec,
} from './bundle-schema';
import { maybeUnserialize } from './php-unserialize';
import { parseTsv, TsvResult, TsvRow } from './tsv';
import { ImportAdapterError } from '../source-adapter';

/**
 * Raw WordPress tables of one bundle, typed and indexed. No business rules
 * here — the detectors and the adapter interpret these rows.
 */

export interface WpPost {
  id: number;
  type: string;
  status: string;
  title: string;
  content: string;
  excerpt: string;
  name: string;
  parent: number;
  guid: string;
  menu_order: number;
  date: string;
  modified: string;
  mime: string;
}

export interface WpTerm {
  term_id: number;
  name: string;
  slug: string;
  term_order: number;
}

export interface WpTermTaxonomy {
  tt_id: number;
  term_id: number;
  taxonomy: string;
  description: string;
  parent: number;
  count: number;
}

export interface WpRelationship {
  tt_id: number;
  term_order: number;
}

export interface WpAttributeTaxonomy {
  id: number;
  name: string;
  label: string;
  type: string;
  orderby: string;
  public: boolean;
}

export interface WpAttachment {
  id: number;
  guid: string;
  mime: string | null;
  parent: number;
  attached_file: string | null;
  metadata: unknown;
  alt: string | null;
}

export interface WpPpomRow {
  id: number;
  name: string;
  /** Decoded `the_meta` JSON (field id → field config), or null when unreadable. */
  fields: Record<string, Record<string, unknown>> | null;
  categories: string | null;
}

export interface WpShippingTables {
  zones: { zone_id: number; zone_name: string; zone_order: number }[];
  locations: { zone_id: number; code: string; type: string }[];
  methods: {
    zone_id: number;
    instance_id: number;
    method_id: string;
    method_order: number;
    is_enabled: boolean;
  }[];
}

/** Ordered multi-valued meta of one object (WordPress `get_*_meta`). */
export class MetaBag {
  private readonly map = new Map<string, (string | null)[]>();

  add(key: string, value: string | null): void {
    const list = this.map.get(key);
    if (list) list.push(value);
    else this.map.set(key, [value]);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** First value (WordPress `get_post_meta($id, $key, true)`), `undefined` when absent. */
  first(key: string): string | null | undefined {
    return this.map.get(key)?.[0];
  }

  /** First value as a trimmed non-empty string, else null. */
  str(key: string): string | null {
    const v = this.first(key);
    if (v === undefined || v === null) return null;
    const t = v.trim();
    return t === '' ? null : v;
  }

  all(key: string): (string | null)[] {
    return this.map.get(key) ?? [];
  }

  keys(): string[] {
    return [...this.map.keys()];
  }
}

export interface WpTables {
  format_version: 0 | 1;
  manifest: BundleManifest | null;
  files: string[];
  posts: Map<number, WpPost>;
  postmeta: Map<number, MetaBag>;
  terms: Map<number, WpTerm>;
  termTaxonomy: Map<number, WpTermTaxonomy>;
  /** term_id → term_taxonomy row (one per term in modern WordPress). */
  termTaxonomyByTerm: Map<number, WpTermTaxonomy>;
  termmeta: Map<number, MetaBag>;
  relationships: Map<number, WpRelationship[]>;
  attributeTaxonomies: WpAttributeTaxonomy[];
  attachments: Map<number, WpAttachment>;
  /** Allowlisted options, raw values. */
  options: Map<string, string | null>;
  ppom: WpPpomRow[];
  shipping: WpShippingTables | null;
  issues: NIssue[];
}

const EMPTY_META = new MetaBag();

export function metaOf(map: Map<number, MetaBag>, id: number): MetaBag {
  return map.get(id) ?? EMPTY_META;
}

function int(v: string | null | undefined, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function hasHeader(text: string, spec: TableSpec): boolean {
  const end = text.indexOf('\n');
  const first = (end === -1 ? text : text.slice(0, end))
    .replace(/\r$/, '')
    .replace(/^\uFEFF/, '');
  const cells = first.split('\t');
  if (spec.columns.length >= 2)
    return cells[0] === spec.columns[0] && cells[1] === spec.columns[1];
  return false;
}

async function readTable(
  bundle: BundleReader,
  name: BundleTableName,
  formatVersion: 0 | 1,
  issues: NIssue[],
): Promise<TsvRow[] | null> {
  const spec: TableSpec = BUNDLE_TABLES[name];
  if (!(await bundle.has(spec.file))) {
    if (spec.required) {
      throw new ImportAdapterError(
        'IMPORT_BUNDLE_MISSING_FILE',
        `The bundle has no ${spec.file}`,
        { file: spec.file },
      );
    }
    return null;
  }
  const text = await bundle.readText(spec.file);
  let result: TsvResult;
  try {
    if (spec.positional) {
      const header = formatVersion === 1;
      if (header) {
        result = parseTsv(text, { header: true, fileName: spec.file });
      } else {
        const firstLine = text.split('\n', 1)[0] ?? '';
        const n = firstLine.trim() === '' ? 1 : firstLine.split('\t').length;
        const columns = Array.from({ length: n }, (_, i) => `c${i}`);
        result = parseTsv(text, { columns, fileName: spec.file });
      }
    } else {
      const header = formatVersion === 1 || hasHeader(text, spec);
      result = parseTsv(text, {
        header,
        columns: spec.columns,
        minColumns: spec.minColumns,
        fileName: spec.file,
      });
    }
  } catch (e) {
    throw new ImportAdapterError(
      'IMPORT_BUNDLE_PARSE_FAILED',
      (e as Error).message,
      { file: spec.file },
    );
  }
  for (const issue of result.issues) {
    issues.push({
      level: 'warn',
      code: issue.code,
      message: `${spec.file}:${issue.line}: ${issue.message}`,
      data: { file: spec.file },
    });
  }
  return result.rows;
}

function toMetaMap(rows: TsvRow[] | null, idCol: string): Map<number, MetaBag> {
  const map = new Map<number, MetaBag>();
  if (!rows) return map;
  // WordPress returns meta in meta_id order.
  const sorted = [...rows].sort((a, b) => int(a.meta_id) - int(b.meta_id));
  for (const r of sorted) {
    const id = int(r[idCol], -1);
    const key = r.meta_key;
    if (id < 0 || key === null || key === undefined) continue;
    let bag = map.get(id);
    if (!bag) map.set(id, (bag = new MetaBag()));
    bag.add(key, r.meta_value ?? null);
  }
  return map;
}

function filterOption(
  name: string,
  value: string | null,
  issues: NIssue[],
): string | null {
  if (name !== 'rank-math-options-general' || value === null) return value;
  // Keep only allowlisted sub-keys; re-serialize nothing — store as JSON.
  const parsed = maybeUnserialize(value);
  if (
    !parsed.ok ||
    !parsed.value ||
    typeof parsed.value !== 'object' ||
    Array.isArray(parsed.value)
  ) {
    issues.push({
      level: 'warn',
      code: 'W_OPTION_UNREADABLE',
      message: 'rank-math-options-general could not be read',
    });
    return null;
  }
  const src = parsed.value as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const k of RANK_MATH_GENERAL_ALLOWED_KEYS)
    if (k in src) kept[k] = src[k];
  return JSON.stringify(kept);
}

function parsePpom(
  rows: TsvRow[] | null,
  formatVersion: 0 | 1,
  issues: NIssue[],
): WpPpomRow[] {
  if (!rows) return [];
  const out: WpPpomRow[] = [];
  for (const r of rows) {
    let id: number;
    let name: string;
    let metaRaw: string | null = null;
    let categories: string | null = null;
    if (formatVersion === 1 && 'productmeta_id' in r) {
      id = int(r.productmeta_id, -1);
      name = r.productmeta_name ?? '';
      metaRaw = r.the_meta ?? null;
      categories = r.productmeta_categories ?? null;
    } else {
      // Legacy: column order differs between PPOM versions. id and name are
      // always first; `the_meta` is the one JSON object column.
      const cells = Object.keys(r)
        .sort((a, b) => int(a.slice(1)) - int(b.slice(1)))
        .map((k) => r[k]);
      id = int(cells[0], -1);
      name = cells[1] ?? '';
      metaRaw =
        cells.find((c) => typeof c === 'string' && c.trim().startsWith('{')) ??
        null;
    }
    let fields: WpPpomRow['fields'] = null;
    if (metaRaw) {
      try {
        const parsed: unknown = JSON.parse(metaRaw);
        if (parsed && typeof parsed === 'object') {
          fields = Array.isArray(parsed)
            ? Object.fromEntries(parsed.map((f, i) => [String(i), f]))
            : (parsed as Record<string, Record<string, unknown>>);
        }
      } catch {
        // PPOM may also store the_meta PHP-serialized.
        const m = maybeUnserialize(metaRaw);
        if (m.ok && m.value && typeof m.value === 'object')
          fields = m.value as WpPpomRow['fields'];
      }
    }
    if (!fields) {
      issues.push({
        level: 'warn',
        code: 'W_PPOM_UNREADABLE',
        message: `PPOM row ${id}: the_meta could not be read`,
      });
    }
    if (id >= 0) out.push({ id, name, fields, categories });
  }
  return out;
}

export async function loadWpTables(bundle: BundleReader): Promise<WpTables> {
  const issues: NIssue[] = [];
  const files = await bundle.list();

  let manifest: BundleManifest | null = null;
  if (await bundle.has(MANIFEST_FILE)) {
    try {
      manifest = parseManifest(
        await bundle.readText(MANIFEST_FILE, { maxBytes: 1024 * 1024 }),
      );
    } catch (e) {
      if (e instanceof BundleReadError) throw e;
      throw new ImportAdapterError(
        'IMPORT_BUNDLE_PARSE_FAILED',
        (e as Error).message,
        { file: MANIFEST_FILE },
      );
    }
  }
  const fv: 0 | 1 = manifest ? 1 : 0;

  const [
    postsRows,
    postmetaRows,
    termsRows,
    ttRows,
    termmetaRows,
    relRows,
    attrRows,
    attRows,
    optRows,
    ppomRows,
  ] = await Promise.all([
    readTable(bundle, 'posts', fv, issues),
    readTable(bundle, 'postmeta', fv, issues),
    readTable(bundle, 'terms', fv, issues),
    readTable(bundle, 'term_taxonomy', fv, issues),
    readTable(bundle, 'termmeta', fv, issues),
    readTable(bundle, 'term_relationships', fv, issues),
    readTable(bundle, 'attribute_taxonomies', fv, issues),
    readTable(bundle, 'attachments', fv, issues),
    readTable(bundle, 'options', fv, issues),
    readTable(bundle, 'ppom_meta', fv, issues),
  ]);

  const posts = new Map<number, WpPost>();
  for (const r of postsRows ?? []) {
    const id = int(r.ID, -1);
    if (id <= 0) continue;
    posts.set(id, {
      id,
      type: r.post_type ?? '',
      status: r.post_status ?? '',
      title: r.post_title ?? '',
      content: r.post_content ?? '',
      excerpt: r.post_excerpt ?? '',
      name: r.post_name ?? '',
      parent: int(r.post_parent),
      guid: r.guid ?? '',
      menu_order: int(r.menu_order),
      date: r.post_date ?? '',
      modified: r.post_modified ?? '',
      mime: r.post_mime_type ?? '',
    });
  }

  const terms = new Map<number, WpTerm>();
  for (const r of termsRows ?? []) {
    const id = int(r.term_id, -1);
    if (id <= 0) continue;
    terms.set(id, {
      term_id: id,
      name: r.name ?? '',
      slug: r.slug ?? '',
      term_order: int(r.term_order),
    });
  }

  const termTaxonomy = new Map<number, WpTermTaxonomy>();
  const termTaxonomyByTerm = new Map<number, WpTermTaxonomy>();
  for (const r of ttRows ?? []) {
    const id = int(r.term_taxonomy_id, -1);
    if (id <= 0) continue;
    const row: WpTermTaxonomy = {
      tt_id: id,
      term_id: int(r.term_id),
      taxonomy: r.taxonomy ?? '',
      description: r.description ?? '',
      parent: int(r.parent),
      count: int(r.count),
    };
    termTaxonomy.set(id, row);
    termTaxonomyByTerm.set(row.term_id, row);
  }

  const relationships = new Map<number, WpRelationship[]>();
  for (const r of relRows ?? []) {
    const oid = int(r.object_id, -1);
    const tt = int(r.term_taxonomy_id, -1);
    if (oid <= 0 || tt <= 0) continue;
    const list = relationships.get(oid);
    const rel = { tt_id: tt, term_order: int(r.term_order) };
    if (list) list.push(rel);
    else relationships.set(oid, [rel]);
  }

  const attributeTaxonomies: WpAttributeTaxonomy[] = (attrRows ?? [])
    .map((r) => ({
      id: int(r.attribute_id, -1),
      name: r.attribute_name ?? '',
      label: r.attribute_label ?? '',
      type: r.attribute_type ?? 'select',
      orderby: r.attribute_orderby ?? 'menu_order',
      public: r.attribute_public === '1',
    }))
    .filter((a) => a.id > 0 && a.name !== '');

  const attachments = new Map<number, WpAttachment>();
  for (const r of attRows ?? []) {
    const id = int(r.ID, -1);
    if (id <= 0) continue;
    let metadata: unknown = null;
    const rawMeta = r._wp_attachment_metadata;
    if (rawMeta) {
      const m = maybeUnserialize(rawMeta);
      metadata = m.ok ? m.value : null;
      if (!m.ok)
        issues.push({
          level: 'warn',
          code: 'W_ATTACHMENT_METADATA_UNREADABLE',
          message: `attachment ${id}: ${m.error}`,
        });
    }
    attachments.set(id, {
      id,
      guid: r.guid ?? '',
      mime: r.post_mime_type ?? null,
      parent: int(r.post_parent),
      attached_file: r._wp_attached_file ?? null,
      metadata,
      alt: r._wp_attachment_image_alt ?? null,
    });
  }

  const options = new Map<string, string | null>();
  for (const r of optRows ?? []) {
    const name = r.option_name;
    if (!name || !isAllowedOption(name)) continue;
    options.set(name, filterOption(name, r.option_value ?? null, issues));
  }

  let shipping: WpShippingTables | null = null;
  if (fv === 1) {
    const [zones, locations, methods] = await Promise.all([
      readTable(bundle, 'shipping_zones', fv, issues),
      readTable(bundle, 'shipping_zone_locations', fv, issues),
      readTable(bundle, 'shipping_zone_methods', fv, issues),
    ]);
    if (zones || methods) {
      shipping = {
        zones: (zones ?? []).map((r) => ({
          zone_id: int(r.zone_id),
          zone_name: r.zone_name ?? '',
          zone_order: int(r.zone_order),
        })),
        locations: (locations ?? []).map((r) => ({
          zone_id: int(r.zone_id),
          code: r.location_code ?? '',
          type: r.location_type ?? '',
        })),
        methods: (methods ?? []).map((r) => ({
          zone_id: int(r.zone_id),
          instance_id: int(r.instance_id),
          method_id: r.method_id ?? '',
          method_order: int(r.method_order),
          is_enabled: r.is_enabled === '1',
        })),
      };
    }
  }

  return {
    format_version: fv,
    manifest,
    files,
    posts,
    postmeta: toMetaMap(postmetaRows, 'post_id'),
    terms,
    termTaxonomy,
    termTaxonomyByTerm,
    termmeta: toMetaMap(termmetaRows, 'term_id'),
    relationships,
    attributeTaxonomies,
    attachments,
    options,
    ppom: parsePpom(ppomRows, fv, issues),
    shipping,
    issues,
  };
}

/** Decode a stored option (serialized PHP, JSON from `filterOption`, or plain). */
export function decodeOption(tables: WpTables, name: string): unknown {
  const raw = tables.options.get(name);
  if (raw === undefined || raw === null) return undefined;
  if (name === 'rank-math-options-general') {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  const m = maybeUnserialize(raw);
  return m.ok ? m.value : undefined;
}

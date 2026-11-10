import { normalizeSiteHost } from '../model/external-ref';
import { maybeUnserialize } from '../adapters/wp-bundle/php-unserialize';
import {
  parseTsv,
  type TsvRow,
  type TsvValue,
} from '../adapters/wp-bundle/tsv';
import {
  ADDRESS_FIELDS,
  ORDERS_ARCHIVE_FILES,
  ORDERS_ARCHIVE_REQUIRED_COLUMNS,
  ORDERS_MANIFEST_FILE,
  ORDER_NUMBER_META_KEYS,
  type ArchivedAddress,
  type OrdersArchiveTable,
} from './wc-orders-schema';

/**
 * WooCommerce order archive parser (plans/wp-order-archive, M70): turns the
 * TSV set (HPOS or legacy posts storage) into normalized archived orders.
 * Pure: no I/O, no database. Everything the tables hold is kept in `raw`.
 *
 * Decisions (Alaa 2026-11-10): import ALL orders (every status, every
 * date); keep refunds as a `refunds` array on their parent order.
 */

export type OrdersArchiveShape = 'hpos' | 'legacy';

export interface OrdersArchiveIssue {
  level: 'warn' | 'error';
  code: string;
  message: string;
}

export class OrdersArchiveParseError extends Error {
  constructor(
    readonly code: 'IMPORT_BUNDLE_MISSING_FILE' | 'IMPORT_BUNDLE_PARSE_FAILED',
    message: string,
    readonly file?: string,
  ) {
    super(message);
    this.name = 'OrdersArchiveParseError';
  }
}

export interface ArchivedRefundRecord {
  external_id: string;
  /** Positive amount, 2 decimals. */
  amount: string;
  reason: string | null;
  created_at: string;
}

export interface ArchivedLineRecord {
  position: number;
  name: string;
  sku: string | null;
  quantity: string;
  unit_price: string | null;
  line_total: string;
  line_tax: string;
  product_external_id: string | null;
  variation_external_id: string | null;
  /** Customisation meta (non-underscore item meta), decoded. */
  meta: Record<string, unknown> | null;
}

export interface ArchivedOrderRecord {
  external_id: string;
  number: string;
  status: string;
  created_at: Date;
  currency: string;
  subtotal: string;
  shipping_total: string;
  discount_total: string;
  tax_total: string;
  total: string;
  payment_method_title: string | null;
  shipping_method_title: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  billing_address: ArchivedAddress | null;
  shipping_address: ArchivedAddress | null;
  customer_note: string | null;
  refunds: ArchivedRefundRecord[];
  lines: ArchivedLineRecord[];
  raw: Record<string, unknown>;
}

export interface OrdersArchiveManifest {
  site_url?: string;
  format?: string;
  exported_at?: string;
  wc_version?: string;
  [key: string]: string | undefined;
}

export interface ParsedOrdersArchive {
  shape: OrdersArchiveShape;
  site_host: string | null;
  manifest: OrdersArchiveManifest;
  orders: ArchivedOrderRecord[];
  /** Source rows that were not imported (unknown types, placeholders). */
  skipped: { external_id: string; reason: string }[];
  issues: OrdersArchiveIssue[];
}

/** File name → UTF-8 text (already extracted). */
export type OrdersArchiveFiles = Record<string, string>;

type MetaBag = Map<string, string | null>;

// ── helpers ──────────────────────────────────────────────────────────────

const str = (v: TsvValue | undefined): string | null =>
  v === null || v === undefined ? null : v;

const text = (v: TsvValue | undefined): string | null => {
  const s = str(v);
  if (s === null) return null;
  const t = s.trim();
  return t === '' ? null : t;
};

/** Number of a scalar (string / number); anything else is NaN. */
function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseFloat(v);
  return NaN;
}

/** Decimal string with 2 places; non-numeric → "0.00". */
export function money(v: unknown): string {
  const n = toNumber(v);
  if (!Number.isFinite(n)) return '0.00';
  // Round half away from zero at 2 decimals (floating noise guarded by EPSILON).
  const sign = n < 0 ? -1 : 1;
  const abs = Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100;
  return (sign * abs).toFixed(2);
}

function qty(v: unknown): string {
  const n = toNumber(v);
  return Number.isFinite(n) ? money(n) : '0.00';
}

/** `YYYY-MM-DD HH:MM:SS` (MySQL) as UTC; null for the zero date / garbage. */
export function mysqlDateUtc(v: string | null | undefined): Date | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(
    v.trim(),
  );
  if (!m || m[1] === '0000') return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function stripWc(status: string | null): string {
  const s = (status ?? '').trim().toLowerCase();
  return s.startsWith('wc-') ? s.slice(3) : s || 'unknown';
}

/** Null token of a TSV export: `\N` (SELECT ... INTO OUTFILE) or `NULL` (mysql --batch). */
export function detectNullToken(tsv: string): string {
  return /(^|\t)\\N(\t|\r?\n|$)/m.test(tsv) ? '\\N' : 'NULL';
}

function metaValue(bag: MetaBag | undefined, key: string): string | null {
  const v = bag?.get(key);
  return v === undefined ? null : v;
}

function metaText(bag: MetaBag | undefined, key: string): string | null {
  const v = metaValue(bag, key);
  return v === null || v.trim() === '' ? null : v.trim();
}

/** PHP-serialized meta → JSON-able value; plain strings stay strings. */
export function decodeMeta(value: string | null): unknown {
  if (value === null) return null;
  const r = maybeUnserialize(value);
  return r.ok ? r.value : value;
}

/**
 * Keys never stored in `raw` or in line meta (privacy / noise), matched at
 * every depth of the decoded values: IP addresses, user agents, anything
 * token-like, the WooCommerce order-attribution and analytics tracking
 * meta, Stripe customer / payment-intent objects, editor locks and the
 * session / cart hashes the archive tab has no use for.
 */
export const RAW_DROP_KEY_RE =
  /ip_address|user_agent|token|cart_hash|order_key|_secret|password|session|_payer_|^_?wc_order_attribution_|^_wc_google_analytics|^_meta_(purchase|event)|^_gla_|^_googlesitekit|^_edit_lock$|^_edit_last$|^_payment_intent$|^_wc_stripe_customer$|^_stripe_(customer|source|intent|payment_method|charge)_id$|^_wc_klarna|^_kp_|^_ppcp_|^_klarna/i;

export function isDroppedRawKey(key: string): boolean {
  return RAW_DROP_KEY_RE.test(key);
}

/** Deep copy without the dropped keys (arrays and nested records included). */
export function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isDroppedRawKey(k)) continue;
      Object.defineProperty(out, k, {
        value: sanitizeValue(v),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

/** Shallow copy of a source row without the dropped keys. */
function sanitizeRow(row: TsvRow | undefined | null): TsvRow | null {
  if (!row) return null;
  return sanitizeValue(row) as TsvRow;
}

function bagToObject(bag: MetaBag | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!bag) return out;
  for (const [k, v] of bag) {
    if (isDroppedRawKey(k)) continue;
    Object.defineProperty(out, k, {
      value: sanitizeValue(decodeMeta(v)),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function addressFromMeta(
  bag: MetaBag | undefined,
  prefix: '_billing_' | '_shipping_',
): ArchivedAddress | null {
  const out: ArchivedAddress = {};
  let any = false;
  for (const f of ADDRESS_FIELDS) {
    const v = metaText(bag, `${prefix}${f}`);
    if (v !== null) {
      out[f] = v;
      any = true;
    }
  }
  return any ? out : null;
}

function addressFromRow(row: TsvRow | undefined): ArchivedAddress | null {
  if (!row) return null;
  const out: ArchivedAddress = {};
  let any = false;
  for (const f of ADDRESS_FIELDS) {
    const v = text(row[f]);
    if (v !== null) {
      out[f] = v;
      any = true;
    }
  }
  return any ? out : null;
}

function fullName(a: ArchivedAddress | null): string | null {
  if (!a) return null;
  const n = [a.first_name, a.last_name].filter(Boolean).join(' ').trim();
  return n || a.company || null;
}

/** Parses `key=value` lines; `#` comments and blank lines ignored. */
export function parseManifest(textContent: string): OrdersArchiveManifest {
  const out: OrdersArchiveManifest = {};
  for (const line of textContent.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    // `key=value` or `key: value` (the first separator wins).
    const m = /^([a-z0-9_]{1,64})\s*[=:]\s*(.*)$/i.exec(t);
    if (!m) continue;
    const key = m[1];
    Object.defineProperty(out, key, {
      value: m[2].trim(),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** `site_url` / `site_host`, else the first host-like token of `source`. */
function siteHostOf(manifest: OrdersArchiveManifest): string | null {
  const candidates = [
    manifest.site_url,
    manifest.site_host,
    manifest.source?.split(/\s+/)[0],
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      return normalizeSiteHost(c);
    } catch {
      // Not a host: try the next candidate.
    }
  }
  return null;
}

// ── table reading ────────────────────────────────────────────────────────

class Tables {
  constructor(
    private readonly files: OrdersArchiveFiles,
    readonly issues: OrdersArchiveIssue[],
  ) {}

  has(name: OrdersArchiveTable): boolean {
    return typeof this.files[ORDERS_ARCHIVE_FILES[name]] === 'string';
  }

  read(name: OrdersArchiveTable, required: boolean): TsvRow[] | null {
    const file = ORDERS_ARCHIVE_FILES[name];
    const content = this.files[file];
    if (typeof content !== 'string') {
      if (required)
        throw new OrdersArchiveParseError(
          'IMPORT_BUNDLE_MISSING_FILE',
          `The archive has no ${file}`,
          file,
        );
      return null;
    }
    try {
      const result = parseTsv(content, {
        header: true,
        columns: ORDERS_ARCHIVE_REQUIRED_COLUMNS[name],
        nullToken: detectNullToken(content),
        fileName: file,
      });
      for (const issue of result.issues)
        this.issues.push({
          level: 'warn',
          code: issue.code,
          message: `${file}:${issue.line}: ${issue.message}`,
        });
      return result.rows;
    } catch (e) {
      throw new OrdersArchiveParseError(
        'IMPORT_BUNDLE_PARSE_FAILED',
        (e as Error).message,
        file,
      );
    }
  }
}

function metaMap(
  rows: TsvRow[] | null,
  idCol: string,
  orderCol = 'meta_id',
): Map<string, MetaBag> {
  const map = new Map<string, MetaBag>();
  if (!rows) return map;
  const sorted = [...rows].sort(
    (a, b) => Number(a[orderCol] ?? 0) - Number(b[orderCol] ?? 0),
  );
  for (const r of sorted) {
    const id = text(r[idCol]);
    const key = str(r.meta_key);
    if (id === null || key === null) continue;
    let bag = map.get(id);
    if (!bag) {
      bag = new Map();
      map.set(id, bag);
    }
    // First value (lowest meta_id) wins for duplicate keys, like
    // get_post_meta($id, $key, true).
    if (!bag.has(key)) bag.set(key, str(r.meta_value));
  }
  return map;
}

// ── items ────────────────────────────────────────────────────────────────

interface ItemRow {
  id: string;
  name: string;
  type: string;
  meta: MetaBag | undefined;
}

function itemsByOrder(
  items: TsvRow[],
  itemMeta: Map<string, MetaBag>,
): Map<string, ItemRow[]> {
  const out = new Map<string, ItemRow[]>();
  const sorted = [...items].sort(
    (a, b) => Number(a.order_item_id ?? 0) - Number(b.order_item_id ?? 0),
  );
  for (const r of sorted) {
    const orderId = text(r.order_id);
    const id = text(r.order_item_id);
    if (orderId === null || id === null) continue;
    const list = out.get(orderId) ?? [];
    list.push({
      id,
      name: str(r.order_item_name) ?? '',
      type: (str(r.order_item_type) ?? '').toLowerCase(),
      meta: itemMeta.get(id),
    });
    out.set(orderId, list);
  }
  return out;
}

function positiveId(v: string | null): string | null {
  if (v === null) return null;
  const t = v.trim();
  return /^\d+$/.test(t) && Number(t) > 0 ? t : null;
}

/**
 * Underscore item meta that IS the customisation (PPOM's hidden field bag,
 * the NPP designer payload); stored under the key without the underscore.
 */
const CUSTOMISATION_HIDDEN_KEYS: Record<string, string> = {
  _ppom_fields: 'ppom_fields',
  _npp_customization: 'npp_customization',
};

/** Customisation meta: every non-underscore item meta key (+ the hidden bags above), decoded. */
function customisationMeta(
  bag: MetaBag | undefined,
): Record<string, unknown> | null {
  if (!bag) return null;
  const out: Record<string, unknown> = {};
  let any = false;
  for (const [rawKey, v] of bag) {
    const k = rawKey.startsWith('_')
      ? CUSTOMISATION_HIDDEN_KEYS[rawKey]
      : rawKey;
    if (
      !k ||
      isDroppedRawKey(k) ||
      Object.prototype.hasOwnProperty.call(out, k)
    )
      continue;
    Object.defineProperty(out, k, {
      value: sanitizeValue(decodeMeta(v)),
      enumerable: true,
      writable: true,
      configurable: true,
    });
    any = true;
  }
  return any ? out : null;
}

function lineFromItem(item: ItemRow, position: number): ArchivedLineRecord {
  const m = item.meta;
  const isFee = item.type === 'fee';
  const q = isFee ? '1.00' : qty(metaValue(m, '_qty'));
  const subtotal = metaValue(m, '_line_subtotal');
  const total = metaValue(m, isFee ? '_line_total' : '_line_total');
  const qn = parseFloat(q);
  const unit =
    !isFee && subtotal !== null && qn > 0
      ? money(parseFloat(subtotal) / qn)
      : null;
  const meta = customisationMeta(m);
  return {
    position,
    name: item.name,
    sku: metaText(m, '_sku') ?? metaText(m, 'sku'),
    quantity: q,
    unit_price: unit,
    line_total: money(total ?? (isFee ? metaValue(m, '_fee_amount') : null)),
    line_tax: money(metaValue(m, '_line_tax')),
    product_external_id: positiveId(metaValue(m, '_product_id')),
    variation_external_id: positiveId(metaValue(m, '_variation_id')),
    meta: isFee ? { ...(meta ?? {}), item_type: 'fee' } : meta,
  };
}

function splitItems(items: ItemRow[] | undefined): {
  lines: ArchivedLineRecord[];
  shipping: string | null;
  subtotal: string;
  raw: unknown[];
} {
  const lines: ArchivedLineRecord[] = [];
  const shipping: string[] = [];
  let subtotal = 0;
  const raw: unknown[] = [];
  for (const it of items ?? []) {
    raw.push({
      id: it.id,
      name: it.name,
      type: it.type,
      meta: bagToObject(it.meta),
    });
    if (it.type === 'line_item' || it.type === 'fee') {
      lines.push(lineFromItem(it, lines.length));
      if (it.type === 'line_item')
        subtotal +=
          parseFloat(metaValue(it.meta, '_line_subtotal') ?? '0') || 0;
    } else if (it.type === 'shipping' && it.name.trim()) {
      shipping.push(it.name.trim());
    }
  }
  return {
    lines,
    shipping: shipping.length ? shipping.join(', ') : null,
    subtotal: money(subtotal),
    raw,
  };
}

function orderNumber(bag: MetaBag | undefined, id: string): string {
  for (const key of ORDER_NUMBER_META_KEYS) {
    const v = metaText(bag, key);
    if (v !== null) return v.slice(0, 64);
  }
  return id;
}

// ── shapes ───────────────────────────────────────────────────────────────

interface PendingRefund {
  parent: string;
  refund: ArchivedRefundRecord;
}

function parseHpos(t: Tables, out: ParsedOrdersArchive): void {
  const orders = t.read('wc_orders', true) ?? [];
  const addresses = t.read('wc_order_addresses', false) ?? [];
  const operational = t.read('wc_order_operational_data', false) ?? [];
  const meta = metaMap(t.read('wc_orders_meta', false), 'order_id', 'id');
  const items = itemsByOrder(
    t.read('order_items', true) ?? [],
    metaMap(t.read('order_itemmeta', false), 'order_item_id'),
  );
  if (!t.has('order_itemmeta'))
    out.issues.push({
      level: 'warn',
      code: 'W_ORDERS_NO_ITEMMETA',
      message:
        'woocommerce_order_itemmeta.tsv is missing: lines have no quantities, prices or product ids',
    });

  const addr = new Map<string, { billing?: TsvRow; shipping?: TsvRow }>();
  for (const a of addresses) {
    const id = text(a.order_id);
    const type = (str(a.address_type) ?? '').toLowerCase();
    if (id === null || (type !== 'billing' && type !== 'shipping')) continue;
    const entry = addr.get(id) ?? {};
    entry[type] = a;
    addr.set(id, entry);
  }
  const ops = new Map<string, TsvRow>();
  for (const o of operational) {
    const id = text(o.order_id);
    if (id !== null) ops.set(id, o);
  }

  const refunds: PendingRefund[] = [];
  for (const row of orders) {
    const id = text(row.id);
    if (id === null) continue;
    const type = (str(row.type) ?? 'shop_order').toLowerCase();
    const bag = meta.get(id);
    const created =
      mysqlDateUtc(str(row.date_created_gmt)) ??
      mysqlDateUtc(str(row.date_updated_gmt));
    if (type === 'shop_order_refund') {
      const parent = text(row.parent_order_id);
      if (parent === null) {
        out.skipped.push({ external_id: id, reason: 'refund without parent' });
        continue;
      }
      refunds.push({
        parent,
        refund: {
          external_id: id,
          amount: money(
            Math.abs(
              parseFloat(
                metaValue(bag, '_refund_amount') ??
                  str(row.total_amount) ??
                  '0',
              ) || 0,
            ),
          ),
          reason: metaText(bag, '_refund_reason'),
          created_at: (created ?? new Date(0)).toISOString(),
        },
      });
      continue;
    }
    if (type !== 'shop_order') {
      out.skipped.push({ external_id: id, reason: `type ${type}` });
      continue;
    }
    if (created === null) {
      out.issues.push({
        level: 'warn',
        code: 'W_ORDER_NO_DATE',
        message: `order ${id}: no creation date; skipped`,
      });
      out.skipped.push({ external_id: id, reason: 'no date' });
      continue;
    }
    const a = addr.get(id);
    const op = ops.get(id);
    const billing = addressFromRow(a?.billing);
    const shipping = addressFromRow(a?.shipping);
    const split = splitItems(items.get(id));
    const email = text(row.billing_email) ?? billing?.email ?? null;
    out.orders.push({
      external_id: id,
      number: orderNumber(bag, id),
      status: stripWc(str(row.status)),
      created_at: created,
      currency: (text(row.currency) ?? '').toUpperCase().slice(0, 3),
      subtotal: split.subtotal,
      shipping_total: money(op?.shipping_total_amount),
      discount_total: money(op?.discount_total_amount),
      tax_total: money(row.tax_amount),
      total: money(row.total_amount),
      payment_method_title:
        text(row.payment_method_title) ?? text(row.payment_method),
      shipping_method_title: split.shipping,
      customer_name: fullName(billing) ?? fullName(shipping),
      customer_email: email ? email.toLowerCase() : null,
      customer_phone: billing?.phone ?? shipping?.phone ?? null,
      billing_address: billing,
      shipping_address: shipping,
      customer_note: text(row.customer_note),
      refunds: [],
      lines: split.lines,
      raw: {
        shape: 'hpos',
        order: sanitizeRow(row),
        operational: sanitizeRow(op),
        addresses: {
          billing: sanitizeRow(a?.billing),
          shipping: sanitizeRow(a?.shipping),
        },
        meta: bagToObject(bag),
        items: split.raw,
      },
    });
  }
  attachRefunds(out, refunds);
}

function parseLegacy(t: Tables, out: ParsedOrdersArchive): void {
  const posts = t.read('posts', true) ?? [];
  const meta = metaMap(t.read('postmeta', false), 'post_id');
  const items = itemsByOrder(
    t.read('order_items', true) ?? [],
    metaMap(t.read('order_itemmeta', false), 'order_item_id'),
  );
  if (!t.has('postmeta'))
    out.issues.push({
      level: 'warn',
      code: 'W_ORDERS_NO_POSTMETA',
      message:
        'postmeta.tsv is missing: orders have no totals, customers or addresses',
    });

  const refunds: PendingRefund[] = [];
  for (const row of posts) {
    const id = text(row.ID);
    if (id === null) continue;
    const type = (str(row.post_type) ?? '').toLowerCase();
    const postStatus = (str(row.post_status) ?? '').toLowerCase();
    const bag = meta.get(id);
    const created =
      mysqlDateUtc(str(row.post_date_gmt)) ?? mysqlDateUtc(str(row.post_date));
    if (type === 'shop_order_refund') {
      const parent = positiveId(str(row.post_parent));
      if (parent === null) {
        out.skipped.push({ external_id: id, reason: 'refund without parent' });
        continue;
      }
      refunds.push({
        parent,
        refund: {
          external_id: id,
          amount: money(
            Math.abs(
              parseFloat(
                metaValue(bag, '_refund_amount') ??
                  metaValue(bag, '_order_total') ??
                  '0',
              ) || 0,
            ),
          ),
          reason: metaText(bag, '_refund_reason') ?? text(row.post_excerpt),
          created_at: (created ?? new Date(0)).toISOString(),
        },
      });
      continue;
    }
    if (type !== 'shop_order') {
      out.skipped.push({ external_id: id, reason: `post_type ${type}` });
      continue;
    }
    if (postStatus === 'auto-draft') {
      out.skipped.push({ external_id: id, reason: 'auto-draft' });
      continue;
    }
    if (created === null) {
      out.issues.push({
        level: 'warn',
        code: 'W_ORDER_NO_DATE',
        message: `order ${id}: no creation date; skipped`,
      });
      out.skipped.push({ external_id: id, reason: 'no date' });
      continue;
    }
    const billing = addressFromMeta(bag, '_billing_');
    const shipping = addressFromMeta(bag, '_shipping_');
    const split = splitItems(items.get(id));
    const email = billing?.email ?? null;
    const tax =
      (parseFloat(metaValue(bag, '_order_tax') ?? '0') || 0) +
      (parseFloat(metaValue(bag, '_order_shipping_tax') ?? '0') || 0);
    out.orders.push({
      external_id: id,
      number: orderNumber(bag, id),
      status: stripWc(postStatus),
      created_at: created,
      currency: (metaText(bag, '_order_currency') ?? '')
        .toUpperCase()
        .slice(0, 3),
      subtotal: split.subtotal,
      shipping_total: money(metaValue(bag, '_order_shipping')),
      discount_total: money(metaValue(bag, '_cart_discount')),
      tax_total: money(tax),
      total: money(metaValue(bag, '_order_total')),
      payment_method_title:
        metaText(bag, '_payment_method_title') ??
        metaText(bag, '_payment_method'),
      shipping_method_title: split.shipping,
      customer_name: fullName(billing) ?? fullName(shipping),
      customer_email: email ? email.toLowerCase() : null,
      customer_phone: billing?.phone ?? shipping?.phone ?? null,
      billing_address: billing,
      shipping_address: shipping,
      customer_note: text(row.post_excerpt),
      refunds: [],
      lines: split.lines,
      raw: {
        shape: 'legacy',
        post: sanitizeRow(row),
        meta: bagToObject(bag),
        items: split.raw,
      },
    });
  }
  attachRefunds(out, refunds);
}

function attachRefunds(
  out: ParsedOrdersArchive,
  refunds: PendingRefund[],
): void {
  const byId = new Map(out.orders.map((o) => [o.external_id, o]));
  for (const { parent, refund } of refunds) {
    const order = byId.get(parent);
    if (!order) {
      out.issues.push({
        level: 'warn',
        code: 'W_REFUND_ORPHAN',
        message: `refund ${refund.external_id}: parent order ${parent} is not in the archive`,
      });
      out.skipped.push({
        external_id: refund.external_id,
        reason: 'orphan refund',
      });
      continue;
    }
    order.refunds.push(refund);
  }
  for (const o of out.orders)
    o.refunds.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// ── entry point ──────────────────────────────────────────────────────────

/**
 * Parses the extracted archive. The shape is detected from the files:
 * `wc_orders.tsv` → HPOS, else `posts.tsv` → legacy (both present → HPOS,
 * reported). Throws `OrdersArchiveParseError` when neither is there.
 */
export function parseOrdersArchive(
  files: OrdersArchiveFiles,
): ParsedOrdersArchive {
  const issues: OrdersArchiveIssue[] = [];
  const manifest =
    typeof files[ORDERS_MANIFEST_FILE] === 'string'
      ? parseManifest(files[ORDERS_MANIFEST_FILE])
      : {};
  const t = new Tables(files, issues);
  const hpos = t.has('wc_orders');
  const legacy = t.has('posts');
  if (!hpos && !legacy)
    throw new OrdersArchiveParseError(
      'IMPORT_BUNDLE_MISSING_FILE',
      'The archive needs wc_orders.tsv (HPOS) or posts.tsv (legacy orders)',
    );
  if (hpos && legacy)
    issues.push({
      level: 'warn',
      code: 'W_ORDERS_BOTH_SHAPES',
      message:
        'Both wc_orders.tsv and posts.tsv are present; the HPOS tables were used',
    });
  const out: ParsedOrdersArchive = {
    shape: hpos ? 'hpos' : 'legacy',
    site_host: siteHostOf(manifest),
    manifest,
    orders: [],
    skipped: [],
    issues,
  };
  if (hpos) parseHpos(t, out);
  else parseLegacy(t, out);
  // Oldest first so the apply order is stable.
  out.orders.sort(
    (a, b) =>
      a.created_at.getTime() - b.created_at.getTime() ||
      Number(a.external_id) - Number(b.external_id),
  );
  return out;
}

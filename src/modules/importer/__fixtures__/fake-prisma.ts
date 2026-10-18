/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-base-to-string -- in-memory Prisma fake rows are untyped in tests */
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import type { PrivateStorage } from '../../../common/storage/private-file-storage';

/**
 * In-memory Prisma stand-in for the importer specs (not a spec file).
 * Supports exactly what the importer, the redirects service and the specs
 * use: where filters (equality, null, in/notIn/not/lt/lte/gt/gte/contains,
 * OR/AND/NOT, compound unique keys), top-level select, orderBy, skip/take,
 * create/createMany/update/updateMany/upsert/delete/deleteMany, count,
 * groupBy and an interactive `$transaction` that restores the data when the
 * callback throws. Unique constraints (incl. the partial one-active-run
 * index) raise `{ code: 'P2002' }` like Prisma.
 */

type Row = Record<string, any>;

const ACTIVE = [
  'PLANNING',
  'QUEUED',
  'RUNNING',
  'ROLLBACK_QUEUED',
  'ROLLING_BACK',
];

const UNIQUES: Record<string, string[][]> = {
  importEntity: [['store_id', 'entity_type', 'external_ref']],
  importMedia: [['store_id', 'source_url']],
  importSource: [['store_id', 'site_host', 'kind']],
  product: [['creator_id', 'external_ref']],
  productVariant: [['sku'], ['product_id', 'external_ref']],
  creatorCategory: [
    ['creator_id', 'slug'],
    ['creator_id', 'external_ref'],
  ],
  productTranslation: [['product_id', 'locale']],
  creatorCategoryTranslation: [['creator_category_id', 'locale']],
  productFaqTranslation: [['faq_id', 'locale']],
  customFieldTranslation: [['field_id', 'locale']],
  storeRedirect: [['store_id', 'from_path']],
  productCreatorCategory: [['product_id', 'creator_category_id']],
  store: [['slug'], ['creator_id']],
  creator: [['user_id']],
  page: [['store_id', 'slug']],
  pageTranslation: [['page_id', 'locale']],
  pageSectionTranslation: [['section_id', 'locale']],
};

const DEFAULTS: Record<string, () => Row> = {
  importEntity: () => ({
    status: 'ACTIVE',
    created_by_import: true,
    payload: null,
    applied_hash: null,
    target_id: null,
  }),
  importRun: () => ({
    status: 'UPLOADED',
    attempt: 0,
    options: {},
    bundle_key: null,
    bundle_sha256: null,
    bundle_bytes: null,
    snapshot_key: null,
    catalog_hash: null,
    plan_fingerprint: null,
    summary: null,
    progress: null,
    error: null,
    worker_id: null,
    heartbeat_at: null,
    cancel_requested_at: null,
    created_by: null,
    confirmed_by: null,
    rollback_by: null,
    planned_at: null,
    started_at: null,
    finished_at: null,
  }),
  importSource: () => ({
    host_aliases: [],
    credentials_enc: null,
    settings: {},
    last_verified_at: null,
  }),
  product: () => ({
    status: 'DRAFT',
    sku: null,
    track_inventory: false,
    stock_quantity: null,
    weight: null,
    tax_exempt: false,
    compare_at_price: null,
    customization_type: null,
    variant_option_config: null,
    shipping_profile_id: null,
    external_ref: null,
    creator_id: null,
  }),
  productTranslation: () => ({
    short_description: null,
    meta_title: null,
    meta_desc: null,
  }),
  productVariant: () => ({
    sku: null,
    price_adjustment: '0',
    compare_at_price: null,
    stock_quantity: null,
    is_active: true,
    external_ref: null,
  }),
  productImage: () => ({
    variant_id: null,
    alt_text: null,
    sort_order: 0,
    is_featured: false,
  }),
  creatorCategory: () => ({
    parent_id: null,
    thumbnail_url: null,
    sort_order: 0,
    is_active: true,
    external_ref: null,
    noindex_when_empty: false,
    match_tags: [],
  }),
  creatorCategoryTranslation: () => ({
    description: null,
    meta_title: null,
    meta_desc: null,
  }),
  productCustomField: () => ({
    parent_id: null,
    preset_key: null,
    preset_ref: null,
    sort_order: 0,
    is_required: false,
  }),
  storeRedirect: () => ({
    status_code: 301,
    source: 'MANUAL',
    import_run_id: null,
    is_active: true,
  }),
  shippingProfile: () => ({ is_default: false, provider_id: null }),
  shippingZone: () => ({ per_item_cost: '0', free_threshold: null }),
  shippingMethod: () => ({
    type: 'DELIVERY',
    per_item_cost: '0',
    free_threshold: null,
    is_active: true,
    sort_order: 0,
    translations: null,
  }),
  importMedia: () => ({
    public_url: null,
    private_key: null,
    fetched_url: null,
    width: null,
    height: null,
  }),
  importRunLog: () => ({ entity_type: null, external_ref: null, data: null }),
  importRunItem: () => ({
    target_id: null,
    before: null,
    diff: null,
    message: null,
  }),
};

function uniqueViolation(model: string, fields: string[]): Error {
  const e = new Error(
    `Unique constraint failed on ${model}(${fields.join(',')})`,
  ) as Error & { code: string };
  e.code = 'P2002';
  return e;
}

function notFound(model: string): Error {
  const e = new Error(`${model}: record not found`) as Error & { code: string };
  e.code = 'P2025';
  return e;
}

const isPlain = (v: unknown): v is Row =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  !(v instanceof Date) &&
  !isDecimal(v);

function isDecimal(v: unknown): boolean {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as { constructor?: { name?: string } }).constructor?.name === 'Decimal'
  );
}

function norm(v: unknown): unknown {
  if (v === Prisma.DbNull || v === Prisma.JsonNull) return null;
  if (isDecimal(v)) return String(v);
  return v;
}

function cmp(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  if (x === y) return 0;
  if (x === null || x === undefined) return -1;
  if (y === null || y === undefined) return 1;
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  return String(x) < String(y) ? -1 : 1;
}

function eq(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return cmp(a, b) === 0;
  if ((a === null || a === undefined) && (b === null || b === undefined))
    return true;
  if (typeof a === 'number' || typeof b === 'number')
    return Number(a) === Number(b);
  return a === b;
}

const OPS = new Set([
  'in',
  'notIn',
  'not',
  'lt',
  'lte',
  'gt',
  'gte',
  'contains',
  'mode',
  'equals',
  'startsWith',
  'has',
]);

function matchField(value: unknown, cond: unknown): boolean {
  if (cond === undefined) return true;
  if (cond === null) return value === null || value === undefined;
  if (isPlain(cond) && Object.keys(cond).every((k) => OPS.has(k))) {
    const c = cond;
    if ('equals' in c && !eq(value, c.equals)) return false;
    if ('in' in c && !(c.in as unknown[]).some((x) => eq(value, x)))
      return false;
    if ('notIn' in c && (c.notIn as unknown[]).some((x) => eq(value, x)))
      return false;
    if ('not' in c) {
      if (c.not === null || norm(c.not) === null) {
        if (value === null || value === undefined) return false;
      } else if (isPlain(c.not)) {
        if (matchField(value, c.not)) return false;
      } else if (eq(value, c.not)) return false;
    }
    if (
      'lt' in c &&
      !(value !== null && value !== undefined && cmp(value, c.lt) < 0)
    )
      return false;
    if (
      'lte' in c &&
      !(value !== null && value !== undefined && cmp(value, c.lte) <= 0)
    )
      return false;
    if (
      'gt' in c &&
      !(value !== null && value !== undefined && cmp(value, c.gt) > 0)
    )
      return false;
    if (
      'gte' in c &&
      !(value !== null && value !== undefined && cmp(value, c.gte) >= 0)
    )
      return false;
    if ('contains' in c) {
      const hay = String(value ?? '');
      const needle = String(c.contains);
      if (
        c.mode === 'insensitive'
          ? !hay.toLowerCase().includes(needle.toLowerCase())
          : !hay.includes(needle)
      )
        return false;
    }
    if (
      'startsWith' in c &&
      !String(value ?? '').startsWith(String(c.startsWith))
    )
      return false;
    if ('has' in c && !(Array.isArray(value) && value.includes(c.has)))
      return false;
    return true;
  }
  return eq(value, cond);
}

export function matchWhere(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (k === 'OR') {
      if (!(cond as Row[]).some((w) => matchWhere(row, w))) return false;
      continue;
    }
    if (k === 'AND') {
      const list = Array.isArray(cond) ? cond : [cond];
      if (!list.every((w: Row) => matchWhere(row, w))) return false;
      continue;
    }
    if (k === 'NOT') {
      const list = Array.isArray(cond) ? cond : [cond];
      if (list.some((w: Row) => matchWhere(row, w))) return false;
      continue;
    }
    // Compound unique key, e.g. store_id_entity_type_external_ref: {...}.
    if (
      !(k in row) &&
      isPlain(cond) &&
      !Object.keys(cond).every((x) => OPS.has(x))
    ) {
      if (!matchWhere(row, cond)) return false;
      continue;
    }
    if (!matchField(row[k], cond)) return false;
  }
  return true;
}

function project(row: Row, select?: Row, include?: Row): Row {
  const copy = { ...row };
  if (!select) {
    if (include)
      for (const k of Object.keys(include))
        if (!(k in copy)) copy[k] = undefined;
    return copy;
  }
  const out: Row = {};
  for (const [k, v] of Object.entries(select)) if (v) out[k] = copy[k];
  return out;
}

export class FakeModel {
  rows: Row[] = [];
  /** Write operations seen (create/update/delete …), for "zero writes" assertions. */
  writes = 0;

  constructor(
    readonly name: string,
    private readonly db: FakePrisma,
  ) {}

  private checkUnique(row: Row, ignore?: Row): void {
    for (const fields of UNIQUES[this.name] ?? []) {
      if (fields.some((f) => row[f] === null || row[f] === undefined)) continue;
      const clash = this.rows.find(
        (r) => r !== ignore && fields.every((f) => eq(r[f], row[f])),
      );
      if (clash) throw uniqueViolation(this.name, fields);
    }
    if (this.name === 'importRun' && ACTIVE.includes(row.status)) {
      const clash = this.rows.find(
        (r) =>
          r !== ignore &&
          r.store_id === row.store_id &&
          ACTIVE.includes(r.status),
      );
      if (clash) throw uniqueViolation(this.name, ['store_id (active)']);
    }
  }

  private build(data: Row): Row {
    const now = new Date();
    const row: Row = {
      id: randomUUID(),
      created_at: now,
      updated_at: now,
      ...(DEFAULTS[this.name]?.() ?? {}),
    };
    for (const [k, v] of Object.entries(data))
      if (v !== undefined) row[k] = norm(v);
    return row;
  }

  private applyData(row: Row, data: Row): Row {
    const next = { ...row };
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (isPlain(v) && 'increment' in v)
        next[k] = Number(next[k] ?? 0) + Number(v.increment);
      else if (isPlain(v) && 'set' in v) next[k] = norm(v.set);
      else next[k] = norm(v);
    }
    next.updated_at = new Date(
      Math.max(Date.now(), (row.updated_at as Date)?.getTime?.() + 1 || 0),
    );
    return next;
  }

  private sorted(rows: Row[], orderBy?: Row | Row[]): Row[] {
    if (!orderBy) return rows;
    const list = Array.isArray(orderBy) ? orderBy : [orderBy];
    return rows.slice().sort((a, b) => {
      for (const o of list) {
        const [k, dir] = Object.entries(o)[0];
        const c = cmp(a[k], b[k]);
        if (c !== 0) return dir === 'desc' ? -c : c;
      }
      return 0;
    });
  }

  findMany(args: Row = {}): Promise<Row[]> {
    let rows = this.sorted(
      this.rows.filter((r) => matchWhere(r, args.where)),
      args.orderBy,
    );
    if (args.skip) rows = rows.slice(args.skip);
    if (args.take !== undefined) rows = rows.slice(0, args.take);
    return Promise.resolve(
      rows.map((r) => project(r, args.select, args.include)),
    );
  }

  findFirst(args: Row = {}): Promise<Row | null> {
    return this.findMany({ ...args, take: 1 }).then((r) => r[0] ?? null);
  }

  findUnique(args: Row): Promise<Row | null> {
    return this.findFirst(args);
  }

  async findUniqueOrThrow(args: Row): Promise<Row> {
    const r = await this.findFirst(args);
    if (!r) throw notFound(this.name);
    return r;
  }

  async findFirstOrThrow(args: Row): Promise<Row> {
    return this.findUniqueOrThrow(args);
  }

  count(args: Row = {}): Promise<number> {
    return Promise.resolve(
      this.rows.filter((r) => matchWhere(r, args.where)).length,
    );
  }

  create(args: Row): Promise<Row> {
    const row = this.build(args.data);
    this.checkUnique(row);
    this.rows.push(row);
    this.writes++;
    return Promise.resolve(project(row, args.select));
  }

  async createMany(args: Row): Promise<{ count: number }> {
    const list = Array.isArray(args.data) ? args.data : [args.data];
    for (const d of list) await this.create({ data: d });
    return { count: list.length };
  }

  update(args: Row): Promise<Row> {
    const idx = this.rows.findIndex((r) => matchWhere(r, args.where));
    if (idx === -1) return Promise.reject(notFound(this.name));
    const next = this.applyData(this.rows[idx], args.data);
    this.checkUnique(next, this.rows[idx]);
    this.rows[idx] = next;
    this.writes++;
    return Promise.resolve(project(next, args.select));
  }

  updateMany(args: Row): Promise<{ count: number }> {
    let count = 0;
    for (let i = 0; i < this.rows.length; i++) {
      if (!matchWhere(this.rows[i], args.where)) continue;
      const next = this.applyData(this.rows[i], args.data);
      this.checkUnique(next, this.rows[i]);
      this.rows[i] = next;
      count++;
    }
    if (count) this.writes++;
    return Promise.resolve({ count });
  }

  async upsert(args: Row): Promise<Row> {
    const found = this.rows.find((r) => matchWhere(r, args.where));
    if (found)
      return this.update({
        where: { id: found.id },
        data: args.update,
        select: args.select,
      });
    return this.create({ data: args.create, select: args.select });
  }

  delete(args: Row): Promise<Row> {
    const idx = this.rows.findIndex((r) => matchWhere(r, args.where));
    if (idx === -1) return Promise.reject(notFound(this.name));
    const [row] = this.rows.splice(idx, 1);
    this.writes++;
    this.db.cascade(this.name, row);
    return Promise.resolve(row);
  }

  deleteMany(args: Row = {}): Promise<{ count: number }> {
    const gone = this.rows.filter((r) => matchWhere(r, args.where));
    this.rows = this.rows.filter((r) => !gone.includes(r));
    if (gone.length) this.writes++;
    for (const r of gone) this.db.cascade(this.name, r);
    return Promise.resolve({ count: gone.length });
  }

  groupBy(args: Row): Promise<Row[]> {
    const groups = new Map<string, Row>();
    for (const r of this.rows.filter((x) => matchWhere(x, args.where))) {
      const key = JSON.stringify(args.by.map((f: string) => r[f]));
      const g = groups.get(key) ?? {
        ...Object.fromEntries(args.by.map((f: string) => [f, r[f]])),
        _count: { _all: 0 },
      };
      g._count._all++;
      groups.set(key, g);
    }
    return Promise.resolve([...groups.values()]);
  }

  aggregate(args: Row): Promise<Row> {
    const rows = this.rows.filter((r) => matchWhere(r, args.where));
    const out: Row = {};
    if (args._count) out._count = { _all: rows.length };
    if (args._sum) {
      out._sum = {};
      for (const k of Object.keys(args._sum))
        out._sum[k] = rows.length
          ? rows.reduce((s, r) => s + Number(r[k] ?? 0), 0)
          : null;
    }
    if (args._max) {
      out._max = {};
      for (const k of Object.keys(args._max))
        out._max[k] = rows.reduce<unknown>(
          (m, r) => (m === null || cmp(r[k], m) > 0 ? r[k] : m),
          null,
        );
    }
    return Promise.resolve(out);
  }
}

/** FK cascades the importer relies on (Prisma `onDelete: Cascade`). */
const CASCADES: Record<string, { model: string; field: string }[]> = {
  product: [
    { model: 'productTranslation', field: 'product_id' },
    { model: 'productVariant', field: 'product_id' },
    { model: 'productImage', field: 'product_id' },
    { model: 'productTag', field: 'product_id' },
    { model: 'productCreatorCategory', field: 'product_id' },
    { model: 'productFaq', field: 'product_id' },
    { model: 'productCustomField', field: 'product_id' },
  ],
  productFaq: [{ model: 'productFaqTranslation', field: 'faq_id' }],
  productCustomField: [{ model: 'customFieldTranslation', field: 'field_id' }],
  creatorCategory: [
    { model: 'creatorCategoryTranslation', field: 'creator_category_id' },
    { model: 'productCreatorCategory', field: 'creator_category_id' },
  ],
  importRun: [
    { model: 'importRunItem', field: 'run_id' },
    { model: 'importRunLog', field: 'run_id' },
  ],
  importSource: [{ model: 'importRun', field: 'source_id' }],
  shippingProfile: [{ model: 'shippingZone', field: 'profile_id' }],
  shippingZone: [{ model: 'shippingMethod', field: 'zone_id' }],
  page: [
    { model: 'pageTranslation', field: 'page_id' },
    { model: 'pageSection', field: 'page_id' },
  ],
  pageSection: [{ model: 'pageSectionTranslation', field: 'section_id' }],
};

export class FakePrisma {
  private readonly models = new Map<string, FakeModel>();

  model(name: string): FakeModel {
    let m = this.models.get(name);
    if (!m) {
      m = new FakeModel(name, this);
      this.models.set(name, m);
    }
    return m;
  }

  cascade(model: string, row: Row): void {
    for (const c of CASCADES[model] ?? []) {
      const child = this.model(c.model);
      const gone = child.rows.filter((r) => r[c.field] === row.id);
      child.rows = child.rows.filter((r) => r[c.field] !== row.id);
      for (const g of gone) this.cascade(c.model, g);
    }
  }

  /** Total writes to the given models (default: every model). */
  writeCount(names?: string[]): number {
    let n = 0;
    for (const [name, m] of this.models)
      if (!names || names.includes(name)) n += m.writes;
    return n;
  }

  resetWriteCounts(): void {
    for (const m of this.models.values()) m.writes = 0;
  }

  async $transaction(arg: unknown): Promise<unknown> {
    if (Array.isArray(arg)) return Promise.all(arg);
    const saved = new Map(
      [...this.models].map(([k, m]) => [k, m.rows.map((r) => ({ ...r }))]),
    );
    try {
      return await (arg as (tx: this) => Promise<unknown>)(this);
    } catch (e) {
      for (const [k, rows] of saved) this.model(k).rows = rows;
      throw e;
    }
  }

  $queryRaw(): Promise<unknown[]> {
    return Promise.resolve([]);
  }

  $executeRaw(): Promise<number> {
    return Promise.resolve(0);
  }
}

/** Creates a fake whose model delegates are reachable as properties (`db.product.findMany`). */
export function createFakePrisma(): FakePrisma & Record<string, FakeModel> {
  const fake = new FakePrisma();
  return new Proxy(fake, {
    get(target, prop, receiver) {
      if (
        typeof prop === 'string' &&
        !(prop in target) &&
        !prop.startsWith('$') &&
        prop !== 'then'
      ) {
        return target.model(prop);
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  }) as FakePrisma & Record<string, FakeModel>;
}

/** Map-backed PrivateStorage (no key validation besides the real pattern check). */
export class MemoryPrivateStorage implements PrivateStorage {
  readonly root = '/memory';
  readonly files = new Map<string, Buffer>();

  exists(key: string): Promise<boolean> {
    return Promise.resolve((this.files.get(key)?.length ?? 0) > 0);
  }
  read(key: string): Promise<Buffer | null> {
    return Promise.resolve(this.files.get(key) ?? null);
  }
  write(key: string, data: Buffer): Promise<void> {
    this.files.set(key, Buffer.from(data));
    return Promise.resolve();
  }
  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.files.delete(key));
  }
  stat(key: string): Promise<{ bytes: number; modified_at: Date } | null> {
    const f = this.files.get(key);
    return Promise.resolve(
      f ? { bytes: f.length, modified_at: new Date() } : null,
    );
  }
}

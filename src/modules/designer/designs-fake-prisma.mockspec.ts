/**
 * In-memory Prisma double for the WP4 designer specs (designs, designer
 * cart, templates). Tables are plain arrays; `where` supports equality,
 * `null`, `{in}`, `{not}` and `{not: {in}}`; `include`s used by WP4 are
 * joined by hand. `$transaction(fn)` runs `fn` with the same double.
 */
import { randomUUID } from 'crypto';

type Row = Record<string, unknown>;

function cond(v: unknown, c: unknown): boolean {
  if (c === null) return v === null || v === undefined;
  if (c && typeof c === 'object' && !(c instanceof Date) && !Array.isArray(c)) {
    const o = c as {
      in?: unknown[];
      not?: unknown;
      notIn?: unknown[];
      lt?: unknown;
      gt?: unknown;
      contains?: string;
    };
    if (Array.isArray(o.in)) return o.in.includes(v);
    if (Array.isArray(o.notIn)) return !o.notIn.includes(v);
    if ('lt' in o) return v instanceof Date && v < (o.lt as Date);
    if ('gt' in o) return v instanceof Date && v > (o.gt as Date);
    if ('contains' in o) {
      return typeof v === 'string' && v.includes(String(o.contains));
    }
    if ('not' in o) {
      const n = o.not;
      if (
        n &&
        typeof n === 'object' &&
        Array.isArray((n as { in?: unknown[] }).in)
      ) {
        return !(n as { in: unknown[] }).in.includes(v);
      }
      return v !== n;
    }
    return false;
  }
  return v === c;
}

export function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, c]) => {
    // Nested relation filters are ignored by the double.
    if (k === 'template_version' || k === 'order_item') return true;
    return cond(row[k], c);
  });
}

export interface WP4Db {
  store: Row[];
  product: Row[];
  productDesigner: Row[];
  designTemplate: Row[];
  designTemplateVersion: Row[];
  design: Row[];
  designAsset: Row[];
  customer: Row[];
  productCustomField: Row[];
  orderItemDesign: Row[];
  productTranslation: Row[];
  storeApp: Row[];
  storeLanguageConfig: Row[];
}

export function emptyDb(): WP4Db {
  return {
    store: [],
    product: [],
    productDesigner: [],
    designTemplate: [],
    designTemplateVersion: [],
    design: [],
    designAsset: [],
    customer: [],
    productCustomField: [],
    orderItemDesign: [],
    productTranslation: [],
    storeApp: [],
    storeLanguageConfig: [],
  };
}

export function fakeWp4Prisma(db: WP4Db) {
  // Relation counts / joins the WP4 services select.
  const counts = (row: Row): Row => ({
    designs: db.design.filter((d) => d.template_version_id === row.id).length,
    products: db.productDesigner.filter((p) => p.template_id === row.id).length,
    versions: db.designTemplateVersion.filter((v) => v.template_id === row.id)
      .length,
  });
  const project = (row: Row | undefined, select?: Row): Row | null => {
    if (!row) return null;
    if (!select) return { ...row };
    const out: Row = {};
    for (const k of Object.keys(select)) {
      if (k === '_count') out[k] = counts(row);
      else if (k === 'template' && row.template_id) {
        const t = db.designTemplate.find((x) => x.id === row.template_id);
        out[k] = project(t, (select[k] as { select?: Row }).select);
      } else if (k === 'product' && row.product_id) {
        const p = db.product.find((x) => x.id === row.product_id) ?? {};
        out[k] = { translations: [], ...p };
      } else out[k] = row[k];
    }
    return out;
  };
  const joinInclude = (table: keyof WP4Db, row: Row, include?: Row): Row => {
    const out: Row = { ...row };
    if (!include) return out;
    if (table === 'design' && include.template_version) {
      const v = db.designTemplateVersion.find(
        (x) => x.id === row.template_version_id,
      );
      out.template_version = project(
        v,
        (include.template_version as { select?: Row }).select,
      );
    }
    if (table === 'productDesigner' && include.template) {
      const t = db.designTemplate.find((x) => x.id === row.template_id);
      out.template = project(t, (include.template as { select?: Row }).select);
    }
    return out;
  };

  const model = (table: keyof WP4Db) => ({
    findUnique: jest.fn(
      ({
        where,
        include,
        select,
      }: {
        where: Row;
        include?: Row;
        select?: Row;
      }) => {
        const r = db[table].find((x) => matches(x, where));
        return Promise.resolve(
          r
            ? select
              ? project(r, select)
              : joinInclude(table, r, include)
            : null,
        );
      },
    ),
    findFirst: jest.fn(
      ({
        where,
        select,
        orderBy,
      }: {
        where?: Row;
        select?: Row;
        orderBy?: Row;
      }) => {
        let rows = db[table].filter((x) => matches(x, where));
        if (orderBy) {
          const [[k, dir]] = Object.entries(orderBy);
          rows = [...rows].sort(
            (a, b) => (Number(a[k]) - Number(b[k])) * (dir === 'desc' ? -1 : 1),
          );
        }
        return Promise.resolve(rows[0] ? project(rows[0], select) : null);
      },
    ),
    findMany: jest.fn(
      ({
        where,
        include,
        select,
      }: { where?: Row; include?: Row; select?: Row } = {}) =>
        Promise.resolve(
          db[table]
            .filter((x) => matches(x, where))
            .map((r) =>
              select ? project(r, select) : joinInclude(table, r, include),
            ),
        ),
    ),
    count: jest.fn(({ where }: { where?: Row } = {}) =>
      Promise.resolve(db[table].filter((x) => matches(x, where)).length),
    ),
    create: jest.fn(({ data }: { data: Row }) => {
      const now = new Date();
      const row: Row = {
        id: randomUUID(),
        created_at: now,
        updated_at: now,
        ...(table === 'designTemplate'
          ? { status: 'DRAFT', current_version_id: null, source: 'native' }
          : {}),
        ...(table === 'design'
          ? {
              state_version: 1,
              status: 'DRAFT',
              proof_key: null,
              proof_state_sha: null,
              customer_id: null,
            }
          : {}),
        ...data,
      };
      // Nested `versions: {create}` of a template.
      const nested = row.versions as { create?: Row } | undefined;
      if (table === 'designTemplate' && nested?.create) {
        delete row.versions;
        db.designTemplateVersion.push({
          id: randomUUID(),
          created_at: now,
          template_id: row.id,
          ...nested.create,
        });
      }
      db[table].push(row);
      return Promise.resolve({ ...row });
    }),
    update: jest.fn(({ where, data }: { where: Row; data: Row }) => {
      const r = db[table].find((x) => matches(x, where));
      if (!r) return Promise.reject(new Error(`${table} not found`));
      Object.assign(r, data);
      return Promise.resolve({ ...r });
    }),
    updateMany: jest.fn(({ where, data }: { where: Row; data: Row }) => {
      const rows = db[table].filter((x) => matches(x, where));
      for (const r of rows) {
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && 'increment' in (v as Row)) {
            r[k] =
              Number(r[k]) + Number((v as { increment: number }).increment);
          } else if (v && typeof v === 'object' && 'decrement' in (v as Row)) {
            r[k] =
              Number(r[k]) - Number((v as { decrement: number }).decrement);
          } else {
            r[k] = v;
          }
        }
      }
      return Promise.resolve({ count: rows.length });
    }),
    upsert: jest.fn(
      ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
        const r = db[table].find((x) => matches(x, where));
        if (r) {
          Object.assign(r, update);
          return Promise.resolve({ ...r });
        }
        const row = { ...create, updated_at: new Date() };
        db[table].push(row);
        return Promise.resolve({ ...row });
      },
    ),
    delete: jest.fn(({ where }: { where: Row }) => {
      const i = db[table].findIndex((x) => matches(x, where));
      if (i < 0) return Promise.reject(new Error(`${table} not found`));
      const [r] = db[table].splice(i, 1);
      return Promise.resolve(r);
    }),
    deleteMany: jest.fn(({ where }: { where?: Row } = {}) => {
      const keep = db[table].filter((x) => !matches(x, where));
      const count = db[table].length - keep.length;
      db[table].splice(0, db[table].length, ...keep);
      return Promise.resolve({ count });
    }),
  });

  const self: { db?: unknown } = {};
  const prisma = {
    store: model('store'),
    product: model('product'),
    productDesigner: model('productDesigner'),
    designTemplate: model('designTemplate'),
    designTemplateVersion: model('designTemplateVersion'),
    design: model('design'),
    designAsset: model('designAsset'),
    customer: model('customer'),
    productCustomField: model('productCustomField'),
    orderItemDesign: model('orderItemDesign'),
    productTranslation: model('productTranslation'),
    storeApp: model('storeApp'),
    storeLanguageConfig: model('storeLanguageConfig'),
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) =>
      fn(self.db),
    ),
  };
  self.db = prisma;
  return prisma;
}

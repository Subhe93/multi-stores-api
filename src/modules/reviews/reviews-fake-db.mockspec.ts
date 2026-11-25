/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- in-memory Prisma fake rows are untyped in tests */
/**
 * In-memory Prisma double of the reviews specs (M171). It really applies the
 * `where` / `select` / `orderBy` of every query (relations included), so the
 * specs exercise the scoping filters and the explicit selects of
 * ReviewsService instead of trusting hand-fed query results.
 */
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';

type Row = Record<string, any>;

interface Relation {
  model: string;
  kind: 'one' | 'many';
  /** Foreign key on THIS row (to-one from the owning side). */
  local?: string;
  /** Foreign key on the OTHER row (to-many, or to-one from the far side). */
  foreign?: string;
}

const RELATIONS: Record<string, Record<string, Relation>> = {
  store: {
    language_config: {
      model: 'storeLanguageConfig',
      kind: 'one',
      foreign: 'store_id',
    },
  },
  creator: { store: { model: 'store', kind: 'one', foreign: 'creator_id' } },
  customer: { user: { model: 'user', kind: 'one', local: 'user_id' } },
  order: {
    customer: { model: 'customer', kind: 'one', local: 'customer_id' },
    items: { model: 'orderItem', kind: 'many', foreign: 'order_id' },
  },
  orderItem: {
    order: { model: 'order', kind: 'one', local: 'order_id' },
    product: { model: 'product', kind: 'one', local: 'product_id' },
    custom_product: {
      model: 'customProduct',
      kind: 'one',
      local: 'custom_product_id',
    },
  },
  product: {
    translations: {
      model: 'productTranslation',
      kind: 'many',
      foreign: 'product_id',
    },
    images: { model: 'productImage', kind: 'many', foreign: 'product_id' },
  },
  customProduct: {
    translations: {
      model: 'customProductTranslation',
      kind: 'many',
      foreign: 'custom_product_id',
    },
    mockup_images: {
      model: 'customProductImage',
      kind: 'many',
      foreign: 'custom_product_id',
    },
    product: { model: 'product', kind: 'one', local: 'product_id' },
  },
  productReview: {
    product: { model: 'product', kind: 'one', local: 'product_id' },
    custom_product: {
      model: 'customProduct',
      kind: 'one',
      local: 'custom_product_id',
    },
    order: { model: 'order', kind: 'one', local: 'order_id' },
    customer: { model: 'customer', kind: 'one', local: 'customer_id' },
  },
};

const MODELS = [
  'store',
  'storeLanguageConfig',
  'storeDomain',
  'creator',
  'user',
  'customer',
  'product',
  'productTranslation',
  'productImage',
  'customProduct',
  'customProductTranslation',
  'customProductImage',
  'order',
  'orderItem',
  'productReview',
  'productReviewHold',
] as const;

export type FakeModel = (typeof MODELS)[number];
export type FakeDb = Record<FakeModel, Row[]>;

export function emptyDb(): FakeDb {
  return Object.fromEntries(MODELS.map((m) => [m, [] as Row[]])) as FakeDb;
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Date)
  );
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime();
  return (a ?? null) === (b ?? null);
}

/** Undo the LIKE escaping of an insensitive `equals` (see slugLookupFilters). */
const unescapeLike = (v: string) => v.replace(/\\([\\%_])/g, '$1');

function scalarMatches(value: unknown, filter: unknown): boolean {
  if (!isPlainObject(filter)) return sameValue(value, filter);
  const f = filter;
  const insensitive = f.mode === 'insensitive';
  for (const [op, arg] of Object.entries(f)) {
    if (op === 'mode') continue;
    if (op === 'equals') {
      if (insensitive && typeof value === 'string' && typeof arg === 'string') {
        if (value.toLowerCase() !== unescapeLike(arg).toLowerCase()) {
          return false;
        }
      } else if (!sameValue(value, arg)) return false;
    } else if (op === 'in') {
      if (!(arg as unknown[]).some((x) => sameValue(value, x))) return false;
    } else if (op === 'notIn') {
      if ((arg as unknown[]).some((x) => sameValue(value, x))) return false;
    } else if (op === 'not') {
      if (scalarMatches(value, arg)) return false;
    } else {
      throw new Error(`fake db: unsupported filter operator "${op}"`);
    }
  }
  return true;
}

/** The query methods of one model, each a jest mock (spy on any of them). */
export type FakeDelegate = Record<
  | 'findMany'
  | 'findFirst'
  | 'findUnique'
  | 'count'
  | 'groupBy'
  | 'create'
  | 'updateMany'
  | 'deleteMany',
  jest.Mock
>;

// One delegate per model, like PrismaClient (`prisma.productReview.findMany`).
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, @typescript-eslint/no-empty-object-type
export interface FakePrisma extends Record<FakeModel, FakeDelegate> {}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class FakePrisma {
  constructor(readonly db: FakeDb) {
    for (const model of MODELS) {
      (this as Record<FakeModel, FakeDelegate>)[model] = this.delegate(model);
    }
  }

  /** Makes the next productReview.create lose the unique-index race. */
  failNextReviewCreateWithRace: (() => void) | null = null;

  private related(model: string, row: Row, field: string): Row | Row[] | null {
    const rel = RELATIONS[model]?.[field];
    if (!rel) throw new Error(`fake db: ${model}.${field} is not a relation`);
    const rows = this.db[rel.model as FakeModel];
    if (rel.kind === 'many') {
      return rows.filter((r) => r[rel.foreign as string] === row.id);
    }
    if (rel.local) {
      const key = row[rel.local];
      return key == null ? null : (rows.find((r) => r.id === key) ?? null);
    }
    return rows.find((r) => r[rel.foreign as string] === row.id) ?? null;
  }

  matches(model: string, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    for (const [key, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (key === 'OR') {
        if (!(cond as Row[]).some((w) => this.matches(model, row, w))) {
          return false;
        }
        continue;
      }
      if (key === 'AND') {
        const list = Array.isArray(cond) ? cond : [cond];
        if (!list.every((w: Row) => this.matches(model, row, w))) return false;
        continue;
      }
      const rel = RELATIONS[model]?.[key];
      if (rel) {
        const related = this.related(model, row, key);
        if (rel.kind === 'many') {
          const list = related as Row[];
          if (
            cond.some &&
            !list.some((r) => this.matches(rel.model, r, cond.some))
          ) {
            return false;
          }
          if (
            cond.none &&
            list.some((r) => this.matches(rel.model, r, cond.none))
          ) {
            return false;
          }
        } else if (cond === null) {
          if (related !== null) return false;
        } else if (!related || !this.matches(rel.model, related as Row, cond)) {
          return false;
        }
        continue;
      }
      if (!scalarMatches(row[key], cond)) return false;
    }
    return true;
  }

  private sort(rows: Row[], orderBy: unknown): Row[] {
    if (!orderBy) return rows;
    const list = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Row[];
    return [...rows].sort((a, b) => {
      for (const entry of list) {
        for (const [field, dir] of Object.entries(entry)) {
          const av = a[field] instanceof Date ? a[field].getTime() : a[field];
          const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
          if (av === bv) continue;
          // Postgres: NULLS FIRST on desc, NULLS LAST on asc.
          const cmp = av == null ? 1 : bv == null ? -1 : av < bv ? -1 : 1;
          return dir === 'desc' ? -cmp : cmp;
        }
      }
      return 0;
    });
  }

  /** Applies `select` exactly: an unselected column is absent. */
  private project(model: string, row: Row, select: Row | undefined): Row {
    if (!select) {
      return { ...row };
    }
    const out: Row = {};
    for (const [key, spec] of Object.entries(select)) {
      if (!spec) continue;
      const rel = RELATIONS[model]?.[key];
      if (!rel) {
        out[key] = row[key] ?? null;
        continue;
      }
      const args: Row = spec === true ? {} : (spec as Row);
      const related = this.related(model, row, key);
      if (rel.kind === 'many') {
        let list = (related as Row[]).filter((r) =>
          this.matches(rel.model, r, args.where),
        );
        list = this.sort(list, args.orderBy);
        if (typeof args.take === 'number') list = list.slice(0, args.take);
        out[key] = list.map((r) => this.project(rel.model, r, args.select));
      } else {
        out[key] = related
          ? this.project(rel.model, related as Row, args.select)
          : null;
      }
    }
    return out;
  }

  private delegate(model: FakeModel): FakeDelegate {
    const rows = () => this.db[model];
    const find = (args: Row = {}) => {
      let list = rows().filter((r) => this.matches(model, r, args.where));
      list = this.sort(list, args.orderBy);
      if (typeof args.skip === 'number') list = list.slice(args.skip);
      if (typeof args.take === 'number') list = list.slice(0, args.take);
      return list;
    };
    return {
      findMany: jest.fn((args: Row = {}) =>
        Promise.resolve(
          find(args).map((r) => this.project(model, r, args.select)),
        ),
      ),
      findFirst: jest.fn((args: Row = {}) => {
        const [row] = find(args);
        return Promise.resolve(
          row ? this.project(model, row, args.select) : null,
        );
      }),
      findUnique: jest.fn((args: Row = {}) => {
        const [row] = find(args);
        return Promise.resolve(
          row ? this.project(model, row, args.select) : null,
        );
      }),
      count: jest.fn((args: Row = {}) => Promise.resolve(find(args).length)),
      groupBy: jest.fn((args: Row) => {
        const field = (args.by as string[])[0];
        const groups = new Map<unknown, number>();
        for (const r of find({ where: args.where })) {
          groups.set(r[field], (groups.get(r[field]) ?? 0) + 1);
        }
        return Promise.resolve(
          [...groups].map(([value, n]) => ({
            [field]: value,
            _count: { _all: n },
          })),
        );
      }),
      create: jest.fn((args: Row) => {
        if (model === 'productReview') {
          if (this.failNextReviewCreateWithRace) {
            const race = this.failNextReviewCreateWithRace;
            this.failNextReviewCreateWithRace = null;
            race();
          }
          const d = args.data as Row;
          const clash = rows().some(
            (r) =>
              r.customer_id === d.customer_id &&
              ((d.product_id && r.product_id === d.product_id) ||
                (d.custom_product_id &&
                  r.custom_product_id === d.custom_product_id)),
          );
          if (clash) {
            throw new Prisma.PrismaClientKnownRequestError(
              'Unique constraint failed',
              { code: 'P2002', clientVersion: 'test' },
            );
          }
        }
        if (model === 'productReviewHold') {
          const d = args.data as Row;
          const clash = rows().some(
            (r) =>
              r.customer_id === d.customer_id &&
              ((d.product_id && r.product_id === d.product_id) ||
                (d.custom_product_id &&
                  r.custom_product_id === d.custom_product_id)),
          );
          if (clash) {
            throw new Prisma.PrismaClientKnownRequestError(
              'Unique constraint failed',
              { code: 'P2002', clientVersion: 'test' },
            );
          }
        }
        const now = new Date();
        const row: Row = {
          id: randomUUID(),
          created_at: now,
          updated_at: now,
          ...(model === 'productReview'
            ? {
                moderated_at: null,
                moderated_by: null,
                reply_body: null,
                replied_at: null,
                published_at: null,
              }
            : {}),
          ...(args.data as Row),
        };
        rows().push(row);
        return Promise.resolve(this.project(model, row, args.select));
      }),
      updateMany: jest.fn((args: Row) => {
        const hit = find({ where: args.where });
        for (const r of hit) {
          // @updatedAt, strictly increasing: two writes inside one
          // millisecond of a test still give two versions.
          const prev =
            r.updated_at instanceof Date ? r.updated_at.getTime() : 0;
          Object.assign(r, args.data, {
            updated_at: new Date(Math.max(Date.now(), prev + 1)),
          });
        }
        return Promise.resolve({ count: hit.length });
      }),
      deleteMany: jest.fn((args: Row = {}) => {
        const hit = new Set(find({ where: args.where }));
        this.db[model] = rows().filter((r) => !hit.has(r));
        return Promise.resolve({ count: hit.size });
      }),
    };
  }
}

// -- World -------------------------------------------------------------------

/** Deterministic uuid: `id('a', 1)`. */
export function id(group: string, n: number): string {
  const g = group.charCodeAt(0).toString(16).padStart(2, '0');
  return `${g}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export const IDS = {
  storeA: id('s', 1),
  storeB: id('s', 2),
  creatorA: id('c', 1),
  creatorB: id('c', 2),
  ownerA: id('u', 1),
  ownerB: id('u', 2),
  admin: id('u', 3),
  provider: id('u', 4),
  // Customers of store A.
  annaUser: id('u', 10),
  anna: id('k', 10),
  bertilUser: id('u', 11),
  bertil: id('k', 11),
  guestUser: id('u', 12),
  guest: id('k', 12),
  // Customer of store B.
  ceciliaUser: id('u', 20),
  cecilia: id('k', 20),
  // Products.
  necklace: id('p', 1),
  ring: id('p', 2),
  draftProduct: id('p', 3),
  baseMug: id('p', 4),
  customMug: id('m', 1),
  productB: id('p', 20),
  // Orders.
  annaOrder: id('o', 1),
  annaOrderLine: id('i', 1),
  annaOrderLine2: id('i', 2),
  annaOrderRingLine: id('i', 3),
  annaMugLine: id('i', 4),
  bertilOrder: id('o', 2),
  bertilOrderLine: id('i', 5),
  guestOrder: id('o', 3),
  guestOrderLine: id('i', 6),
  ceciliaOrder: id('o', 20),
  ceciliaOrderLine: id('i', 20),
} as const;

function user(
  uid: string,
  role: string,
  storeId: string | null,
  email: string,
): Row {
  return {
    id: uid,
    email,
    role,
    status: 'ACTIVE',
    store_id: storeId,
    tokens_valid_after: null,
    email_verified_at: new Date('2026-01-01T00:00:00Z'),
    created_at: new Date('2026-01-01T00:00:00Z'),
  };
}

function order(
  oid: string,
  storeId: string,
  customerId: string,
  n: number,
): Row {
  return {
    id: oid,
    order_number: `ORD-${n}`,
    store_id: storeId,
    customer_id: customerId,
    status: 'CONFIRMED',
    payment_status: 'paid',
    payment_method: 'STRIPE',
    is_test: false,
    deleted_at: null,
    hostname: null,
    created_at: new Date(Date.UTC(2026, 10, n)),
  };
}

function line(
  lid: string,
  orderId: string,
  target: { product_id?: string; custom_product_id?: string },
): Row {
  return {
    id: lid,
    order_id: orderId,
    product_id: target.product_id ?? null,
    custom_product_id: target.custom_product_id ?? null,
  };
}

/**
 * Two stores. Store A (MARKETPLACE, slug `alpha`, primary locale sv) sells
 * the necklace, the ring, a DRAFT product and a custom mug; Anna bought the
 * necklace (two lines), the ring and the mug in one paid order, Bertil
 * bought the necklace, and a guest record with empty names bought the ring.
 * Store B (slug `beta`) sells its own product, bought by Cecilia.
 */
export function seedWorld(): FakeDb {
  const db = emptyDb();
  db.store.push(
    {
      id: IDS.storeA,
      slug: 'alpha',
      creator_id: IDS.creatorA,
      store_type: 'MARKETPLACE',
      custom_domain: null,
      is_active: true,
    },
    {
      id: IDS.storeB,
      slug: 'beta',
      creator_id: IDS.creatorB,
      store_type: 'INDEPENDENT',
      custom_domain: null,
      is_active: true,
    },
  );
  db.storeLanguageConfig.push(
    { id: id('l', 1), store_id: IDS.storeA, primary_locale: 'sv' },
    { id: id('l', 2), store_id: IDS.storeB, primary_locale: 'en' },
  );
  db.creator.push(
    { id: IDS.creatorA, user_id: IDS.ownerA },
    { id: IDS.creatorB, user_id: IDS.ownerB },
  );
  db.user.push(
    user(IDS.ownerA, 'CREATOR', null, 'owner-a@example.test'),
    user(IDS.ownerB, 'CREATOR', null, 'owner-b@example.test'),
    user(IDS.admin, 'ADMIN', null, 'admin@example.test'),
    user(IDS.provider, 'PROVIDER', null, 'provider@example.test'),
    user(IDS.annaUser, 'CUSTOMER', IDS.storeA, 'anna.svensson@example.test'),
    user(IDS.bertilUser, 'CUSTOMER', IDS.storeA, 'bertil@example.test'),
    user(IDS.guestUser, 'CUSTOMER', IDS.storeA, 'guest@example.test'),
    user(IDS.ceciliaUser, 'CUSTOMER', IDS.storeB, 'cecilia@example.test'),
  );
  db.customer.push(
    {
      id: IDS.anna,
      user_id: IDS.annaUser,
      first_name: 'Anna',
      last_name: 'Svensson',
      phone: '+46700000000',
    },
    {
      id: IDS.bertil,
      user_id: IDS.bertilUser,
      first_name: 'Bertil',
      last_name: '',
      phone: null,
    },
    {
      id: IDS.guest,
      user_id: IDS.guestUser,
      first_name: '',
      last_name: '',
      phone: null,
    },
    {
      id: IDS.cecilia,
      user_id: IDS.ceciliaUser,
      first_name: 'Cecilia',
      last_name: 'Berg',
      phone: null,
    },
  );

  const product = (pid: string, creatorId: string, status: string, n: number) =>
    db.product.push({
      id: pid,
      creator_id: creatorId,
      status,
      updated_at: new Date(Date.UTC(2026, 0, n)),
    });
  product(IDS.necklace, IDS.creatorA, 'PUBLISHED', 1);
  product(IDS.ring, IDS.creatorA, 'PUBLISHED', 2);
  product(IDS.draftProduct, IDS.creatorA, 'DRAFT', 3);
  // Provider base product of the custom mug (not a product of creator A).
  product(IDS.baseMug, 'provider-catalog', 'PUBLISHED', 4);
  product(IDS.productB, IDS.creatorB, 'PUBLISHED', 5);

  const tr = (pid: string, locale: string, title: string, slug: string) =>
    db.productTranslation.push({
      id: randomUUID(),
      product_id: pid,
      locale,
      title,
      slug,
    });
  tr(IDS.necklace, 'sv', 'Namnhalsband', 'namnhalsband');
  tr(IDS.necklace, 'de', 'Namenskette', 'namenskette');
  // Legacy slug with capitals (case-insensitive fallback).
  tr(IDS.ring, 'sv', 'Ring', 'Silver-Ring');
  tr(IDS.draftProduct, 'sv', 'Utkast', 'utkast');
  tr(IDS.baseMug, 'en', 'Mug', 'mug');
  tr(IDS.productB, 'en', 'Beta product', 'namnhalsband');

  db.productImage.push(
    {
      id: randomUUID(),
      product_id: IDS.necklace,
      variant_id: null,
      url: '/uploads/necklace.jpg',
      is_featured: true,
      sort_order: 0,
    },
    {
      id: randomUUID(),
      product_id: IDS.baseMug,
      variant_id: null,
      url: '/uploads/mug-base.jpg',
      is_featured: false,
      sort_order: 0,
    },
  );
  db.customProduct.push({
    id: IDS.customMug,
    creator_id: IDS.creatorA,
    product_id: IDS.baseMug,
    status: 'PUBLISHED',
    updated_at: new Date(Date.UTC(2026, 0, 6)),
  });
  db.customProductTranslation.push({
    id: randomUUID(),
    custom_product_id: IDS.customMug,
    locale: 'sv',
    title: 'Mugg',
    slug: 'mugg',
  });

  db.order.push(
    order(IDS.annaOrder, IDS.storeA, IDS.anna, 1),
    order(IDS.bertilOrder, IDS.storeA, IDS.bertil, 2),
    order(IDS.guestOrder, IDS.storeA, IDS.guest, 3),
    order(IDS.ceciliaOrder, IDS.storeB, IDS.cecilia, 4),
  );
  db.orderItem.push(
    line(IDS.annaOrderLine, IDS.annaOrder, { product_id: IDS.necklace }),
    line(IDS.annaOrderLine2, IDS.annaOrder, { product_id: IDS.necklace }),
    line(IDS.annaOrderRingLine, IDS.annaOrder, { product_id: IDS.ring }),
    line(IDS.annaMugLine, IDS.annaOrder, { custom_product_id: IDS.customMug }),
    line(IDS.bertilOrderLine, IDS.bertilOrder, { product_id: IDS.necklace }),
    line(IDS.guestOrderLine, IDS.guestOrder, { product_id: IDS.ring }),
    line(IDS.ceciliaOrderLine, IDS.ceciliaOrder, { product_id: IDS.productB }),
  );
  return db;
}

/** A stored review row with sensible defaults (for seeding). */
export function reviewRow(over: Row): Row {
  const now = new Date('2026-11-20T10:00:00Z');
  return {
    id: randomUUID(),
    store_id: IDS.storeA,
    product_id: null,
    custom_product_id: null,
    customer_id: IDS.anna,
    order_id: null,
    order_item_id: null,
    verified_purchase: true,
    rating: 5,
    title: null,
    body: 'A perfectly fine review text.',
    display_name: 'Anna S.',
    locale: 'sv',
    status: 'APPROVED',
    source: 'ACCOUNT',
    published_at: now,
    moderated_at: null,
    moderated_by: null,
    reply_body: null,
    replied_at: null,
    created_at: now,
    updated_at: now,
    ...over,
  };
}

/** StoreAppsService double: the reviews app per store, with its settings. */
export function fakeStoreApps(db: FakeDb, enabled: Iterable<string>) {
  const on = new Set(enabled);
  const settings = new Map<string, Record<string, unknown>>();
  return {
    on,
    settings,
    isEnabled: jest.fn((storeId: string, key: string) =>
      Promise.resolve(key === 'reviews' && on.has(storeId)),
    ),
    getSettings: jest.fn((storeId: string, key: string) =>
      Promise.resolve(
        key === 'reviews' && on.has(storeId)
          ? (settings.get(storeId) ?? {})
          : null,
      ),
    ),
    storeIdBySlug: jest.fn((slug: string) =>
      Promise.resolve(
        db.store.find((s) => s.slug === slug && s.is_active)?.id ?? null,
      ),
    ),
    storeIdByUser: jest.fn((userId: string) => {
      const creator = db.creator.find((c) => c.user_id === userId);
      return Promise.resolve(
        db.store.find((s) => s.creator_id === creator?.id)?.id ?? null,
      );
    }),
  };
}

export const TEST_JWT_SECRET = 'test-access-secret-0123456789abcdef';

/** ConfigService double (the access secret, optionally a previous one). */
export function fakeConfig(extra: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    JWT_SECRET: TEST_JWT_SECRET,
    STOREFRONT_URL: 'https://shop.example.test',
    ...extra,
  };
  return {
    values,
    get: (key: string) => values[key],
  };
}

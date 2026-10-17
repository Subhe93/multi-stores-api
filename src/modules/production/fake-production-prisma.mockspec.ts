// In-memory PrismaService fake of the production specs (not a test file
// itself: the name ends in "spec.ts" so the build skips it, but not in
// ".spec.ts" so jest does not run it). It models just enough of Prisma for
// ProductionChecklistService: flat where-matching (equality, in, notIn,
// not), orderBy / skip / take, the unique (order_item_id, source_key) of
// OrderProductionCheck with createMany skipDuplicates, a write counter for
// idempotency checks, and - so the concurrency specs mean something -
// READ COMMITTED transactions with a real per-key advisory lock:
//
//  - inside `$transaction` every read sees the committed rows plus the
//    transaction's own writes; the writes land at commit (or are dropped
//    when the callback throws), exactly like two Postgres sessions;
//  - `$executeRaw` (the only raw SQL: pg_advisory_xact_lock) queues on the
//    key until the transaction holding it ends.
//
// Without the lock, two concurrent "last check" writes each read the other's
// check as open, both store IN_PROGRESS, and the COMPLETED spec fails.

import { randomUUID } from 'crypto';
import type { PrismaService } from '../../prisma/prisma.service';

type Row = Record<string, unknown>;

export const STORE_ID = 's1';
export const OTHER_STORE_ID = 's2';
export const CREATOR_ID = 'cr1';
export const USER_ID = 'u1';

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    const v = row[key];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      const c = cond as Row;
      if ('in' in c) return (c.in as unknown[]).includes(v);
      if ('notIn' in c) return !(c.notIn as unknown[]).includes(v);
      if ('not' in c) return v !== c.not;
      return true;
    }
    return v === cond;
  });
}

type OrderBy = Row | Row[] | undefined;

function sortRows(rows: Row[], orderBy: OrderBy): Row[] {
  if (!orderBy) return rows;
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) =>
    Object.entries(o),
  );
  return [...rows].sort((a, b) => {
    for (const [field, dir] of keys) {
      const x = a[field] as number | string | Date;
      const y = b[field] as number | string | Date;
      if (x === y) continue;
      const cmp = x < y ? -1 : 1;
      return dir === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
}

interface Query {
  where?: Row;
  orderBy?: OrderBy;
  skip?: number;
  take?: number;
}

export interface FakeOrderItem {
  id: string;
  order_id: string;
  fulfiller_type: 'CREATOR' | 'PROVIDER';
  fulfiller_id: string;
  fulfillment_status?: string;
  /** Order-time option map (M4.3); undefined / null = pre-snapshot line. */
  variant_options_snapshot?: unknown;
  variant?: { options?: unknown } | null;
  custom_field_values?: Row[];
}

export interface FakeOrder {
  id: string;
  store_id: string;
  status: string;
  created_at?: Date;
  items: FakeOrderItem[];
}

/** A frozen OrderItemDesign row (designer provider specs). */
export interface FakeDesign {
  id: string;
  order_id: string;
  order_item_id: string;
  store_id: string;
  print_status: string;
  files_purged_at?: Date | null;
  created_at?: Date;
}

/** Per-transaction write overlay of one table. */
interface Overlay {
  updated: Map<string, Row>;
  inserted: Row[];
  deleted: Set<string>;
}

interface Tx {
  overlays: Map<string, Overlay>;
  releases: (() => void)[];
}

interface TableSpec {
  name: string;
  rows: Row[];
  /** Primary key field. */
  key: string;
  /** Unique constraint key of a row (null = none). */
  unique?: (r: Row) => string | null;
  defaults?: (data: Row) => Row;
  /** Sort applied when the query has no orderBy. */
  defaultOrder?: OrderBy;
}

export function makeFakePrisma(init: {
  orders: FakeOrder[];
  designs?: FakeDesign[];
}) {
  const db = {
    orders: init.orders,
    designs: (init.designs ?? []) as unknown as Row[],
    checks: [] as Row[],
    summaries: [] as Row[],
    events: [] as Row[],
    timeline: [] as Row[],
    /** Advisory lock keys taken by $executeRaw (per-order write lock). */
    locks: [] as string[],
    writes: 0,
  };
  const write = () => {
    db.writes++;
  };
  /** Tail of the wait queue per advisory lock key. */
  const lockQueues = new Map<string, Promise<void>>();

  function table(spec: TableSpec) {
    const keyOf = (r: Row) => String(r[spec.key]);
    const overlayOf = (tx: Tx | null): Overlay | null => {
      if (!tx) return null;
      let o = tx.overlays.get(spec.name);
      if (!o) {
        o = { updated: new Map(), inserted: [], deleted: new Set() };
        tx.overlays.set(spec.name, o);
      }
      return o;
    };
    /** Committed rows + the transaction's own writes (READ COMMITTED). */
    const view = (tx: Tx | null): Row[] => {
      const o = overlayOf(tx);
      if (!o) return spec.rows;
      return spec.rows
        .filter((r) => !o.deleted.has(keyOf(r)))
        .map((r) => o.updated.get(keyOf(r)) ?? r)
        .concat(o.inserted);
    };
    const query = (tx: Tx | null, q: Query = {}): Row[] => {
      let rows = sortRows(
        view(tx).filter((r) => matches(r, q.where)),
        q.orderBy ?? spec.defaultOrder,
      );
      if (q.skip) rows = rows.slice(q.skip);
      if (q.take !== undefined) rows = rows.slice(0, q.take);
      return rows;
    };
    const hasUnique = (tx: Tx | null, row: Row): boolean => {
      const u = spec.unique?.(row);
      if (!u) return false;
      return view(tx).some((r) => spec.unique!(r) === u);
    };
    const insert = (tx: Tx | null, row: Row) => {
      const o = overlayOf(tx);
      if (o) o.inserted.push(row);
      else spec.rows.push(row);
    };
    /** Apply `data` to the row seen by the transaction. */
    const assign = (tx: Tx | null, current: Row, data: Row): Row => {
      const o = overlayOf(tx);
      if (!o) {
        Object.assign(current, data, { updated_at: new Date() });
        return current;
      }
      const k = keyOf(current);
      const own = o.inserted.find((r) => keyOf(r) === k);
      if (own) {
        Object.assign(own, data, { updated_at: new Date() });
        return own;
      }
      const next = { ...current, ...data, updated_at: new Date() };
      o.updated.set(k, next);
      return next;
    };
    const commit = (tx: Tx) => {
      const o = tx.overlays.get(spec.name);
      if (!o) return;
      for (const [k, row] of o.updated) {
        const target = spec.rows.find((r) => keyOf(r) === k);
        if (target) Object.assign(target, row);
      }
      for (const row of o.inserted) {
        // A concurrent insert of the same unique key committed first.
        if (hasUnique(null, row)) continue;
        spec.rows.push(row);
      }
      for (const k of o.deleted) {
        const i = spec.rows.findIndex((r) => keyOf(r) === k);
        if (i >= 0) spec.rows.splice(i, 1);
      }
    };
    const bind = (tx: Tx | null) => ({
      findMany: (q: Query = {}) =>
        Promise.resolve(query(tx, q).map((r) => ({ ...r }))),
      findFirst: (q: Query = {}) => {
        const r = query(tx, q)[0];
        return Promise.resolve(r ? { ...r } : null);
      },
      findUnique: ({ where }: { where: Row }) => {
        const r = view(tx).find((x) => matches(x, where));
        return Promise.resolve(r ? { ...r } : null);
      },
      count: ({ where }: { where?: Row } = {}) =>
        Promise.resolve(query(tx, { where }).length),
      create: ({ data }: { data: Row }) => {
        write();
        const row = spec.defaults ? spec.defaults(data) : { ...data };
        if (hasUnique(tx, row)) {
          return Promise.reject(new Error('P2002 unique constraint'));
        }
        insert(tx, row);
        return Promise.resolve({ ...row });
      },
      createMany: ({
        data,
        skipDuplicates,
      }: {
        data: Row[];
        skipDuplicates?: boolean;
      }) => {
        write();
        let count = 0;
        for (const d of data) {
          const row = spec.defaults ? spec.defaults(d) : { ...d };
          if (hasUnique(tx, row)) {
            if (skipDuplicates) continue;
            return Promise.reject(new Error('P2002 unique constraint'));
          }
          insert(tx, row);
          count++;
        }
        return Promise.resolve({ count });
      },
      update: ({ where, data }: { where: Row; data: Row }) => {
        write();
        const current = view(tx).find((x) => matches(x, where));
        if (!current) return Promise.reject(new Error('P2025 not found'));
        return Promise.resolve({ ...assign(tx, current, data) });
      },
      updateMany: ({ where, data }: { where: Row; data: Row }) => {
        const hit = view(tx).filter((x) => matches(x, where));
        if (hit.length) write();
        hit.forEach((c) => assign(tx, c, data));
        return Promise.resolve({ count: hit.length });
      },
      delete: ({ where }: { where: Row }) => {
        write();
        const current = view(tx).find((x) => matches(x, where));
        if (!current) return Promise.reject(new Error('P2025 not found'));
        const o = overlayOf(tx);
        if (o) {
          const i = o.inserted.findIndex((r) => keyOf(r) === keyOf(current));
          if (i >= 0) o.inserted.splice(i, 1);
          else o.deleted.add(keyOf(current));
        } else {
          spec.rows.splice(spec.rows.indexOf(current), 1);
        }
        return Promise.resolve({ ...current });
      },
    });
    return { bind, commit };
  }

  const checks = table({
    name: 'checks',
    rows: db.checks,
    key: 'id',
    unique: (r) => `${String(r.order_item_id)}\u0000${String(r.source_key)}`,
    defaults: withDefaults,
    defaultOrder: { sort_order: 'asc' },
  });
  const summaries = table({
    name: 'summaries',
    rows: db.summaries,
    key: 'order_id',
    unique: (r) => String(r.order_id),
    defaults: (data) => ({
      completed_at: null,
      auto_advance_pending: false,
      ...data,
    }),
  });
  const events = table({
    name: 'events',
    rows: db.events,
    key: 'id',
    defaults: (data) => ({ id: randomUUID(), created_at: new Date(), ...data }),
  });
  const timeline = table({
    name: 'timeline',
    rows: db.timeline,
    key: 'id',
    defaults: (data) => ({ id: randomUUID(), created_at: new Date(), ...data }),
  });
  const tables = [checks, summaries, events, timeline];

  const client = (tx: Tx | null): Record<string, unknown> => ({
    creator: {
      findUnique: ({ where }: { where: Row }) =>
        Promise.resolve(
          where.user_id === USER_ID
            ? {
                id: CREATOR_ID,
                display_name: 'Anna Creator',
                store: {
                  id: STORE_ID,
                  language_config: { primary_locale: 'sv' },
                },
              }
            : null,
        ),
    },
    store: {
      findUnique: ({ where }: { where: Row }) =>
        Promise.resolve(
          where.id === STORE_ID
            ? {
                creator_id: CREATOR_ID,
                language_config: { primary_locale: 'sv' },
              }
            : { creator_id: 'other', language_config: null },
        ),
    },
    order: {
      findUnique: ({ where }: { where: Row }) => {
        const o = db.orders.find((x) => x.id === where.id);
        return Promise.resolve(o ? structuredClone(o) : null);
      },
      findMany: ({ where, take }: { where?: Row; take?: number } = {}) =>
        Promise.resolve(
          db.orders
            .filter((o) => matches(o as unknown as Row, where))
            .slice(0, take ?? db.orders.length)
            .map((o) => ({ id: o.id })),
        ),
      count: ({ where }: { where?: Row } = {}) =>
        Promise.resolve(
          db.orders.filter((o) => matches(o as unknown as Row, where)).length,
        ),
    },
    orderItem: {
      findFirst: ({ where }: { where: Row }) => {
        for (const o of db.orders) {
          const it = o.items.find(
            (i) => i.id === where.id && i.order_id === where.order_id,
          );
          if (it) return Promise.resolve({ ...it });
        }
        return Promise.resolve(null);
      },
    },
    orderItemDesign: {
      findUnique: ({ where }: { where: Row }) => {
        const d = db.designs.find((x) => matches(x, where));
        return Promise.resolve(d ? { ...d } : null);
      },
      findMany: (q: Query = {}) =>
        Promise.resolve(
          sortRows(
            db.designs.filter((d) => matches(d, q.where)),
            q.orderBy,
          ).map((d) => ({ ...d })),
        ),
    },
    orderProductionCheck: checks.bind(tx),
    orderProductionSummary: summaries.bind(tx),
    orderProductionEvent: events.bind(tx),
    orderTimeline: timeline.bind(tx),
    // Only the per-order advisory lock uses raw SQL: record the key and
    // queue behind the transaction currently holding it.
    $executeRaw: async (_sql: TemplateStringsArray, ...values: unknown[]) => {
      const key = String(values[0]);
      db.locks.push(key);
      if (!tx) return 1;
      const prev = lockQueues.get(key) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((r) => (release = r));
      lockQueues.set(
        key,
        prev.then(() => mine),
      );
      await prev;
      tx.releases.push(release);
      return 1;
    },
  });

  const prisma = client(null);
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx: Tx = { overlays: new Map(), releases: [] };
    try {
      const result = await fn(client(tx));
      tables.forEach((t) => t.commit(tx));
      return result;
    } finally {
      tx.releases.forEach((r) => r());
    }
  };

  return { prisma: prisma as unknown as PrismaService, db };
}

function withDefaults(data: Row): Row {
  return {
    id: randomUUID(),
    source_hash: null,
    value: null,
    group_index: null,
    file_url: null,
    sort_order: 0,
    done: false,
    done_at: null,
    done_by: null,
    done_by_name: null,
    stale: false,
    created_by: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...data,
  };
}

/** A snapshot value row as M4.0/M4.1 write it. */
export function valueRow(id: string, over: Row = {}): Row {
  return {
    id,
    value: null,
    file_url: null,
    field_name: null,
    field_type: 'TEXT',
    field_label: null,
    display_value: null,
    sort_order: null,
    group_index: null,
    group_label: null,
    source: 'FIELD',
    meta: null,
    custom_field: null,
    ...over,
  };
}

// In-memory PrismaService fake of the production specs (not a test file
// itself: the name ends in "spec.ts" so the build skips it, but not in
// ".spec.ts" so jest does not run it). It models just enough of Prisma for
// ProductionChecklistService: flat where-matching (equality, in, notIn,
// not), the unique (order_item_id, source_key) of OrderProductionCheck with
// createMany skipDuplicates, and a write counter for idempotency checks.

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

export interface FakeOrderItem {
  id: string;
  order_id: string;
  fulfiller_type: 'CREATOR' | 'PROVIDER';
  fulfiller_id: string;
  fulfillment_status?: string;
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

export function makeFakePrisma(init: { orders: FakeOrder[] }) {
  const db = {
    orders: init.orders,
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

  const checkTable = {
    findMany: ({ where }: { where?: Row } = {}) =>
      Promise.resolve(
        db.checks
          .filter((c) => matches(c, where))
          .map((c) => ({ ...c }))
          .sort((a, b) => (a.sort_order as number) - (b.sort_order as number)),
      ),
    findUnique: ({ where }: { where: Row }) => {
      const c = db.checks.find((x) => x.id === where.id);
      return Promise.resolve(c ? { ...c } : null);
    },
    count: ({ where }: { where?: Row } = {}) =>
      Promise.resolve(db.checks.filter((c) => matches(c, where)).length),
    create: ({ data }: { data: Row }) => {
      write();
      if (
        db.checks.some(
          (c) =>
            c.order_item_id === data.order_item_id &&
            c.source_key === data.source_key,
        )
      ) {
        return Promise.reject(new Error('P2002 unique constraint'));
      }
      const row = withDefaults(data);
      db.checks.push(row);
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
        const dup = db.checks.some(
          (c) =>
            c.order_item_id === d.order_item_id &&
            c.source_key === d.source_key,
        );
        if (dup) {
          if (skipDuplicates) continue;
          return Promise.reject(new Error('P2002 unique constraint'));
        }
        db.checks.push(withDefaults(d));
        count++;
      }
      return Promise.resolve({ count });
    },
    update: ({ where, data }: { where: Row; data: Row }) => {
      write();
      const c = db.checks.find((x) => x.id === where.id);
      if (!c) return Promise.reject(new Error('P2025 not found'));
      Object.assign(c, data, { updated_at: new Date() });
      return Promise.resolve({ ...c });
    },
    updateMany: ({ where, data }: { where: Row; data: Row }) => {
      const hit = db.checks.filter((c) => matches(c, where));
      if (hit.length) write();
      hit.forEach((c) => Object.assign(c, data));
      return Promise.resolve({ count: hit.length });
    },
    delete: ({ where }: { where: Row }) => {
      write();
      const i = db.checks.findIndex((x) => x.id === where.id);
      const [row] = db.checks.splice(i, 1);
      return Promise.resolve(row);
    },
  };

  const summaryTable = {
    findUnique: ({ where }: { where: Row }) => {
      const s = db.summaries.find((x) => x.order_id === where.order_id);
      return Promise.resolve(s ? { ...s } : null);
    },
    findMany: ({ where }: { where?: Row } = {}) =>
      Promise.resolve(
        db.summaries.filter((s) => matches(s, where)).map((s) => ({ ...s })),
      ),
    create: ({ data }: { data: Row }) => {
      write();
      const row = { completed_at: null, ...data };
      db.summaries.push(row);
      return Promise.resolve({ ...row });
    },
    update: ({ where, data }: { where: Row; data: Row }) => {
      write();
      const s = db.summaries.find((x) => x.order_id === where.order_id)!;
      Object.assign(s, data);
      return Promise.resolve({ ...s });
    },
    updateMany: ({ where, data }: { where: Row; data: Row }) => {
      const hit = db.summaries.filter((s) => matches(s, where));
      if (hit.length) write();
      hit.forEach((s) => Object.assign(s, data));
      return Promise.resolve({ count: hit.length });
    },
  };

  const eventTable = {
    create: ({ data }: { data: Row }) => {
      write();
      const row = { id: randomUUID(), created_at: new Date(), ...data };
      db.events.push(row);
      return Promise.resolve(row);
    },
    createMany: ({ data }: { data: Row[] }) => {
      write();
      data.forEach((d) =>
        db.events.push({ id: randomUUID(), created_at: new Date(), ...d }),
      );
      return Promise.resolve({ count: data.length });
    },
    findMany: ({ where }: { where?: Row } = {}) =>
      Promise.resolve(db.events.filter((e) => matches(e, where))),
  };

  const prisma: Record<string, unknown> = {
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
      findMany: ({ where }: { where?: Row } = {}) =>
        Promise.resolve(
          db.orders
            .filter((o) => matches(o as unknown as Row, where))
            .map((o) => ({ id: o.id })),
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
    orderProductionCheck: checkTable,
    orderProductionSummary: summaryTable,
    orderProductionEvent: eventTable,
    orderTimeline: {
      create: ({ data }: { data: Row }) => {
        write();
        db.timeline.push(data);
        return Promise.resolve(data);
      },
    },
  };
  prisma.$transaction = (fn: (tx: unknown) => Promise<unknown>) => fn(prisma);
  // Only the per-order advisory lock uses raw SQL; record its key.
  prisma.$executeRaw = (_sql: TemplateStringsArray, ...values: unknown[]) => {
    db.locks.push(String(values[0]));
    return Promise.resolve(1);
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

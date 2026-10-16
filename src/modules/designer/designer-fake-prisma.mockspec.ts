/**
 * In-memory Prisma double for the designer specs (hand-rolled, like the
 * M0/M3 fakes). Supports exactly the calls WP3 makes; `where` handles
 * equality, `{in: [...]}` and `null`.
 */
import { randomUUID } from 'crypto';
import type { DesignAsset } from '@prisma/client';

type Row = Record<string, unknown>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond === null) return v === null || v === undefined;
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[] };
      if (Array.isArray(c.in)) return c.in.includes(v);
      return false;
    }
    return v === cond;
  });
}

function sortBy(rows: Row[], orderBy: Row | undefined): Row[] {
  if (!orderBy) return rows;
  const [[key, dir]] = Object.entries(orderBy);
  return [...rows].sort((a, b) => {
    const x = a[key] as number | Date;
    const y = b[key] as number | Date;
    const d = Number(x) - Number(y);
    return dir === 'desc' ? -d : d;
  });
}

export interface FakeDesignerDb {
  assets: DesignAsset[];
  templates: Row[];
  designs: Row[];
  orderItemDesigns: Row[];
  /** Results of the two COUNT queries of assetReferences, in call order. */
  refCounts: number[];
}

export function fakeDesignerPrisma(db: FakeDesignerDb) {
  let tick = 0;
  const designAsset = {
    findFirst: jest.fn(({ where, orderBy }: { where?: Row; orderBy?: Row }) =>
      Promise.resolve(
        (sortBy(db.assets as unknown as Row[], orderBy).find((r) =>
          matches(r, where),
        ) as DesignAsset | undefined) ?? null,
      ),
    ),
    findUnique: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(
        (db.assets as unknown as Row[]).find((r) => matches(r, where)) ?? null,
      ),
    ),
    findMany: jest.fn(
      ({
        where,
        orderBy,
        skip,
        take,
      }: {
        where?: Row;
        orderBy?: Row;
        skip?: number;
        take?: number;
      }) => {
        let rows = sortBy(db.assets as unknown as Row[], orderBy).filter((r) =>
          matches(r, where),
        );
        if (skip) rows = rows.slice(skip);
        if (take !== undefined) rows = rows.slice(0, take);
        return Promise.resolve(rows);
      },
    ),
    count: jest.fn(({ where }: { where?: Row }) =>
      Promise.resolve(
        (db.assets as unknown as Row[]).filter((r) => matches(r, where)).length,
      ),
    ),
    create: jest.fn(({ data }: { data: Row }) => {
      // Strictly increasing timestamps keep "newest first" deterministic.
      const created = new Date(Date.UTC(2026, 9, 16) + ++tick * 1000);
      const row = {
        id: randomUUID(),
        design_id: null,
        private_key: null,
        preview_key: null,
        public_url: null,
        meta: null,
        purged_at: null,
        ...data,
        created_at: created,
      } as unknown as DesignAsset;
      db.assets.push(row);
      return Promise.resolve(row);
    }),
    update: jest.fn(({ where, data }: { where: Row; data: Row }) => {
      const row = (db.assets as unknown as Row[]).find((r) =>
        matches(r, where),
      );
      if (!row) return Promise.reject(new Error('not found'));
      Object.assign(row, data);
      return Promise.resolve(row);
    }),
    delete: jest.fn(({ where }: { where: Row }) => {
      const i = (db.assets as unknown as Row[]).findIndex((r) =>
        matches(r, where),
      );
      const [row] = db.assets.splice(i, 1);
      return Promise.resolve(row);
    }),
  };
  return {
    designAsset,
    designTemplate: {
      findFirst: jest.fn(({ where }: { where: Row }) =>
        Promise.resolve(db.templates.find((r) => matches(r, where)) ?? null),
      ),
    },
    design: {
      findUnique: jest.fn(({ where }: { where: Row }) =>
        Promise.resolve(db.designs.find((r) => matches(r, where)) ?? null),
      ),
    },
    orderItemDesign: {
      findUnique: jest.fn(({ where }: { where: Row }) =>
        Promise.resolve(
          db.orderItemDesigns.find((r) => matches(r, where)) ?? null,
        ),
      ),
    },
    $queryRaw: jest.fn(() =>
      Promise.resolve([{ n: BigInt(db.refCounts.shift() ?? 0) }]),
    ),
  };
}

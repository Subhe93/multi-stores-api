import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RetentionService } from '../retention/retention.service';
import {
  CONSENT_EXPORT_MAX_ROWS,
  CONSENT_EXPORT_PAGE,
  CONSENT_LOG_KEEP_MS,
  ConsentLogService,
  consentLogOwnerSelect,
  consentStoreSelect,
  consentStoreSlugSelect,
  createdAtRange,
  uaHash,
} from './consent-log.service';
import type { LogConsentDto } from './dto/consent-log.dto';

const STORE = 'store-1';
const IP = '203.0.113.77';
const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';

function dto(patch: Partial<LogConsentDto> = {}): LogConsentDto {
  return {
    event_id: '3b241101-e2bb-4255-8caf-4136c566a962',
    consent_id: '9f1c2a7e-5d4b-4c3a-8b2a-1e0f9d8c7b6a',
    action: 'accept_all',
    source: 'banner',
    analytics: true,
    marketing: true,
    external_media: true,
    consent_version: '3',
    vendors: ['meta', 'ga4', 'clarity'],
    text_hash: 'b'.repeat(64),
    locale: 'sv',
    ...patch,
  };
}

type Row = ReturnType<typeof row>;
interface CreateManyArgs {
  data: Array<Record<string, unknown>>;
  skipDuplicates: boolean;
}
interface FindManyArgs {
  where: {
    store_id: string;
    consent_id?: string;
    created_at?: Record<string, Date>;
  };
  select: unknown;
  orderBy: unknown;
  take: number;
  cursor?: { id: string };
  skip?: number;
}
interface WindowArgs {
  where: { store_id: string; created_at: { gte: Date } };
}
type RawArgs = [TemplateStringsArray, ...unknown[]];

function makePrisma() {
  return {
    store: { findUnique: jest.fn<Promise<unknown>, [unknown]>() },
    consentLog: {
      createMany: jest
        .fn<Promise<{ count: number }>, [CreateManyArgs]>()
        .mockResolvedValue({ count: 1 }),
      findMany: jest.fn<Promise<Row[]>, [FindManyArgs]>().mockResolvedValue([]),
      groupBy: jest
        .fn<
          Promise<Array<{ action: string; _count: { _all: number } }>>,
          [WindowArgs]
        >()
        .mockResolvedValue([]),
      count: jest.fn<Promise<number>, [WindowArgs]>().mockResolvedValue(0),
    },
    $queryRaw: jest.fn<Promise<Array<{ n: bigint }>>, RawArgs>(),
    $executeRaw: jest.fn<Promise<number>, RawArgs>(),
  };
}

function setup() {
  const prisma = makePrisma();
  const service = new ConsentLogService(prisma as unknown as PrismaService);
  return { prisma, service };
}

function row(i: number, at = new Date(Date.UTC(2026, 10, 1, 0, 0, i))) {
  return {
    id: `r${i}`,
    created_at: at,
    consent_id: '9f1c2a7e-5d4b-4c3a-8b2a-1e0f9d8c7b6a',
    action: 'save',
    source: 'dialog',
    analytics: true,
    marketing: false,
    external_media: null,
    consent_version: '3',
    vendors: ['ga4'],
    locale: 'sv',
    text_hash: 'legacy',
  };
}

describe('ConsentLogService.record', () => {
  it('404 for an unknown slug, nothing inserted', async () => {
    const { prisma, service } = setup();
    prisma.store.findUnique.mockResolvedValue(null);
    await expect(
      service.record('nope', dto(), { ip: IP, userAgent: UA }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.consentLog.createMany).not.toHaveBeenCalled();
  });

  it('inserts one row with a truncated IP and hashed UA, never the raw values', async () => {
    const { prisma, service } = setup();
    prisma.store.findUnique.mockResolvedValue({ id: STORE });
    await service.record('namez-se', dto(), { ip: IP, userAgent: UA });

    expect(prisma.store.findUnique).toHaveBeenCalledWith({
      where: { slug: 'namez-se' },
      select: { id: true },
    });
    const arg = prisma.consentLog.createMany.mock.calls[0][0];
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(1);
    const r = arg.data[0];
    expect(r).toMatchObject({
      store_id: STORE,
      event_id: dto().event_id,
      consent_id: dto().consent_id,
      action: 'accept_all',
      source: 'banner',
      analytics: true,
      marketing: true,
      external_media: true,
      consent_version: '3',
      vendors: ['clarity', 'ga4', 'meta'],
      text_hash: 'b'.repeat(64),
      locale: 'sv',
      ip_prefix: '203.0.113.0',
      ua_hash: uaHash(UA),
    });
    expect(r.ua_hash).toMatch(/^[a-f0-9]{64}$/);
    const serialized = JSON.stringify(arg);
    expect(serialized).not.toContain(IP);
    expect(serialized).not.toContain('Mozilla');
    expect(serialized).not.toContain('iPhone');
  });

  it('omitted booleans are stored as null; no UA / bad IP give null', async () => {
    const { prisma, service } = setup();
    prisma.store.findUnique.mockResolvedValue({ id: STORE });
    await service.record(
      'namez-se',
      dto({
        action: 'external_media_grant',
        source: 'facade',
        analytics: undefined,
        marketing: null,
        external_media: true,
        vendors: [],
        text_hash: 'facade',
      }),
      { ip: 'garbage', userAgent: undefined },
    );
    const r = prisma.consentLog.createMany.mock.calls[0][0].data[0];
    expect(r.analytics).toBeNull();
    expect(r.marketing).toBeNull();
    expect(r.ip_prefix).toBeNull();
    expect(r.ua_hash).toBeNull();
  });

  it('a duplicate event_id relies on ON CONFLICT DO NOTHING (skipDuplicates), so a retry is one row', async () => {
    const { prisma, service } = setup();
    prisma.store.findUnique.mockResolvedValue({ id: STORE });
    prisma.consentLog.createMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    await service.record('s', dto(), { ip: IP, userAgent: UA });
    await service.record('s', dto(), { ip: IP, userAgent: UA });
    for (const call of prisma.consentLog.createMany.mock.calls) {
      expect(call[0].skipDuplicates).toBe(true);
    }
  });

  it('the UA is cut to 512 chars before hashing', () => {
    const long = 'x'.repeat(600);
    expect(uaHash(long)).toBe(uaHash('x'.repeat(512)));
    expect(uaHash('')).toBeNull();
  });
});

describe('ConsentLogService owner reads', () => {
  it('list is scoped to the store, newest first, without ip_prefix / ua_hash', async () => {
    const { prisma, service } = setup();
    prisma.consentLog.findMany.mockResolvedValue([row(3), row(2), row(1)]);
    const out = await service.list(STORE, { limit: 2 });
    const arg = prisma.consentLog.findMany.mock.calls[0][0];
    expect(arg.where.store_id).toBe(STORE);
    expect(arg.take).toBe(3);
    expect(arg.orderBy).toEqual([{ created_at: 'desc' }, { id: 'desc' }]);
    expect(arg.select).toBe(consentLogOwnerSelect);
    expect(arg.select).not.toHaveProperty('ip_prefix');
    expect(arg.select).not.toHaveProperty('ua_hash');
    expect(arg.select).not.toHaveProperty('store_id');
    expect(out.items.map((r) => r.id)).toEqual(['r3', 'r2']);
    expect(out.next_before).toBe(row(2).created_at.toISOString());
  });

  it('last page has no cursor; before / consent_id / range become filters', async () => {
    const { prisma, service } = setup();
    prisma.consentLog.findMany.mockResolvedValue([row(1)]);
    const out = await service.list(STORE, {
      before: '2026-11-10T00:00:00.000Z',
      consent_id: '9f1c2a7e-5d4b-4c3a-8b2a-1e0f9d8c7b6a',
      from: '2026-11-01',
      to: '2026-11-30',
    });
    expect(out.next_before).toBeNull();
    const where = prisma.consentLog.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      store_id: STORE,
      consent_id: '9f1c2a7e-5d4b-4c3a-8b2a-1e0f9d8c7b6a',
      created_at: {
        gte: new Date('2026-11-01T00:00:00.000Z'),
        lt: new Date('2026-11-10T00:00:00.000Z'),
      },
    });
    expect(prisma.consentLog.findMany.mock.calls[0][0].take).toBe(51);
  });

  it('summary counts decisions of the window for this store only', async () => {
    const { prisma, service } = setup();
    prisma.consentLog.groupBy.mockResolvedValue([
      { action: 'accept_all', _count: { _all: 7 } },
      { action: 'reject_all', _count: { _all: 2 } },
      { action: 'save', _count: { _all: 1 } },
      { action: 'migrated', _count: { _all: 4 } },
    ]);
    prisma.consentLog.count
      .mockResolvedValueOnce(9)
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(6);
    const out = await service.summary(STORE, 30);
    expect(out).toEqual({
      days: 30,
      total: 14,
      accept_all: 7,
      reject_all: 2,
      save: 1,
      analytics_granted: 9,
      marketing_granted: 8,
      external_media_granted: 6,
    });
    for (const call of [
      ...prisma.consentLog.groupBy.mock.calls,
      ...prisma.consentLog.count.mock.calls,
    ]) {
      expect(call[0].where.store_id).toBe(STORE);
      expect(call[0].where.created_at.gte).toBeInstanceOf(Date);
    }
  });

  it('createdAtRange: date-only `to` covers the whole day, timestamps are exact', () => {
    expect(createdAtRange('2026-01-01', '2026-01-31')).toEqual({
      gte: new Date('2026-01-01T00:00:00.000Z'),
      lt: new Date('2026-02-01T00:00:00.000Z'),
    });
    expect(createdAtRange(undefined, '2026-01-31T12:00:00Z')).toEqual({
      lte: new Date('2026-01-31T12:00:00Z'),
    });
  });

  it('export range: at most 366 days, from <= to', () => {
    const { service } = setup();
    expect(() =>
      service.exportRange({ from: '2026-01-01', to: '2027-01-01' }),
    ).not.toThrow();
    expect(() =>
      service.exportRange({ from: '2026-01-01', to: '2027-01-03' }),
    ).toThrow(BadRequestException);
    expect(() =>
      service.exportRange({ from: '2026-02-01', to: '2026-01-01' }),
    ).toThrow(BadRequestException);
  });
});

describe('ConsentLogService.exportCsv', () => {
  async function collect(gen: AsyncGenerator<string>): Promise<string> {
    let s = '';
    for await (const c of gen) s += c;
    return s;
  }

  it('pages with a keyset cursor, oldest first, scoped to the store', async () => {
    const { prisma, service } = setup();
    const page1 = Array.from({ length: CONSENT_EXPORT_PAGE }, (_, i) => row(i));
    prisma.consentLog.findMany
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce([{ ...row(5000), action: '=cmd' }]);
    const csv = await collect(
      service.exportCsv(STORE, createdAtRange('2026-01-01', '2026-12-31')),
    );
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toMatch(/^id,created_at,consent_id,action/);
    expect(lines).toHaveLength(1 + CONSENT_EXPORT_PAGE + 1);
    // Formula cells are neutralized.
    expect(csv).toContain(",'=cmd,");
    const calls = prisma.consentLog.findMany.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.where.store_id).toBe(STORE);
      expect(c.orderBy).toEqual([{ created_at: 'asc' }, { id: 'asc' }]);
      expect(c.select).toBe(consentLogOwnerSelect);
    }
    expect(calls[0].cursor).toBeUndefined();
    expect(calls[1]).toMatchObject({
      cursor: { id: `r${CONSENT_EXPORT_PAGE - 1}` },
      skip: 1,
    });
  });

  it(`caps the export at ${CONSENT_EXPORT_MAX_ROWS} rows`, async () => {
    const { prisma, service } = setup();
    prisma.consentLog.findMany.mockImplementation(
      ({ take }: { take: number }) =>
        Promise.resolve(Array.from({ length: take }, (_, i) => row(i))),
    );
    const csv = await collect(service.exportCsv(STORE, {}));
    const lines = csv.trimEnd().split('\r\n');
    expect(lines).toHaveLength(1 + CONSENT_EXPORT_MAX_ROWS);
    expect(prisma.consentLog.findMany).toHaveBeenCalledTimes(
      CONSENT_EXPORT_MAX_ROWS / CONSENT_EXPORT_PAGE,
    );
  });
});

describe('ConsentLogService retention (`consent-log`)', () => {
  const now = new Date('2028-11-14T00:00:00.000Z');

  it('registers the task with the retention registry', () => {
    const prisma = makePrisma();
    const registerTask = jest.fn();
    const service = new ConsentLogService(
      prisma as unknown as PrismaService,
      { registerTask } as unknown as RetentionService,
    );
    service.onModuleInit();
    expect(registerTask).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'consent-log' }),
    );
  });

  it('works without the retention module', () => {
    const { service } = setup();
    expect(() => service.onModuleInit()).not.toThrow();
  });

  it('dry run only counts rows older than 730 days', async () => {
    const { prisma, service } = setup();
    prisma.$queryRaw.mockResolvedValue([{ n: BigInt(12) }]);
    const out = await service.purge(now, { dryRun: true, limit: 500 });
    expect(out).toEqual({ purged: 12, skipped: 0, errors: 0 });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    const values = prisma.$queryRaw.mock.calls[0].slice(1);
    expect(values[0]).toEqual(new Date(now.getTime() - CONSENT_LOG_KEEP_MS));
  });

  it('deletes in batches until a batch is short', async () => {
    const { prisma, service } = setup();
    prisma.$executeRaw
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(42);
    const out = await service.purge(now, { dryRun: false, limit: 500 });
    expect(out.purged).toBe(1042);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(3);
    const call = prisma.$executeRaw.mock.calls[0];
    const sql = call[0].join('?');
    expect(sql).toMatch(/DELETE FROM "ConsentLog" WHERE "id" IN/);
    expect(sql).toMatch(/"created_at" < \?/);
    expect(sql).toMatch(/LIMIT \?/);
    expect(call[1]).toEqual(new Date(now.getTime() - CONSENT_LOG_KEEP_MS));
    expect(call[2]).toBe(500);
  });

  it('stops at the run deadline', async () => {
    const { prisma, service } = setup();
    prisma.$executeRaw.mockResolvedValue(500);
    const past = await service.purge(now, {
      dryRun: false,
      limit: 500,
      deadline: Date.now() - 1,
    });
    expect(past.purged).toBe(0);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();

    let calls = 0;
    const spy = jest.spyOn(Date, 'now');
    const base = 1_000_000;
    spy.mockImplementation(() => base + (calls >= 2 ? 10_000 : 0));
    prisma.$executeRaw.mockImplementation(() => {
      calls += 1;
      return Promise.resolve(500);
    });
    const out = await service.purge(now, {
      dryRun: false,
      limit: 500,
      deadline: base + 5_000,
    });
    spy.mockRestore();
    expect(out.purged).toBe(1000);
  });
});

describe('ConsentLog selects match the generated Prisma data model', () => {
  const model = (name: string) =>
    Prisma.dmmf.datamodel.models.find((m) => m.name === name);

  it.each([
    ['Store', consentStoreSelect],
    ['Store', consentStoreSlugSelect],
    ['ConsentLog', consentLogOwnerSelect],
  ] as const)('%s select fields exist', (name, select) => {
    const m = model(name);
    expect(m).toBeDefined();
    const fields = new Set(m!.fields.map((f) => f.name));
    expect(Object.keys(select).filter((k) => !fields.has(k))).toEqual([]);
  });

  it('Store has the consent_logs back-relation', () => {
    expect(model('Store')!.fields.some((f) => f.name === 'consent_logs')).toBe(
      true,
    );
  });
});

describe('migration 20261127120000_consent_log matches the schema', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '../../../prisma/migrations/20261127120000_consent_log/migration.sql',
    ),
    'utf8',
  );
  const m = Prisma.dmmf.datamodel.models.find((x) => x.name === 'ConsentLog')!;
  const table =
    /CREATE TABLE IF NOT EXISTS "ConsentLog" \(([\s\S]*?)\n\);/.exec(sql)![1];

  it('every scalar field is a column with the right nullability', () => {
    const scalars = m.fields.filter((f) => f.kind === 'scalar');
    const columns = [...table.matchAll(/^\s+"(\w+)" ([^\n]+?),?$/gm)].map(
      (x) => ({ name: x[1], def: x[2] }),
    );
    expect(columns.map((c) => c.name).sort()).toEqual(
      scalars.map((f) => f.name).sort(),
    );
    for (const f of scalars) {
      const col = columns.find((c) => c.name === f.name)!;
      // Prisma lists are nullable columns; required scalars are NOT NULL.
      const notNull = f.isRequired && !f.isList;
      expect([f.name, /NOT NULL/.test(col.def)]).toEqual([f.name, notNull]);
    }
  });

  it('unique key, indexes and the cascading store FK exist', () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "ConsentLog_store_id_event_id_key" ON "ConsentLog"("store_id", "event_id")',
    );
    expect(sql).toContain(
      '"ConsentLog_store_id_created_at_idx" ON "ConsentLog"("store_id", "created_at")',
    );
    expect(sql).toContain(
      '"ConsentLog_store_id_consent_id_idx" ON "ConsentLog"("store_id", "consent_id")',
    );
    expect(sql).toContain(
      '"ConsentLog_created_at_idx" ON "ConsentLog"("created_at")',
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("store_id"\) REFERENCES "Store"\("id"\) ON DELETE CASCADE/,
    );
    expect(m.uniqueFields).toContainEqual(['store_id', 'event_id']);
  });

  it('every statement is re-runnable (the FK is guarded like the IF NOT EXISTS DDL)', () => {
    expect(sql).not.toMatch(/^ALTER TABLE/m);
    expect(sql).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'ConsentLog_store_id_fkey'\) THEN\s+ALTER TABLE "ConsentLog" ADD CONSTRAINT "ConsentLog_store_id_fkey"/,
    );
  });

  it('stores no raw IP or user agent column', () => {
    const names = m.fields.map((f) => f.name);
    expect(names).not.toContain('ip');
    expect(names).not.toContain('user_agent');
    expect(names).toEqual(expect.arrayContaining(['ip_prefix', 'ua_hash']));
  });
});

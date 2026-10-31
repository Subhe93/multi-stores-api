import { GUARDS_METADATA } from '@nestjs/common/constants';
import { REQUIRE_APP_KEY } from '../../common/decorators';
import {
  BULK_REDIRECT_MAX_ROWS,
  parseBulkRedirectCsv,
  RedirectsService,
} from './redirects.service';
import { RedirectsCreatorController } from './redirects-creator.controller';
import { RedirectsPublicController } from './redirects-public.controller';
import type { PrismaService } from '../../prisma/prisma.service';

// M4.4 §6.3: version cache (proxy hot path), map/lookup modes, resolve with
// the fallback key, store-scoped CRUD with chain flattening and loop checks.

type Row = {
  id: string;
  store_id: string;
  from_path: string;
  to_path: string;
  status_code: number;
  source: 'IMPORT' | 'MANUAL' | 'SLUG_CHANGE';
  import_run_id: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

function mkRow(over: Partial<Row> & { id: string; from_path: string }): Row {
  return {
    store_id: 's1',
    to_path: '/',
    status_code: 301,
    source: 'MANUAL',
    import_run_id: null,
    is_active: true,
    created_at: new Date(0),
    updated_at: new Date(1_000),
    ...over,
  };
}

/** Tiny in-memory StoreRedirect table behind the Prisma calls we use. */
function setup(initial: Row[] = []) {
  let rows = [...initial];
  let n = 0;
  const match = (r: Row, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'from_path' && v && typeof v === 'object' && 'in' in v) {
        return (v as { in: string[] }).in.includes(r.from_path);
      }
      if (k === 'OR' || k === 'source') return true;
      return (r as unknown as Record<string, unknown>)[k] === v;
    });
  const storeRedirect = {
    aggregate: jest.fn(({ where }: { where: Record<string, unknown> }) => {
      const hit = rows.filter((r) => match(r, where));
      const max = hit.reduce<Date | null>(
        (m, r) => (!m || r.updated_at > m ? r.updated_at : m),
        null,
      );
      return Promise.resolve({
        _count: { _all: hit.length },
        _max: { updated_at: max },
      });
    }),
    findMany: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(rows.filter((r) => match(r, where))),
    ),
    findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(rows.find((r) => match(r, where)) ?? null),
    ),
    findUnique: jest.fn(
      ({
        where,
      }: {
        where: { store_id_from_path: { store_id: string; from_path: string } };
      }) =>
        Promise.resolve(
          rows.find(
            (r) =>
              r.store_id === where.store_id_from_path.store_id &&
              r.from_path === where.store_id_from_path.from_path,
          ) ?? null,
        ),
    ),
    create: jest.fn(({ data }: { data: Partial<Row> }) => {
      const r = mkRow({
        id: `new-${++n}`,
        from_path: data.from_path!,
        ...data,
        updated_at: new Date(10_000 + n),
      });
      rows.push(r);
      return Promise.resolve(r);
    }),
    update: jest.fn(
      ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const r = rows.find((x) => x.id === where.id)!;
        Object.assign(r, data, { updated_at: new Date(20_000 + ++n) });
        return Promise.resolve(r);
      },
    ),
    deleteMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
      const before = rows.length;
      rows = rows.filter((r) => !match(r, where));
      return Promise.resolve({ count: before - rows.length });
    }),
    count: jest.fn(() => Promise.resolve(rows.length)),
    createMany: jest.fn(({ data }: { data: Partial<Row>[] }) => {
      for (const d of data)
        rows.push(mkRow({ id: `new-${++n}`, from_path: d.from_path!, ...d }));
      return Promise.resolve({ count: data.length });
    }),
  };
  const prisma = {
    storeRedirect,
    store: {
      findUnique: jest.fn(({ where }: { where: { slug: string } }) =>
        Promise.resolve(
          where.slug === 'namez'
            ? { id: 's1', is_active: true }
            : where.slug === 'off'
              ? { id: 's2', is_active: false }
              : null,
        ),
      ),
    },
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) =>
      fn({ storeRedirect }),
    ),
  };
  const svc = new RedirectsService(prisma as unknown as PrismaService);
  return { svc, prisma, rows: () => rows };
}

describe('RedirectsService.versionFor', () => {
  it('is null for a store without active rows (and cached)', async () => {
    const { svc, prisma } = setup([
      mkRow({ id: 'r1', from_path: '/a', is_active: false }),
    ]);
    expect(await svc.versionFor('s1')).toBeNull();
    expect(await svc.versionFor('s1')).toBeNull();
    expect(prisma.storeRedirect.aggregate).toHaveBeenCalledTimes(1);
  });

  it('changes after a write (invalidated) and is cached in between', async () => {
    const { svc, prisma } = setup([
      mkRow({ id: 'r1', from_path: '/a', to_path: '/b' }),
    ]);
    const v1 = await svc.versionFor('s1');
    expect(v1).toMatch(/^1-/);
    await svc.versionFor('s1');
    expect(prisma.storeRedirect.aggregate).toHaveBeenCalledTimes(1);
    await svc.create('s1', { from_path: '/c', to_path: '/d' });
    const v2 = await svc.versionFor('s1');
    expect(v2).toMatch(/^2-/);
    expect(v2).not.toBe(v1);
  });

  it('fails open: a DB error answers null and is not cached', async () => {
    const { svc, prisma } = setup([mkRow({ id: 'r1', from_path: '/a' })]);
    prisma.storeRedirect.aggregate.mockImplementationOnce(() =>
      Promise.reject(new Error('db down')),
    );
    expect(await svc.versionFor('s1')).toBeNull();
    expect(await svc.versionFor('s1')).toMatch(/^1-/);
  });
});

describe('RedirectsService public reads', () => {
  it('mapFor returns active tuples; empty store → version null', async () => {
    const { svc } = setup([
      mkRow({ id: 'r1', from_path: '/a', to_path: '/b' }),
      mkRow({ id: 'r2', from_path: '/c', to_path: '/d', status_code: 302 }),
      mkRow({ id: 'r3', from_path: '/x', to_path: '/y', is_active: false }),
    ]);
    const res = await svc.mapFor('s1');
    expect(res.mode).toBe('map');
    expect(res.mode === 'map' && res.items).toEqual([
      ['/a', '/b', 301],
      ['/c', '/d', 302],
    ]);
    expect(await svc.mapFor('other')).toEqual({
      version: null,
      mode: 'map',
      items: [],
    });
  });

  it('switches to lookup mode above 20 000 rows', async () => {
    const { svc, prisma } = setup();
    prisma.storeRedirect.aggregate.mockImplementationOnce(() =>
      Promise.resolve({
        _count: { _all: 20_001 },
        _max: { updated_at: new Date(5) },
      }),
    );
    const res = await svc.mapFor('s1');
    expect(res).toMatchObject({ mode: 'lookup' });
    expect(typeof res.version).toBe('string');
    expect(prisma.storeRedirect.findMany).not.toHaveBeenCalled();
  });

  it('resolve: exact first, then the /page/<n> fallback; inactive rows ignored', async () => {
    const { svc } = setup([
      mkRow({
        id: 'r1',
        from_path: '/product-category/barn',
        to_path: '/collections/barn',
      }),
      mkRow({
        id: 'r2',
        from_path: '/produkt/x',
        to_path: '/products/x',
        is_active: false,
      }),
    ]);
    expect(
      await svc.resolve('s1', '/Product-Category/Barn/page/3/?a=1'),
    ).toEqual({
      to: '/collections/barn',
      status: 301,
    });
    expect(await svc.resolve('s1', '/produkt/x')).toBeNull();
    expect(await svc.resolve('s1', 'not-a-path')).toBeNull();
  });

  it('publicStoreId: 404 for unknown or inactive stores', async () => {
    const { svc } = setup();
    await expect(svc.publicStoreId('namez')).resolves.toBe('s1');
    await expect(svc.publicStoreId('off')).rejects.toMatchObject({
      response: { code: 'STORE_NOT_FOUND' },
    });
    await expect(svc.publicStoreId('nope')).rejects.toMatchObject({
      response: { code: 'STORE_NOT_FOUND' },
    });
  });
});

describe('RedirectsService creator CRUD', () => {
  it('create normalises from_path, validates to_path and rejects duplicates', async () => {
    const { svc } = setup();
    const r = await svc.create('s1', {
      from_path: '/Old/Page/',
      to_path: '/products/x',
    });
    expect(r).toMatchObject({
      from_path: '/old/page',
      to_path: '/products/x',
      source: 'MANUAL',
      status_code: 301,
    });
    await expect(
      svc.create('s1', { from_path: '/old/page', to_path: '/y' }),
    ).rejects.toMatchObject({ response: { code: 'REDIRECT_DUPLICATE' } });
    await expect(
      svc.create('s1', { from_path: '/z', to_path: 'https://evil.example' }),
    ).rejects.toMatchObject({ response: { code: 'REDIRECT_INVALID_PATH' } });
    await expect(
      svc.create('s1', { from_path: 'z', to_path: '/y' }),
    ).rejects.toMatchObject({ response: { code: 'REDIRECT_INVALID_PATH' } });
  });

  it('create flattens a chain and re-points rows targeting the new source', async () => {
    const { svc, rows } = setup([
      mkRow({ id: 'r1', from_path: '/b', to_path: '/c' }),
      mkRow({ id: 'r2', from_path: '/x', to_path: '/a' }),
    ]);
    const r = await svc.create('s1', { from_path: '/a', to_path: '/b' });
    expect(r.to_path).toBe('/c');
    expect(rows().find((x) => x.id === 'r2')!.to_path).toBe('/c');
  });

  it('create rejects loops (REDIRECT_LOOP)', async () => {
    const { svc } = setup([
      mkRow({ id: 'r1', from_path: '/b', to_path: '/c' }),
      mkRow({ id: 'r2', from_path: '/c', to_path: '/a' }),
    ]);
    await expect(
      svc.create('s1', { from_path: '/a', to_path: '/b' }),
    ).rejects.toMatchObject({
      response: { code: 'REDIRECT_LOOP' },
    });
    await expect(
      svc.create('s1', { from_path: '/q', to_path: '/Q/' }),
    ).rejects.toMatchObject({
      response: { code: 'REDIRECT_LOOP' },
    });
  });

  it('update is store-scoped and turns an imported row into MANUAL', async () => {
    const { svc } = setup([
      mkRow({
        id: 'r1',
        from_path: '/a',
        to_path: '/b',
        source: 'IMPORT',
        import_run_id: 'run1',
      }),
      mkRow({ id: 'other', store_id: 's2', from_path: '/a', to_path: '/b' }),
    ]);
    const r = await svc.update('s1', 'r1', { to_path: '/c', status_code: 302 });
    expect(r).toMatchObject({
      to_path: '/c',
      status_code: 302,
      source: 'MANUAL',
    });
    await expect(
      svc.update('s1', 'other', { to_path: '/z' }),
    ).rejects.toMatchObject({
      response: { code: 'REDIRECT_NOT_FOUND' },
    });
  });

  it('update: duplicate from_path and a loop through itself are rejected', async () => {
    const { svc } = setup([
      mkRow({ id: 'r1', from_path: '/a', to_path: '/b' }),
      mkRow({ id: 'r2', from_path: '/b', to_path: '/c' }),
    ]);
    await expect(
      svc.update('s1', 'r1', { from_path: '/b' }),
    ).rejects.toMatchObject({
      response: { code: 'REDIRECT_DUPLICATE' },
    });
    await expect(
      svc.update('s1', 'r2', { to_path: '/a' }),
    ).rejects.toMatchObject({
      response: { code: 'REDIRECT_LOOP' },
    });
    // Deactivating skips the chain check.
    await expect(
      svc.update('s1', 'r2', { to_path: '/a', is_active: false }),
    ).resolves.toMatchObject({
      is_active: false,
    });
  });

  it("remove is store-scoped (404 for another store's row)", async () => {
    const { svc } = setup([
      mkRow({ id: 'r1', from_path: '/a' }),
      mkRow({ id: 'other', store_id: 's2', from_path: '/a' }),
    ]);
    await expect(svc.remove('s1', 'other')).rejects.toMatchObject({
      response: { code: 'REDIRECT_NOT_FOUND' },
    });
    await expect(svc.remove('s1', 'r1')).resolves.toEqual({ deleted: true });
  });

  it('test reports the normalised path and the live match', async () => {
    const { svc } = setup([
      mkRow({ id: 'r1', from_path: '/feed-me', to_path: '/x' }),
    ]);
    expect(await svc.test('s1', '/Feed-Me/feed')).toEqual({
      path: '/feed-me/feed',
      match: {
        id: 'r1',
        from_path: '/feed-me',
        to_path: '/x',
        status_code: 301,
        source: 'MANUAL',
      },
    });
    await expect(svc.test('s1', 'nope')).rejects.toMatchObject({
      response: { code: 'REDIRECT_INVALID_PATH' },
    });
  });
});

describe('RedirectsService.bulkUpsertFromImport', () => {
  it('creates, keeps MANUAL rows, and is idempotent on a re-run', async () => {
    const { svc, prisma, rows } = setup([
      mkRow({ id: 'm1', from_path: '/produkt/kept', to_path: '/mine' }),
    ]);
    const createMany = jest.fn(({ data }: { data: Partial<Row>[] }) => {
      for (const d of data) {
        rows().push(
          mkRow({ id: `imp-${d.from_path}`, from_path: d.from_path!, ...d }),
        );
      }
      return Promise.resolve({ count: data.length });
    });
    const tx = { storeRedirect: { ...prisma.storeRedirect, createMany } };
    const batch = [
      { from_path: '/produkt/a', to_path: '/products/a' },
      { from_path: '/produkt/kept', to_path: '/products/kept' },
    ];
    const first = await svc.bulkUpsertFromImport(
      tx as never,
      's1',
      'run1',
      batch,
    );
    expect(first).toMatchObject({ created: 1, updated: 0, unchanged: 0 });
    expect(first.conflicts).toEqual([
      {
        from_path: '/produkt/kept',
        to_path: '/products/kept',
        code: 'REDIRECT_CONFLICT',
      },
    ]);
    expect(createMany.mock.calls[0][0].data[0]).toMatchObject({
      source: 'IMPORT',
      import_run_id: 'run1',
      store_id: 's1',
    });
    const second = await svc.bulkUpsertFromImport(
      tx as never,
      's1',
      'run2',
      batch,
    );
    expect(second).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
  });
});

describe('redirect controllers: guards and app gating', () => {
  const appKey = (proto: object, method: string) =>
    Reflect.getMetadata(
      REQUIRE_APP_KEY,
      (proto as Record<string, object>)[method],
    ) as string | undefined;

  it('creator writes require the importer app; list and delete stay open', () => {
    const p = RedirectsCreatorController.prototype;
    expect(appKey(p, 'create')).toBe('importer');
    expect(appKey(p, 'update')).toBe('importer');
    expect(appKey(p, 'test')).toBe('importer');
    expect(appKey(p, 'list')).toBeUndefined();
    expect(appKey(p, 'remove')).toBeUndefined();
    expect(
      Reflect.getMetadata(GUARDS_METADATA, RedirectsCreatorController),
    ).toHaveLength(3);
  });

  it('public routes have no route guards and their own throttle limits', () => {
    const p = RedirectsPublicController.prototype as unknown as Record<
      string,
      object
    >;
    expect(
      Reflect.getMetadata(GUARDS_METADATA, RedirectsPublicController),
    ).toBeUndefined();
    for (const m of ['map', 'resolve']) {
      expect(Reflect.getMetadata(GUARDS_METADATA, p[m])).toBeUndefined();
      expect(appKey(p, m)).toBeUndefined();
      const keys = Reflect.getMetadataKeys(p[m]).map(String);
      expect(keys.some((k) => k.includes('LIMIT'))).toBe(true);
    }
  });

  it('public resolve answers 404 REDIRECT_NOT_FOUND without a match', async () => {
    const { svc } = setup();
    const ctrl = new RedirectsPublicController(svc);
    await expect(ctrl.resolve('namez', '/nothing')).rejects.toMatchObject({
      response: { code: 'REDIRECT_NOT_FOUND' },
    });
    await expect(ctrl.resolve('namez')).rejects.toMatchObject({
      response: { code: 'REDIRECT_NOT_FOUND' },
    });
  });
});

// M5 B17: `POST redirects/my/bulk` — CSV text in, created / conflicts out.
describe('RedirectsService.bulkCreate', () => {
  it('parses CSV lines: header, comments, quotes, `;` and tab separators, 1-based line numbers', () => {
    const rows = parseBulkRedirectCsv(
      [
        'from_path,to_path,status',
        '# a comment',
        '',
        '"/a","/b",302',
        '/c;/d',
        '/e\t/f\t307',
      ].join('\r\n'),
    );
    expect(rows).toEqual([
      { line: 4, from_path: '/a', to_path: '/b', status_code: 302 },
      { line: 5, from_path: '/c', to_path: '/d' },
      { line: 6, from_path: '/e', to_path: '/f', status_code: 307 },
    ]);
  });

  it('creates MANUAL rows, flattens chains, re-points rows and reports each failed line with a code', async () => {
    const { svc, rows } = setup([
      mkRow({ id: 'm1', from_path: '/taken', to_path: '/x' }),
      mkRow({ id: 'i1', from_path: '/old', to_path: '/a', source: 'IMPORT' }),
    ]);
    const res = await svc.bulkCreate(
      's1',
      parseBulkRedirectCsv(
        [
          '/a,/b',
          '/taken,/y',
          '/b,/a',
          'not-a-path,/z',
          '/q,/r,999',
          '/loop,/loop2',
          '/loop2,/loop',
        ].join('\n'),
      ),
    );
    expect(res.created.map((c) => [c.line, c.from_path, c.to_path])).toEqual([
      [1, '/a', '/b'],
      [6, '/loop', '/loop2'],
    ]);
    expect(res.created.every((c) => c.status_code === 301)).toBe(true);
    expect(res.conflicts).toEqual([
      {
        line: 2,
        from_path: '/taken',
        to_path: '/y',
        code: 'REDIRECT_DUPLICATE',
      },
      { line: 3, from_path: '/b', to_path: '/a', code: 'REDIRECT_LOOP' },
      {
        line: 4,
        from_path: 'not-a-path',
        to_path: '/z',
        code: 'REDIRECT_INVALID_PATH',
      },
      {
        line: 5,
        from_path: '/q',
        to_path: '/r',
        code: 'REDIRECT_INVALID_PATH',
      },
      { line: 7, from_path: '/loop2', to_path: '/loop', code: 'REDIRECT_LOOP' },
    ]);
    const all = rows();
    expect(all.filter((r) => r.from_path === '/a')[0]).toMatchObject({
      source: 'MANUAL',
      to_path: '/b',
      is_active: true,
    });
    // The existing row that targeted /a now points at /b (chain flattened).
    expect(all.find((r) => r.id === 'i1')?.to_path).toBe('/b');
    expect(all).toHaveLength(4);
  });

  it('refuses more than the row cap with REDIRECT_BULK_TOO_MANY', async () => {
    const { svc, prisma } = setup();
    const rows = Array.from({ length: BULK_REDIRECT_MAX_ROWS + 1 }, (_, i) => ({
      line: i + 1,
      from_path: `/f${i}`,
      to_path: '/t',
    }));
    await expect(svc.bulkCreate('s1', rows)).rejects.toMatchObject({
      response: { code: 'REDIRECT_BULK_TOO_MANY' },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('the bulk route requires the importer app', () => {
    const p = RedirectsCreatorController.prototype as unknown as Record<
      string,
      object
    >;
    expect(Reflect.getMetadata(REQUIRE_APP_KEY, p.bulk)).toBe('importer');
  });
});

describe('RedirectsService.applySlugChangeRedirects (old-slug 301s)', () => {
  it('writes SLUG_CHANGE rows, re-points, switches off shadowing rows, invalidates', async () => {
    const { svc, rows } = setup([
      mkRow({ id: 'r1', from_path: '/gammal', to_path: '/products/mugg' }),
      mkRow({
        id: 'r2',
        from_path: '/products/kopp',
        to_path: '/products/x',
        source: 'SLUG_CHANGE',
      }),
    ]);
    const invalidate = jest.spyOn(svc, 'invalidate');
    const plan = await svc.applySlugChangeRedirects('s1', [
      { from: '/products/mugg', to: '/products/kopp' },
    ]);
    expect(plan?.conflicts).toEqual([]);
    const byFrom = Object.fromEntries(
      rows().map((r) => [r.from_path, [r.to_path, r.source, r.is_active]]),
    );
    expect(byFrom).toEqual({
      '/gammal': ['/products/kopp', 'MANUAL', true],
      '/products/kopp': ['/products/x', 'SLUG_CHANGE', false],
      '/products/mugg': ['/products/kopp', 'SLUG_CHANGE', true],
    });
    expect(invalidate).toHaveBeenCalledWith('s1');
  });

  it('nothing to do: no writes', async () => {
    const { svc, prisma } = setup();
    expect(await svc.applySlugChangeRedirects('s1', [])).toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('RedirectsService live paths and locale prefixes (old-slug 301s)', () => {
  /** setup() plus a language config, markets and a real updateMany. */
  function withLocales(initial: Row[]) {
    const ctx = setup(initial);
    const p = ctx.prisma as unknown as Record<string, unknown> & {
      storeRedirect: Record<string, unknown>;
      $transaction: jest.Mock;
    };
    p.storeLanguageConfig = {
      findUnique: jest.fn(() =>
        Promise.resolve({ primary_locale: 'sv', secondary_locales: ['en'] }),
      ),
    };
    p.market = {
      findMany: jest.fn(() =>
        Promise.resolve([{ locales: ['ar', 'xx'] }, { locales: [] }]),
      ),
    };
    p.storeRedirect.updateMany = jest.fn(
      ({
        where,
        data,
      }: {
        where: {
          store_id: string;
          is_active: boolean;
          source: { not: string };
          from_path: { in: string[] };
        };
        data: Partial<Row>;
      }) => {
        let count = 0;
        for (const r of ctx.rows()) {
          if (
            r.store_id === where.store_id &&
            r.is_active === where.is_active &&
            r.source !== where.source.not &&
            where.from_path.in.includes(r.from_path)
          ) {
            Object.assign(r, data);
            count++;
          }
        }
        return Promise.resolve({ count });
      },
    );
    p.$transaction = jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(p));
    return ctx;
  }

  it('storeLocalePrefixes: secondary + market locales, known ones, primary excluded', async () => {
    const { svc } = withLocales([]);
    expect((await svc.storeLocalePrefixes('s1')).sort()).toEqual(['ar', 'en']);
  });

  it('releaseLivePaths switches off IMPORT / SLUG_CHANGE rows on live paths, never MANUAL', async () => {
    const { svc, rows } = withLocales([
      mkRow({
        id: 'a',
        from_path: '/products/mugg',
        to_path: '/products/kopp',
        source: 'SLUG_CHANGE',
      }),
      mkRow({
        id: 'b',
        from_path: '/en/products/mugg',
        to_path: '/en/products/kopp',
        source: 'IMPORT',
      }),
      mkRow({
        id: 'c',
        from_path: '/products/kläder',
        to_path: '/products/x',
        source: 'SLUG_CHANGE',
      }),
      mkRow({
        id: 'm',
        from_path: '/ar/products/mugg',
        to_path: '/',
        source: 'MANUAL',
      }),
      mkRow({
        id: 'o',
        from_path: '/products/other',
        to_path: '/',
        source: 'SLUG_CHANGE',
      }),
    ]);
    const invalidate = jest.spyOn(svc, 'invalidate');
    const n = await svc.releaseLivePaths(
      's1',
      ['/products/mugg', '/products/kl%c3%a4der'],
      { localePrefixes: true },
    );
    expect(n).toBe(3);
    const active = Object.fromEntries(rows().map((r) => [r.id, r.is_active]));
    expect(active).toEqual({ a: false, b: false, c: false, m: true, o: true });
    expect(invalidate).toHaveBeenCalledWith('s1');
  });

  it('applySlugChangeRedirects with localePrefixes also moves /<locale>/ paths', async () => {
    const { svc, rows } = withLocales([]);
    await svc.applySlugChangeRedirects(
      's1',
      [{ from: '/collections/rea', to: '/collections/kampanj' }],
      undefined,
      { localePrefixes: true },
    );
    expect(
      rows()
        .map((r) => `${r.from_path} -> ${r.to_path}`)
        .sort(),
    ).toEqual([
      '/ar/collections/rea -> /ar/collections/kampanj',
      '/collections/rea -> /collections/kampanj',
      '/en/collections/rea -> /en/collections/kampanj',
    ]);
  });
});

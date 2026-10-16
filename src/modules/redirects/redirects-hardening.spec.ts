import { ParseUUIDPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import type { ExecutionContext } from '@nestjs/common';
import { resolveRedirectChain } from './redirect-chain';
import {
  PROXY_KEY_HEADER,
  REDIRECTS_PUBLIC_LIMIT,
  isTrustedProxyKey,
  redirectsThrottleLimit,
} from './redirect-proxy-key';
import {
  REDIRECT_MAP_MAX_BYTES,
  REDIRECT_MAX_ROWS_PER_STORE,
  RedirectsService,
  redirectMapBytes,
  type RedirectTuple,
} from './redirects.service';
import { RedirectsCreatorController } from './redirects-creator.controller';
import type { PrismaService } from '../../prisma/prisma.service';

// M4.4 fixer B: proxy-key throttle bypass, map byte cap, per-store row cap,
// loop checks through query targets and fallback keys, UUID route params.

const KEY = 'k'.repeat(32);

function ctx(headers: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

describe('redirect proxy key', () => {
  const prev = process.env.REDIRECTS_PROXY_KEY;
  afterEach(() => {
    if (prev === undefined) delete process.env.REDIRECTS_PROXY_KEY;
    else process.env.REDIRECTS_PROXY_KEY = prev;
  });

  it('matches only the configured key', () => {
    expect(isTrustedProxyKey(KEY, KEY)).toBe(true);
    expect(isTrustedProxyKey([KEY], KEY)).toBe(true);
    expect(isTrustedProxyKey(KEY + 'x', KEY)).toBe(false);
    expect(isTrustedProxyKey('', KEY)).toBe(false);
    expect(isTrustedProxyKey(undefined, KEY)).toBe(false);
  });

  it('is off when the key is unset or too short', () => {
    expect(isTrustedProxyKey('', undefined)).toBe(false);
    expect(isTrustedProxyKey('short', 'short')).toBe(false);
  });

  it('lifts the per-IP limit only with the right header', () => {
    process.env.REDIRECTS_PROXY_KEY = KEY;
    expect(redirectsThrottleLimit(ctx({ [PROXY_KEY_HEADER]: KEY }))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(redirectsThrottleLimit(ctx({ [PROXY_KEY_HEADER]: 'nope' }))).toBe(
      REDIRECTS_PUBLIC_LIMIT,
    );
    expect(redirectsThrottleLimit(ctx({}))).toBe(REDIRECTS_PUBLIC_LIMIT);
    delete process.env.REDIRECTS_PROXY_KEY;
    expect(redirectsThrottleLimit(ctx({ [PROXY_KEY_HEADER]: KEY }))).toBe(
      REDIRECTS_PUBLIC_LIMIT,
    );
  });
});

describe('resolveRedirectChain loop checks', () => {
  it('finds a loop through a target with a query string', () => {
    const map = new Map([['/b', '/a']]);
    expect(resolveRedirectChain(map, '/a', '/b?x=1').ok).toBe(false);
  });

  it('keeps a query target verbatim when there is no loop', () => {
    const map = new Map([['/b', '/c']]);
    expect(resolveRedirectChain(map, '/a', '/b?x=1')).toEqual({
      ok: true,
      to: '/b?x=1',
    });
  });

  it('finds a loop through the fallback key (/x/feed → /x)', () => {
    expect(resolveRedirectChain(new Map(), '/shop', '/shop/feed').ok).toBe(
      false,
    );
    expect(resolveRedirectChain(new Map(), '/shop', '/shop/page/2').ok).toBe(
      false,
    );
    const map = new Map([['/b', '/a/amp']]);
    expect(resolveRedirectChain(map, '/a', '/b').ok).toBe(false);
  });

  it('does not flatten through a fallback-only match', () => {
    const map = new Map([['/b', '/c']]);
    expect(resolveRedirectChain(map, '/a', '/b/feed')).toEqual({
      ok: true,
      to: '/b/feed',
    });
  });

  it('an exact row wins over the fallback key', () => {
    // /shop/feed has its own row, so the request never falls back to /shop.
    const map = new Map([['/shop/feed', '/rss']]);
    expect(resolveRedirectChain(map, '/shop', '/shop/feed')).toEqual({
      ok: true,
      to: '/rss',
    });
  });
});

function svcWith(rows: { from_path: string; to_path: string }[]) {
  const storeRedirect = {
    aggregate: jest.fn(() =>
      Promise.resolve({
        _count: { _all: rows.length },
        _max: { updated_at: new Date(1000) },
      }),
    ),
    findMany: jest.fn(() =>
      Promise.resolve(rows.map((r) => ({ ...r, status_code: 301 }))),
    ),
    findUnique: jest.fn(() => Promise.resolve(null)),
    count: jest.fn(() => Promise.resolve(rows.length)),
    create: jest.fn(),
  };
  const prisma = {
    storeRedirect,
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) =>
      fn({ storeRedirect }),
    ),
  };
  return {
    svc: new RedirectsService(prisma as unknown as PrismaService),
    storeRedirect,
  };
}

describe('RedirectsService map size cap', () => {
  it('estimates the JSON size of the map', () => {
    const items: RedirectTuple[] = [
      ['/a', '/b', 301],
      ['/ö', '/c?x=1', 302],
    ];
    expect(redirectMapBytes(items)).toBe(
      Buffer.byteLength(JSON.stringify(items)),
    );
  });

  it('switches to lookup mode above 2 MB even under the row limit', async () => {
    const long = '/' + 'x'.repeat(1000);
    const rows = Array.from({ length: 2100 }, (_, i) => ({
      from_path: `${long}-${i}`,
      to_path: '/t',
    }));
    const { svc, storeRedirect } = svcWith(rows);
    const res = await svc.mapFor('s1');
    expect(res.mode).toBe('lookup');
    expect(res).not.toHaveProperty('items');
    // Cached: the second call does not reload the rows.
    expect((await svc.mapFor('s1')).mode).toBe('lookup');
    expect(storeRedirect.findMany).toHaveBeenCalledTimes(1);
    expect(
      redirectMapBytes(rows.map((r) => [r.from_path, r.to_path, 301])),
    ).toBeGreaterThan(REDIRECT_MAP_MAX_BYTES);
  });

  it('keeps map mode for a small map', async () => {
    const { svc } = svcWith([{ from_path: '/a', to_path: '/b' }]);
    const res = await svc.mapFor('s1');
    expect(res.mode).toBe('map');
    expect(typeof res.version).toBe('string');
    expect(res).toHaveProperty('items', [['/a', '/b', 301]]);
  });
});

describe('RedirectsService row cap', () => {
  it('refuses a manual redirect past 25 000 rows (REDIRECT_LIMIT)', async () => {
    const { svc, storeRedirect } = svcWith([]);
    storeRedirect.count.mockResolvedValue(REDIRECT_MAX_ROWS_PER_STORE);
    await expect(
      svc.create('s1', { from_path: '/a', to_path: '/b' }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'REDIRECT_LIMIT' },
    });
    expect(storeRedirect.create).not.toHaveBeenCalled();
  });
});

describe('RedirectsCreatorController :id routes', () => {
  it.each(['update', 'remove'])('%s parses :id with ParseUUIDPipe', (m) => {
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      RedirectsCreatorController,
      m,
    ) as Record<string, { data?: string; pipes?: unknown[] }>;
    const idArg = Object.values(args).find((a) => a.data === 'id');
    expect(idArg?.pipes).toContain(ParseUUIDPipe);
  });
});

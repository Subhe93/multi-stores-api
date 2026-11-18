import type { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from './revalidation.service';

// Provider products (decision D5): a base product change refreshes every
// store that resells it through a CustomProduct.

describe('RevalidationService: reselling stores of a base product', () => {
  function make(creators: string[], slugs: Record<string, string>) {
    const prisma = {
      customProduct: {
        findMany: jest.fn(() =>
          Promise.resolve(creators.map((creator_id) => ({ creator_id }))),
        ),
      },
      store: {
        findMany: jest.fn(
          ({ where }: { where: { creator_id: { in: string[] } } }) =>
            Promise.resolve(
              where.creator_id.in
                .filter((c) => slugs[c])
                .map((c) => ({ slug: slugs[c] })),
            ),
        ),
      },
    };
    const svc = new RevalidationService(prisma as unknown as PrismaService);
    const posted = jest
      .spyOn(svc, 'revalidateStoreBySlug')
      .mockResolvedValue(undefined);
    return { svc, prisma, posted };
  }

  it('revalidates each distinct reselling store once', async () => {
    const { svc, prisma, posted } = make(['c1', 'c2', 'c3'], {
      c1: 'noroj',
      c2: 'shop-two',
    });
    await svc.revalidateStoresByBaseProductId('base-1');
    expect(prisma.customProduct.findMany).toHaveBeenCalledWith({
      where: { product_id: 'base-1' },
      select: { creator_id: true },
      distinct: ['creator_id'],
    });
    expect(posted.mock.calls.map((c) => c[0]).sort()).toEqual([
      'noroj',
      'shop-two',
    ]);
  });

  it('does nothing for a product no store resells', async () => {
    const { svc, prisma, posted } = make([], {});
    await svc.revalidateStoresByBaseProductId('base-1');
    expect(prisma.store.findMany).not.toHaveBeenCalled();
    expect(posted).not.toHaveBeenCalled();
  });

  it('revalidateStoreSlugs dedupes and sends every slug', async () => {
    const { svc, posted } = make([], {});
    const slugs = Array.from({ length: 23 }, (_, i) => `s${i}`);
    await svc.revalidateStoreSlugs([...slugs, 's0']);
    expect(posted).toHaveBeenCalledTimes(23);
  });
});

// Delivery: fire-and-forget for the caller, debounced per slug, retried.

describe('RevalidationService delivery', () => {
  const env = { ...process.env };
  let fetchMock: jest.Mock<Promise<unknown>, [string, { body: string }]>;
  let warn: jest.SpyInstance;
  const warned = () => warn.mock.calls.map((c: unknown[]) => String(c[0]));

  const ok = () => Promise.resolve({ ok: true, status: 200, statusText: 'OK' });
  const bad = (status: number) =>
    Promise.resolve({ ok: false, status, statusText: 'ERR' });
  const posted = () =>
    fetchMock.mock.calls.map((c) => JSON.parse(c[1].body) as { slug?: string });

  function make(prisma: unknown = {}) {
    const svc = new RevalidationService(prisma as PrismaService);
    warn = jest
      .spyOn((svc as unknown as { logger: { warn(): void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    return svc;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.STOREFRONT_URL = 'http://web.test';
    process.env.REVALIDATE_SECRET = 's3cret';
    fetchMock = jest.fn(ok);
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env = { ...env };
  });

  it('returns before the POST is sent (does not block the caller)', async () => {
    const svc = make();
    await svc.revalidateStoreBySlug('namez');
    expect(fetchMock).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(300);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://web.test/api/revalidate');
    expect(posted()).toEqual([{ slug: 'namez' }]);
  });

  it('debounce: several calls for one slug are one POST', async () => {
    const svc = make();
    for (let i = 0; i < 50; i++) await svc.revalidateStoreBySlug('namez');
    await jest.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('debounce: two slugs are two POSTs', async () => {
    const svc = make();
    await svc.revalidateStoreBySlug('namez');
    await svc.revalidateStoreBySlug('noroj');
    await svc.revalidateStoreBySlug('namez');
    await jest.advanceTimersByTimeAsync(1000);
    expect(
      posted()
        .map((b) => b.slug)
        .sort(),
    ).toEqual(['namez', 'noroj']);
  });

  it('debounce: a steady stream of calls still sends within the max wait', async () => {
    const svc = make();
    for (let i = 0; i < 12; i++) {
      await svc.revalidateStoreBySlug('namez');
      await jest.advanceTimersByTimeAsync(200);
    }
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('a call after the POST went out sends again', async () => {
    const svc = make();
    await svc.revalidateStoreBySlug('namez');
    await jest.advanceTimersByTimeAsync(300);
    await svc.revalidateStoreBySlug('namez');
    await jest.advanceTimersByTimeAsync(300);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retry: fails twice, succeeds the third time, no warning', async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.reject(new Error('ECONNREFUSED')))
      .mockImplementationOnce(() => bad(503));
    const svc = make();
    await svc.revalidateStoreBySlug('namez');
    await jest.advanceTimersByTimeAsync(300);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it('retry: fails three times → one warning with slug and reason, no throw', async () => {
    fetchMock.mockImplementation(() =>
      Promise.reject(new Error('ECONNREFUSED')),
    );
    const svc = make();
    await expect(svc.revalidateStoreBySlug('namez')).resolves.toBeUndefined();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warned()[0]).toContain('store "namez"');
    expect(warned()[0]).toContain('ECONNREFUSED');
  });

  it('a 4xx answer (wrong secret) is final at once: one attempt, one warning', async () => {
    fetchMock.mockImplementation(() => bad(401));
    const svc = make();
    await svc.revalidateStoreBySlug('namez');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warned()[0]).toContain('401');
  });

  it('a failing lookup in the by-id helpers does not throw', async () => {
    const down = () => Promise.reject(new Error('db down'));
    const svc = make({
      store: { findUnique: jest.fn(down), findMany: jest.fn(down) },
      customProduct: { findMany: jest.fn(down) },
    });
    await expect(svc.revalidateStoreById('s1')).resolves.toBeUndefined();
    await expect(svc.revalidateStoreByCreatorId('c1')).resolves.toBeUndefined();
    await expect(
      svc.revalidateStoresByBaseProductId('p1'),
    ).resolves.toBeUndefined();
    await jest.advanceTimersByTimeAsync(1000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warned()[0]).toContain('db down');
  });

  it('by-id helper resolves the slug and sends it', async () => {
    const svc = make({
      store: { findUnique: jest.fn(() => Promise.resolve({ slug: 'namez' })) },
    });
    await svc.revalidateStoreById('s1');
    await jest.advanceTimersByTimeAsync(300);
    expect(posted()).toEqual([{ slug: 'namez' }]);
  });

  it('shutdown sends what is still waiting, once', async () => {
    const svc = make();
    await svc.revalidateStoreBySlug('namez');
    await svc.onModuleDestroy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

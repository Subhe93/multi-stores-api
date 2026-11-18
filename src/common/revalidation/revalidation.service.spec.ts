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
  const realFetch = global.fetch;
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
    fetchMock = jest.fn<Promise<unknown>, [string, { body: string }]>(ok);
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env = { ...env };
    global.fetch = realFetch;
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
    // 2.4 s of calls every 200 ms: exactly one POST, at the 2 s max wait.
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it('retry: every attempt fails → one warning with slug and reason, no throw', async () => {
    fetchMock.mockImplementation(() =>
      Promise.reject(new Error('ECONNREFUSED')),
    );
    const svc = make();
    await expect(svc.revalidateStoreBySlug('namez')).resolves.toBeUndefined();
    // Debounce, then attempts at once, +1 s and +5 s: three so far.
    await jest.advanceTimersByTimeAsync(300 + 1000 + 5000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalled();
    // The last attempt comes 30 s later (outlasts a storefront restart).
    await jest.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
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

  it('the answer body is released after every attempt', async () => {
    const cancel = jest.fn(() => Promise.resolve());
    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: true, status: 200, body: { cancel } }),
    );
    const svc = make();
    await svc.revalidateStoreBySlug('namez');
    await jest.advanceTimersByTimeAsync(300);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  // A storefront that does not answer: every POST stays in flight.
  const hang = () => new Promise<unknown>(() => undefined);

  it('at most 10 POSTs are in flight; the rest waits, one entry per slug', async () => {
    fetchMock.mockImplementation(hang);
    const svc = make();
    for (let i = 0; i < 14; i++) await svc.revalidateStoreBySlug(`s${i}`);
    await jest.advanceTimersByTimeAsync(300);
    expect(fetchMock).toHaveBeenCalledTimes(10);
    // s12 is called again twice while it waits for a slot: still one entry.
    await svc.revalidateStoreBySlug('s12');
    await jest.advanceTimersByTimeAsync(300);
    await svc.revalidateStoreBySlug('s12');
    await jest.advanceTimersByTimeAsync(300);
    expect(fetchMock).toHaveBeenCalledTimes(10);
    const queue = (svc as unknown as { queue: unknown[] }).queue;
    expect(queue).toHaveLength(4);
  });

  it('shutdown also sends the queued jobs and waits a bounded time for the rest', async () => {
    fetchMock.mockImplementation(hang);
    const svc = make();
    for (let i = 0; i < 14; i++) await svc.revalidateStoreBySlug(`s${i}`);
    await jest.advanceTimersByTimeAsync(300);
    // Inside the debounce window at shutdown.
    await svc.revalidateStoreBySlug('late');
    expect(fetchMock).toHaveBeenCalledTimes(10);

    let done = false;
    const closing = svc.onModuleDestroy().then(() => (done = true));
    await jest.advanceTimersByTimeAsync(0);
    // 10 in flight + 4 queued + 1 debounced: all were sent.
    expect(fetchMock).toHaveBeenCalledTimes(15);
    const expected = Array.from({ length: 14 }, (_, i) => `s${i}`);
    expect(
      posted()
        .map((b) => b.slug)
        .sort(),
    ).toEqual([...expected, 'late'].sort());
    expect(done).toBe(false);
    // Nothing answers: the hook gives up after its cap instead of hanging.
    await jest.advanceTimersByTimeAsync(5000);
    await closing;
    expect(done).toBe(true);
  });

  it('shutdown waits for a delivery that is between two attempts', async () => {
    fetchMock.mockImplementationOnce(() => bad(503));
    const svc = make();
    await svc.revalidateStoreBySlug('namez');
    await jest.advanceTimersByTimeAsync(300);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    let done = false;
    const closing = svc.onModuleDestroy().then(() => (done = true));
    await jest.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await closing;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a call after shutdown started is sent at once', async () => {
    const svc = make();
    await svc.onModuleDestroy();
    await svc.revalidateStoreBySlug('namez');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(posted()).toEqual([{ slug: 'namez' }]);
  });

  it('flush(): a script that exits right after still sends its revalidation', async () => {
    const svc = make();
    await svc.revalidateStoreBySlug('namez');
    expect(fetchMock).not.toHaveBeenCalled();
    await svc.flush();
    expect(posted()).toEqual([{ slug: 'namez' }]);
    // Nothing is left behind for a timer.
    await jest.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('revalidateStoreBySlugNow resolves after the POST and replaces a waiting send', async () => {
    const svc = make();
    await svc.revalidateStoreBySlug('namez');
    await svc.revalidateStoreBySlugNow('namez');
    expect(posted()).toEqual([{ slug: 'namez' }]);
    await jest.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('revalidateStoreBySlugNow: two attempts, then one warning, never rejects', async () => {
    fetchMock.mockImplementation(() => bad(502));
    const svc = make();
    let done = false;
    const sent = svc
      .revalidateStoreBySlugNow('namez')
      .then(() => (done = true));
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1000);
    await sent;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warned()[0]).toContain('502');
  });
});

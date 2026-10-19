import { MarketsContextService, MARKETS_CHANNEL } from './markets-context.service';

/** Cross-instance cache invalidation over pg_notify('markets', …). */
describe('MarketsContextService cache invalidation', () => {
  function make() {
    const executeRaw = jest.fn().mockResolvedValue(1);
    const prisma = { $executeRaw: executeRaw } as never;
    const fx = { onRatesChanged: jest.fn() } as never;
    const svc = new MarketsContextService(prisma, {} as never, fx);
    const cache = (svc as unknown as { cache: Map<string, unknown> }).cache;
    return { svc, cache, executeRaw };
  }

  it('invalidate drops the store locally and notifies other instances', () => {
    const { svc, cache, executeRaw } = make();
    cache.set('s1', {});
    cache.set('s2', {});
    svc.invalidate('s1');
    expect(cache.has('s1')).toBe(false);
    expect(cache.has('s2')).toBe(true);
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const values = executeRaw.mock.calls[0].slice(1);
    expect(values).toEqual([MARKETS_CHANNEL, 's1']);
  });

  it('invalidateAll clears everything and notifies with *', () => {
    const { svc, cache, executeRaw } = make();
    cache.set('s1', {});
    svc.invalidateAll();
    expect(cache.size).toBe(0);
    expect(executeRaw.mock.calls[0].slice(1)).toEqual([MARKETS_CHANNEL, '*']);
  });

  it('a notification from another instance drops locally without re-notifying', () => {
    const { svc, cache, executeRaw } = make();
    cache.set('s1', {});
    cache.set('s2', {});
    (svc as unknown as { dropLocal(p: string): void }).dropLocal('s2');
    expect([...cache.keys()]).toEqual(['s1']);
    (svc as unknown as { dropLocal(p: string): void }).dropLocal('*');
    expect(cache.size).toBe(0);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('a failing pg_notify never throws', async () => {
    const { svc, executeRaw } = make();
    executeRaw.mockRejectedValueOnce(new Error('down'));
    expect(() => svc.invalidate('s1')).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });
});

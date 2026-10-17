import {
  PgUploadQuotaStore,
  QUOTA_STORE_DEGRADED_MS,
  quotaKey,
  quotaWindowStart,
} from './upload-quota-store';

const DAY = 24 * 60 * 60 * 1000;

/** A fake `$queryRaw` that keeps (scope,key,window) → bytes in a Map. */
function fakePrisma(fail: { value: boolean } = { value: false }) {
  const rows = new Map<string, number>();
  const calls: string[] = [];
  const $queryRaw = jest.fn(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      calls.push(sql);
      if (fail.value) return Promise.reject(new Error('db down'));
      const [scope, key, window] = values as [string, string, Date];
      const id = `${scope}|${key}|${window.toISOString()}`;
      if (sql.includes('INSERT INTO')) {
        const n = Number(values[3]);
        rows.set(id, (rows.get(id) ?? 0) + n);
        return Promise.resolve([{ bytes: BigInt(rows.get(id) as number) }]);
      }
      const bytes = rows.get(id);
      return Promise.resolve(
        bytes === undefined ? [] : [{ bytes: BigInt(bytes) }],
      );
    },
  );
  return { $queryRaw, rows, calls };
}

describe('quotaWindowStart / quotaKey', () => {
  it('buckets by UTC day', () => {
    const t = Date.UTC(2026, 9, 17, 23, 59, 59);
    expect(quotaWindowStart(t).toISOString()).toBe('2026-10-17T00:00:00.000Z');
    expect(quotaWindowStart(t + 1000).toISOString()).toBe(
      '2026-10-18T00:00:00.000Z',
    );
  });
  it('hashes keys so no raw IP is stored', () => {
    expect(quotaKey('198.51.100.1')).toMatch(/^[0-9a-f]{64}$/);
    expect(quotaKey('a')).not.toBe(quotaKey('b'));
  });
});

describe('PgUploadQuotaStore', () => {
  it('is unavailable without $queryRaw (unit-test fakes) and answers null', async () => {
    const store = new PgUploadQuotaStore({} as never);
    expect(store.available()).toBe(false);
    expect(await store.used('customer.ip', 'x')).toBeNull();
    expect(await store.add('customer.ip', 'x', 10)).toBeNull();
  });

  it('reads 0 for an unknown key, adds atomically and returns the total', async () => {
    let now = Date.UTC(2026, 9, 17, 10, 0, 0);
    const prisma = fakePrisma();
    const store = new PgUploadQuotaStore(prisma, () => now);
    expect(await store.used('designer.ip', 'ip1')).toBe(0);
    expect(await store.add('designer.ip', 'ip1', 80)).toBe(80);
    expect(await store.add('designer.ip', 'ip1', 20)).toBe(100);
    expect(await store.used('designer.ip', 'ip1')).toBe(100);
    // Scopes and keys are independent.
    expect(await store.used('designer.store', 'ip1')).toBe(0);
    expect(await store.used('designer.ip', 'ip2')).toBe(0);
    // A new UTC day starts a new window.
    now += DAY;
    expect(await store.used('designer.ip', 'ip1')).toBe(0);
    expect(prisma.calls.some((c) => c.includes('ON CONFLICT'))).toBe(true);
    // The stored key is the hash, never the raw value.
    expect([...prisma.rows.keys()].some((k) => k.includes('|ip1|'))).toBe(
      false,
    );
  });

  it('a non-positive add only reads', async () => {
    const prisma = fakePrisma();
    const store = new PgUploadQuotaStore(prisma, () => 0);
    expect(await store.add('customer.ip', 'k', 0)).toBe(0);
    expect(prisma.calls.every((c) => !c.includes('INSERT'))).toBe(true);
  });

  it('degrades to null for 30 s after a failure, then recovers', async () => {
    let now = 1_000_000;
    const fail = { value: true };
    const prisma = fakePrisma(fail);
    const store = new PgUploadQuotaStore(prisma, () => now);
    expect(await store.add('customer.ip', 'k', 5)).toBeNull();
    expect(store.available()).toBe(false);
    fail.value = false;
    // Still degraded: no query is sent.
    const before = prisma.$queryRaw.mock.calls.length;
    expect(await store.used('customer.ip', 'k')).toBeNull();
    expect(prisma.$queryRaw.mock.calls.length).toBe(before);
    now += QUOTA_STORE_DEGRADED_MS;
    expect(store.available()).toBe(true);
    expect(await store.used('customer.ip', 'k')).toBe(0);
  });
});

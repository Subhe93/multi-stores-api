import { MagicLinkService, hashLoginToken } from './magic-link.service';
import type { PrismaService } from '../../prisma/prisma.service';

type Row = {
  user_id: string;
  token_hash: string;
  purpose: string;
  store_id: string | null;
  expires_at: Date;
  used_at: Date | null;
};

/**
 * In-memory LoginToken table that honours the exact where-clauses the
 * service uses, so single use and expiry are exercised for real.
 */
function build(users: Record<string, { id: string; status: string }>) {
  const rows: Row[] = [];
  const matches = (r: Row, where: Record<string, unknown>) => {
    if (where.user_id !== undefined && r.user_id !== where.user_id)
      return false;
    if (where.token_hash !== undefined && r.token_hash !== where.token_hash)
      return false;
    if (where.purpose !== undefined && r.purpose !== where.purpose)
      return false;
    if (where.used_at === null && r.used_at !== null) return false;
    const exp = where.expires_at as { gt?: Date } | undefined;
    if (exp?.gt && !(r.expires_at > exp.gt)) return false;
    return true;
  };
  const prisma = {
    loginToken: {
      create: jest.fn(({ data }: { data: Row }) => {
        rows.push({ ...data, used_at: null });
        return Promise.resolve(data);
      }),
      deleteMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          const r = rows[i];
          if (r.user_id !== where.user_id) continue;
          const or = where.OR as unknown[] | undefined;
          if (or) {
            const dead = r.expires_at < new Date() || r.used_at !== null;
            if (!dead) continue;
          }
          rows.splice(i, 1);
        }
        return Promise.resolve({ count: before - rows.length });
      }),
      updateMany: jest.fn(
        ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: { used_at: Date };
        }) => {
          const hit = rows.filter((r) => matches(r, where));
          hit.forEach((r) => (r.used_at = data.used_at));
          return Promise.resolve({ count: hit.length });
        },
      ),
      findUnique: jest.fn(({ where }: { where: { token_hash: string } }) => {
        const r = rows.find((x) => x.token_hash === where.token_hash);
        return Promise.resolve(r ? { user: users[r.user_id] ?? null } : null);
      }),
    },
  };
  const service = new MagicLinkService(prisma as unknown as PrismaService);
  return { service, prisma, rows };
}

describe('MagicLinkService', () => {
  const users = {
    u1: { id: 'u1', status: 'ACTIVE' },
    u2: { id: 'u2', status: 'SUSPENDED' },
  };

  it('issues a URL-safe 32-byte token and stores only its sha256', async () => {
    const { service, rows } = build(users);
    const raw = await service.issue('u1', { storeId: 's1' });
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(hashLoginToken(raw));
    expect(rows[0].token_hash).not.toContain(raw);
    expect(rows[0].store_id).toBe('s1');
    expect(rows[0].purpose).toBe('MAGIC_LOGIN');
  });

  it('defaults to a 72-hour lifetime', async () => {
    const { service, rows } = build(users);
    const before = Date.now();
    await service.issue('u1');
    const ttl = rows[0].expires_at.getTime() - before;
    expect(ttl).toBeGreaterThan(72 * 3600_000 - 5_000);
    expect(ttl).toBeLessThanOrEqual(72 * 3600_000 + 5_000);
  });

  it('consumes a valid token exactly once', async () => {
    const { service } = build(users);
    const raw = await service.issue('u1');
    await expect(service.consume(raw)).resolves.toMatchObject({ id: 'u1' });
    await expect(service.consume(raw)).resolves.toBeNull();
  });

  it('rejects an expired token', async () => {
    const { service, rows } = build(users);
    const raw = await service.issue('u1');
    rows[0].expires_at = new Date(Date.now() - 1000);
    await expect(service.consume(raw)).resolves.toBeNull();
  });

  it('rejects unknown and malformed tokens without a lookup for the malformed', async () => {
    const { service, prisma } = build(users);
    await expect(service.consume('A'.repeat(43))).resolves.toBeNull();
    expect(prisma.loginToken.updateMany).toHaveBeenCalledTimes(1);
    await expect(service.consume('short')).resolves.toBeNull();
    await expect(service.consume('x'.repeat(500))).resolves.toBeNull();
    await expect(service.consume('bad token!*'.repeat(3))).resolves.toBeNull();
    await expect(service.consume(undefined)).resolves.toBeNull();
    expect(prisma.loginToken.updateMany).toHaveBeenCalledTimes(1);
  });

  it('rejects tokens of inactive accounts', async () => {
    const { service } = build(users);
    const raw = await service.issue('u2');
    await expect(service.consume(raw)).resolves.toBeNull();
  });

  it('invalidateForUser kills every outstanding token of that user only', async () => {
    const { service, rows } = build(users);
    const a = await service.issue('u1');
    const b = await service.issue('u1');
    const other = await service.issue('u2');
    await service.invalidateForUser('u1');
    await expect(service.consume(a)).resolves.toBeNull();
    await expect(service.consume(b)).resolves.toBeNull();
    expect(rows.map((r) => r.token_hash)).toEqual([hashLoginToken(other)]);
  });

  it('issue() cleans up the user own expired and used rows', async () => {
    const { service, rows } = build(users);
    const used = await service.issue('u1');
    await service.consume(used);
    await service.issue('u1');
    rows[0].expires_at = new Date(Date.now() - 1000);
    await service.issue('u1');
    expect(rows).toHaveLength(1);
  });
});

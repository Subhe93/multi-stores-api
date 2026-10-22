import { ConfigService } from '@nestjs/config';
import { DomainsService, type DnsResolver } from './domains.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { MarketsContextService } from './markets-context.service';

// Hostnames are the one thing in the markets app that can collide with the
// platform or with another store, so add/verify are checked against an
// in-memory StoreDomain table and a fake DNS.

type Row = {
  id: string;
  store_id: string;
  market_id: string;
  hostname: string;
  is_primary: boolean;
  redirect_to: string | null;
  status: 'PENDING' | 'VERIFIED' | 'ACTIVE';
  verified_at: Date | null;
  last_observed: unknown;
  created_at: Date;
};

const STORE_ID = 's1';
const MARKET_ID = 'm-se';

function makePrisma(seed: Partial<Row>[], legacyDomains: string[] = []) {
  let n = 0;
  const rows: Row[] = seed.map((r) => ({
    id: r.id ?? `d${++n}`,
    store_id: r.store_id ?? STORE_ID,
    market_id: r.market_id ?? MARKET_ID,
    hostname: r.hostname as string,
    is_primary: r.is_primary ?? false,
    redirect_to: r.redirect_to ?? null,
    status: r.status ?? 'PENDING',
    verified_at: r.verified_at ?? null,
    last_observed: r.last_observed ?? null,
    created_at: new Date(),
  }));
  const match = (row: Row, where: Partial<Row>) =>
    Object.entries(where).every(([k, v]) => row[k as keyof Row] === v);
  const storeDomain = {
    findUnique: jest.fn(
      ({ where }: { where: { hostname?: string; id?: string } }) =>
        Promise.resolve(
          rows.find((r) =>
            where.hostname ? r.hostname === where.hostname : r.id === where.id,
          ) ?? null,
        ),
    ),
    findFirst: jest.fn(({ where }: { where: Partial<Row> }) =>
      Promise.resolve(rows.find((r) => match(r, where)) ?? null),
    ),
    findMany: jest.fn(({ where }: { where: Partial<Row> }) =>
      Promise.resolve(rows.filter((r) => match(r, where))),
    ),
    count: jest.fn(({ where }: { where: Partial<Row> }) =>
      Promise.resolve(rows.filter((r) => match(r, where)).length),
    ),
    create: jest.fn(({ data }: { data: Partial<Row> }) => {
      const row: Row = {
        id: `d${++n}`,
        store_id: data.store_id as string,
        market_id: data.market_id as string,
        hostname: data.hostname as string,
        is_primary: data.is_primary ?? false,
        redirect_to: data.redirect_to ?? null,
        status: 'PENDING',
        verified_at: null,
        last_observed: null,
        created_at: new Date(),
      };
      rows.push(row);
      return Promise.resolve(row);
    }),
    update: jest.fn(
      ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return Promise.resolve({ ...row });
      },
    ),
    updateMany: jest.fn(
      ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
        rows
          .filter((r) => match(r, where))
          .forEach((r) => Object.assign(r, data));
        return Promise.resolve({ count: 1 });
      },
    ),
    delete: jest.fn(({ where }: { where: { id: string } }) => {
      const i = rows.findIndex((r) => r.id === where.id);
      rows.splice(i, 1);
      return Promise.resolve({});
    }),
  };
  const store = {
    findFirst: jest.fn(
      ({ where }: { where: { custom_domain: { equals: string } } }) =>
        Promise.resolve(
          legacyDomains.includes(where.custom_domain.equals)
            ? { id: 'x' }
            : null,
        ),
    ),
    findUnique: jest.fn(() => Promise.resolve({ id: STORE_ID, slug: 'namez-se' })),
  };
  return {
    rows,
    storeDomain,
    store,
    market: {
      findUnique: jest.fn(() =>
        Promise.resolve({ status: 'LIVE', is_default: false }),
      ),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
}

function build(
  seed: Partial<Row>[],
  opts: {
    legacy?: string[];
    dns?: Partial<DnsResolver>;
    httpVerify?: string;
    target?: string | null;
  } = {},
) {
  const prisma = makePrisma(seed, opts.legacy);
  const config = {
    get: (key: string) => {
      if (key === 'CUSTOM_DOMAIN_CNAME_TARGET') {
        return opts.target === null
          ? undefined
          : (opts.target ?? 'stores.platform.test');
      }
      // Keep the DNS timeout short for the hanging-resolver case.
      if (key === 'CUSTOM_DOMAIN_DNS_TIMEOUT_MS') return '30';
      if (key === 'CUSTOM_DOMAIN_HTTP_VERIFY') return opts.httpVerify;
      if (key === 'STOREFRONT_URL') return 'https://iwings-digital.com';
      return undefined;
    },
  };
  const revalidation = {
    revalidateStoreById: jest.fn(() => Promise.resolve()),
  };
  const markets = { invalidate: jest.fn() };
  const resolver: DnsResolver = {
    resolveCname:
      opts.dns?.resolveCname ?? (() => Promise.reject(new Error('ENODATA'))),
    resolve4:
      opts.dns?.resolve4 ?? (() => Promise.reject(new Error('ENODATA'))),
    probe: opts.dns?.probe ?? (() => Promise.resolve(null)),
  };
  const service = new DomainsService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
    revalidation as unknown as RevalidationService,
    markets as unknown as MarketsContextService,
    resolver,
  );
  return { service, prisma, revalidation, markets };
}

describe('DomainsService.add', () => {
  it('refuses a platform (reserved) host and its subdomains', async () => {
    const { service } = build([]);
    await expect(
      service.add(STORE_ID, MARKET_ID, {
        hostname: 'admin.iwings-digital.com',
      }),
    ).rejects.toMatchObject({ response: { code: 'MARKET_DOMAIN_RESERVED' } });
    await expect(
      service.add(STORE_ID, MARKET_ID, { hostname: 'Localhost' }),
    ).rejects.toMatchObject({ response: { code: 'MARKET_DOMAIN_INVALID' } });
  });

  it('refuses a host taken by another StoreDomain row or a legacy custom_domain', async () => {
    const { service } = build([{ hostname: 'namez.se', store_id: 'other' }], {
      legacy: ['old-shop.com'],
    });
    await expect(
      service.add(STORE_ID, MARKET_ID, { hostname: 'NAMEZ.se' }),
    ).rejects.toMatchObject({ response: { code: 'MARKET_DOMAIN_TAKEN' } });
    await expect(
      service.add(STORE_ID, MARKET_ID, { hostname: 'old-shop.com' }),
    ).rejects.toMatchObject({ response: { code: 'MARKET_DOMAIN_TAKEN' } });
  });

  it('normalises the host, makes the first one primary and starts PENDING', async () => {
    const { service, markets, revalidation } = build([]);
    const view = await service.add(STORE_ID, MARKET_ID, {
      hostname: ' Namez.SE:443 ',
    });
    expect(view).toMatchObject({
      hostname: 'namez.se',
      is_primary: true,
      status: 'PENDING',
      redirect_to: null,
      dns: { expected_cname: 'stores.platform.test', observed: null },
    });
    expect(markets.invalidate).toHaveBeenCalledWith(STORE_ID);
    expect(revalidation.revalidateStoreById).toHaveBeenCalledWith(STORE_ID);
  });

  it('redirect_to must point at a non-redirecting host of the same market', async () => {
    const { service } = build([
      { hostname: 'namez.se', is_primary: true },
      { hostname: 'namez.shop', market_id: 'm-eu' },
    ]);
    await expect(
      service.add(STORE_ID, MARKET_ID, {
        hostname: 'www.namez.se',
        redirect_to: 'namez.shop',
      }),
    ).rejects.toMatchObject({
      response: { code: 'MARKET_DOMAIN_REDIRECT_INVALID' },
    });
    const www = await service.add(STORE_ID, MARKET_ID, {
      hostname: 'www.namez.se',
      redirect_to: 'namez.se',
    });
    expect(www).toMatchObject({ redirect_to: 'namez.se', is_primary: false });
  });
});

describe('DomainsService.verify', () => {
  it('ACTIVE when the CNAME points at the platform target', async () => {
    const { service } = build([{ id: 'd1', hostname: 'namez.se' }], {
      dns: { resolveCname: () => Promise.resolve(['Stores.Platform.Test.']) },
    });
    const view = await service.verify(STORE_ID, MARKET_ID, 'd1');
    expect(view.status).toBe('ACTIVE');
    expect(view.verified_at).not.toBeNull();
    expect(view.dns.observed).toEqual(['Stores.Platform.Test.']);
  });

  it('keeps ACTIVE on re-verify and fails with what was observed otherwise', async () => {
    const { service } = build(
      [
        { id: 'd1', hostname: 'namez.se', status: 'ACTIVE' },
        { id: 'd2', hostname: 'namez.shop' },
      ],
      {
        dns: {
          resolveCname: (host) =>
            host === 'namez.se'
              ? Promise.resolve(['stores.platform.test'])
              : Promise.reject(new Error('ENODATA')),
          resolve4: () => Promise.resolve(['198.51.100.7']),
        },
      },
    );
    expect((await service.verify(STORE_ID, MARKET_ID, 'd1')).status).toBe(
      'ACTIVE',
    );
    await expect(
      service.verify(STORE_ID, MARKET_ID, 'd2'),
    ).rejects.toMatchObject({
      response: {
        code: 'MARKET_DOMAIN_VERIFY_FAILED',
        observed: ['198.51.100.7'],
      },
    });
  });

  it('404s a domain of another market', async () => {
    const { service } = build([
      { id: 'd1', hostname: 'namez.se', market_id: 'm-eu' },
    ]);
    await expect(
      service.verify(STORE_ID, MARKET_ID, 'd1'),
    ).rejects.toMatchObject({
      response: { code: 'MARKET_DOMAIN_NOT_FOUND' },
    });
  });
});

describe('DomainsService DNS target and observed records', () => {
  it('answers {cname: null} and a null expected_cname until ops configure a target', async () => {
    const { service } = build([{ id: 'd1', hostname: 'namez.se' }], {
      target: null,
    });
    expect(service.dnsTarget()).toEqual({ cname: null });
    expect(service.dnsTarget('namez-se')).toEqual({
      cname: 'namez-se.iwings-digital.com',
    });
    const [view] = await service.listForMarket(MARKET_ID);
    expect(view.dns).toEqual({
      expected_cname: 'namez-se.iwings-digital.com',
      observed: null,
    });
    // The resolver answers nothing: verify fails and reports what it saw.
    await expect(
      service.verify(STORE_ID, MARKET_ID, 'd1'),
    ).rejects.toMatchObject({
      response: { code: 'MARKET_DOMAIN_VERIFY_FAILED', observed: [] },
    });
  });

  it('a failed verify persists the observed records for later views', async () => {
    const { service, prisma } = build([{ id: 'd1', hostname: 'namez.se' }], {
      dns: {
        resolveCname: () => Promise.resolve(['elsewhere.example.net']),
        resolve4: () => Promise.resolve(['198.51.100.7']),
      },
    });
    await expect(
      service.verify(STORE_ID, MARKET_ID, 'd1'),
    ).rejects.toMatchObject({
      response: {
        code: 'MARKET_DOMAIN_VERIFY_FAILED',
        observed: ['elsewhere.example.net', '198.51.100.7'],
      },
    });
    expect(prisma.rows[0].last_observed).toEqual([
      'elsewhere.example.net',
      '198.51.100.7',
    ]);
    expect(prisma.rows[0].status).toBe('PENDING');
    const [view] = await service.listForMarket(MARKET_ID);
    expect(view.dns.observed).toEqual([
      'elsewhere.example.net',
      '198.51.100.7',
    ]);
  });
});

describe('DomainsService.remove', () => {
  it('refuses the canonical host of a LIVE non-default market', async () => {
    const { service, prisma } = build([
      { id: 'd1', hostname: 'namez.se', is_primary: true, status: 'ACTIVE' },
      {
        id: 'd2',
        hostname: 'www.namez.se',
        status: 'ACTIVE',
        redirect_to: 'namez.se',
      },
    ]);
    await expect(
      service.remove(STORE_ID, MARKET_ID, 'd1'),
    ).rejects.toMatchObject({
      response: { code: 'MARKET_DOMAIN_IN_USE' },
    });
    // A redirecting host, or any host of a draft / default market, can go.
    expect(await service.remove(STORE_ID, MARKET_ID, 'd2')).toEqual({
      deleted: true,
    });
    prisma.market.findUnique.mockResolvedValueOnce({
      status: 'DRAFT',
      is_default: false,
    });
    expect(await service.remove(STORE_ID, MARKET_ID, 'd1')).toEqual({
      deleted: true,
    });
  });
});

describe('DomainsService.verify timeout', () => {
  it('a hanging resolver counts as nothing observed (verify fails, no hang)', async () => {
    const { service } = build([{ id: 'd1', hostname: 'namez.se' }], {
      dns: {
        resolveCname: () => new Promise<string[]>(() => undefined),
        resolve4: () => new Promise<string[]>(() => undefined),
      },
    });
    await expect(
      service.verify(STORE_ID, MARKET_ID, 'd1'),
    ).rejects.toMatchObject({
      response: { code: 'MARKET_DOMAIN_VERIFY_FAILED', observed: [] },
    });
  });
});

describe('DomainsService admin status', () => {
  it('sets ACTIVE and stamps verified_at when missing', async () => {
    const { service, markets } = build([{ id: 'd1', hostname: 'namez.se' }]);
    const view = await service.adminSetStatus('d1', 'ACTIVE');
    expect(view.status).toBe('ACTIVE');
    expect(view.verified_at).not.toBeNull();
    expect(markets.invalidate).toHaveBeenCalledWith(STORE_ID);
  });
});

describe('DomainsService.verify behind a proxy (HTTP probe)', () => {
  it('ACTIVE when DNS points at the proxy but the host answers the probe', async () => {
    const { service } = build([{ id: 'd1', hostname: 'namez.shop' }], {
      dns: {
        resolve4: () => Promise.resolve(['104.21.1.1']),
        probe: (host) => Promise.resolve(host),
      },
    });
    const view = await service.verify(STORE_ID, MARKET_ID, 'd1');
    expect(view.status).toBe('ACTIVE');
    expect(view.dns.observed).toEqual(['104.21.1.1', 'http:namez.shop']);
  });

  it('fails when the probe answers for another host, hangs, or is disabled', async () => {
    const other = build([{ id: 'd1', hostname: 'namez.shop' }], {
      dns: { probe: () => Promise.resolve('resumely.net') },
    });
    await expect(
      other.service.verify(STORE_ID, MARKET_ID, 'd1'),
    ).rejects.toMatchObject({
      response: { code: 'MARKET_DOMAIN_VERIFY_FAILED' },
    });

    const hanging = build([{ id: 'd1', hostname: 'namez.shop' }], {
      dns: { probe: () => new Promise(() => undefined) },
    });
    await expect(
      hanging.service.verify(STORE_ID, MARKET_ID, 'd1'),
    ).rejects.toMatchObject({
      response: { code: 'MARKET_DOMAIN_VERIFY_FAILED' },
    });

    const off = build([{ id: 'd1', hostname: 'namez.shop' }], {
      dns: { probe: (host) => Promise.resolve(host) },
      httpVerify: 'off',
    });
    await expect(
      off.service.verify(STORE_ID, MARKET_ID, 'd1'),
    ).rejects.toMatchObject({
      response: { code: 'MARKET_DOMAIN_VERIFY_FAILED' },
    });
  });
});

describe('DomainsService.verify against the store platform hostname', () => {
  it('ACTIVE when the CNAME points at <slug>.<storefront host> (no override set)', async () => {
    const { service } = build([{ id: 'd1', hostname: 'namez.shop' }], {
      target: null,
      dns: { resolveCname: () => Promise.resolve(['namez-se.iwings-digital.com']) },
    });
    const view = await service.verify(STORE_ID, MARKET_ID, 'd1');
    expect(view.status).toBe('ACTIVE');
    expect(view.dns.expected_cname).toBe('namez-se.iwings-digital.com');
  });

  it("another store's platform hostname does not verify", async () => {
    const { service } = build([{ id: 'd1', hostname: 'namez.shop' }], {
      target: null,
      dns: { resolveCname: () => Promise.resolve(['other.iwings-digital.com']) },
    });
    await expect(
      service.verify(STORE_ID, MARKET_ID, 'd1'),
    ).rejects.toMatchObject({ response: { code: 'MARKET_DOMAIN_VERIFY_FAILED' } });
  });
});

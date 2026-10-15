import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { ViesService, VIES_MAX_CONCURRENT, maskVat } from './vies.service';
import { MockViesHttpClient } from './vies.mock';
import type { ViesHttpClient, ViesHttpResponse } from './vies.types';

// ViesService with an injected fake transport and an in-memory
// VatNumberCheck table. No network.

type Row = {
  id: string;
  vat_number: string;
  country_code: string;
  status: 'VALID' | 'INVALID' | 'UNAVAILABLE';
  error_code: string | null;
  name: string | null;
  address: string | null;
  request_identifier: string | null;
  requester: string | null;
  request_date: Date | null;
  checked_at: Date;
  store_id: string | null;
  source: string;
  mode: string;
};

function makePrisma(opts: { failWrite?: boolean; profileVat?: string } = {}) {
  const rows: Row[] = [];
  let seq = 0;
  const prisma = {
    rows,
    vatNumberCheck: {
      create: jest.fn(({ data }: { data: Omit<Row, 'id'> }) => {
        if (opts.failWrite) return Promise.reject(new Error('db down'));
        seq += 1;
        const row = { id: `chk-${seq}`, ...data } as Row;
        rows.push(row);
        return Promise.resolve({ id: row.id });
      }),
      findFirst: jest.fn(
        ({
          where,
        }: {
          where: {
            vat_number: string;
            store_id: string | null;
            requester: string | null;
            mode: string;
            checked_at: { gt: Date };
          };
        }) => {
          const hit = rows
            .filter(
              (r) =>
                r.vat_number === where.vat_number &&
                r.store_id === where.store_id &&
                r.requester === where.requester &&
                r.mode === where.mode &&
                r.status !== 'UNAVAILABLE' &&
                r.checked_at > where.checked_at.gt,
            )
            .sort((a, b) => b.checked_at.getTime() - a.checked_at.getTime())[0];
          return Promise.resolve(hit ?? null);
        },
      ),
    },
    storeLegalProfile: {
      findUnique: jest.fn(() =>
        Promise.resolve(
          opts.profileVat ? { vat_number: opts.profileVat } : null,
        ),
      ),
    },
  };
  return prisma;
}

function config(values: Record<string, string> = {}): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

function okBody(valid: boolean, extra: Record<string, unknown> = {}) {
  return {
    countryCode: 'DE',
    vatNumber: '123456789',
    requestDate: '2026-10-15T09:12:00.000Z',
    valid,
    requestIdentifier: '',
    name: valid ? 'Muster GmbH' : '---',
    address: valid ? 'Musterstr. 1' : '---',
    ...extra,
  };
}

function envelope(code: string) {
  return { actionSucceed: false, errorWrappers: [{ error: code }] };
}

function fakeClient(
  impl: (body: Record<string, unknown>) => Promise<ViesHttpResponse>,
) {
  const post = jest.fn((_url: string, body: unknown) =>
    impl(body as Record<string, unknown>),
  );
  return { client: { post } as ViesHttpClient, post };
}

const ok = (json: unknown): Promise<ViesHttpResponse> =>
  Promise.resolve({ status: 200, json });

function build(
  impl: (body: Record<string, unknown>) => Promise<ViesHttpResponse>,
  opts: { env?: Record<string, string>; failWrite?: boolean } = {},
) {
  const prisma = makePrisma({ failWrite: opts.failWrite });
  const { client, post } = fakeClient(impl);
  const service = new ViesService(
    prisma as unknown as PrismaService,
    config(opts.env),
    client,
  );
  return { service, prisma, post };
}

const LIVE = { source: 'order' as const, mode: 'live' as const, storeId: 's1' };

describe('ViesService.check', () => {
  afterEach(() => jest.useRealTimers());

  it('valid with requester: consultation number stored and returned', async () => {
    const { service, prisma, post } = build(() =>
      ok(okBody(true, { requestIdentifier: 'WAPIAAAA-1' })),
    );
    const e = await service.check('DE 123 456 789', {
      ...LIVE,
      requester: 'SE556036079301',
    });
    expect(e).toMatchObject({
      source: 'VIES',
      vat_number: 'DE123456789',
      country_code: 'DE',
      status: 'valid',
      valid: true,
      name: 'Muster GmbH',
      request_identifier: 'WAPIAAAA-1',
      requester: 'SE556036079301',
      check_id: 'chk-1',
    });
    expect(post.mock.calls[0][1]).toEqual({
      countryCode: 'DE',
      vatNumber: '123456789',
      requesterMemberStateCode: 'SE',
      requesterNumber: '556036079301',
    });
    expect(prisma.rows[0]).toMatchObject({
      status: 'VALID',
      request_identifier: 'WAPIAAAA-1',
      source: 'order',
      store_id: 's1',
    });
  });

  it('valid without requester: "" identifier becomes null', async () => {
    const { service } = build(() => ok(okBody(true)));
    const e = await service.check('DE123456789', LIVE);
    expect(e.request_identifier).toBeNull();
    expect(e.requester).toBeNull();
  });

  it('valid:false and INVALID_INPUT are invalid', async () => {
    const a = build(() => ok(okBody(false)));
    expect((await a.service.check('DE123456789', LIVE)).status).toBe('invalid');
    const b = build(() => ok(envelope('INVALID_INPUT')));
    const e = await b.service.check('DE123456789', LIVE);
    expect(e).toMatchObject({ status: 'invalid', error_code: 'INVALID_INPUT' });
  });

  it.each([
    'MS_UNAVAILABLE',
    'TIMEOUT',
    'SERVICE_UNAVAILABLE',
    'GLOBAL_MAX_CONCURRENT_REQ',
    'MS_MAX_CONCURRENT_REQ',
  ])('HTTP-200 %s envelope is unavailable', async (code) => {
    const { service, prisma } = build(() => ok(envelope(code)));
    const e = await service.check('DE123456789', LIVE);
    expect(e).toMatchObject({ status: 'unavailable', error_code: code });
    expect(prisma.rows[0].status).toBe('UNAVAILABLE');
  });

  it('HTTP 500 / network error are unavailable', async () => {
    const a = build(() => Promise.resolve({ status: 500, json: null }));
    expect(await a.service.check('DE123456789', LIVE)).toMatchObject({
      status: 'unavailable',
      error_code: 'HTTP_500',
    });
    const b = build(() => Promise.reject(new TypeError('fetch failed')));
    expect(await b.service.check('DE123456789', LIVE)).toMatchObject({
      status: 'unavailable',
      error_code: 'NETWORK_ERROR',
    });
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const c = build(() => Promise.reject(abort));
    expect((await c.service.check('DE123456789', LIVE)).error_code).toBe(
      'TIMEOUT',
    );
  });

  it('a hanging call is cut after 4 s (fake timers)', async () => {
    jest.useFakeTimers();
    const { service } = build(() => new Promise<ViesHttpResponse>(() => {}));
    const pending = service.check('DE123456789', LIVE);
    await jest.advanceTimersByTimeAsync(3999);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({
      status: 'unavailable',
      error_code: 'TIMEOUT',
    });
  });

  it('INVALID_REQUESTER_INFO retries once without the requester', async () => {
    const { service, post } = build((body) =>
      ok(
        body.requesterNumber
          ? envelope('INVALID_REQUESTER_INFO')
          : okBody(true),
      ),
    );
    const e = await service.check('DE123456789', {
      ...LIVE,
      requester: 'SE556036079301',
    });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1]).not.toHaveProperty('requesterNumber');
    expect(e).toMatchObject({ status: 'valid', requester: null });
  });

  it('GR numbers are sent as EL; XI is accepted', async () => {
    const { service, post } = build(() => ok(okBody(true)));
    const gr = await service.check('GR123456789', LIVE);
    expect(post.mock.calls[0][1]).toMatchObject({ countryCode: 'EL' });
    expect(gr).toMatchObject({ vat_number: 'EL123456789', country_code: 'EL' });
    await service.check('XI123456789', LIVE);
    expect(post.mock.calls[1][1]).toMatchObject({ countryCode: 'XI' });
  });

  it('non-EU and malformed numbers never reach VIES', async () => {
    const { service, post } = build(() => ok(okBody(true)));
    expect((await service.check('NO123456789MVA', LIVE)).status).toBe('not_eu');
    expect((await service.check('CHE123456789', LIVE)).status).toBe('not_eu');
    expect((await service.check('DE12', LIVE)).status).toBe('format_invalid');
    expect((await service.check('', LIVE)).status).toBe('format_invalid');
    expect(post).not.toHaveBeenCalled();
  });

  it('VALID is cached 24 h (L1), then checked live again', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-10-15T10:00:00Z') });
    const { service, post } = build(() => ok(okBody(true)));
    await service.check('DE123456789', LIVE);
    await jest.advanceTimersByTimeAsync(23 * 3_600_000);
    expect((await service.check('DE123456789', LIVE)).status).toBe('valid');
    expect(post).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2 * 3_600_000);
    await service.check('DE123456789', LIVE);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('the VatNumberCheck log is the L2 cache (survives a restart)', async () => {
    const { service, prisma, post } = build(() => ok(okBody(true)));
    await service.check('DE123456789', LIVE);
    const restarted = new ViesService(
      prisma as unknown as PrismaService,
      config(),
      { post } as ViesHttpClient,
    );
    const e = await restarted.check('DE123456789', {
      ...LIVE,
      mode: 'cached',
    });
    expect(e).toMatchObject({ status: 'valid', check_id: 'chk-1' });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('UNAVAILABLE is cached 60 s only', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-10-15T10:00:00Z') });
    const { service, post } = build(() => ok(envelope('SERVICE_UNAVAILABLE')));
    await service.check('DE123456789', LIVE);
    await service.check('DE123456789', LIVE);
    expect(post).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(61_000);
    await service.check('DE123456789', LIVE);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('MS_UNAVAILABLE opens a 30 s circuit for the member state', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-10-15T10:00:00Z') });
    const { service, post } = build(() => ok(envelope('MS_UNAVAILABLE')));
    await service.check('DE123456789', LIVE);
    // Another DE number: skipped while the circuit is open.
    const e = await service.check('DE987654321', LIVE);
    expect(e).toMatchObject({ status: 'unavailable', check_id: null });
    expect(post).toHaveBeenCalledTimes(1);
    // Other member states are unaffected.
    await service.check('FRXX123456789', LIVE);
    expect(post).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(31_000);
    await service.check('DE987654321', LIVE);
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('concurrent identical checks share one call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { service, post } = build(async () => {
      await gate;
      return { status: 200, json: okBody(true) };
    });
    const all = Promise.all([
      service.check('DE123456789', LIVE),
      service.check('DE123456789', LIVE),
      service.check('de 123456789', LIVE),
    ]);
    release();
    const results = await all;
    expect(post).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.status === 'valid')).toBe(true);
  });

  it(`at most ${VIES_MAX_CONCURRENT} calls are in flight`, async () => {
    let inFlight = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const { service, post } = build(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => releases.push(r));
      inFlight--;
      return { status: 200, json: okBody(true) };
    });
    const numbers = Array.from(
      { length: 7 },
      (_, i) => `DE${String(100000000 + i)}`,
    );
    const all = Promise.all(numbers.map((n) => service.check(n, LIVE)));
    for (let i = 0; i < 20 && post.mock.calls.length < 7; i++) {
      await new Promise((r) => setImmediate(r));
      while (releases.length) releases.shift()!();
    }
    await all;
    expect(post).toHaveBeenCalledTimes(7);
    expect(peak).toBeLessThanOrEqual(VIES_MAX_CONCURRENT);
  });

  it('cached mode never calls VIES on a miss', async () => {
    const { service, post } = build(() => ok(okBody(true)));
    const e = await service.check('DE123456789', { ...LIVE, mode: 'cached' });
    expect(e).toMatchObject({
      status: 'unavailable',
      error_code: 'NOT_CHECKED',
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('a failing DB write does not throw', async () => {
    const { service } = build(() => ok(okBody(true)), { failWrite: true });
    const e = await service.check('DE123456789', LIVE);
    expect(e).toMatchObject({ status: 'valid', check_id: null });
  });

  it('VIES_MODE=off is always unavailable, without a call', async () => {
    const { service, post } = build(() => ok(okBody(true)), {
      env: { VIES_MODE: 'off' },
    });
    expect(await service.check('DE123456789', LIVE)).toMatchObject({
      status: 'unavailable',
      error_code: 'VIES_OFF',
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('VIES_MODE=mock follows the official test numbers and suffix rules', async () => {
    const prisma = makePrisma();
    const service = new ViesService(
      prisma as unknown as PrismaService,
      config({ VIES_MODE: 'mock' }),
      new MockViesHttpClient(),
    );
    const status = async (n: string) => (await service.check(n, LIVE)).status;
    expect(await status('EL100')).toBe('valid');
    expect((await service.check('EL100', LIVE)).name).toBe('John Doe');
    expect(await status('LU200')).toBe('invalid');
    expect(await status('LU201')).toBe('invalid');
    for (const n of ['CZ300', 'CY301', 'BG302', 'LV500', 'LT600']) {
      expect(await status(n)).toBe('unavailable');
    }
    expect(await status('DE123450000')).toBe('invalid');
    expect(await status('FI12349999')).toBe('unavailable');
    expect(await status('DK12348888')).toBe('unavailable');
    const mocked = await service.check('DE123456789', LIVE);
    expect(mocked).toMatchObject({ status: 'valid', name: 'Mock Company DE' });
  });

  it('uses the configured endpoint (test service base kept as is)', async () => {
    const a = build(() => ok(okBody(true)));
    await a.service.check('DE123456789', LIVE);
    expect(a.post.mock.calls[0][0]).toBe(
      'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number',
    );
    const b = build(() => ok(okBody(true)), {
      env: {
        VIES_BASE_URL:
          'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-test-service',
      },
    });
    await b.service.check('DE123456789', LIVE);
    expect(b.post.mock.calls[0][0]).toMatch(/check-vat-test-service$/);
  });
});

describe('ViesService.requesterFor', () => {
  it('prefers the setting, else the legal-profile VAT number', async () => {
    const prisma = makePrisma({ profileVat: 'SE 5560 3607 9301' });
    const service = new ViesService(
      prisma as unknown as PrismaService,
      config(),
      new MockViesHttpClient(),
    );
    expect(await service.requesterFor('s1', 'DE123456789')).toBe('DE123456789');
    expect(await service.requesterFor('s1', null)).toBe('SE556036079301');
    const none = new ViesService(
      makePrisma({ profileVat: 'NO123456789MVA' }) as unknown as PrismaService,
      config(),
      new MockViesHttpClient(),
    );
    expect(await none.requesterFor('s1', null)).toBeNull();
  });
});

// M2.5 review fixes.
describe('ViesService review fixes', () => {
  afterEach(() => jest.useRealTimers());

  it("M1: one store never receives another store's consultation evidence", async () => {
    const { service, prisma, post } = build((body) =>
      ok(
        okBody(true, {
          requestIdentifier:
            typeof body.requesterNumber === 'string'
              ? `WAPI-${body.requesterNumber}`
              : '',
        }),
      ),
    );
    const a = await service.check('DE123456789', {
      ...LIVE,
      storeId: 'store-a',
      requester: 'SE556036079301',
    });
    expect(a.request_identifier).toBe('WAPI-556036079301');
    // Store B (other requester) and C (none): own call, own row.
    const b = await service.check('DE123456789', {
      ...LIVE,
      storeId: 'store-b',
      requester: 'FI12345678',
    });
    const c = await service.check('DE123456789', {
      ...LIVE,
      storeId: 'store-c',
    });
    for (const e of [b, c]) {
      expect(e.request_identifier).not.toBe(a.request_identifier);
      expect(e.check_id).not.toBe(a.check_id);
      expect(e.requester).not.toBe('SE556036079301');
    }
    expect(b.request_identifier).toBe('WAPI-12345678');
    expect(c.request_identifier).toBeNull();
    expect(post).toHaveBeenCalledTimes(3);
    expect(prisma.rows.map((r) => r.store_id)).toEqual([
      'store-a',
      'store-b',
      'store-c',
    ]);
    // The DB cache (fresh process) respects it too.
    const restarted = new ViesService(
      prisma as unknown as PrismaService,
      config(),
      { post } as ViesHttpClient,
    );
    const cachedB = await restarted.check('DE123456789', {
      ...LIVE,
      mode: 'cached',
      storeId: 'store-b',
      requester: 'FI12345678',
    });
    expect(cachedB.check_id).toBe(b.check_id);
    const otherReq = await restarted.check('DE123456789', {
      ...LIVE,
      mode: 'cached',
      storeId: 'store-a',
      requester: 'FI12345678',
    });
    expect(otherReq).toMatchObject({
      status: 'unavailable',
      error_code: 'NOT_CHECKED',
      request_identifier: null,
    });
  });

  it('rows written in mock mode never serve live mode', async () => {
    const prisma = makePrisma();
    const mock = new ViesService(
      prisma as unknown as PrismaService,
      config({ VIES_MODE: 'mock' }),
      new MockViesHttpClient(),
    );
    await mock.check('DE123456789', LIVE);
    expect(prisma.rows[0].mode).toBe('mock');
    const live = new ViesService(
      prisma as unknown as PrismaService,
      config(),
      new MockViesHttpClient(),
    );
    expect(
      (await live.check('DE123456789', { ...LIVE, mode: 'cached' })).error_code,
    ).toBe('NOT_CHECKED');
  });

  it('L1: a full queue fails closed after VIES_QUEUE_TIMEOUT_MS', async () => {
    jest.useFakeTimers();
    const { service } = build(() => new Promise<ViesHttpResponse>(() => {}), {
      env: { VIES_QUEUE_TIMEOUT_MS: '2000', VIES_TIMEOUT_MS: '60000' },
    });
    for (let i = 0; i < VIES_MAX_CONCURRENT; i++) {
      void service.check(`DE10000000${i}`, LIVE);
    }
    const queued = service.check('DE200000000', LIVE);
    await jest.advanceTimersByTimeAsync(2001);
    expect(await queued).toMatchObject({
      status: 'unavailable',
      error_code: 'QUEUE_TIMEOUT',
    });
  });

  it('L1: storefront checks hold at most 2 slots; orders keep priority', async () => {
    jest.useFakeTimers();
    const sent: string[] = [];
    const { service, post } = build(
      (body) => {
        sent.push(String(body.vatNumber));
        return new Promise<ViesHttpResponse>(() => {});
      },
      { env: { VIES_QUEUE_TIMEOUT_MS: '2000', VIES_TIMEOUT_MS: '60000' } },
    );
    const storefront = (n: string) =>
      service.check(n, { ...LIVE, source: 'storefront' });
    void storefront('DE100000001');
    void storefront('DE100000002');
    const third = storefront('DE100000003');
    await jest.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(2);
    // Order checks still get the remaining two slots immediately.
    void service.check('DE300000001', LIVE);
    void service.check('DE300000002', LIVE);
    await jest.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(2001);
    expect((await third).error_code).toBe('QUEUE_TIMEOUT');
    expect(sent).toEqual(['100000001', '100000002', '300000001', '300000002']);
  });

  it('L1: a freed slot goes to a waiting order check before a storefront one', async () => {
    const releases: (() => void)[] = [];
    const sent: string[] = [];
    const { service } = build((body) => {
      sent.push(String(body.vatNumber));
      return new Promise<ViesHttpResponse>((resolve) =>
        releases.push(() => resolve({ status: 200, json: okBody(true) })),
      );
    });
    const first = Array.from({ length: VIES_MAX_CONCURRENT }, (_, i) =>
      service.check(`DE10000000${i}`, LIVE),
    );
    const sf = service.check('DE900000000', { ...LIVE, source: 'storefront' });
    const ord = service.check('DE800000000', LIVE);
    const tick = () => new Promise((r) => setImmediate(r));
    await tick();
    releases.shift()!();
    await first[0];
    await tick();
    expect(sent[VIES_MAX_CONCURRENT]).toBe('800000000');
    for (let i = 0; i < 5; i++) {
      while (releases.length) releases.shift()!();
      await tick();
    }
    await Promise.all([...first, sf, ord]);
    expect(sent).toContain('900000000');
  });

  it('L6: warn logs mask the VAT number', async () => {
    const { service } = build(() => Promise.reject(new TypeError('down')));
    const logger = (service as unknown as { logger: { warn: () => void } })
      .logger;
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await service.check('DE123456789', LIVE);
    const logged = warn.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join(' ');
    expect(logged).toContain('DE***6789');
    expect(logged).not.toContain('DE123456789');
    expect(maskVat('SE556036079301')).toBe('SE***9301');
  });

  it('requesterFor caches the legal-profile lookup per store (60 s)', async () => {
    jest.useFakeTimers();
    const prisma = makePrisma({ profileVat: 'SE556036079301' });
    const service = new ViesService(
      prisma as unknown as PrismaService,
      config(),
      new MockViesHttpClient(),
    );
    await service.requesterFor('s1', null);
    await service.requesterFor('s1', null);
    expect(prisma.storeLegalProfile.findUnique).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(61_000);
    await service.requesterFor('s1', null);
    expect(prisma.storeLegalProfile.findUnique).toHaveBeenCalledTimes(2);
  });
});

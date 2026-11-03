import type { ConfigService } from '@nestjs/config';
import { TraderVatCheckService } from './trader-vat-check';

// VIES check of the trader-details VAT number (wave 3), transport mocked:
// valid / invalid / unavailable (timeout, 5xx, MS_UNAVAILABLE) / non-EU.

const NOW = new Date('2026-11-03T10:00:00.000Z');

function mockFetch(
  impl: (url: string, init: RequestInit) => Promise<Response>,
) {
  const fn = jest.fn(impl);
  (globalThis as { fetch: unknown }).fetch = fn;
  return fn;
}
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const originalFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = originalFetch;
});

function build(baseUrl?: string) {
  const config = {
    get: (k: string) => (k === 'VIES_BASE_URL' ? baseUrl : undefined),
  } as unknown as ConfigService;
  return new TraderVatCheckService(config);
}

describe('TraderVatCheckService.check', () => {
  it('posts {countryCode, vatNumber} to check-vat-number and maps a valid answer', async () => {
    const fetchMock = mockFetch(() =>
      json({
        valid: true,
        name: 'NAMEZ AB',
        address: 'STORGATAN 1\n111 22 STOCKHOLM',
      }),
    );
    const res = await build().check('SE556016068001', NOW);
    expect(res).toEqual({
      valid: true,
      checked_at: '2026-11-03T10:00:00.000Z',
      name: 'NAMEZ AB',
      address: 'STORGATAN 1\n111 22 STOCKHOLM',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number',
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      countryCode: 'SE',
      vatNumber: '556016068001',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('Greece uses the EL member-state code; "---" name/address are dropped', async () => {
    const fetchMock = mockFetch(() =>
      json({ valid: true, name: '---', address: '---' }),
    );
    const res = await build().check('GR123456789', NOW);
    expect(res).toEqual({ valid: true, checked_at: NOW.toISOString() });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      countryCode: 'EL',
      vatNumber: '123456789',
    });
  });

  it('valid:false is invalid (blocking)', async () => {
    mockFetch(() => json({ valid: false }));
    expect(await build().check('SE556016068001', NOW)).toEqual({
      valid: false,
      checked_at: NOW.toISOString(),
    });
  });

  it('INVALID_INPUT counts as invalid too', async () => {
    mockFetch(() =>
      json({
        actionSucceed: false,
        errorWrappers: [{ error: 'INVALID_INPUT' }],
      }),
    );
    expect((await build().check('SE1', NOW)).valid).toBe(false);
  });

  it('timeout, network error, 5xx, MS_UNAVAILABLE or a bad body is valid: null', async () => {
    const cases: Array<(url: string, init: RequestInit) => Promise<Response>> = [
      () =>
        Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' })),
      () => Promise.reject(new Error('ECONNRESET')),
      () => Promise.resolve(new Response('bad gateway', { status: 502 })),
      () =>
        json({
          actionSucceed: false,
          errorWrappers: [{ error: 'MS_UNAVAILABLE' }],
        }),
      () => Promise.resolve(new Response('<html>', { status: 200 })),
    ];
    for (const impl of cases) {
      mockFetch(impl);
      expect(await build().check('SE556016068001', NOW)).toEqual({
        valid: null,
        checked_at: NOW.toISOString(),
      });
    }
  });

  it('a non-EU prefix is not checkable (valid: null, no request)', async () => {
    const fetchMock = mockFetch(() => json({ valid: true }));
    expect(await build().check('GB123456789', NOW)).toEqual({
      valid: null,
      checked_at: NOW.toISOString(),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a staging base ending in /check-vat-test-service is used as is', async () => {
    const fetchMock = mockFetch(() => json({ valid: true }));
    await build('https://x.test/vies/check-vat-test-service/').check(
      'SE556016068001',
      NOW,
    );
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://x.test/vies/check-vat-test-service',
    );
  });
});

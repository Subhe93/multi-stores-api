import { Logger } from '@nestjs/common';
import { MetaConversionsService } from './meta-conversions.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CryptoService } from '../../common/crypto/crypto.service';

// MetaConversionsService.sendPurchase: what is sent, when nothing is sent,
// and that it never throws nor logs the token / personal data.

const TOKEN = 'EAAGm0PX4ZCpsBAsecretTokenValue123';
const ENCRYPTED = 'v2:ciphertext';
const ORDER_ID = '0b0f6a2e-1c1d-4a55-9a53-1f2f3a4b5c6d';
const EMAIL = 'anna.svensson@example.com';

type Row = Record<string, unknown>;

function build(over: { head?: Row; store?: Row | null; order?: Row } = {}) {
  const head = {
    id: ORDER_ID,
    store_id: 's1',
    is_test: false,
    deleted_at: null,
    ...over.head,
  };
  const store =
    over.store === null
      ? null
      : {
          meta_pixel_id: '123456789012345',
          meta_capi_token: ENCRYPTED,
          meta_test_event_code: null,
          consent_required: true,
          custom_domain: 'shop.example.com',
          ...over.store,
        };
  const order = {
    id: ORDER_ID,
    order_number: 'ORD-1001',
    total: '349.50',
    currency: 'SEK',
    paid_at: new Date('2026-11-11T10:00:00.000Z'),
    hostname: null,
    tracking_context: {
      fbp: 'fb.1.1700000000000.123456789',
      source_url: 'https://shop.example.com/checkout',
      ip: '203.0.113.7',
      user_agent: 'Mozilla/5.0',
    },
    items: [
      {
        id: 'i1',
        product_id: 'p1',
        custom_product_id: null,
        quantity: 2,
        unit_price: '100.00',
      },
      {
        id: 'i2',
        product_id: null,
        custom_product_id: 'cp9',
        quantity: 1,
        unit_price: '149.50',
      },
    ],
    customer: {
      first_name: 'Anna',
      last_name: 'Svensson',
      phone: '070-123 45 67',
      user: { email: EMAIL },
    },
    address: {
      full_name: 'Anna Svensson',
      city: 'Stockholm',
      postal_code: '111 22',
      country_code: 'SE',
      phone: null,
    },
    ...over.order,
  };
  const prisma = {
    order: {
      // First read: the cheap head; second read: the full order.
      findUnique: jest.fn(
        ({ select }: { select: Row }): Promise<Row | null> =>
          Promise.resolve('order_number' in select ? order : head),
      ),
    },
    store: { findUnique: jest.fn(() => Promise.resolve(store)) },
  };
  const crypto = {
    decrypt: jest.fn((v: string) => (v === ENCRYPTED ? TOKEN : null)),
  };
  const service = new MetaConversionsService(
    prisma as unknown as PrismaService,
    crypto as unknown as CryptoService,
  );
  return { service, prisma, crypto };
}

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ events_received: 1 }),
  } as unknown as Response;
}

function errorResponse(status: number, error: Row): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ error }),
  } as unknown as Response;
}

const originalFetch = globalThis.fetch;
let fetchMock: jest.Mock;
let logged: string[];

beforeEach(() => {
  fetchMock = jest.fn(() => Promise.resolve(okResponse()));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  logged = [];
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
    jest
      .spyOn(Logger.prototype, level)
      .mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => String(a)).join(' '));
      });
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
});

/** The single request made, parsed. */
function sentRequest(): { url: string; init: RequestInit; body: Row } {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, init, body: JSON.parse(init.body as string) as Row };
}

describe('MetaConversionsService.sendPurchase', () => {
  it('sends one Purchase to the pixel events endpoint with the deduplication id', async () => {
    const { service, crypto } = build();
    await expect(service.sendPurchase(ORDER_ID)).resolves.toEqual({
      sent: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init, body } = sentRequest();
    expect(url).toBe('https://graph.facebook.com/v24.0/123456789012345/events');
    // The token never travels in the URL.
    expect(url).not.toContain(TOKEN);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(crypto.decrypt).toHaveBeenCalledWith(ENCRYPTED);

    expect(body.access_token).toBe(TOKEN);
    expect('test_event_code' in body).toBe(false);
    const events = body.data as Row[];
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event).toMatchObject({
      event_name: 'Purchase',
      event_id: `purchase_${ORDER_ID}`,
      event_time: Math.floor(Date.UTC(2026, 10, 11, 10) / 1000),
      action_source: 'website',
      event_source_url: 'https://shop.example.com/checkout',
      custom_data: {
        currency: 'SEK',
        value: 349.5,
        content_type: 'product',
        contents: [
          { id: 'p1', quantity: 2, item_price: 100 },
          { id: 'cp9', quantity: 1, item_price: 149.5 },
        ],
        content_ids: ['p1', 'cp9'],
        num_items: 3,
        order_id: 'ORD-1001',
      },
    });
    const user = event.user_data as Record<string, unknown>;
    // Customer parameters are SHA-256 hex, never the clear value.
    for (const key of ['em', 'ph', 'fn', 'ln', 'ct', 'zp', 'country']) {
      const value = user[key] as string[];
      expect(value).toHaveLength(1);
      expect(value[0]).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(JSON.stringify(user)).not.toContain(EMAIL);
    expect(JSON.stringify(user)).not.toContain('Svensson');
    // The browser context is sent unhashed.
    expect(user.client_ip_address).toBe('203.0.113.7');
    expect(user.client_user_agent).toBe('Mozilla/5.0');
    expect(user.fbp).toBe('fb.1.1700000000000.123456789');
    expect('fbc' in user).toBe(false);
  });

  it('asks for the token column explicitly (it is omitted from reads by default)', async () => {
    const { service, prisma } = build();
    await service.sendPurchase(ORDER_ID);
    expect(prisma.store.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 's1' },
        select: expect.objectContaining({ meta_capi_token: true }) as unknown,
      }),
    );
  });

  it('sends the test event code while one is set', async () => {
    const { service } = build({ store: { meta_test_event_code: 'TEST12345' } });
    await service.sendPurchase(ORDER_ID);
    expect(sentRequest().body.test_event_code).toBe('TEST12345');
  });

  it('falls back to the storefront host as the source URL', async () => {
    const { service } = build({
      order: { tracking_context: { ip: '203.0.113.7' }, hostname: 'namez.se' },
    });
    await service.sendPurchase(ORDER_ID);
    const event = (sentRequest().body.data as Row[])[0];
    expect(event.event_source_url).toBe('https://namez.se');
  });

  describe('sends nothing', () => {
    const cases: [string, Parameters<typeof build>[0], string][] = [
      ['a test order', { head: { is_test: true } }, 'test_order'],
      [
        'a deleted order',
        { head: { deleted_at: new Date() } },
        'order_deleted',
      ],
      ['an order without a store', { head: { store_id: null } }, 'no_store'],
      [
        'no access token',
        { store: { meta_capi_token: null } },
        'not_configured',
      ],
      ['no pixel id', { store: { meta_pixel_id: null } }, 'not_configured'],
      ['an unknown store', { store: null }, 'not_configured'],
      [
        'consent required and no browser context on the order',
        { order: { tracking_context: null } },
        'no_consent_evidence',
      ],
    ];
    it.each(cases)('for %s', async (_name, over, reason) => {
      const { service, crypto } = build(over);
      await expect(service.sendPurchase(ORDER_ID)).resolves.toEqual({
        sent: false,
        reason,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      // The token is only ever decrypted right before a request.
      expect(crypto.decrypt).not.toHaveBeenCalled();
    });

    it('for an order that does not exist', async () => {
      const { service, prisma } = build();
      prisma.order.findUnique.mockImplementation(() => Promise.resolve(null));
      await expect(service.sendPurchase('missing')).resolves.toEqual({
        sent: false,
        reason: 'order_not_found',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('when the stored token cannot be decrypted', async () => {
      const { service, crypto } = build();
      crypto.decrypt.mockImplementation(() => {
        throw new Error('bad ciphertext');
      });
      await expect(service.sendPurchase(ORDER_ID)).resolves.toEqual({
        sent: false,
        reason: 'token_unreadable',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('a store that does not ask for consent sends without a browser context', async () => {
    const { service } = build({
      store: { consent_required: false },
      order: { tracking_context: null },
    });
    await expect(service.sendPurchase(ORDER_ID)).resolves.toEqual({
      sent: true,
    });
    const event = (sentRequest().body.data as Row[])[0];
    const user = event.user_data as Record<string, unknown>;
    expect('client_ip_address' in user).toBe(false);
    expect('fbp' in user).toBe(false);
    expect(event.event_source_url).toBe('https://shop.example.com');
  });

  it('never throws when fetch rejects, and retries a network error once', async () => {
    fetchMock.mockImplementation(() =>
      Promise.reject(new TypeError(`fetch failed for ${TOKEN}`)),
    );
    const { service } = build();
    await expect(service.sendPurchase(ORDER_ID)).resolves.toEqual({
      sent: false,
      reason: 'request_failed',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 5xx once and succeeds on the second attempt', async () => {
    fetchMock
      .mockImplementationOnce(() =>
        Promise.resolve(errorResponse(503, { message: 'Service down' })),
      )
      .mockImplementationOnce(() => Promise.resolve(okResponse()));
    const { service } = build();
    await expect(service.sendPurchase(ORDER_ID)).resolves.toEqual({
      sent: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx and logs the status with the Meta error only', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        errorResponse(400, {
          message: `Invalid OAuth access token ${TOKEN}`,
          code: 190,
          error_subcode: 460,
          fbtrace_id: 'AbC123',
        }),
      ),
    );
    const { service } = build();
    await expect(service.sendPurchase(ORDER_ID)).resolves.toEqual({
      sent: false,
      reason: 'request_failed',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const line = logged.join('\n');
    expect(line).toContain(ORDER_ID);
    expect(line).toContain('HTTP 400');
    expect(line).toContain('code=190');
    expect(line).toContain('subcode=460');
    expect(line).toContain('Invalid OAuth access token [token]');
  });

  it('never throws when the database read fails', async () => {
    const { service, prisma } = build();
    prisma.order.findUnique.mockImplementation(() =>
      Promise.reject(new Error(`db down ${EMAIL}`)),
    );
    await expect(service.sendPurchase(ORDER_ID)).resolves.toEqual({
      sent: false,
      reason: 'request_failed',
    });
  });

  it('never logs the token, the ciphertext or personal data', async () => {
    const run = async (
      prepare: () => void,
      over?: Parameters<typeof build>[0],
    ) => {
      prepare();
      await build(over).service.sendPurchase(ORDER_ID);
    };
    // Success, 4xx with the token echoed, 5xx twice, network error, timeout.
    await run(() =>
      fetchMock.mockImplementation(() => Promise.resolve(okResponse())),
    );
    await run(() =>
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          errorResponse(400, { message: `bad token ${TOKEN}`, code: 190 }),
        ),
      ),
    );
    await run(() =>
      fetchMock.mockImplementation(() =>
        Promise.resolve(errorResponse(500, { message: 'oops', code: 1 })),
      ),
    );
    await run(() =>
      fetchMock.mockImplementation(() =>
        Promise.reject(new Error(`connect failed ${TOKEN} ${EMAIL}`)),
      ),
    );
    await run(
      () => fetchMock.mockImplementation(() => Promise.resolve(okResponse())),
      { order: { tracking_context: null } },
    );

    expect(logged.length).toBeGreaterThan(0);
    const all = logged.join('\n');
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(ENCRYPTED);
    expect(all).not.toContain(EMAIL);
    expect(all).not.toContain('Svensson');
    expect(all).not.toContain('203.0.113.7');
    expect(all).not.toContain('0701234567');
    expect(all).not.toContain('fb.1.1700000000000.123456789');
  });

  it('aborts a request that hangs past the timeout', async () => {
    jest.useFakeTimers();
    try {
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new Error('aborted')),
            );
          }),
      );
      const { service } = build();
      const pending = service.sendPurchase(ORDER_ID);
      // Two attempts, each cut at the timeout.
      await jest.advanceTimersByTimeAsync(5000);
      await jest.advanceTimersByTimeAsync(5000);
      await expect(pending).resolves.toEqual({
        sent: false,
        reason: 'request_failed',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(logged.join('\n')).toContain('timeout after 5000 ms');
    } finally {
      jest.useRealTimers();
    }
  });
});

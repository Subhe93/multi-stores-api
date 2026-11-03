import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { TurnstileService, TURNSTILE_VERIFY_URL } from './turnstile.service';

// Turnstile verifier (onboarding wave 3): off without a secret, fail-closed
// with one, 503 when siteverify cannot be reached.

function build(secret?: string) {
  const config = {
    get: (k: string) => (k === 'TURNSTILE_SECRET_KEY' ? secret : undefined),
  } as unknown as ConfigService;
  return new TurnstileService(config);
}

function mockFetch(
  impl: (url: string, init: RequestInit) => Promise<Response>,
) {
  const fn = jest.fn(impl);
  (globalThis as { fetch: unknown }).fetch = fn;
  return fn;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = originalFetch;
});

describe('TurnstileService', () => {
  it('is off without a secret: verify resolves and never calls fetch', async () => {
    const fetchMock = mockFetch(() => Promise.reject(new Error('no')));
    const svc = build(undefined);
    expect(svc.enabled).toBe(false);
    await expect(svc.verify(undefined)).resolves.toBeUndefined();
    await expect(svc.verify('anything')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with a secret: missing token is 400 AUTH_CAPTCHA_FAILED without a round trip', async () => {
    const fetchMock = mockFetch(() => Promise.reject(new Error('no')));
    const svc = build('sk');
    expect(svc.enabled).toBe(true);
    const err = await svc.verify('   ').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'AUTH_CAPTCHA_FAILED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts secret/response/remoteip as a form and accepts success:true', async () => {
    const fetchMock = mockFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ success: true }), { status: 200 }),
      ),
    );
    await build('sk').verify('tok', '203.0.113.9');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TURNSTILE_VERIFY_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    const body = new URLSearchParams(String(init.body));
    expect(body.get('secret')).toBe('sk');
    expect(body.get('response')).toBe('tok');
    expect(body.get('remoteip')).toBe('203.0.113.9');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('success:false is 400 AUTH_CAPTCHA_FAILED', async () => {
    mockFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            success: false,
            'error-codes': ['invalid-input-response'],
          }),
          { status: 200 },
        ),
      ),
    );
    const err = await build('sk').verify('bad').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'AUTH_CAPTCHA_FAILED',
    });
  });

  it('network error, timeout, 5xx or a non-JSON body is 503 AUTH_CAPTCHA_UNAVAILABLE', async () => {
    const cases: Array<() => Promise<Response>> = [
      () => Promise.reject(new Error('ECONNRESET')),
      () =>
        Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' })),
      () => Promise.resolve(new Response('oops', { status: 502 })),
      () => Promise.resolve(new Response('not json', { status: 200 })),
    ];
    for (const impl of cases) {
      mockFetch(impl);
      const err = await build('sk').verify('tok').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(
        (err as ServiceUnavailableException).getResponse(),
      ).toMatchObject({ code: 'AUTH_CAPTCHA_UNAVAILABLE' });
    }
  });
});

import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { TurnstileService, turnstileHostAllowed } from './turnstile.service';

// Hostname binding of accepted tokens and the storefront-customer switch.

function build(env: Record<string, string | undefined>) {
  const config = { get: (k: string) => env[k] } as unknown as ConfigService;
  return new TurnstileService(config);
}

function answer(body: Record<string, unknown>) {
  const fn = jest.fn(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
  );
  (globalThis as { fetch: unknown }).fetch = fn;
  return fn;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = originalFetch;
});

describe('turnstileHostAllowed', () => {
  it('matches exact hosts and dot-prefixed suffixes only', () => {
    const allowed = ['namez.se', '.shopsdoor.com'];
    expect(turnstileHostAllowed('namez.se', allowed)).toBe(true);
    expect(turnstileHostAllowed('NAMEZ.se', allowed)).toBe(true);
    expect(turnstileHostAllowed('muba.shopsdoor.com', allowed)).toBe(true);
    expect(turnstileHostAllowed('shopsdoor.com', allowed)).toBe(true);
    expect(turnstileHostAllowed('evilshopsdoor.com', allowed)).toBe(false);
    expect(turnstileHostAllowed('www.namez.se', allowed)).toBe(false);
    expect(turnstileHostAllowed(undefined, allowed)).toBe(false);
  });
});

describe('TurnstileService hostname binding', () => {
  it('refuses a token solved on another site', async () => {
    answer({ success: true, hostname: 'attacker.example' });
    await expect(
      build({ TURNSTILE_SECRET_KEY: 'sk' }).verify('tok', null, {
        hostnames: ['shopsdoor.com'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a token solved on an allowed host', async () => {
    answer({ success: true, hostname: 'shopsdoor.com' });
    await expect(
      build({ TURNSTILE_SECRET_KEY: 'sk' }).verify('tok', null, {
        hostnames: ['shopsdoor.com'],
      }),
    ).resolves.toBeUndefined();
  });
});

describe('TurnstileService customer switch', () => {
  it('is off unless both the secret and TURNSTILE_CUSTOMERS are set', async () => {
    const fetchMock = answer({ success: false });
    const secretOnly = build({ TURNSTILE_SECRET_KEY: 'sk' });
    const flagOnly = build({ TURNSTILE_CUSTOMERS: 'on' });
    expect(secretOnly.customersEnabled).toBe(false);
    expect(flagOnly.customersEnabled).toBe(false);
    await secretOnly.verifyCustomer(undefined, null, ['namez.se']);
    await flagOnly.verifyCustomer(undefined, null, ['namez.se']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('when on, requires a token solved on one of the store hosts', async () => {
    const svc = build({
      TURNSTILE_SECRET_KEY: 'sk',
      TURNSTILE_CUSTOMERS: 'on',
    });
    expect(svc.customersEnabled).toBe(true);
    await expect(
      svc.verifyCustomer(undefined, null, ['namez.se']),
    ).rejects.toBeInstanceOf(BadRequestException);
    answer({ success: true, hostname: 'other-store.se' });
    await expect(
      svc.verifyCustomer('tok', null, ['namez.se']),
    ).rejects.toBeInstanceOf(BadRequestException);
    answer({ success: true, hostname: 'namez.se' });
    await expect(
      svc.verifyCustomer('tok', null, ['namez.se']),
    ).resolves.toBeUndefined();
  });
});

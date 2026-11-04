import { lastValueFrom, of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import {
  clearRefreshCookie,
  dashboardOrigins,
  fromDashboard,
  readRefreshCookie,
  RefreshCookieInterceptor,
  setRefreshCookie,
  wantsRefreshCookie,
} from './refresh-cookie';

// httpOnly refresh cookie for the dashboard: only for the dashboard origin
// (store subdomains are same-site with the API and run creator scripts).

const PROD = {
  NODE_ENV: 'production',
  DASHBOARD_URL: 'https://app.shopsdoor.com',
} as NodeJS.ProcessEnv;

function req(headers: Record<string, string>, secure = true) {
  return { headers, secure } as never;
}

function jwtExpiringIn(seconds: number): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds }),
  ).toString('base64url');
  return `h.${payload}.s`;
}

const env = process.env;
beforeEach(() => {
  process.env = { ...env, ...PROD };
});
afterAll(() => {
  process.env = env;
});

describe('dashboard origin check', () => {
  it('accepts only the configured dashboard origins in production', () => {
    expect(dashboardOrigins(PROD)).toEqual(['https://app.shopsdoor.com']);
    expect(
      fromDashboard(req({ origin: 'https://app.shopsdoor.com' }), PROD),
    ).toBe(true);
    expect(
      fromDashboard(req({ origin: 'https://evil.shopsdoor.com' }), PROD),
    ).toBe(false);
    expect(fromDashboard(req({ origin: 'http://localhost:3002' }), PROD)).toBe(
      false,
    );
    expect(fromDashboard(req({}), PROD)).toBe(false);
  });

  it('allows localhost dashboards outside production', () => {
    expect(
      fromDashboard(req({ origin: 'http://localhost:3002' }), {
        NODE_ENV: 'development',
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

describe('readRefreshCookie', () => {
  it('reads the cookie for the dashboard origin only', () => {
    const cookie = 'a=1; ms_rt=tok%2E1; b=2';
    expect(
      readRefreshCookie(req({ origin: 'https://app.shopsdoor.com', cookie })),
    ).toBe('tok.1');
    expect(
      readRefreshCookie(req({ origin: 'https://muba.shopsdoor.com', cookie })),
    ).toBeNull();
    expect(
      readRefreshCookie(req({ origin: 'https://app.shopsdoor.com' })),
    ).toBeNull();
  });
});

describe('set / clear', () => {
  it('sets an httpOnly, Strict, Secure cookie on /api/auth sized by exp', () => {
    const append = jest.fn<void, [string, string]>();
    setRefreshCookie(req({}), { append } as never, jwtExpiringIn(3600));
    const value = append.mock.calls[0][1];
    expect(value).toMatch(/^ms_rt=h\.[^;]+\.s; Max-Age=(3599|3600);/);
    expect(value).toContain('Path=/api/auth');
    expect(value).toContain('HttpOnly');
    expect(value).toContain('SameSite=Strict');
    expect(value).toContain('Secure');
  });

  it('clears with Max-Age=0', () => {
    const append = jest.fn<void, [string, string]>();
    clearRefreshCookie(req({}), { append } as never);
    expect(append.mock.calls[0][1]).toMatch(/^ms_rt=; Max-Age=0;/);
  });
});

describe('RefreshCookieInterceptor', () => {
  async function run(headers: Record<string, string>, body: unknown) {
    const append = jest.fn<void, [string, string]>();
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => req(headers),
        getResponse: () => ({ append }),
      }),
    } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of(body) };
    const out = await lastValueFrom(
      new RefreshCookieInterceptor().intercept(ctx, next),
    );
    return { out, append };
  }

  const tokens = { access_token: 'a', refresh_token: jwtExpiringIn(60) };

  it('moves the refresh token into the cookie for the opted-in dashboard', async () => {
    const { out, append } = await run(
      { origin: 'https://app.shopsdoor.com', 'x-auth-cookie': '1' },
      tokens,
    );
    expect(out).toEqual({ access_token: 'a' });
    expect(append).toHaveBeenCalledTimes(1);
    expect(wantsRefreshCookie(req({}))).toBe(false);
  });

  it('leaves the body alone without the opt-in or from another origin', async () => {
    const plain = await run({ origin: 'https://app.shopsdoor.com' }, tokens);
    expect(plain.out).toEqual(tokens);
    const store = await run(
      { origin: 'https://muba.shopsdoor.com', 'x-auth-cookie': '1' },
      tokens,
    );
    expect(store.out).toEqual(tokens);
    expect(store.append).not.toHaveBeenCalled();
  });
});

import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { map, type Observable } from 'rxjs';

/**
 * httpOnly refresh-token cookie for the dashboard (staff on app.<platform>,
 * API on api.<platform>: same site). A client opts in with the
 * `X-Auth-Cookie: 1` request header; the refresh token then travels only in
 * this cookie, which page scripts cannot read, and is removed from the JSON
 * body. Storefronts on custom domains are cross-site to the API (blocked
 * third-party cookies), so they keep the body token flow.
 */
export const REFRESH_COOKIE = 'ms_rt';
export const REFRESH_COOKIE_PATH = '/api/auth';
export const AUTH_COOKIE_HEADER = 'x-auth-cookie';

type Req = Pick<Request, 'headers' | 'secure'>;

/**
 * Origins allowed to use the cookie: the dashboard (DASHBOARD_URL plus any
 * DASHBOARD_ORIGINS). Store subdomains (<slug>.<platform>) are same-site
 * with the API and run creator scripts, so SameSite alone is not enough:
 * the cookie is only honoured, and only set, for these exact origins.
 */
export function dashboardOrigins(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const out: string[] = [];
  for (const raw of [
    env.DASHBOARD_URL ?? '',
    ...(env.DASHBOARD_ORIGINS ?? '').split(','),
  ]) {
    try {
      const origin = new URL(raw.trim()).origin;
      if (origin !== 'null' && !out.includes(origin)) out.push(origin);
    } catch {
      // Empty or not a URL.
    }
  }
  return out;
}

/** The request comes from the dashboard (dev: any http://localhost port). */
export function fromDashboard(
  req: Req,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const origin = req.headers?.origin;
  if (typeof origin !== 'string') return false;
  if (dashboardOrigins(env).includes(origin)) return true;
  return (
    env.NODE_ENV !== 'production' && /^http:\/\/localhost:\d+$/.test(origin)
  );
}

/** The dashboard asked for the cookie flow. */
export function wantsRefreshCookie(req: Req): boolean {
  return req.headers?.[AUTH_COOKIE_HEADER] === '1' && fromDashboard(req);
}

/** The refresh token from the Cookie header (dashboard origin only), or null. */
export function readRefreshCookie(req: Req): string | null {
  if (!fromDashboard(req)) return null;
  const header = req.headers?.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== REFRESH_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value) || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Seconds until the JWT's `exp` (no signature check: only sizes the cookie). */
function secondsLeft(jwt: string): number {
  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { exp?: number };
    if (typeof payload.exp !== 'number') return 0;
    return Math.max(0, payload.exp - Math.floor(Date.now() / 1000));
  } catch {
    return 0;
  }
}

function cookieFlags(req: Req): string[] {
  // Secure everywhere but plain-http development (localhost counts as a
  // secure context in browsers anyway).
  const secure = req.secure || process.env.NODE_ENV === 'production';
  return [
    `Path=${REFRESH_COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Strict',
    ...(secure ? ['Secure'] : []),
  ];
}

export function setRefreshCookie(
  req: Req,
  res: Pick<Response, 'append'>,
  token: string,
): void {
  const maxAge = secondsLeft(token);
  res.append(
    'Set-Cookie',
    [
      `${REFRESH_COOKIE}=${encodeURIComponent(token)}`,
      `Max-Age=${maxAge}`,
      ...cookieFlags(req),
    ].join('; '),
  );
}

export function clearRefreshCookie(
  req: Req,
  res: Pick<Response, 'append'>,
): void {
  res.append(
    'Set-Cookie',
    [`${REFRESH_COOKIE}=`, 'Max-Age=0', ...cookieFlags(req)].join('; '),
  );
}

/**
 * On auth routes: when the client opted in, a `refresh_token` in the
 * handler's result moves into the cookie and out of the body.
 */
@Injectable()
export class RefreshCookieInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    return next.handle().pipe(
      map((body: unknown) => {
        if (!wantsRefreshCookie(req) || !body || typeof body !== 'object') {
          return body;
        }
        const token = (body as { refresh_token?: unknown }).refresh_token;
        if (typeof token !== 'string' || !token) return body;
        setRefreshCookie(req, res, token);
        const rest = { ...(body as Record<string, unknown>) };
        delete rest.refresh_token;
        return rest;
      }),
    );
  }
}

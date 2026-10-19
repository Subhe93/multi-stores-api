/**
 * Signed links of the designer app (M4.2 §4.1 `designer/files/:signed`, §6.1).
 *
 * Private designer files (customer photo previews, template print
 * backgrounds, proofs) are never public: the editor, the dashboard (an <img>
 * cannot send the Bearer token), emails and the account page get a
 * short-lived capability URL instead. The token is
 *
 *   b64url(JSON {k, id, s, exp}) + "." + b64url(HMAC-SHA256(secret, part1))
 *
 * - `k`   what the id points at (see `DesignerLinkKind`);
 * - `id`  DesignAsset.id / Design.id / OrderItemDesign.id;
 * - `s`   the owning store id (checked again against the row: defence in depth);
 * - `exp` expiry, unix seconds.
 *
 * Signing and verification are pure and synchronous (WP4 builds cart/order
 * image URLs inside sync mappers). Public template assets and fonts are NOT
 * signed: they have stable public paths (`designerAssetPath`,
 * `designerFontPath`) so ISR-cached product pages never embed an expiring URL.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { UUID_RE } from './designs.util';

/** Environment variable holding the HMAC secret (≥ 32 chars recommended). */
export const DESIGNER_URL_SECRET_ENV = 'DESIGNER_URL_SECRET';

/**
 * - `asset`         original bytes of a private DesignAsset (template print
 *                   background; creator dashboard / editor preview);
 * - `photo_preview` the private WebP preview of a customer photo (editor);
 * - `proof`         the proof of a Design (draft / cart);
 * - `oid_proof`     the frozen proof of an OrderItemDesign (emails, account);
 * - `proof_back` / `oid_proof_back` the same for the back side (M5.6).
 */
export const DESIGNER_LINK_KINDS = [
  'asset',
  'photo_preview',
  'proof',
  'oid_proof',
  'proof_back',
  'oid_proof_back',
] as const;
export type DesignerLinkKind = (typeof DESIGNER_LINK_KINDS)[number];

export interface DesignerLinkPayload {
  k: DesignerLinkKind;
  id: string;
  s: string;
  /** Unix seconds. */
  exp: number;
}

/** Default lifetimes (seconds). */
export const DESIGNER_LINK_TTL = {
  /** Storefront editor and creator dashboard previews (§6.1: 1 h). */
  editor: 60 * 60,
  /** Creator dashboard (asset library, order card). */
  creator: 60 * 60,
  /** Upper bound for any link (emails are capped lower, see designerMailLinkExpiry). */
  max: 400 * 24 * 60 * 60,
} as const;

/**
 * Proof links in order emails expire at the files purge date, but never
 * later than this many days after sending: an email is forwarded and kept
 * far longer than the order needs. Env `DESIGNER_MAIL_LINK_MAX_DAYS`
 * (1–365, default 30). The account page and the dashboard mint fresh
 * short-lived links, so a customer can still see the proof there.
 */
export const DESIGNER_MAIL_LINK_MAX_DAYS_ENV = 'DESIGNER_MAIL_LINK_MAX_DAYS';
export const DESIGNER_MAIL_LINK_MAX_DAYS_DEFAULT = 30;
export const DESIGNER_MAIL_LINK_MAX_DAYS_LIMIT = 365;

/** The configured email link cap in days (1–365, default 30). */
export function designerMailLinkMaxDays(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[DESIGNER_MAIL_LINK_MAX_DAYS_ENV]?.trim();
  const n = raw ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1) return DESIGNER_MAIL_LINK_MAX_DAYS_DEFAULT;
  return Math.min(n, DESIGNER_MAIL_LINK_MAX_DAYS_LIMIT);
}

/**
 * Expiry of a proof link in an email: the estimated purge date, at least
 * `minDays` (retention may lag) and at most `designerMailLinkMaxDays()`
 * after `nowMs`. When the cap is below `minDays` the cap wins.
 */
export function designerMailLinkExpiry(
  purgeAtMs: number,
  nowMs: number,
  opts: { minDays?: number; env?: NodeJS.ProcessEnv } = {},
): Date {
  const day = 24 * 60 * 60 * 1000;
  const cap = nowMs + designerMailLinkMaxDays(opts.env) * day;
  const floor = nowMs + (opts.minDays ?? 0) * day;
  const at = Number.isFinite(purgeAtMs) ? Math.max(purgeAtMs, floor) : cap;
  return new Date(Math.min(at, cap));
}

/** API path prefix of the signed-file route (global prefix included). */
export const DESIGNER_FILES_PATH = '/api/designer/files/';

const MAX_TOKEN_LENGTH = 512;

function b64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromB64url(s: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function mac(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

/** Signs a payload. Throws on an empty secret or a malformed payload. */
export function signDesignerToken(
  payload: DesignerLinkPayload,
  secret: string,
): string {
  if (!secret) throw new Error('Designer URL secret is not configured');
  if (
    !(DESIGNER_LINK_KINDS as readonly string[]).includes(payload.k) ||
    !UUID_RE.test(payload.id) ||
    !UUID_RE.test(payload.s) ||
    !Number.isInteger(payload.exp) ||
    payload.exp <= 0
  ) {
    throw new Error('Invalid designer link payload');
  }
  const body = b64url(
    Buffer.from(
      JSON.stringify({
        k: payload.k,
        id: payload.id,
        s: payload.s,
        exp: payload.exp,
      }),
    ),
  );
  return `${body}.${b64url(mac(secret, body))}`;
}

export type DesignerTokenCheck =
  | { ok: true; payload: DesignerLinkPayload }
  | { ok: false; reason: 'malformed' | 'signature' | 'expired' };

/**
 * Verifies a token. The signature is compared in constant time before the
 * payload is parsed; `expired` is only reported for an authentic token.
 */
export function verifyDesignerToken(
  token: unknown,
  secret: string,
  nowMs: number = Date.now(),
): DesignerTokenCheck {
  if (
    !secret ||
    typeof token !== 'string' ||
    token.length > MAX_TOKEN_LENGTH ||
    token.split('.').length !== 2
  ) {
    return { ok: false, reason: 'malformed' };
  }
  const [body, sig] = token.split('.');
  const given = fromB64url(sig);
  if (!body || !given) return { ok: false, reason: 'malformed' };
  const expected = mac(secret, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'signature' };
  }
  let p: Partial<DesignerLinkPayload>;
  try {
    p = JSON.parse(
      (fromB64url(body) ?? Buffer.alloc(0)).toString('utf8'),
    ) as Partial<DesignerLinkPayload>;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    !p ||
    !(DESIGNER_LINK_KINDS as readonly unknown[]).includes(p.k) ||
    typeof p.id !== 'string' ||
    !UUID_RE.test(p.id) ||
    typeof p.s !== 'string' ||
    !UUID_RE.test(p.s) ||
    typeof p.exp !== 'number' ||
    !Number.isInteger(p.exp)
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (p.exp * 1000 <= nowMs) return { ok: false, reason: 'expired' };
  return {
    ok: true,
    payload: { k: p.k as DesignerLinkKind, id: p.id, s: p.s, exp: p.exp },
  };
}

/**
 * Production must set its own `DESIGNER_URL_SECRET` (a derived key ties
 * every signed designer link to JWT_SECRET rotation, and an empty secret
 * would make links unsignable). Throws a clear error at boot otherwise.
 */
export function assertDesignerUrlSecret(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV !== 'production') return;
  const own = env[DESIGNER_URL_SECRET_ENV]?.trim() ?? '';
  if (own.length < 32) {
    throw new Error(
      `${DESIGNER_URL_SECRET_ENV} must be set to at least 32 random characters when NODE_ENV=production ` +
        '(it signs the private designer file links). Generate one with: openssl rand -hex 32',
    );
  }
}

/**
 * Resolves the signing secret: `DESIGNER_URL_SECRET`, else a key derived
 * from `JWT_SECRET` (so a dev box works without extra config), else ''.
 * Production never gets here without its own secret (assertDesignerUrlSecret).
 */
export function resolveDesignerUrlSecret(
  env: NodeJS.ProcessEnv = process.env,
): { secret: string; derived: boolean } {
  const own = env[DESIGNER_URL_SECRET_ENV]?.trim();
  if (own) return { secret: own, derived: false };
  const jwt = env.JWT_SECRET?.trim();
  if (jwt) {
    return {
      secret: createHmac('sha256', jwt)
        .update('designer-urls/v1')
        .digest('hex'),
      derived: true,
    };
  }
  return { secret: '', derived: false };
}

/** Stable public path of a public template asset (web bg, decoration, thumbnail). */
export function designerAssetPath(assetId: string, ext: string): string {
  return `/api/designer/assets/${assetId}.${ext}`;
}

/** Stable public path of a self-hosted font file. */
export function designerFontPath(assetId: string, ext: string): string {
  return `/api/designer/fonts/${assetId}.${ext}`;
}

/** `PUBLIC_API_URL` + path when configured, else the path (same-origin proxy). */
export function absoluteApiUrl(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = env.PUBLIC_API_URL?.trim().replace(/\/+$/, '');
  return base ? `${base}${path}` : path;
}

/**
 * Injectable wrapper with the configured secret. Every method is sync.
 * Paths are relative to the API origin (`/api/designer/files/<token>`);
 * `absolute()` prefixes PUBLIC_API_URL for emails.
 */
@Injectable()
export class DesignerUrlsService {
  private readonly logger = new Logger(DesignerUrlsService.name);
  private readonly secret: string;

  constructor() {
    assertDesignerUrlSecret();
    const { secret, derived } = resolveDesignerUrlSecret();
    this.secret = secret;
    if (derived) {
      this.logger.warn(
        `${DESIGNER_URL_SECRET_ENV} is not set; signed designer links use a key derived from JWT_SECRET (development only).`,
      );
    }
  }

  /** Signed path for `kind`/`id` of `storeId`, valid for `ttlSec` (or until `expiresAt`). */
  signedPath(
    kind: DesignerLinkKind,
    id: string,
    storeId: string,
    opts: { ttlSec?: number; expiresAt?: Date; now?: number } = {},
  ): string {
    const now = opts.now ?? Date.now();
    let exp = opts.expiresAt
      ? Math.floor(opts.expiresAt.getTime() / 1000)
      : Math.floor(now / 1000) + (opts.ttlSec ?? DESIGNER_LINK_TTL.editor);
    exp = Math.min(exp, Math.floor(now / 1000) + DESIGNER_LINK_TTL.max);
    return (
      DESIGNER_FILES_PATH +
      signDesignerToken({ k: kind, id, s: storeId, exp }, this.secret)
    );
  }

  verify(token: string, nowMs?: number): DesignerTokenCheck {
    return verifyDesignerToken(token, this.secret, nowMs);
  }

  absolute(path: string): string {
    return absoluteApiUrl(path);
  }
}

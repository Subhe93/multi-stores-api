import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';

/**
 * JWT secret rotation.
 *
 * Tokens are always SIGNED with the current secret (JWT_SECRET for access and
 * purpose tokens, JWT_REFRESH_SECRET for refresh tokens). While a rotation is
 * in progress the previous secret can stay in JWT_SECRET_PREVIOUS /
 * JWT_REFRESH_SECRET_PREVIOUS so tokens issued before the switch keep
 * VERIFYING until they expire; nobody is logged out by the rotation itself.
 * Removing the *_PREVIOUS value ends the grace window.
 *
 * Runbook: plans/security-hardening/KEY-ROTATION.md (monorepo root, outside this package).
 */
export type JwtSecretKind = 'access' | 'refresh';

const ENV_KEYS: Record<JwtSecretKind, { current: string; previous: string }> = {
  access: { current: 'JWT_SECRET', previous: 'JWT_SECRET_PREVIOUS' },
  refresh: { current: 'JWT_REFRESH_SECRET', previous: 'JWT_REFRESH_SECRET_PREVIOUS' },
};

type ConfigReader = Pick<ConfigService, 'get'>;

/** Current secret first, then the previous one while it is set and differs. */
export function jwtSecrets(config: ConfigReader, kind: JwtSecretKind): string[] {
  const keys = ENV_KEYS[kind];
  const current = config.get<string>(keys.current);
  const previous = config.get<string>(keys.previous)?.trim();
  const out: string[] = [];
  if (current) out.push(current);
  if (previous && previous !== current) out.push(previous);
  return out;
}

/**
 * Verifies `token` with the current secret, then with the previous one.
 * On failure the error of the current-secret attempt is thrown, so an expired
 * token is still reported as expired rather than as a signature mismatch.
 */
export async function verifyWithRotation<T extends object>(
  jwt: Pick<JwtService, 'verifyAsync'>,
  config: ConfigReader,
  kind: JwtSecretKind,
  token: string,
): Promise<T> {
  const secrets = jwtSecrets(config, kind);
  let firstError: unknown;
  for (const secret of secrets) {
    try {
      return await jwt.verifyAsync<T>(token, { secret, algorithms: ['HS256'] });
    } catch (err) {
      firstError ??= err;
    }
  }
  throw firstError ?? new Error(`No ${kind} JWT secret configured`);
}

/**
 * Boot-time sanity check for the four secrets. Returns the problem, or null.
 * Rules: both current secrets set and different; a previous secret, when set,
 * differs from its current one and from the other kind's secrets (a refresh
 * token must never verify as an access token through a stale value).
 */
export function jwtSecretsProblem(env: Record<string, string | undefined>): string | null {
  const access = env.JWT_SECRET;
  const refresh = env.JWT_REFRESH_SECRET;
  if (!access || !refresh || access === refresh) {
    return 'JWT_SECRET and JWT_REFRESH_SECRET must both be set and must differ';
  }
  const accessPrev = env.JWT_SECRET_PREVIOUS?.trim();
  const refreshPrev = env.JWT_REFRESH_SECRET_PREVIOUS?.trim();
  const accessSet = new Set([access, accessPrev].filter(Boolean));
  const refreshSet = new Set([refresh, refreshPrev].filter(Boolean));
  for (const v of accessSet) {
    if (refreshSet.has(v)) {
      return 'JWT_SECRET(_PREVIOUS) and JWT_REFRESH_SECRET(_PREVIOUS) must not share a value';
    }
  }
  return null;
}

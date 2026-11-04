import { UserRole } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import type { AccountLinksService } from './account-links.service';
import type { AccountCredentialsService } from './account-credentials.service';
import type { MagicLinkService } from './magic-link.service';
import type { MailService } from '../mail/mail.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { TwoFactorService } from '../security/two-factor.service';

// JWT_CUSTOMER_EXPIRES_IN: an optional, separate access lifetime for
// storefront customers; staff keep JWT_EXPIRES_IN.

function build(env: Record<string, string>) {
  const config = { get: jest.fn((k: string) => env[k]) };
  const jwt = new JwtService({});
  const service = new AuthService(
    {} as PrismaService,
    jwt,
    config as unknown as ConfigService,
    {} as MailService,
    {} as MagicLinkService,
    {} as AccountLinksService,
    {} as AccountCredentialsService,
    {} as TwoFactorService,
  );
  return { service, jwt };
}

const base = {
  JWT_SECRET: 'a',
  JWT_REFRESH_SECRET: 'r',
  JWT_EXPIRES_IN: '15m',
  JWT_REFRESH_EXPIRES_IN: '7d',
};

async function accessLifetime(
  env: Record<string, string>,
  role: UserRole,
): Promise<number> {
  const { service, jwt } = build(env);
  const { access_token } = await service.issueTokens({
    id: 'u1',
    email: 'x@x.se',
    role,
    store_id: role === UserRole.CUSTOMER ? 's1' : null,
    tokens_valid_after: null,
  } as never);
  const p = jwt.decode<{ iat: number; exp: number }>(access_token);
  return p.exp - p.iat;
}

describe('access token lifetime per role', () => {
  it('uses JWT_EXPIRES_IN for everyone when no customer value is set', async () => {
    expect(await accessLifetime(base, UserRole.CUSTOMER)).toBe(15 * 60);
    expect(await accessLifetime(base, UserRole.ADMIN)).toBe(15 * 60);
  });

  it('gives customers JWT_CUSTOMER_EXPIRES_IN, staff unchanged', async () => {
    const env = { ...base, JWT_CUSTOMER_EXPIRES_IN: '7d' };
    expect(await accessLifetime(env, UserRole.CUSTOMER)).toBe(7 * 86400);
    expect(await accessLifetime(env, UserRole.CREATOR)).toBe(15 * 60);
  });
});

import { UnauthorizedException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import {
  AuthService,
  issuedAtFor,
  tokenIssuedAfterCutoff,
} from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import type { AccountLinksService } from './account-links.service';
import type { AccountCredentialsService } from './account-credentials.service';
import type { MagicLinkService } from './magic-link.service';
import type { MailService } from '../mail/mail.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import type { TwoFactorService } from '../security/two-factor.service';

/** Accounts in these specs have no 2FA. */
const noTwoFactor = {
  issueChallenge: jest.fn(),
  verifyLogin: jest.fn(),
} as unknown as TwoFactorService;

/** Narrows a login result to the signed-in shape. */
function signedIn<T>(r: T): Extract<T, { user: unknown }> {
  return r as Extract<T, { user: unknown }>;
}

/**
 * Revocation cutoff (User.tokens_valid_after) and the magic-login store
 * check. Real JWT signing/verification, in-memory user rows.
 */

const SECRET = 'access-secret';
const REFRESH = 'refresh-secret';

type Row = {
  id: string;
  email: string;
  role: UserRole;
  status: string;
  store_id: string | null;
  password_hash: string;
  tokens_valid_after: Date | null;
};

function build(initial: Partial<Row> = {}) {
  const user: Row = {
    id: 'u1',
    email: 'anna@x.se',
    role: UserRole.CUSTOMER,
    status: 'ACTIVE',
    store_id: 's1',
    password_hash: bcrypt.hashSync('Current-pw1', 4),
    tokens_valid_after: null,
    ...initial,
  };
  const prisma = {
    user: {
      findUnique: jest.fn(() => Promise.resolve({ ...user })),
      update: jest.fn(({ data }: { data: Partial<Row> }) => {
        Object.assign(user, data);
        return Promise.resolve({ ...user });
      }),
    },
    session: {
      findUnique: jest.fn(({ where }: { where: { token: string } }) =>
        Promise.resolve(
          where.token === 'reset-token'
            ? { expires_at: new Date(Date.now() + 60_000) }
            : null,
        ),
      ),
      deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
    },
  };
  const env: Record<string, string> = {
    JWT_SECRET: SECRET,
    JWT_REFRESH_SECRET: REFRESH,
    JWT_EXPIRES_IN: '15m',
    JWT_REFRESH_EXPIRES_IN: '7d',
  };
  const config = { get: jest.fn((k: string) => env[k]) };
  const jwt = new JwtService({});
  const magicLinks = {
    invalidateForUser: jest.fn(() => Promise.resolve()),
    peek: jest.fn(),
    consume: jest.fn(),
  };
  const links = {
    resolveRequestStore: jest.fn((slug?: string) =>
      slug === 'shop-a'
        ? Promise.resolve({ id: 's1', slug: 'shop-a' })
        : slug === 'shop-b'
          ? Promise.resolve({ id: 's2', slug: 'shop-b' })
          : Promise.reject(new Error('STORE_NOT_FOUND')),
    ),
  };
  const service = new AuthService(
    prisma as unknown as PrismaService,
    jwt,
    config as unknown as ConfigService,
    {} as MailService,
    magicLinks as unknown as MagicLinkService,
    links as unknown as AccountLinksService,
    {} as AccountCredentialsService,
    noTwoFactor,
  );
  const strategy = new JwtStrategy(
    config as unknown as ConfigService,
    prisma as unknown as PrismaService,
    new JwtService({}),
  );
  const sign = (iatSec: number, secret = SECRET) =>
    jwt.sign(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        store_id: user.store_id,
        iat: iatSec,
      },
      { secret, expiresIn: '1h' },
    );
  const access = (token: string) =>
    strategy.validate(undefined, jwt.verify(token, { secret: SECRET }));
  return {
    service,
    strategy,
    prisma,
    user,
    jwt,
    sign,
    access,
    magicLinks,
    links,
  };
}

const nowSec = () => Math.floor(Date.now() / 1000);

// Real bcrypt (cost 12 in the services): generous under a loaded full run.
jest.setTimeout(30_000);

describe('tokenIssuedAfterCutoff / issuedAtFor', () => {
  const cutoff = new Date('2026-11-01T10:00:00.400Z');
  const cutoffSec = Math.floor(cutoff.getTime() / 1000);

  it('no cutoff: every token passes', () => {
    expect(
      tokenIssuedAfterCutoff({ iat: 1 }, { tokens_valid_after: null }),
    ).toBe(true);
  });

  it('iat at or before the cutoff second is rejected, after it passes', () => {
    const u = { tokens_valid_after: cutoff };
    expect(tokenIssuedAfterCutoff({ iat: cutoffSec - 1 }, u)).toBe(false);
    expect(tokenIssuedAfterCutoff({ iat: cutoffSec }, u)).toBe(false);
    expect(tokenIssuedAfterCutoff({ iat: cutoffSec + 1 }, u)).toBe(true);
    expect(tokenIssuedAfterCutoff({}, u)).toBe(false);
  });

  it('a token minted in the cutoff second is dated after it', () => {
    const u = { tokens_valid_after: cutoff };
    expect(issuedAtFor(u, cutoff.getTime() + 300)).toBe(cutoffSec + 1);
    expect(issuedAtFor(u, cutoff.getTime() + 5000)).toBe(cutoffSec + 5);
    expect(issuedAtFor({ tokens_valid_after: null }, cutoff.getTime())).toBe(
      cutoffSec,
    );
  });
});

describe('JwtStrategy and refreshToken honour the cutoff', () => {
  it('rejects access tokens issued at or before the cutoff', async () => {
    const cutoff = new Date();
    const cutoffSec = Math.floor(cutoff.getTime() / 1000);
    const t = build({ tokens_valid_after: cutoff });
    await expect(t.access(t.sign(cutoffSec - 60))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(t.access(t.sign(cutoffSec))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(t.access(t.sign(cutoffSec + 1))).resolves.toMatchObject({
      id: 'u1',
      storeId: 's1',
    });
  });

  it('accepts any token while no cutoff is set', async () => {
    const t = build();
    await expect(t.access(t.sign(nowSec() - 600))).resolves.toMatchObject({
      id: 'u1',
    });
  });

  it('refresh: an old refresh token is dead after the cutoff, a later one works', async () => {
    const t = build();
    const old = t.sign(nowSec() - 60, REFRESH);
    t.user.tokens_valid_after = new Date();
    await expect(t.service.refreshToken(old)).rejects.toMatchObject({
      response: { code: 'AUTH_INVALID_REFRESH_TOKEN' },
    });
    const fresh = t.sign(nowSec() + 1, REFRESH);
    const pair = await t.service.refreshToken(fresh);
    expect(pair.access_token).toEqual(expect.any(String));
  });

  it('refresh: a purpose token (2FA challenge) is never exchanged for a session', async () => {
    // Staff: no store claim needed, so only the type check can refuse it.
    const t = build({ role: UserRole.ADMIN, store_id: null });
    // Signed with the refresh secret on purpose: even if the two secrets
    // were equal, the `type` claim alone must get it refused.
    const challenge = new JwtService({}).sign(
      { sub: 'u1', type: 'two_factor_challenge' },
      { secret: REFRESH, expiresIn: 300 },
    );
    await expect(t.service.refreshToken(challenge)).rejects.toMatchObject({
      response: { code: 'AUTH_INVALID_REFRESH_TOKEN' },
    });
  });
});

describe('cutoff is moved on password changes and blocks', () => {
  it('change-password revokes older tokens and returns a pair that works', async () => {
    const t = build();
    const before = t.sign(nowSec() - 5);
    const res = await t.service.changePassword(
      'u1',
      'Current-pw1',
      'New-password-1',
    );
    expect(t.user.tokens_valid_after).toBeInstanceOf(Date);
    await expect(t.access(before)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    // Same second as the cutoff, yet valid: iat is dated after it.
    await expect(t.access(res.access_token)).resolves.toMatchObject({
      id: 'u1',
    });
    await expect(t.service.refreshToken(res.refresh_token)).resolves.toEqual(
      expect.objectContaining({ access_token: expect.any(String) }),
    );
  });

  it('reset-password sets the cutoff', async () => {
    const t = build();
    t.jwt.verifyAsync = jest.fn(async () => ({
      sub: 'u1',
      type: 'password_reset',
    })) as never;
    await t.service.resetPassword('reset-token', 'New-password-1');
    expect(t.prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: {
        password_hash: expect.any(String),
        tokens_valid_after: expect.any(Date),
      },
    });
  });

  it('admin: status change to non-ACTIVE and password reset set the cutoff; ACTIVE does not', async () => {
    const update = jest.fn(() => Promise.resolve({}));
    const prisma = {
      user: {
        findUnique: jest.fn(() =>
          Promise.resolve({ id: 'u1', role: UserRole.CUSTOMER }),
        ),
        update,
      },
      session: { deleteMany: jest.fn(() => Promise.resolve({ count: 0 })) },
    };
    const users = new UsersService(
      prisma as unknown as PrismaService,
      { invalidateForUser: jest.fn() } as unknown as MagicLinkService,
      {} as AccountCredentialsService,
      {} as AccountLinksService,
    );
    await users.updateStatus('u1', 'BANNED');
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: { status: 'BANNED', tokens_valid_after: expect.any(Date) },
      }),
    );
    await users.updateStatus('u1', 'ACTIVE');
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { status: 'ACTIVE' } }),
    );
    await users.resetPassword('u1', 'New-password-1');
    expect(update).toHaveBeenLastCalledWith({
      where: { id: 'u1' },
      data: {
        password_hash: expect.any(String),
        tokens_valid_after: expect.any(Date),
      },
    });
  });
});

describe('magic-login store check (before the link is consumed)', () => {
  const customer = { userId: 'u1', role: UserRole.CUSTOMER, storeId: 's1' };
  const consumed = {
    id: 'u1',
    email: 'anna@x.se',
    role: UserRole.CUSTOMER,
    status: 'ACTIVE',
    store_id: 's1',
    tokens_valid_after: null,
  };

  it('same store: consumed and logged in', async () => {
    const t = build();
    t.magicLinks.peek.mockResolvedValue(customer);
    t.magicLinks.consume.mockResolvedValue(consumed);
    const res = await t.service.magicLogin('tok', { store_slug: 'shop-a' });
    expect(signedIn(res).user).toMatchObject({ id: 'u1', store_id: 's1' });
    expect(t.magicLinks.consume).toHaveBeenCalledWith('tok');
  });

  it.each([
    ['another store', { store_slug: 'shop-b' }, customer],
    ['an unknown store', { store_slug: 'nope' }, customer],
    [
      'a staff account',
      { store_slug: 'shop-a' },
      { userId: 'u1', role: UserRole.CREATOR, storeId: null },
    ],
    ['a dead link', { store_slug: 'shop-a' }, null],
  ])(
    '%s: 401 MAGIC_LINK_INVALID and the link is NOT consumed',
    async (_label, ctx, owner) => {
      const t = build();
      t.magicLinks.peek.mockResolvedValue(owner);
      const err = await t.service
        .magicLogin('tok', ctx)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as UnauthorizedException).getResponse()).toEqual({
        code: 'MAGIC_LINK_INVALID',
        message: 'This login link is invalid or has expired',
      });
      expect(t.magicLinks.consume).not.toHaveBeenCalled();
    },
  );

  it('without a store context (dashboard) no peek is made', async () => {
    const t = build();
    t.magicLinks.consume.mockResolvedValue({
      ...consumed,
      role: UserRole.CREATOR,
      store_id: null,
    });
    await t.service.magicLogin('tok');
    expect(t.magicLinks.peek).not.toHaveBeenCalled();
    expect(t.magicLinks.consume).toHaveBeenCalledWith('tok');
  });
});

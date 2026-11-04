import { UnauthorizedException } from '@nestjs/common';
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

/**
 * Logout revocation markers: a refresh token surrendered on one device must
 * stay revoked after the user logs out on another device.
 */

type SessionRow = {
  user_id: string;
  token: string;
  expires_at: Date;
  created_at: Date;
};

const REFRESH = 'refresh-secret';

function build() {
  const user = {
    id: 'u1',
    email: 'staff@x.se',
    role: UserRole.CREATOR,
    status: 'ACTIVE',
    store_id: null,
    tokens_valid_after: null,
    email_verified_at: new Date(),
  };
  let sessions: SessionRow[] = [];
  type Where = {
    user_id?: string;
    token?: string;
    expires_at?: Date | { gt: Date };
    created_at?: { lt: Date };
  };
  const matches = (s: SessionRow, w: Where) =>
    (w.user_id === undefined || s.user_id === w.user_id) &&
    (w.token === undefined || s.token === w.token) &&
    (w.expires_at === undefined ||
      (w.expires_at instanceof Date
        ? s.expires_at.getTime() === w.expires_at.getTime()
        : s.expires_at > w.expires_at.gt)) &&
    (w.created_at === undefined || s.created_at < w.created_at.lt);
  const prisma = {
    user: { findUnique: jest.fn(() => Promise.resolve({ ...user })) },
    session: {
      findUnique: jest.fn(({ where }: { where: { token: string } }) =>
        Promise.resolve(sessions.find((s) => s.token === where.token) ?? null),
      ),
      deleteMany: jest.fn(({ where }: { where: Where }) => {
        const before = sessions.length;
        sessions = sessions.filter((s) => !matches(s, where));
        return Promise.resolve({ count: before - sessions.length });
      }),
      upsert: jest.fn(
        ({
          where,
          update,
          create,
        }: {
          where: { token: string };
          update: Partial<SessionRow>;
          create: Omit<SessionRow, 'created_at'>;
        }) => {
          const row = sessions.find((s) => s.token === where.token);
          if (row) Object.assign(row, update);
          else sessions.push({ ...create, created_at: new Date() });
          return Promise.resolve({});
        },
      ),
    },
  };
  const env: Record<string, string> = {
    JWT_SECRET: 'access-secret',
    JWT_REFRESH_SECRET: REFRESH,
    JWT_EXPIRES_IN: '15m',
    JWT_REFRESH_EXPIRES_IN: '7d',
  };
  const config = { get: jest.fn((k: string) => env[k]) };
  const jwt = new JwtService({});
  const service = new AuthService(
    prisma as unknown as PrismaService,
    jwt,
    config as unknown as ConfigService,
    {} as MailService,
    {} as MagicLinkService,
    {} as AccountLinksService,
    {} as AccountCredentialsService,
    {} as TwoFactorService,
  );
  const refreshToken = (device: string) =>
    jwt.sign(
      { sub: user.id, email: user.email, role: user.role, device },
      { secret: REFRESH, expiresIn: '7d' },
    );
  return {
    service,
    refreshToken,
    sessions: () => sessions,
    addSession: (row: SessionRow) => sessions.push(row),
  };
}

describe('AuthService.logout revocation markers', () => {
  it('a token revoked on device 1 stays revoked after a logout on device 2', async () => {
    const { service, refreshToken } = build();
    const r1 = refreshToken('d1');
    const r2 = refreshToken('d2');

    await service.logout('u1', r1);
    await service.logout('u1', r2);

    await expect(service.refreshToken(r1)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(service.refreshToken(r2)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('logging out twice with the same token does not fail', async () => {
    const { service, refreshToken, sessions } = build();
    const r1 = refreshToken('d1');
    await service.logout('u1', r1);
    await service.logout('u1', r1);
    expect(sessions().filter((s) => s.token === r1)).toHaveLength(1);
  });

  it('drops live session rows but prunes only markers past retention', async () => {
    const { service, sessions, addSession } = build();
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    addSession({
      user_id: 'u1',
      token: 'reset-link',
      expires_at: new Date(Date.now() + 60_000),
      created_at: new Date(),
    });
    addSession({
      user_id: 'u1',
      token: 'old-marker',
      expires_at: new Date(0),
      created_at: old,
    });
    addSession({
      user_id: 'u1',
      token: 'recent-marker',
      expires_at: new Date(0),
      created_at: new Date(),
    });
    await service.logout('u1');
    expect(sessions().map((s) => s.token)).toEqual(['recent-marker']);
  });
});

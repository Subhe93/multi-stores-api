import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import type { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AccountLinksService } from './account-links.service';
import { AccountCredentialsService } from './account-credentials.service';
import type { MagicLinkService } from './magic-link.service';
import type { MailService } from '../mail/mail.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { TwoFactorService } from '../security/two-factor.service';

/** Accounts in these specs have no 2FA. */
const twoFactorMock = {
  issueChallenge: jest.fn(),
  verifyLogin: jest.fn(),
};
const noTwoFactor = twoFactorMock as unknown as TwoFactorService;

const RAW_TOKEN = 'RawMagicToken_abcdefghijklmnopqrstuvwxyz0123';

const activeStore = {
  id: 's1',
  slug: 'namez',
  name: 'Namez',
  custom_domain: 'namez.se',
  is_active: true,
  language_config: { primary_locale: 'sv' },
};

function build(
  opts: {
    existing?: Record<string, unknown> | null;
    store?: Record<string, unknown> | null;
    consumed?: Record<string, unknown> | null;
  } = {},
) {
  const prisma = {
    user: {
      findUnique: jest.fn((args: { where: { id?: string } }) =>
        Promise.resolve(
          args.where.id
            ? {
                id: args.where.id,
                password_hash: bcrypt.hashSync('Current-pw1', 4),
              }
            : (opts.existing ?? null),
        ),
      ),
      findFirst: jest.fn(() => Promise.resolve(null)),
      create: jest.fn(
        ({
          data,
        }: {
          data: { email: string; role: UserRole; store_id?: string | null };
        }) =>
          Promise.resolve({
            id: 'u-new',
            email: data.email,
            role: data.role,
            status: 'ACTIVE',
            store_id: data.store_id ?? null,
            created_at: new Date('2026-11-01T00:00:00Z'),
          }),
      ),
      update: jest.fn(() => Promise.resolve({})),
    },
    customer: { create: jest.fn(() => Promise.resolve({})) },
    creator: { create: jest.fn(() => Promise.resolve({})) },
    store: {
      findUnique: jest.fn(() => Promise.resolve(opts.store ?? null)),
    },
    storeDomain: { findFirst: jest.fn(() => Promise.resolve(null)) },
    session: {
      findUnique: jest.fn(() =>
        Promise.resolve({ expires_at: new Date(Date.now() + 60_000) }),
      ),
      deleteMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
  };
  const jwt = {
    signAsync: jest.fn((p: { sub: string }) => Promise.resolve(`jwt-${p.sub}`)),
    verify: jest.fn(() => ({ sub: 'u1', type: 'password_reset' })),
  };
  const env: Record<string, string> = {
    STOREFRONT_URL: 'https://stores.example.com',
    DASHBOARD_URL: 'https://dash.example.com',
    JWT_SECRET: 's',
    JWT_REFRESH_SECRET: 'r',
  };
  const config = { get: jest.fn((k: string) => env[k]) };
  const mail = {
    sendWelcome: jest.fn(() => Promise.resolve()),
    sendAccountCreated: jest.fn(() => Promise.resolve()),
    sendPasswordReset: jest.fn(() => Promise.resolve()),
    sendOnboarding: jest.fn(() => Promise.resolve({ sent: true })),
    adminRecipients: jest.fn(() => Promise.resolve([])),
  };
  const magicLinks = {
    issue: jest.fn(() => Promise.resolve(RAW_TOKEN)),
    consume: jest.fn(() => Promise.resolve(opts.consumed ?? null)),
    invalidateForUser: jest.fn(() => Promise.resolve()),
  };
  const storeApps = { isEnabled: jest.fn(() => Promise.resolve(false)) };
  const links = new AccountLinksService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
    storeApps as unknown as StoreAppsService,
  );
  const credentials = new AccountCredentialsService(
    magicLinks as unknown as MagicLinkService,
    links,
    mail as unknown as MailService,
  );
  const service = new AuthService(
    prisma as unknown as PrismaService,
    jwt as unknown as JwtService,
    config as unknown as ConfigService,
    mail as unknown as MailService,
    magicLinks as unknown as MagicLinkService,
    links,
    credentials,
    noTwoFactor,
  );
  return { service, prisma, mail, magicLinks, jwt };
}

/** Resolves once `check` passes (background email work is fire-and-forget). */
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(check()).toBe(true);
}

describe('AuthService.guestRegister', () => {
  it('creates a CUSTOMER with a generated password and mails it with a magic link on the store domain', async () => {
    const { service, prisma, mail, magicLinks } = build({
      store: activeStore,
    });
    const res = await service.guestRegister({
      email: ' Anna@Example.com ',
      first_name: 'Anna',
      last_name: 'S',
      phone: '+4670',
      store_slug: 'namez',
    });

    expect(res).toEqual({
      user: {
        id: 'u-new',
        email: 'anna@example.com',
        role: 'CUSTOMER',
        status: 'ACTIVE',
        store_id: 's1',
        created_at: expect.any(Date) as unknown,
      },
      access_token: 'jwt-u-new',
      refresh_token: 'jwt-u-new',
    });

    const data = (
      prisma.user.create.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(data).toMatchObject({
      email: 'anna@example.com',
      role: 'CUSTOMER',
      status: 'ACTIVE',
      store_id: 's1',
      customer: {
        create: { first_name: 'Anna', last_name: 'S', phone: '+4670' },
      },
    });

    await waitFor(() => mail.sendAccountCreated.mock.calls.length === 1);
    const [to, vars, locale, brand] = mail.sendAccountCreated.mock
      .calls[0] as unknown as [
      string,
      {
        password: string;
        magicUrl: string;
        loginUrl: string;
        expiresHours: number;
        email: string;
        name: string;
      },
      string,
      unknown,
    ];
    expect(to).toBe('anna@example.com');
    expect(vars).toMatchObject({
      name: 'Anna',
      email: 'anna@example.com',
      magicUrl: `https://namez.se/auth/magic#token=${RAW_TOKEN}`,
      loginUrl: 'https://namez.se/auth/login',
      expiresHours: 72,
    });
    expect(vars.password).toMatch(/^[A-Za-z2-9]{16}$/);
    // bcrypt 12 hash of exactly the mailed password.
    const hash = data.password_hash as string;
    expect(hash.startsWith('$2b$12$')).toBe(true);
    await expect(bcrypt.compare(vars.password, hash)).resolves.toBe(true);
    expect(locale).toBe('sv');
    expect(brand).toEqual({ storeId: 's1', storeName: 'Namez' });
    expect(magicLinks.issue).toHaveBeenCalledWith('u-new', {
      storeId: 's1',
      ttlHours: 72,
    });

    // Never in the response.
    expect(JSON.stringify(res)).not.toContain(vars.password);
  });

  it('without a store: 400 STORE_REQUIRED, nothing created or mailed', async () => {
    const { service, prisma, mail } = build();
    const err = await service
      .guestRegister({ email: 'a@b.se', locale: 'de' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'STORE_REQUIRED',
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(mail.sendAccountCreated).not.toHaveBeenCalled();
  });

  it('an unknown store slug: 400 STORE_NOT_FOUND', async () => {
    const { service } = build({ store: null });
    const err = await service
      .guestRegister({ email: 'a@b.se', store_slug: 'nope' })
      .catch((e: unknown) => e);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'STORE_NOT_FOUND',
    });
  });

  it('an inactive store: platform links, explicit locale, platform sender', async () => {
    const { service, mail, prisma } = build({
      store: { ...activeStore, is_active: false },
    });
    await service.guestRegister({
      email: 'a@b.se',
      store_slug: 'namez',
      locale: 'de',
    });
    // The account still belongs to the store.
    expect(
      (
        prisma.user.create.mock.calls[0] as unknown as [
          { data: { store_id: string } },
        ]
      )[0].data.store_id,
    ).toBe('s1');
    await waitFor(() => mail.sendAccountCreated.mock.calls.length === 1);
    const [, vars, locale, brand] = mail.sendAccountCreated.mock
      .calls[0] as unknown as [string, { magicUrl: string }, string, unknown];
    expect(vars.magicUrl).toBe(
      `https://stores.example.com/de/auth/magic#token=${RAW_TOKEN}`,
    );
    expect(locale).toBe('de');
    expect(brand).toBeNull();
  });

  it('an existing email in this store is the same 409 AUTH_EMAIL_EXISTS as register', async () => {
    const { service, prisma, mail } = build({
      store: activeStore,
      existing: { id: 'u1', email: 'a@b.se', role: 'CUSTOMER', store_id: 's1' },
    });
    const err = await service
      .guestRegister({ email: 'A@B.se', store_slug: 'namez' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'AUTH_EMAIL_EXISTS',
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(mail.sendAccountCreated).not.toHaveBeenCalled();
  });

  it('a concurrent duplicate (P2002) is also 409', async () => {
    const { service, prisma } = build({ store: activeStore });
    prisma.user.create.mockImplementationOnce(() =>
      Promise.reject(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'x',
        }),
      ),
    );
    await expect(
      service.guestRegister({ email: 'a@b.se', store_slug: 'namez' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('a failing mail never fails the signup nor logs the password', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { service, mail } = build({ store: activeStore });
    mail.sendAccountCreated.mockImplementationOnce(() =>
      Promise.reject(new Error('smtp down')),
    );
    const res = await service.guestRegister({
      email: 'a@b.se',
      store_slug: 'namez',
    });
    expect(res.access_token).toBe('jwt-u-new');
    await waitFor(() => warn.mock.calls.length === 1);
    const [, vars] = mail.sendAccountCreated.mock.calls[0] as unknown as [
      string,
      { password: string },
    ];
    expect(JSON.stringify(warn.mock.calls)).not.toContain(vars.password);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(RAW_TOKEN);
    warn.mockRestore();
  });
});

describe('AuthService.register with store context', () => {
  const dto = {
    email: 'Anna@Example.com',
    password: 'chosen-pass-1',
    role: UserRole.CUSTOMER,
    first_name: 'Anna',
  };

  it('brands and localizes the welcome email with the store, never a password', async () => {
    const { service, mail } = build({ store: activeStore });
    const res = await service.register({ ...dto, store_slug: 'namez' });
    expect(res.user.email).toBe('anna@example.com');
    await waitFor(() => mail.sendWelcome.mock.calls.length === 1);
    expect(mail.sendWelcome).toHaveBeenCalledWith(
      'anna@example.com',
      { name: 'Anna', loginUrl: 'https://namez.se/auth/login' },
      'sv',
      { storeId: 's1', storeName: 'Namez' },
    );
    expect(JSON.stringify(mail.sendWelcome.mock.calls)).not.toContain(
      dto.password,
    );
    expect(mail.sendAccountCreated).not.toHaveBeenCalled();
  });

  it('an explicit locale wins over the store primary locale', async () => {
    const { service, mail } = build({ store: activeStore });
    await service.register({ ...dto, store_slug: 'namez', locale: 'fr' });
    await waitFor(() => mail.sendWelcome.mock.calls.length === 1);
    expect((mail.sendWelcome.mock.calls[0] as unknown as unknown[])[2]).toBe(
      'fr',
    );
  });

  it('a customer without a store: 400 STORE_REQUIRED', async () => {
    const { service, prisma } = build();
    const err = await service.register(dto).catch((e: unknown) => e);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'STORE_REQUIRED',
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('a creator without a store: verification email and a single-use dashboard sign-in', async () => {
    const { service, mail, prisma, magicLinks } = build();
    const res = await service.register({
      ...dto,
      role: UserRole.CREATOR,
      account_kind: 'independent',
      accept_terms: true,
    });
    // The browser follows this straight away, so the link is short-lived.
    expect(magicLinks.issue).toHaveBeenCalledWith('u-new', { ttlHours: 0.25 });
    expect(res.dashboard_login_url).toBe(
      `https://dash.example.com/auth/magic#token=${RAW_TOKEN}`,
    );
    expect(
      (
        prisma.user.create.mock.calls[0] as unknown as [
          { data: { store_id: string | null } },
        ]
      )[0].data.store_id,
    ).toBeNull();
    // The welcome follows verification (SPEC §2); the first mail is the
    // verification link.
    await waitFor(() => mail.sendOnboarding.mock.calls.length >= 1);
    expect(mail.sendWelcome).not.toHaveBeenCalled();
    expect(
      (mail.sendOnboarding.mock.calls[0] as unknown as [string, string])[0],
    ).toBe('email_verification');
  });

  it('still rejects an existing email in the store with AUTH_EMAIL_EXISTS', async () => {
    const { service } = build({
      store: activeStore,
      existing: { id: 'u1', role: 'CUSTOMER', store_id: 's1' },
    });
    await expect(
      service.register({ ...dto, store_slug: 'namez' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('AuthService.magicLogin', () => {
  it('returns the login body for a consumed token', async () => {
    const { service, magicLinks } = build({
      consumed: {
        id: 'u1',
        email: 'a@b.se',
        role: 'CUSTOMER',
        status: 'ACTIVE',
        store_id: 's1',
        password_hash: 'secret-hash',
      },
    });
    const res = await service.magicLogin(RAW_TOKEN);
    expect(magicLinks.consume).toHaveBeenCalledWith(RAW_TOKEN);
    expect(res).toEqual({
      user: {
        id: 'u1',
        email: 'a@b.se',
        role: 'CUSTOMER',
        status: 'ACTIVE',
        store_id: 's1',
      },
      access_token: 'jwt-u1',
      refresh_token: 'jwt-u1',
    });
  });

  it('a link never bypasses 2FA: challenge instead of tokens', async () => {
    const { service, prisma, jwt } = build({
      consumed: {
        id: 'u2',
        email: 'c@b.se',
        role: 'CREATOR',
        status: 'ACTIVE',
        store_id: null,
      },
    });
    prisma.user.findUnique.mockResolvedValueOnce({
      totp_enabled_at: new Date(),
      totp_secret: 'v1:enc',
    } as never);
    twoFactorMock.issueChallenge.mockResolvedValueOnce({
      requires_2fa: true,
      challenge_token: 'challenge',
      expires_in: 300,
    });
    const res = await service.magicLogin(RAW_TOKEN);
    expect(res).toEqual({
      requires_2fa: true,
      challenge_token: 'challenge',
      expires_in: 300,
    });
    expect(twoFactorMock.issueChallenge).toHaveBeenCalledWith('u2');
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  it('answers unknown / expired / used / inactive with the same 401', async () => {
    const { service } = build({ consumed: null });
    const err = await service.magicLogin('whatever').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).getResponse()).toEqual({
      code: 'MAGIC_LINK_INVALID',
      message: 'This login link is invalid or has expired',
    });
  });
});

describe('AuthService.login with 2FA', () => {
  it('a right password on a 2FA account returns a challenge, no tokens', async () => {
    const { service, prisma, jwt } = build();
    prisma.user.findFirst.mockResolvedValueOnce({
      id: 'u3',
      email: 'admin@b.se',
      role: 'ADMIN',
      status: 'ACTIVE',
      store_id: null,
      password_hash: bcrypt.hashSync('Right-pw1', 4),
      totp_enabled_at: new Date(),
      totp_secret: 'v1:enc',
    } as never);
    twoFactorMock.issueChallenge.mockResolvedValueOnce({
      requires_2fa: true,
      challenge_token: 'c',
      expires_in: 300,
    });
    const res = await service.login({
      email: 'admin@b.se',
      password: 'Right-pw1',
    });
    expect(res).toMatchObject({ requires_2fa: true });
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });
});

describe('AuthService password changes invalidate magic links', () => {
  it('resetPassword', async () => {
    const { service, magicLinks } = build();
    await service.resetPassword('reset-jwt', 'new-password-1');
    expect(magicLinks.invalidateForUser).toHaveBeenCalledWith('u1');
  });

  it('changePassword', async () => {
    const { service, magicLinks } = build();
    await service.changePassword('u9', 'Current-pw1', 'new-password-1');
    expect(magicLinks.invalidateForUser).toHaveBeenCalledWith('u9');
  });
});

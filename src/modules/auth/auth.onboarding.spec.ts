import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { UserRole, UserStatus } from '@prisma/client';
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
import { JwtStrategy } from './strategies/jwt.strategy';
import type { TurnstileService } from '../../common/security/turnstile.service';

// Platform onboarding (SPEC §2): staff sign-up with account kinds, the
// honeypot, terms and disposable-domain rules, PENDING accounts, email
// verification + resend, and the grace-period behaviour of the JWT strategy.

const RAW_TOKEN = 'RawVerifyToken_abcdefghijklmnopqrstuvwxyz012';
const twoFactor = {
  issueChallenge: jest.fn(),
  verifyLogin: jest.fn(),
} as unknown as TwoFactorService;

function build(
  opts: {
    existing?: Record<string, unknown> | null;
    consumed?: Record<string, unknown> | null;
    recent?: number;
    /** Turnstile stub (wave 3); omitted = no captcha wired. */
    turnstile?: { enabled: boolean; verify: jest.Mock };
  } = {},
) {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    user: {
      findUnique: jest.fn(() => Promise.resolve(opts.existing ?? null)),
      findFirst: jest.fn(() => Promise.resolve(null)),
      create: jest.fn(
        ({
          data,
        }: {
          data: {
            email: string;
            role: UserRole;
            status: UserStatus;
            store_id?: string | null;
            email_verified_at: Date | null;
          };
        }) => {
          created.push(data);
          return Promise.resolve({
            id: 'u-new',
            email: data.email,
            role: data.role,
            status: data.status,
            store_id: data.store_id ?? null,
            created_at: new Date('2026-11-01T00:00:00Z'),
          });
        },
      ),
      update: jest.fn(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...(opts.consumed ?? {}), ...data }),
      ),
    },
    customer: { create: jest.fn(() => Promise.resolve({})) },
    creator: {
      create: jest.fn(() => Promise.resolve({})),
      findUnique: jest.fn(() => Promise.resolve({ display_name: 'Anna' })),
    },
    provider: {
      create: jest.fn(() => Promise.resolve({})),
      findUnique: jest.fn(() =>
        Promise.resolve({ company_name: 'Acme', contact_name: 'Sam Supplier' }),
      ),
    },
    platformConfig: {
      findFirst: jest.fn(() =>
        Promise.resolve({ support_email: 'help@x.se', default_locale: 'en' }),
      ),
    },
    loginToken: { deleteMany: jest.fn(() => Promise.resolve({ count: 0 })) },
    store: { findUnique: jest.fn(() => Promise.resolve(null)) },
    storeDomain: { findFirst: jest.fn(() => Promise.resolve(null)) },
    session: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
    },
  };
  const jwt = {
    signAsync: jest.fn((p: { sub: string }) => Promise.resolve(`jwt-${p.sub}`)),
    verify: jest.fn(),
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
    sendOnboarding: jest.fn(() => Promise.resolve({ sent: true })),
    adminRecipients: jest.fn(() => Promise.resolve(['admin@x.se'])),
  };
  const magicLinks = {
    issue: jest.fn(() => Promise.resolve(RAW_TOKEN)),
    consume: jest.fn(() => Promise.resolve(opts.consumed ?? null)),
    countRecent: jest.fn(() => Promise.resolve(opts.recent ?? 0)),
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
    twoFactor,
    opts.turnstile as unknown as TurnstileService | undefined,
  );
  return { service, prisma, mail, magicLinks, created };
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(check()).toBe(true);
}

const base = {
  email: 'Anna@Example.com',
  password: 'chosen-pass-1',
  first_name: 'Anna',
  last_name: 'Svensson',
  accept_terms: true,
  country: 'se',
};

async function code(p: Promise<unknown>): Promise<string | undefined> {
  const err = await p.catch((e: unknown) => e);
  return (err as { getResponse?: () => { code?: string } }).getResponse?.()
    ?.code;
}

describe('AuthService.register (Turnstile, wave 3)', () => {
  it('staff sign-up verifies the token with the client IP before any lookup; a refusal creates nothing', async () => {
    const verify = jest.fn(() =>
      Promise.reject(
        new BadRequestException({ code: 'AUTH_CAPTCHA_FAILED', message: 'x' }),
      ),
    );
    const { service, prisma, created } = build({
      turnstile: { enabled: true, verify },
    });
    expect(
      await code(
        service.register(
          { ...base, account_kind: 'independent', turnstile_token: 'tok' },
          { ip: '203.0.113.9' },
        ),
      ),
    ).toBe('AUTH_CAPTCHA_FAILED');
    expect(verify).toHaveBeenCalledWith('tok', '203.0.113.9', {
      hostnames: expect.arrayContaining(['localhost']) as unknown,
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it('an accepted token lets the sign-up through', async () => {
    const verify = jest.fn(() => Promise.resolve());
    const { service, created } = build({
      turnstile: { enabled: true, verify },
    });
    await service.register(
      { ...base, account_kind: 'independent', turnstile_token: 'tok' },
      { ip: '203.0.113.9' },
    );
    expect(verify).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
  });

  it('storefront customers are never asked for a token', async () => {
    const verify = jest.fn(() => Promise.resolve());
    const { service } = build({ turnstile: { enabled: true, verify } });
    // Customers need a store; the 400 STORE_REQUIRED comes after the staff
    // branch, which is the only one that calls the verifier.
    await service
      .register({ ...base, role: UserRole.CUSTOMER })
      .catch(() => undefined);
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('AuthService.register (platform onboarding)', () => {
  it('independent → PENDING CREATOR with onboarding_profile, last name kept, verification email', async () => {
    const { service, prisma, mail, created, magicLinks } = build();
    const res = await service.register({
      ...base,
      account_kind: 'independent',
    });
    expect(created[0]).toMatchObject({
      role: UserRole.CREATOR,
      status: UserStatus.PENDING,
      email_verified_at: null,
      store_id: null,
    });
    expect(prisma.creator.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        display_name: 'Anna',
        last_name: 'Svensson',
        onboarding_profile: { account_kind: 'independent', country: 'SE' },
      }),
    });
    expect(res.user.status).toBe(UserStatus.PENDING);
    expect(res.dashboard_login_url).toContain('/auth/magic#token=');
    await waitFor(() => mail.sendOnboarding.mock.calls.length >= 2);
    const events = mail.sendOnboarding.mock.calls.map(
      (c) => (c as unknown as [string])[0],
    );
    expect(events).toContain('email_verification');
    expect(events).toContain('admin_new_signup');
    expect(mail.sendWelcome).not.toHaveBeenCalled();
    expect(magicLinks.issue).toHaveBeenCalledWith('u-new', {
      purpose: 'EMAIL_VERIFY',
    });
    const verification = mail.sendOnboarding.mock.calls.find(
      (c) => (c as unknown as [string])[0] === 'email_verification',
    ) as unknown as [string, string, Record<string, string>, string, unknown];
    expect(verification[1]).toBe('anna@example.com');
    expect(verification[2].verify_url).toBe(
      `https://dash.example.com/auth/verify#token=${RAW_TOKEN}`,
    );
    expect(verification[2].expires_hours).toBe('24');
  });

  it('marketplace → CREATOR with account_kind marketplace', async () => {
    const { service, prisma } = build();
    await service.register({ ...base, account_kind: 'marketplace' });
    expect(prisma.creator.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        onboarding_profile: expect.objectContaining({
          account_kind: 'marketplace',
        }),
      }),
    });
  });

  it('supplier → PENDING PROVIDER with company, contact name and country (no US default)', async () => {
    const { service, prisma, created } = build();
    await service.register({
      ...base,
      account_kind: 'supplier',
      company_name: 'Acme Prints',
    });
    expect(created[0]).toMatchObject({
      role: UserRole.PROVIDER,
      status: UserStatus.PENDING,
    });
    expect(prisma.provider.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        company_name: 'Acme Prints',
        contact_name: 'Anna Svensson',
        country: 'SE',
      }),
    });
    const noCountry = build();
    await noCountry.service.register({
      ...base,
      country: undefined,
      account_kind: 'supplier',
      company_name: 'Acme',
    });
    expect(noCountry.prisma.provider.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ country: null }),
    });
  });

  it('supplier without a company name → 400 AUTH_COMPANY_NAME_REQUIRED', async () => {
    const { service } = build();
    expect(
      await code(service.register({ ...base, account_kind: 'supplier' })),
    ).toBe('AUTH_COMPANY_NAME_REQUIRED');
  });

  it('honeypot filled → a fake 200 body and nothing created or mailed', async () => {
    const { service, prisma, mail } = build();
    const res = await service.register({
      ...base,
      account_kind: 'independent',
      website: 'http://spam.example',
    });
    expect(res.access_token).toBe('');
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(mail.sendOnboarding).not.toHaveBeenCalled();
  });

  it('staff sign-ups: 5 per IP per hour → 429 AUTH_SIGNUP_RATE_LIMITED; customers unaffected', async () => {
    const { service } = build();
    const staff = { ...base, account_kind: 'independent' as const };
    for (let i = 0; i < 5; i++) {
      await service.register({ ...staff, email: `u${i}@example.com` }, { ip: '9.9.9.9' });
    }
    const err = await service
      .register({ ...staff, email: 'u6@example.com' }, { ip: '9.9.9.9' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toMatchObject({
      code: 'AUTH_SIGNUP_RATE_LIMITED',
    });
    // Another address and an unknown address are not limited.
    await expect(
      service.register({ ...staff, email: 'u7@example.com' }, { ip: '8.8.8.8' }),
    ).resolves.toBeDefined();
    await expect(
      service.register({ ...staff, email: 'u8@example.com' }),
    ).resolves.toBeDefined();
    // A customer sign-up from the capped address goes through the store
    // path (fails on the missing store, not on the limiter).
    expect(
      await code(
        service.register(
          { email: 'c@example.com', password: base.password, role: UserRole.CUSTOMER },
          { ip: '9.9.9.9' },
        ),
      ),
    ).toBe('STORE_REQUIRED');
  });

  it('terms not accepted → 400 AUTH_TERMS_REQUIRED', async () => {
    const { service, prisma } = build();
    expect(
      await code(
        service.register({
          ...base,
          account_kind: 'independent',
          accept_terms: false,
        }),
      ),
    ).toBe('AUTH_TERMS_REQUIRED');
    expect(
      await code(
        service.register({
          ...base,
          account_kind: 'independent',
          accept_terms: undefined,
        }),
      ),
    ).toBe('AUTH_TERMS_REQUIRED');
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('disposable email domain → 400 AUTH_EMAIL_DISPOSABLE', async () => {
    const { service } = build();
    const err = await service
      .register({
        ...base,
        email: 'x@mailinator.com',
        account_kind: 'independent',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'AUTH_EMAIL_DISPOSABLE',
    });
  });

  it('a staff sign-up without account_kind is refused; ADMIN stays refused', async () => {
    const { service } = build();
    expect(
      await code(service.register({ ...base, role: UserRole.CREATOR })),
    ).toBe('AUTH_ACCOUNT_KIND_REQUIRED');
    const err = await service
      .register({ ...base, role: UserRole.ADMIN })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
  });

  it('the customer path is unchanged: ACTIVE, no account kind or terms needed', async () => {
    const { service, created } = build();
    const store = {
      id: 's1',
      slug: 'namez',
      name: 'Namez',
      custom_domain: null,
      is_active: true,
      language_config: { primary_locale: 'sv' },
    };
    const t = build();
    t.prisma.store.findUnique.mockResolvedValue(store as never);
    const res = await t.service.register({
      email: base.email,
      password: base.password,
      role: UserRole.CUSTOMER,
      first_name: 'Anna',
      store_slug: 'namez',
    });
    expect(res.user.status).toBe(UserStatus.ACTIVE);
    expect(t.created[0]).toMatchObject({ status: UserStatus.ACTIVE });
    expect(t.created[0].email_verified_at).toBeInstanceOf(Date);
    void service;
    void created;
  });
});

describe('AuthService.verifyEmail / resendVerification', () => {
  const pendingUser = {
    id: 'u1',
    email: 'anna@example.com',
    role: UserRole.CREATOR,
    status: UserStatus.PENDING,
    store_id: null,
    email_verified_at: null,
    totp_enabled_at: null,
    totp_secret: null,
    tokens_valid_after: null,
    created_at: new Date('2026-11-01T00:00:00Z'),
  };

  it('a valid token activates the account, returns a session and sends welcome_owner', async () => {
    const { service, prisma, mail, magicLinks } = build({
      consumed: pendingUser,
      existing: { totp_enabled_at: null, totp_secret: null },
    });
    const res = await service.verifyEmail(RAW_TOKEN);
    expect(magicLinks.consume).toHaveBeenCalledWith(RAW_TOKEN, 'EMAIL_VERIFY');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: expect.objectContaining({
        status: UserStatus.ACTIVE,
        email_verified_at: expect.any(Date),
      }),
    });
    expect(prisma.loginToken.deleteMany).toHaveBeenCalledWith({
      where: { user_id: 'u1', purpose: 'EMAIL_VERIFY' },
    });
    expect(res).toMatchObject({
      user: { id: 'u1', status: UserStatus.ACTIVE },
      access_token: 'jwt-u1',
      refresh_token: 'jwt-u1',
    });
    await waitFor(() => mail.sendOnboarding.mock.calls.length === 1);
    expect(mail.sendOnboarding).toHaveBeenCalledWith(
      'welcome_owner',
      'anna@example.com',
      {
        name: 'Anna',
        dashboard_url: 'https://dash.example.com',
        support_email: 'help@x.se',
      },
      'en',
    );
  });

  it('a supplier gets welcome_supplier', async () => {
    const { service, mail } = build({
      consumed: { ...pendingUser, role: UserRole.PROVIDER },
      existing: { totp_enabled_at: null, totp_secret: null },
    });
    await service.verifyEmail(RAW_TOKEN);
    await waitFor(() => mail.sendOnboarding.mock.calls.length === 1);
    expect(mail.sendOnboarding).toHaveBeenCalledWith(
      'welcome_supplier',
      'anna@example.com',
      expect.objectContaining({ company_name: 'Acme', name: 'Sam Supplier' }),
      'en',
    );
  });

  it('unknown / used / expired → 401 EMAIL_VERIFY_INVALID', async () => {
    const { service, prisma } = build({ consumed: null });
    const err = await service.verifyEmail('nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).getResponse()).toMatchObject({
      code: 'EMAIL_VERIFY_INVALID',
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('resend: new token + email for a PENDING user, 3/hour, refused once verified', async () => {
    const { service, mail, magicLinks } = build({ existing: pendingUser });
    await service.resendVerification('u1');
    expect(magicLinks.issue).toHaveBeenCalledWith('u1', {
      purpose: 'EMAIL_VERIFY',
    });
    expect(mail.sendOnboarding).toHaveBeenCalledWith(
      'email_verification',
      'anna@example.com',
      expect.objectContaining({ name: 'Anna' }),
      undefined,
      { sensitive: [RAW_TOKEN] },
    );

    const limited = build({ existing: pendingUser, recent: 3 });
    const err = await limited.service
      .resendVerification('u1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);

    const verified = build({
      existing: {
        ...pendingUser,
        status: UserStatus.ACTIVE,
        email_verified_at: new Date(),
      },
    });
    expect(await code(verified.service.resendVerification('u1'))).toBe(
      'AUTH_ALREADY_VERIFIED',
    );
  });
});

describe('PENDING staff accounts and sessions', () => {
  it('login accepts a PENDING creator, refuses a PENDING customer', async () => {
    const hash = bcrypt.hashSync('chosen-pass-1', 4);
    const pendingCreator = {
      id: 'u1',
      email: 'anna@example.com',
      password_hash: hash,
      role: UserRole.CREATOR,
      status: UserStatus.PENDING,
      store_id: null,
      totp_enabled_at: null,
      totp_secret: null,
      tokens_valid_after: null,
    };
    const t = build();
    t.prisma.user.findFirst.mockResolvedValue(pendingCreator as never);
    const res = await t.service.login({
      email: 'anna@example.com',
      password: 'chosen-pass-1',
    });
    expect(res).toMatchObject({ user: { status: UserStatus.PENDING } });

    const c = build();
    const store = {
      id: 's1',
      slug: 'namez',
      name: 'Namez',
      custom_domain: null,
      is_active: true,
      language_config: null,
    };
    c.prisma.store.findUnique.mockResolvedValue(store as never);
    c.prisma.user.findUnique.mockResolvedValue({
      ...pendingCreator,
      role: UserRole.CUSTOMER,
      store_id: 's1',
    } as never);
    const err = await c.service
      .login({ email: 'anna@example.com', password: 'chosen-pass-1', store_slug: 'namez' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
  });

  it('getProfile exposes email_verified_at and the verification deadline while PENDING', async () => {
    const t = build({
      existing: {
        id: 'u1',
        email: 'anna@example.com',
        role: UserRole.CREATOR,
        status: UserStatus.PENDING,
        avatar_url: null,
        store_id: null,
        store: null,
        created_at: new Date('2026-11-01T00:00:00Z'),
        provider: null,
        creator: {},
        customer: null,
        totp_enabled_at: null,
        email_verified_at: null,
      },
    });
    const profile = await t.service.getProfile('u1');
    expect(profile.email_verified_at).toBeNull();
    expect(profile.verification_deadline?.toISOString()).toBe(
      '2026-11-08T00:00:00.000Z',
    );
  });
});

describe('JwtStrategy grace period', () => {
  function strategy(user: Record<string, unknown>) {
    const prisma = {
      user: { findUnique: jest.fn(() => Promise.resolve(user)) },
    } as unknown as PrismaService;
    const config = { get: () => 'secret' } as unknown as ConfigService;
    return new JwtStrategy(config, prisma);
  }
  const pending = {
    id: 'u1',
    email: 'a@b.se',
    role: UserRole.CREATOR,
    status: UserStatus.PENDING,
    store_id: null,
    tokens_valid_after: null,
    email_verified_at: null,
    created_at: new Date(Date.now() - 2 * 24 * 3600_000),
  };
  const payload = { sub: 'u1', role: UserRole.CREATOR, store_id: null };

  it('inside the grace period a PENDING creator may write', async () => {
    const s = strategy(pending);
    await expect(
      s.validate({ method: 'POST', originalUrl: '/api/products', url: '/api/products' }, payload),
    ).resolves.toMatchObject({ id: 'u1', status: UserStatus.PENDING });
  });

  it('after 7 days only exempt requests pass (403 ACCOUNT_EMAIL_UNVERIFIED_EXPIRED)', async () => {
    const old = { ...pending, created_at: new Date(Date.now() - 8 * 24 * 3600_000) };
    const s = strategy(old);
    const err = await s
      .validate({ method: 'POST', originalUrl: '/api/products', url: '/api/products' }, payload)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({
      code: 'ACCOUNT_EMAIL_UNVERIFIED_EXPIRED',
    });
    await expect(
      s.validate({ method: 'GET', originalUrl: '/api/stores/my/store', url: '' }, payload),
    ).resolves.toMatchObject({ id: 'u1' });
    await expect(
      s.validate(
        { method: 'POST', originalUrl: '/api/auth/resend-verification', url: '' },
        payload,
      ),
    ).resolves.toMatchObject({ id: 'u1' });
  });

  it('a PENDING customer token is still refused', async () => {
    const s = strategy({ ...pending, role: UserRole.CUSTOMER, store_id: 's1' });
    await expect(
      s.validate(undefined, { ...payload, role: UserRole.CUSTOMER, store_id: 's1' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import type { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import { AuthService, tokenStoreMatches } from './auth.service';
import { AccountLinksService } from './account-links.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import type { AccountCredentialsService } from './account-credentials.service';
import type { MagicLinkService } from './magic-link.service';
import type { MailService } from '../mail/mail.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
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
 * Customer accounts per store (plans/customer-per-store): login, register,
 * forgot-password and tokens against a small in-memory User table that
 * enforces the same uniqueness as the DB (staff email unique where
 * store_id IS NULL, customers unique per (store_id, email)).
 */

interface Row {
  id: string;
  email: string;
  password_hash: string;
  role: UserRole;
  status: string;
  store_id: string | null;
  created_at: Date;
}

const STORES = [
  { id: 'sa', slug: 'store-a', name: 'Store A' },
  { id: 'sb', slug: 'store-b', name: 'Store B' },
];

type EmailFilter = string | { equals: string; mode?: string };
interface Where {
  id?: string | { not: string };
  email?: EmailFilter;
  store_id?: string | null;
  role?: UserRole | { not: UserRole };
  store_id_email?: { store_id: string; email: string };
}

function matches(row: Row, where: Where): boolean {
  if (where.store_id_email) {
    return (
      row.store_id === where.store_id_email.store_id &&
      row.email === where.store_id_email.email
    );
  }
  if (typeof where.id === 'string' && row.id !== where.id) return false;
  if (typeof where.id === 'object' && row.id === where.id.not) return false;
  if ('store_id' in where && row.store_id !== where.store_id) return false;
  if (typeof where.role === 'string' && row.role !== where.role) return false;
  if (typeof where.role === 'object' && row.role === where.role.not)
    return false;
  if (typeof where.email === 'string' && row.email !== where.email)
    return false;
  if (
    typeof where.email === 'object' &&
    row.email.toLowerCase() !== where.email.equals.toLowerCase()
  )
    return false;
  return true;
}

function build() {
  const rows: Row[] = [];
  let seq = 0;
  const p2002 = () =>
    Object.assign(new Error('unique'), {
      code: 'P2002',
    });
  const prisma = {
    user: {
      findUnique: jest.fn(({ where }: { where: Where }) =>
        Promise.resolve(rows.find((r) => matches(r, where)) ?? null),
      ),
      findFirst: jest.fn(({ where }: { where: Where }) =>
        Promise.resolve(rows.find((r) => matches(r, where)) ?? null),
      ),
      create: jest.fn(({ data }: { data: Partial<Row> }) => {
        const storeId = data.store_id ?? null;
        const clash = rows.some(
          (r) => r.store_id === storeId && r.email === data.email,
        );
        if (clash) return Promise.reject(p2002());
        const row: Row = {
          id: `u${++seq}`,
          email: data.email!,
          password_hash: data.password_hash!,
          role: data.role!,
          status: 'ACTIVE',
          store_id: storeId,
          created_at: new Date(),
        };
        rows.push(row);
        return Promise.resolve(row);
      }),
    },
    customer: { create: jest.fn(() => Promise.resolve({})) },
    creator: { create: jest.fn(() => Promise.resolve({})) },
    store: {
      findUnique: jest.fn(({ where }: { where: { slug: string } }) => {
        const s = STORES.find((x) => x.slug === where.slug);
        return Promise.resolve(
          s
            ? {
                ...s,
                custom_domain: null,
                is_active: true,
                language_config: { primary_locale: 'sv' },
              }
            : null,
        );
      }),
    },
    storeDomain: {
      findFirst: jest.fn(({ where }: { where: { hostname: string } }) =>
        Promise.resolve(
          where.hostname === 'shop-b.se'
            ? { store_id: 'sb', store: { slug: 'store-b' } }
            : null,
        ),
      ),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    session: {
      create: jest.fn(() => Promise.resolve({})),
      findUnique: jest.fn(() => Promise.resolve(null)),
    },
  };
  const signed: Record<string, unknown>[] = [];
  let verifyResult: Record<string, unknown> = {};
  const jwt = {
    signAsync: jest.fn((p: Record<string, unknown>) => {
      signed.push(p);
      return Promise.resolve(`jwt-${String(p.sub)}`);
    }),
    verify: jest.fn(() => verifyResult),
  };
  const env: Record<string, string> = {
    STOREFRONT_URL: 'https://stores.example.com',
    JWT_SECRET: 's',
    JWT_REFRESH_SECRET: 'r',
  };
  const config = { get: jest.fn((k: string) => env[k]) };
  const mail = {
    sendWelcome: jest.fn(() => Promise.resolve()),
    sendOnboarding: jest.fn(() => Promise.resolve({ sent: true })),
    adminRecipients: jest.fn(() => Promise.resolve([])),
    sendPasswordReset: jest.fn(() => Promise.resolve()),
  };
  const storeApps = { isEnabled: jest.fn(() => Promise.resolve(false)) };
  const links = new AccountLinksService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
    storeApps as unknown as StoreAppsService,
  );
  const service = new AuthService(
    prisma as unknown as PrismaService,
    jwt as unknown as JwtService,
    config as unknown as ConfigService,
    mail as unknown as MailService,
    { issue: jest.fn(() => Promise.resolve('raw-token')) } as unknown as MagicLinkService,
    links,
    {
      send: jest.fn(() => Promise.resolve()),
    } as unknown as AccountCredentialsService,
    noTwoFactor,
  );
  const strategy = new JwtStrategy(
    config as unknown as ConfigService,
    prisma as unknown as PrismaService,
  );
  const add = (r: Partial<Row> & { password: string }) => {
    rows.push({
      id: r.id ?? `seed${rows.length}`,
      email: r.email!,
      password_hash: bcrypt.hashSync(r.password, 4),
      role: r.role ?? UserRole.CUSTOMER,
      status: 'ACTIVE',
      store_id: r.store_id ?? null,
      created_at: new Date(),
    });
  };
  return {
    service,
    strategy,
    prisma,
    mail,
    rows,
    signed,
    add,
    setVerify: (v: Record<string, unknown>) => (verifyResult = v),
  };
}

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
}

function bodyOf(e: unknown): unknown {
  return (e as { getResponse(): unknown }).getResponse();
}

const INVALID = {
  code: 'AUTH_INVALID_CREDENTIALS',
  message: 'Invalid credentials',
};

describe('login is store scoped', () => {
  it('same email in two stores with different passwords: each logs in to its own account', async () => {
    const t = build();
    t.add({
      id: 'ca',
      email: 'anna@x.se',
      password: 'pass-A-1',
      store_id: 'sa',
    });
    t.add({
      id: 'cb',
      email: 'anna@x.se',
      password: 'pass-B-1',
      store_id: 'sb',
    });

    const a = await t.service.login({
      email: 'Anna@X.se',
      password: 'pass-A-1',
      store_slug: 'store-a',
    });
    expect(signedIn(a).user).toEqual({
      id: 'ca',
      email: 'anna@x.se',
      role: 'CUSTOMER',
      status: 'ACTIVE',
      store_id: 'sa',
    });
    const b = await t.service.login({
      email: 'anna@x.se',
      password: 'pass-B-1',
      store_slug: 'store-b',
    });
    expect(signedIn(b).user.id).toBe('cb');

    // Store A's password does not open store B's account.
    const err = await errorOf(
      t.service.login({
        email: 'anna@x.se',
        password: 'pass-A-1',
        store_slug: 'store-b',
      }),
    );
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(bodyOf(err)).toEqual(INVALID);
  });

  it("finds only that store's customer (no account there = generic 401)", async () => {
    const t = build();
    t.add({ email: 'anna@x.se', password: 'pass-A-1', store_id: 'sa' });
    const err = await errorOf(
      t.service.login({
        email: 'anna@x.se',
        password: 'pass-A-1',
        store_slug: 'store-b',
      }),
    );
    expect(bodyOf(err)).toEqual(INVALID);
  });

  it('staff log in without a store; a customer without a store gets the same generic 401', async () => {
    const t = build();
    t.add({
      id: 'cr',
      email: 'owner@x.se',
      password: 'owner-pw-1',
      role: UserRole.CREATOR,
    });
    t.add({ email: 'anna@x.se', password: 'pass-A-1', store_id: 'sa' });

    const staff = await t.service.login({
      email: 'owner@x.se',
      password: 'owner-pw-1',
    });
    expect(signedIn(staff).user).toMatchObject({
      id: 'cr',
      role: 'CREATOR',
      store_id: null,
    });

    const customer = await errorOf(
      t.service.login({ email: 'anna@x.se', password: 'pass-A-1' }),
    );
    const unknown = await errorOf(
      t.service.login({ email: 'nobody@x.se', password: 'whatever-1' }),
    );
    expect(bodyOf(customer)).toEqual(INVALID);
    expect(bodyOf(unknown)).toEqual(INVALID);
  });

  it('a staff account cannot log in through a store context', async () => {
    const t = build();
    t.add({
      email: 'owner@x.se',
      password: 'owner-pw-1',
      role: UserRole.CREATOR,
    });
    const err = await errorOf(
      t.service.login({
        email: 'owner@x.se',
        password: 'owner-pw-1',
        store_slug: 'store-a',
      }),
    );
    expect(bodyOf(err)).toEqual(INVALID);
  });

  it('an unknown store_slug is 400 STORE_NOT_FOUND; a foreign or platform hostname with a valid slug is ignored', async () => {
    const t = build();
    t.add({ email: 'anna@x.se', password: 'pass-A-1', store_id: 'sa' });
    const err = await errorOf(
      t.service.login({
        email: 'anna@x.se',
        password: 'pass-A-1',
        store_slug: 'nope',
      }),
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect(bodyOf(err)).toMatchObject({ code: 'STORE_NOT_FOUND' });

    for (const hostname of ['shop-b.se', 'localhost', 'stores.example.com']) {
      const res = await t.service.login({
        email: 'anna@x.se',
        password: 'pass-A-1',
        store_slug: 'store-a',
        hostname,
      });
      expect(signedIn(res).user.store_id).toBe('sa');
    }
  });

  it('a hostname alone resolves the store owning that ACTIVE domain', async () => {
    const t = build();
    t.add({
      id: 'cb',
      email: 'anna@x.se',
      password: 'pass-B-1',
      store_id: 'sb',
    });
    const res = await t.service.login({
      email: 'anna@x.se',
      password: 'pass-B-1',
      hostname: 'shop-b.se',
    });
    expect(signedIn(res).user.id).toBe('cb');
    const err = await errorOf(
      t.service.login({
        email: 'anna@x.se',
        password: 'pass-B-1',
        hostname: 'unknown.example',
      }),
    );
    expect(bodyOf(err)).toMatchObject({ code: 'STORE_NOT_FOUND' });
  });

  it('the JWT payload carries store_id (null for staff)', async () => {
    const t = build();
    t.add({
      id: 'ca',
      email: 'anna@x.se',
      password: 'pass-A-1',
      store_id: 'sa',
    });
    t.add({
      id: 'cr',
      email: 'owner@x.se',
      password: 'owner-pw-1',
      role: UserRole.CREATOR,
    });
    await t.service.login({
      email: 'anna@x.se',
      password: 'pass-A-1',
      store_slug: 'store-a',
    });
    await t.service.login({ email: 'owner@x.se', password: 'owner-pw-1' });
    const iat = expect.any(Number);
    expect(t.signed).toEqual([
      { sub: 'ca', email: 'anna@x.se', role: 'CUSTOMER', store_id: 'sa', iat },
      { sub: 'ca', email: 'anna@x.se', role: 'CUSTOMER', store_id: 'sa', iat },
      { sub: 'cr', email: 'owner@x.se', role: 'CREATOR', store_id: null, iat },
      { sub: 'cr', email: 'owner@x.se', role: 'CREATOR', store_id: null, iat },
    ]);
  });
});

describe('register / guest-register are store scoped', () => {
  it('same email registers in store B, but 409 AUTH_EMAIL_EXISTS in store A', async () => {
    const t = build();
    t.add({ email: 'anna@x.se', password: 'pass-A-1', store_id: 'sa' });
    const dto = {
      email: 'anna@x.se',
      password: 'pass-B-12',
      role: UserRole.CUSTOMER,
    };
    const res = await t.service.register({ ...dto, store_slug: 'store-b' });
    expect(res.user).toMatchObject({ store_id: 'sb', role: 'CUSTOMER' });

    const err = await errorOf(
      t.service.register({ ...dto, store_slug: 'store-a' }),
    );
    expect(err).toBeInstanceOf(ConflictException);
    expect(bodyOf(err)).toMatchObject({ code: 'AUTH_EMAIL_EXISTS' });
  });

  it('a staff email does not block a customer registration, and vice versa', async () => {
    const t = build();
    t.add({
      email: 'owner@x.se',
      password: 'owner-pw-1',
      role: UserRole.CREATOR,
    });
    t.add({ email: 'anna@x.se', password: 'pass-A-1', store_id: 'sa' });
    await expect(
      t.service.register({
        email: 'owner@x.se',
        password: 'shopper-pw-1',
        role: UserRole.CUSTOMER,
        store_slug: 'store-a',
      }),
    ).resolves.toMatchObject({ user: { store_id: 'sa' } });
    await expect(
      t.service.register({
        email: 'anna@x.se',
        password: 'creator-pw-1',
        role: UserRole.CREATOR,
        account_kind: 'independent',
        accept_terms: true,
      }),
    ).resolves.toMatchObject({ user: { store_id: null } });
    // A second staff account with the same email is still a conflict.
    await expect(
      t.service.register({
        email: 'owner@x.se',
        password: 'creator-pw-2',
        role: UserRole.PROVIDER,
        account_kind: 'supplier',
        company_name: 'Acme',
        accept_terms: true,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('guest-register without a store is 400 STORE_REQUIRED', async () => {
    const t = build();
    const err = await errorOf(t.service.guestRegister({ email: 'a@x.se' }));
    expect(bodyOf(err)).toMatchObject({ code: 'STORE_REQUIRED' });
    expect(t.rows).toHaveLength(0);
  });
});

describe('forgot-password is store scoped', () => {
  it('mails only the account of the store; staff only without a store; the answer never changes', async () => {
    const t = build();
    t.add({
      id: 'ca',
      email: 'anna@x.se',
      password: 'pass-A-1',
      store_id: 'sa',
    });
    t.add({
      id: 'cr',
      email: 'owner@x.se',
      password: 'owner-pw-1',
      role: UserRole.CREATOR,
    });
    const generic = {
      message: 'If the email exists, a reset link will be sent',
    };

    await expect(
      t.service.forgotPassword('anna@x.se', 'store-b'),
    ).resolves.toEqual(generic);
    await expect(t.service.forgotPassword('anna@x.se')).resolves.toEqual(
      generic,
    );
    expect(t.mail.sendPasswordReset).not.toHaveBeenCalled();

    await expect(
      t.service.forgotPassword('anna@x.se', 'store-a'),
    ).resolves.toEqual(generic);
    await expect(t.service.forgotPassword('owner@x.se')).resolves.toEqual(
      generic,
    );
    expect(t.mail.sendPasswordReset).toHaveBeenCalledTimes(2);
    // The reset token rides in the URL fragment, never in the query string.
    for (const call of (t.mail.sendPasswordReset as jest.Mock).mock
      .calls as unknown[][]) {
      const url = call[1] as string;
      expect(url).toMatch(/\/auth\/reset-password#token=[^&?]+$/);
      expect(url).not.toContain('?token=');
    }
    expect(t.signed.map((p) => (p as { sub: string }).sub)).toEqual([
      'ca',
      'cr',
    ]);
  });
});

describe('tokens without a store claim', () => {
  const customer = { role: UserRole.CUSTOMER, store_id: 'sa' };
  it('tokenStoreMatches', () => {
    expect(tokenStoreMatches({ store_id: 'sa' }, customer)).toBe(true);
    expect(tokenStoreMatches({}, customer)).toBe(false);
    expect(tokenStoreMatches({ store_id: null }, customer)).toBe(false);
    expect(tokenStoreMatches({ store_id: 'sb' }, customer)).toBe(false);
    expect(
      tokenStoreMatches({}, { role: UserRole.ADMIN, store_id: null }),
    ).toBe(true);
  });

  it('JwtStrategy: storeId on the request user; an old customer token is 401', async () => {
    const t = build();
    t.add({
      id: 'ca',
      email: 'anna@x.se',
      password: 'pass-A-1',
      store_id: 'sa',
    });
    t.add({
      id: 'cr',
      email: 'owner@x.se',
      password: 'owner-pw-1',
      role: UserRole.CREATOR,
    });

    await expect(
      t.strategy.validate(undefined, {
        sub: 'ca',
        role: UserRole.CUSTOMER,
        store_id: 'sa',
      }),
    ).resolves.toEqual({
      id: 'ca',
      email: 'anna@x.se',
      role: 'CUSTOMER',
      status: 'ACTIVE',
      storeId: 'sa',
    });
    await expect(
      t.strategy.validate(undefined, { sub: 'ca', role: UserRole.CUSTOMER }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    // Staff tokens from before the change keep working.
    await expect(
      t.strategy.validate(undefined, { sub: 'cr', role: UserRole.CREATOR }),
    ).resolves.toMatchObject({ id: 'cr', storeId: null });
    // A password-reset token is never an access token.
    await expect(
      t.strategy.validate(undefined, { sub: 'cr', type: 'password_reset' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refresh: an old customer refresh token is 401, a new one is reissued with store_id', async () => {
    const t = build();
    t.add({
      id: 'ca',
      email: 'anna@x.se',
      password: 'pass-A-1',
      store_id: 'sa',
    });
    t.setVerify({ sub: 'ca', email: 'anna@x.se', role: 'CUSTOMER' });
    const err = await errorOf(t.service.refreshToken('old'));
    expect(bodyOf(err)).toMatchObject({ code: 'AUTH_INVALID_REFRESH_TOKEN' });

    t.setVerify({ sub: 'ca', role: 'CUSTOMER', store_id: 'sa' });
    await expect(t.service.refreshToken('new')).resolves.toEqual({
      access_token: 'jwt-ca',
      refresh_token: 'jwt-ca',
    });
    expect(t.signed[0]).toMatchObject({ store_id: 'sa' });
  });
});

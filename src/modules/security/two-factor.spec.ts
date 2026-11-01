import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UserRole } from '@prisma/client';
import { CryptoService } from '../../common/crypto/crypto.service';
import { PrismaService } from '../../prisma/prisma.service';
import { base32Decode, hotp, totpStep } from '../../common/security/totp';
import { SecurityAuditService } from './security-audit.service';
import { TwoFactorService, type SecurityUser } from './two-factor.service';
import { ReauthService } from './reauth.service';
import { PaymentKeysGuardService } from './payment-keys-guard.service';
import type { MagicLinkService } from '../auth/magic-link.service';

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const JWT_SECRET = 'test-jwt-secret';

/** In-memory stand-in for the few Prisma calls the 2FA code makes. */
function makePrisma(user: SecurityUser) {
  const row: SecurityUser = { ...user };
  const matches = (where: Record<string, unknown>): boolean => {
    const num = (v: unknown) =>
      v instanceof Date ? v.getTime() : (v as number);
    // Just enough of Prisma's filter language for the 2FA code paths.
    const cond = (value: unknown, spec: unknown): boolean => {
      if (spec === null) return value === null || value === undefined;
      if (spec && typeof spec === 'object' && !(spec instanceof Date)) {
        const f = spec as Record<string, unknown>;
        if (value === null || value === undefined) return false;
        if ('has' in f) return (value as unknown[]).includes(f.has);
        if ('lt' in f && !(num(value) < num(f.lt))) return false;
        if ('lte' in f && !(num(value) <= num(f.lte))) return false;
        if ('gte' in f && !(num(value) >= num(f.gte))) return false;
        return true;
      }
      return value === spec;
    };
    const all = (w: Record<string, unknown>): boolean =>
      Object.entries(w).every(([k, spec]) =>
        k === 'OR'
          ? (spec as Array<Record<string, unknown>>).some(all)
          : cond((row as unknown as Record<string, unknown>)[k], spec),
      );
    return all(where);
  };
  const apply = (data: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && 'increment' in v) {
        (row as unknown as Record<string, number>)[k] += (
          v as { increment: number }
        ).increment;
      } else {
        (row as unknown as Record<string, unknown>)[k] = v;
      }
    }
  };
  return {
    row,
    user: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === row.id ? { ...row } : null),
      ),
      findMany: jest.fn(() => Promise.resolve([{ email: 'admin@x.se' }])),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        apply(data);
        return Promise.resolve({ ...row });
      }),
      updateMany: jest.fn(
        ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          if (!matches(where)) return Promise.resolve({ count: 0 });
          apply(data);
          return Promise.resolve({ count: 1 });
        },
      ),
    },
    platformConfig: {
      findFirst: jest.fn(() =>
        Promise.resolve({ platform_name: 'Test', default_locale: 'en' }),
      ),
    },
    securityEvent: { create: jest.fn(() => Promise.resolve({})) },
  };
}

async function build(overrides: Partial<SecurityUser> = {}) {
  const config = {
    get: (k: string) => ({ ENCRYPTION_KEY, JWT_SECRET })[k as 'JWT_SECRET'],
  } as unknown as ConfigService;
  const crypto = new CryptoService(config);
  crypto.onModuleInit();
  const user: SecurityUser = {
    id: 'u1',
    email: 'owner@x.se',
    role: UserRole.ADMIN,
    status: 'ACTIVE',
    store_id: null,
    password_hash: await bcrypt.hash('right-password', 4),
    tokens_valid_after: null,
    totp_secret: null,
    totp_enabled_at: null,
    totp_last_step: null,
    totp_recovery_hashes: [],
    auth_failed_count: 0,
    auth_locked_until: null,
    reauth_failed_count: 0,
    reauth_locked_until: null,
    ...overrides,
  };
  const prisma = makePrisma(user);
  const mail = {
    sendSecurityAlert: jest.fn(() => Promise.resolve({ sent: true })),
  };
  const audit = new SecurityAuditService(
    prisma as unknown as PrismaService,
    mail as never,
  );
  const jwt = new JwtService({});
  const twoFactor = new TwoFactorService(
    prisma as unknown as PrismaService,
    crypto,
    jwt,
    config,
    audit,
  );
  const magicLinks = { invalidateForUser: jest.fn(() => Promise.resolve()) };
  const reauth = new ReauthService(
    twoFactor,
    prisma as unknown as PrismaService,
    audit,
    magicLinks as unknown as MagicLinkService,
    jwt,
    config,
  );
  const guard = new PaymentKeysGuardService(reauth, audit);
  return {
    prisma,
    mail,
    audit,
    twoFactor,
    reauth,
    guard,
    jwt,
    crypto,
    magicLinks,
  };
}

// bcrypt + QR generation under parallel jest workers can exceed 5 s.
jest.setTimeout(20000);

/** Sets up and enables 2FA; returns the secret and the recovery codes. */
async function enable(
  t: Awaited<ReturnType<typeof build>>,
  nowMs = Date.now(),
) {
  const { secret } = await t.twoFactor.beginSetup('u1', 'right-password');
  const code = hotp(base32Decode(secret), totpStep(nowMs));
  const { recovery_codes } = await t.twoFactor.enable('u1', code);
  return { secret, recovery_codes };
}

const codeFor = (secret: string, stepOffset = 0) =>
  hotp(base32Decode(secret), totpStep() + stepOffset);

async function errorCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    const res = (e as { getResponse?: () => unknown }).getResponse?.();
    return (res as { code?: string } | undefined)?.code;
  }
  return undefined;
}

describe('TwoFactorService', () => {
  it('setup needs the password and stores the secret encrypted', async () => {
    const t = await build();
    expect(await errorCode(t.twoFactor.beginSetup('u1', undefined))).toBe(
      'REAUTH_REQUIRED',
    );
    expect(await errorCode(t.twoFactor.beginSetup('u1', 'nope'))).toBe(
      'REAUTH_PASSWORD_INVALID',
    );
    const res = await t.twoFactor.beginSetup('u1', 'right-password');
    expect(res.qr_data_url.startsWith('data:image/png;base64,')).toBe(true);
    expect(t.prisma.row.totp_secret).not.toContain(res.secret);
    expect(t.crypto.isEncrypted(t.prisma.row.totp_secret)).toBe(true);
    expect(t.prisma.row.totp_enabled_at).toBeNull();
  });

  it('enable verifies the code, returns 10 recovery codes and revokes old tokens', async () => {
    const t = await build();
    const { recovery_codes } = await enable(t);
    expect(recovery_codes).toHaveLength(10);
    expect(t.prisma.row.totp_enabled_at).toBeInstanceOf(Date);
    expect(t.prisma.row.tokens_valid_after).toBeInstanceOf(Date);
    // Only hashes are stored.
    expect(t.prisma.row.totp_recovery_hashes).not.toContain(recovery_codes[0]);
    expect(t.mail.sendSecurityAlert).toHaveBeenCalledWith(
      'owner@x.se',
      expect.objectContaining({ kind: 'two_factor_enabled' }),
      'en',
    );
  });

  it('enable refuses a wrong code', async () => {
    const t = await build();
    await t.twoFactor.beginSetup('u1', 'right-password');
    expect(await errorCode(t.twoFactor.enable('u1', '000000'))).toBe(
      'TWO_FACTOR_CODE_INVALID',
    );
    expect(t.prisma.row.totp_enabled_at).toBeNull();
  });

  it('never accepts the same app code twice', async () => {
    const t = await build();
    const { secret } = await enable(t);
    const next = codeFor(secret, 1);
    await t.twoFactor.checkLoginCode(await t.twoFactor.loadUser('u1'), next);
    expect(
      await errorCode(
        t.twoFactor.checkLoginCode(await t.twoFactor.loadUser('u1'), next),
      ),
    ).toBe('TWO_FACTOR_CODE_INVALID');
  });

  it('a recovery code works exactly once and alerts the owner', async () => {
    const t = await build();
    const { recovery_codes } = await enable(t);
    const code = recovery_codes[3].toLowerCase();
    await t.twoFactor.checkLoginCode(await t.twoFactor.loadUser('u1'), code);
    expect(t.prisma.row.totp_recovery_hashes).toHaveLength(9);
    expect(t.mail.sendSecurityAlert).toHaveBeenCalledWith(
      'owner@x.se',
      expect.objectContaining({ kind: 'recovery_code_used' }),
      'en',
    );
    expect(
      await errorCode(
        t.twoFactor.checkLoginCode(await t.twoFactor.loadUser('u1'), code),
      ),
    ).toBe('TWO_FACTOR_CODE_INVALID');
  });

  it('locks after 5 wrong codes, even for a right code afterwards', async () => {
    const t = await build();
    const { secret } = await enable(t);
    for (let i = 0; i < 5; i++) {
      await errorCode(
        t.twoFactor.checkLoginCode(await t.twoFactor.loadUser('u1'), '000000'),
      );
    }
    expect(t.prisma.row.auth_locked_until!.getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(
      await errorCode(
        t.twoFactor.checkLoginCode(
          await t.twoFactor.loadUser('u1'),
          codeFor(secret, 1),
        ),
      ),
    ).toBe('TWO_FACTOR_LOCKED');
    expect(t.prisma.securityEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'two_factor.locked',
        }) as unknown,
      }),
    );
  });

  it('20 parallel wrong codes: at most 5 are ever evaluated (M2)', async () => {
    const t = await build();
    await enable(t);
    const user = await t.twoFactor.loadUser('u1');
    const spy = jest.spyOn(
      t.twoFactor as unknown as { consumeCode: () => Promise<boolean> },
      'consumeCode',
    );
    const codes = await Promise.all(
      Array.from({ length: 20 }, () =>
        errorCode(t.twoFactor.checkLoginCode(user, '000000')),
      ),
    );
    expect(spy.mock.calls.length).toBeLessThanOrEqual(5);
    expect(
      codes.filter((c) => c === 'TWO_FACTOR_LOCKED').length,
    ).toBeGreaterThanOrEqual(15);
    expect(t.prisma.row.auth_locked_until!.getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it('a full window that is not locked yet locks instead of reopening', async () => {
    const t = await build({ auth_failed_count: 5, auth_locked_until: null });
    await enable(t);
    expect(
      await errorCode(
        t.twoFactor.checkLoginCode(await t.twoFactor.loadUser('u1'), '000000'),
      ),
    ).toBe('TWO_FACTOR_LOCKED');
    expect(t.prisma.row.auth_locked_until).toBeInstanceOf(Date);
  });

  it('an expired lock opens a fresh window', async () => {
    const t = await build();
    const { secret } = await enable(t);
    t.prisma.row.auth_failed_count = 5;
    t.prisma.row.auth_locked_until = new Date(Date.now() - 1000);
    await t.twoFactor.checkLoginCode(
      await t.twoFactor.loadUser('u1'),
      codeFor(secret, 1),
    );
    expect(t.prisma.row.auth_failed_count).toBe(0);
    expect(t.prisma.row.auth_locked_until).toBeNull();
  });

  it('re-auth failures never lock sign-in, and a re-auth lock ends the session (M3)', async () => {
    const t = await build();
    const { secret } = await enable(t);
    for (let i = 0; i < 5; i++) {
      await errorCode(
        t.reauth.verify(
          'u1',
          { current_password: 'bad', totp_code: '000000' },
          { purpose: 'x' },
        ),
      );
    }
    expect(t.prisma.row.reauth_locked_until!.getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(t.prisma.row.tokens_valid_after!.getTime()).toBeGreaterThan(
      Date.now() - 2000,
    );
    expect(t.prisma.row.auth_locked_until).toBeNull();
    // The owner can still finish signing in.
    await expect(
      t.twoFactor.checkLoginCode(
        await t.twoFactor.loadUser('u1'),
        codeFor(secret, 1),
      ),
    ).resolves.toBeUndefined();
  });

  it('a known password does not reset the counter for code guessing', async () => {
    const t = await build();
    await enable(t);
    for (let i = 0; i < 5; i++) {
      await errorCode(
        t.reauth.verify(
          'u1',
          { current_password: 'right-password', totp_code: '000000' },
          { purpose: 'x' },
        ),
      );
    }
    expect(
      await errorCode(
        t.reauth.verify(
          'u1',
          { current_password: 'right-password', totp_code: '000000' },
          { purpose: 'x' },
        ),
      ),
    ).toBe('TWO_FACTOR_LOCKED');
  });

  it('an unexpected error during the check still counts as an attempt', async () => {
    const t = await build();
    await enable(t);
    jest
      .spyOn(
        t.twoFactor as unknown as { consumeCode: () => Promise<boolean> },
        'consumeCode',
      )
      .mockRejectedValue(new Error('decrypt failed'));
    await errorCode(
      t.twoFactor.checkLoginCode(await t.twoFactor.loadUser('u1'), '123456'),
    );
    expect(t.prisma.row.auth_failed_count).toBe(1);
  });

  describe('login challenge', () => {
    it('round-trips a challenge into the user', async () => {
      const t = await build();
      const { secret } = await enable(t);
      // Enabling moved the cutoff to "now"; a challenge must be issued after it.
      t.prisma.row.tokens_valid_after = new Date(Date.now() - 5000);
      const { challenge_token } = await t.twoFactor.issueChallenge('u1');
      const user = await t.twoFactor.verifyLogin(
        challenge_token,
        codeFor(secret, 1),
      );
      expect(user.id).toBe('u1');
    });

    it('works right after enabling (same second as the cutoff)', async () => {
      const t = await build();
      const { secret } = await enable(t);
      const { challenge_token } = await t.twoFactor.issueChallenge('u1');
      await expect(
        t.twoFactor.verifyLogin(challenge_token, codeFor(secret, 1)),
      ).resolves.toMatchObject({ id: 'u1' });
    });

    it('rejects an access token used as a challenge', async () => {
      const t = await build();
      await enable(t);
      const notChallenge = await t.jwt.signAsync(
        { sub: 'u1' },
        { secret: JWT_SECRET },
      );
      expect(
        await errorCode(t.twoFactor.verifyLogin(notChallenge, '123456')),
      ).toBe('TWO_FACTOR_CHALLENGE_INVALID');
    });

    it('a password change after the challenge kills it', async () => {
      const t = await build();
      const { secret } = await enable(t);
      t.prisma.row.tokens_valid_after = new Date(Date.now() - 5000);
      const { challenge_token } = await t.twoFactor.issueChallenge('u1');
      t.prisma.row.tokens_valid_after = new Date(Date.now() + 2000);
      expect(
        await errorCode(
          t.twoFactor.verifyLogin(challenge_token, codeFor(secret, 1)),
        ),
      ).toBe('TWO_FACTOR_CHALLENGE_INVALID');
    });
  });

  it('disable needs password AND code, then clears everything', async () => {
    const t = await build();
    const { secret } = await enable(t);
    expect(
      await errorCode(t.twoFactor.disable('u1', 'right-password', undefined)),
    ).toBe('TWO_FACTOR_CODE_INVALID');
    await t.twoFactor.disable('u1', 'right-password', codeFor(secret, 1));
    expect(t.prisma.row.totp_secret).toBeNull();
    expect(t.prisma.row.totp_enabled_at).toBeNull();
    expect(t.prisma.row.totp_recovery_hashes).toEqual([]);
  });
});

describe('ReauthService', () => {
  it('require2fa refuses an account without 2FA before checking the password', async () => {
    const t = await build();
    expect(
      await errorCode(
        t.reauth.verify(
          'u1',
          { current_password: 'right-password' },
          { purpose: 'x', require2fa: true },
        ),
      ),
    ).toBe('REAUTH_2FA_REQUIRED');
  });

  it('without 2FA the password alone is enough', async () => {
    const t = await build();
    await expect(
      t.reauth.verify(
        'u1',
        { current_password: 'right-password' },
        { purpose: 'x' },
      ),
    ).resolves.toMatchObject({ id: 'u1' });
  });

  it('with 2FA the code is required too', async () => {
    const t = await build();
    const { secret } = await enable(t);
    expect(
      await errorCode(
        t.reauth.verify(
          'u1',
          { current_password: 'right-password' },
          { purpose: 'x' },
        ),
      ),
    ).toBe('TWO_FACTOR_CODE_INVALID');
    await expect(
      t.reauth.verify(
        'u1',
        { current_password: 'right-password', totp_code: codeFor(secret, 1) },
        { purpose: 'x', require2fa: true },
      ),
    ).resolves.toMatchObject({ id: 'u1' });
  });

  it('wrong passwords count toward the lock', async () => {
    const t = await build();
    for (let i = 0; i < 5; i++) {
      await errorCode(
        t.reauth.verify('u1', { current_password: 'bad' }, { purpose: 'x' }),
      );
    }
    expect(
      await errorCode(
        t.reauth.verify(
          'u1',
          { current_password: 'right-password' },
          { purpose: 'x' },
        ),
      ),
    ).toBe('TWO_FACTOR_LOCKED');
  });
});

describe('PaymentKeysGuardService', () => {
  const admin = {
    id: 'u1',
    email: 'owner@x.se',
    role: UserRole.ADMIN,
    status: 'ACTIVE' as const,
    storeId: null,
  };
  const meta = { ip: '1.2.3.4', userAgent: 'jest' };

  it('runs a change without credential fields with no re-auth', async () => {
    const t = await build();
    const apply = jest.fn(() => Promise.resolve('ok'));
    await expect(
      t.guard.run({
        scope: 'platform',
        user: admin,
        input: {},
        changed: { secret_key: undefined },
        meta,
        apply,
      }),
    ).resolves.toBe('ok');
    expect(t.prisma.securityEvent.create).not.toHaveBeenCalled();
  });

  it('blocks platform key changes until the admin has 2FA', async () => {
    const t = await build();
    const apply = jest.fn(() => Promise.resolve('ok'));
    expect(
      await errorCode(
        t.guard.run({
          scope: 'platform',
          user: admin,
          input: { current_password: 'right-password' },
          changed: { secret_key: 'sk_live_SECRET' },
          meta,
          apply,
        }),
      ),
    ).toBe('REAUTH_2FA_REQUIRED');
    expect(apply).not.toHaveBeenCalled();
  });

  it('after re-auth: applies, audits field names only and alerts admins', async () => {
    const t = await build();
    const { secret } = await enable(t);
    const apply = jest.fn(() => Promise.resolve('ok'));
    await t.guard.run({
      scope: 'platform',
      user: admin,
      input: {
        current_password: 'right-password',
        totp_code: codeFor(secret, 1),
      },
      changed: { secret_key: 'sk_live_SECRET', webhook_secret: '' },
      meta,
      apply,
    });
    expect(apply).toHaveBeenCalled();
    const calls = JSON.stringify([
      t.prisma.securityEvent.create.mock.calls,
      t.mail.sendSecurityAlert.mock.calls,
    ]);
    expect(calls).not.toContain('sk_live_SECRET');
    expect(t.prisma.securityEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'payment_keys.platform.updated',
        fields: ['secret_key', 'webhook_secret (cleared)'],
        ip: '1.2.3.4',
      }) as unknown,
    });
    expect(t.mail.sendSecurityAlert).toHaveBeenCalledWith(
      'admin@x.se',
      expect.objectContaining({ kind: 'platform_keys_changed' }),
      'en',
    );
  });

  it('Kustom changes need only the password when 2FA is off', async () => {
    const t = await build({ role: UserRole.CREATOR });
    const creator = { ...admin, role: UserRole.CREATOR };
    const apply = jest.fn(() => Promise.resolve('ok'));
    await t.guard.run({
      scope: 'kustom',
      user: creator,
      input: { current_password: 'right-password' },
      changed: { merchant_id: 'M1', shared_secret: undefined },
      meta,
      apply,
    });
    expect(apply).toHaveBeenCalled();
    expect(t.mail.sendSecurityAlert).toHaveBeenCalledWith(
      'owner@x.se',
      expect.objectContaining({
        kind: 'kustom_keys_changed',
        fields: ['merchant_id'],
      }),
      'en',
    );
  });
});

describe('ReauthService admin grant (sudo mode)', () => {
  it('needs 2FA, then covers several admin actions with one code', async () => {
    const t = await build();
    expect(
      await errorCode(
        t.reauth.grant('u1', { current_password: 'right-password' }),
      ),
    ).toBe('REAUTH_2FA_REQUIRED');
    const { secret } = await enable(t);
    t.prisma.row.tokens_valid_after = new Date(Date.now() - 5000);
    const { reauth_token } = await t.reauth.grant('u1', {
      current_password: 'right-password',
      totp_code: codeFor(secret, 1),
    });
    for (let i = 0; i < 3; i++) {
      await expect(
        t.reauth.verifyAdmin('u1', { reauth_token }, { purpose: 'x' }),
      ).resolves.toMatchObject({ id: 'u1' });
    }
    expect(t.prisma.securityEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'reauth.granted' }) as unknown,
    });
  });

  it('is refused for another user, after sign-out everywhere, and as an access token type', async () => {
    const t = await build();
    const { secret } = await enable(t);
    t.prisma.row.tokens_valid_after = new Date(Date.now() - 5000);
    const { reauth_token } = await t.reauth.grant('u1', {
      current_password: 'right-password',
      totp_code: codeFor(secret, 1),
    });
    expect(await errorCode(t.reauth.verifyGrant('u2', reauth_token))).toBe(
      'REAUTH_REQUIRED',
    );
    t.prisma.row.tokens_valid_after = new Date(Date.now() + 2000);
    expect(await errorCode(t.reauth.verifyGrant('u1', reauth_token))).toBe(
      'REAUTH_REQUIRED',
    );
    const challenge = await t.jwt.signAsync(
      { sub: 'u1', type: 'two_factor_challenge' },
      { secret: JWT_SECRET },
    );
    expect(await errorCode(t.reauth.verifyGrant('u1', challenge))).toBe(
      'REAUTH_REQUIRED',
    );
  });

  it('payment-key changes never accept a grant', async () => {
    const t = await build();
    const { secret } = await enable(t);
    t.prisma.row.tokens_valid_after = new Date(Date.now() - 5000);
    const { reauth_token } = await t.reauth.grant('u1', {
      current_password: 'right-password',
      totp_code: codeFor(secret, 1),
    });
    expect(
      await errorCode(
        t.reauth.verify('u1', { reauth_token }, { purpose: 'x' }),
      ),
    ).toBe('REAUTH_REQUIRED');
  });

  it('admin 2FA reset signs the target out and kills magic links (L1)', async () => {
    const t = await build();
    const { secret } = await enable(t);
    t.prisma.row.tokens_valid_after = new Date(Date.now() - 5000);
    // The fake holds one row; point the target lookup at a second user.
    t.prisma.user.findUnique.mockImplementationOnce(() =>
      Promise.resolve({
        id: 'u9',
        email: 't@x.se',
        role: 'CREATOR',
        totp_enabled_at: new Date(),
      } as never),
    );
    await t.reauth.adminResetTwoFactor('u1', 'u9', {
      current_password: 'right-password',
      totp_code: codeFor(secret, 1),
    });
    expect(t.magicLinks.invalidateForUser).toHaveBeenCalledWith('u9');
    expect(t.prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u9' },
        data: expect.objectContaining({
          tokens_valid_after: expect.any(Date) as unknown,
        }) as unknown,
      }),
    );
  });
});

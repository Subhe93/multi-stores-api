import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as QRCode from 'qrcode';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  otpauthUrl,
  verifyTotp,
} from '../../common/security/totp';
import { SecurityAuditService } from './security-audit.service';
import type { RequestMeta } from './request-meta';

/** Consecutive failures (wrong 2FA code or re-auth password) before a lock. */
export const MAX_AUTH_FAILURES = 5;
export const AUTH_LOCK_MS = 15 * 60 * 1000;
/** Lifetime of the half-signed-in state between password and code. */
export const CHALLENGE_TTL_SECONDS = 300;
const CHALLENGE_TYPE = 'two_factor_challenge';

/** Columns every 2FA / re-auth check needs. */
export const SECURITY_USER_SELECT = {
  id: true,
  email: true,
  role: true,
  status: true,
  store_id: true,
  password_hash: true,
  tokens_valid_after: true,
  totp_secret: true,
  totp_enabled_at: true,
  totp_last_step: true,
  totp_recovery_hashes: true,
  auth_failed_count: true,
  auth_locked_until: true,
  reauth_failed_count: true,
  reauth_locked_until: true,
} as const;

/** Which failure counter an attempt counts toward. */
export type LockKind = 'login' | 'session';

export interface SecurityUser {
  id: string;
  email: string;
  role: UserRole;
  status: string;
  store_id: string | null;
  password_hash: string;
  tokens_valid_after: Date | null;
  totp_secret: string | null;
  totp_enabled_at: Date | null;
  totp_last_step: number | null;
  totp_recovery_hashes: string[];
  auth_failed_count: number;
  auth_locked_until: Date | null;
  reauth_failed_count: number;
  reauth_locked_until: Date | null;
}

const codeInvalid = (status: 'login' | 'session') =>
  status === 'login'
    ? new UnauthorizedException({
        code: 'TWO_FACTOR_CODE_INVALID',
        message: 'The verification code is not valid',
      })
    : new ForbiddenException({
        code: 'TWO_FACTOR_CODE_INVALID',
        message: 'The verification code is not valid',
      });

@Injectable()
export class TwoFactorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: SecurityAuditService,
  ) {}

  // ── Loading and locking ───────────────────────────────────────────────────

  async loadUser(userId: string): Promise<SecurityUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: SECURITY_USER_SELECT,
    });
    if (!user) throw new UnauthorizedException();
    return user;
  }

  isEnabled(
    user: Pick<SecurityUser, 'totp_enabled_at' | 'totp_secret'>,
  ): boolean {
    return Boolean(user.totp_enabled_at && user.totp_secret);
  }

  /**
   * 'login' = the sign-in challenge; 'session' = re-auth inside a signed-in
   * session (payment keys, 2FA changes). Separate counters, so a stolen
   * token guessing passwords can never lock the owner out of signing in.
   */
  private lockColumns(kind: LockKind) {
    return kind === 'login'
      ? ({ count: 'auth_failed_count', until: 'auth_locked_until' } as const)
      : ({
          count: 'reauth_failed_count',
          until: 'reauth_locked_until',
        } as const);
  }

  private lockedError(until: Date) {
    return new HttpException(
      {
        code: 'TWO_FACTOR_LOCKED',
        message: 'Too many failed attempts. Try again later.',
        retry_after_seconds: Math.max(
          1,
          Math.ceil((until.getTime() - Date.now()) / 1000),
        ),
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /** Cheap early check on an already loaded row (no reservation). */
  assertNotLocked(user: SecurityUser, kind: LockKind = 'login'): void {
    const until = user[this.lockColumns(kind).until];
    if (until && until.getTime() > Date.now()) throw this.lockedError(until);
  }

  /**
   * Reserves one attempt BEFORE anything is checked, with a single
   * conditional UPDATE: parallel requests serialize on the row, so at most
   * MAX_AUTH_FAILURES attempts per window are ever evaluated.
   */
  private async reserveAttempt(
    user: SecurityUser,
    kind: LockKind,
    meta?: RequestMeta,
  ): Promise<void> {
    const c = this.lockColumns(kind);
    for (let tries = 0; tries < 2; tries++) {
      const now = new Date();
      const gate = await this.prisma.user.updateMany({
        where: {
          id: user.id,
          [c.count]: { lt: MAX_AUTH_FAILURES },
          OR: [{ [c.until]: null }, { [c.until]: { lte: now } }],
        },
        data: { [c.count]: { increment: 1 } },
      });
      if (gate.count === 1) return;
      const row = await this.prisma.user.findUnique({
        where: { id: user.id },
        select: { [c.until]: true },
      });
      const until = (row as Record<string, Date | null> | null)?.[c.until];
      if (until && until.getTime() > now.getTime()) {
        throw this.lockedError(until);
      }
      if (!until) {
        // Window full but not locked yet: the last attempts are still being
        // evaluated (or a request died mid-way). Never open a new window
        // here — lock now, so the state always ends in an expiring lock.
        await this.lockWindow(user, kind, meta);
        throw this.lockedError(new Date(now.getTime() + AUTH_LOCK_MS));
      }
      // The lock expired with the counter still full: open a new window
      // (conditional, so only one racing request does it), then retry.
      await this.prisma.user.updateMany({
        where: {
          id: user.id,
          [c.count]: { gte: MAX_AUTH_FAILURES },
          [c.until]: { lte: now },
        },
        data: { [c.count]: 0, [c.until]: null },
      });
    }
    throw this.lockedError(new Date(Date.now() + AUTH_LOCK_MS));
  }

  /** Success: the window starts over. */
  private async releaseAttempts(userId: string, kind: LockKind): Promise<void> {
    const c = this.lockColumns(kind);
    await this.prisma.user.update({
      where: { id: userId },
      data: { [c.count]: 0, [c.until]: null },
    });
  }

  /**
   * Locks a full window (exactly one racing request wins the conditional
   * write and alerts). A session lock also signs out every token — the one
   * guessing included — while the owner can still sign in.
   */
  private async lockWindow(
    user: SecurityUser,
    kind: LockKind,
    meta?: RequestMeta,
  ): Promise<void> {
    const c = this.lockColumns(kind);
    const now = new Date();
    const locked = await this.prisma.user.updateMany({
      where: {
        id: user.id,
        [c.count]: { gte: MAX_AUTH_FAILURES },
        OR: [{ [c.until]: null }, { [c.until]: { lte: now } }],
      },
      data: {
        [c.until]: new Date(now.getTime() + AUTH_LOCK_MS),
        ...(kind === 'session' ? { tokens_valid_after: now } : {}),
      },
    });
    if (locked.count !== 1) return;
    await this.audit.record({
      actor: { id: user.id, email: user.email, role: user.role },
      action: 'two_factor.locked',
      targetType: 'user',
      targetId: user.id,
      targetLabel: kind,
      meta,
    });
    this.audit.alert(
      [user.email],
      'account_locked',
      { actorEmail: user.email, meta },
      await this.audit.localeFor(user.id),
    );
  }

  /**
   * Runs one reserved attempt. `check` returns null on success or the field
   * that failed; an unexpected error also counts as a failure, so a reserved
   * attempt is never left dangling.
   */
  private async attempt(
    user: SecurityUser,
    kind: LockKind,
    purpose: string,
    meta: RequestMeta | undefined,
    check: () => Promise<'password' | 'two_factor_code' | null>,
  ): Promise<'password' | 'two_factor_code' | null> {
    await this.reserveAttempt(user, kind, meta);
    let failed: 'password' | 'two_factor_code' | null;
    try {
      failed = await check();
    } catch (err) {
      await this.lockWindow(user, kind, meta);
      throw err;
    }
    if (failed) {
      await this.recordFailure(user, kind, failed, purpose, meta);
      await this.lockWindow(user, kind, meta);
    } else {
      await this.releaseAttempts(user.id, kind);
    }
    return failed;
  }

  private async recordFailure(
    user: SecurityUser,
    kind: LockKind,
    field: 'password' | 'two_factor_code',
    purpose: string,
    meta?: RequestMeta,
  ) {
    await this.audit.record({
      actor: { id: user.id, email: user.email, role: user.role },
      action: kind === 'login' ? 'two_factor.login_failed' : 'reauth.failed',
      targetType: 'user',
      targetId: user.id,
      targetLabel: purpose,
      fields: [field],
      meta,
    });
  }

  // ── Checks ───────────────────────────────────────────────────────────────

  /**
   * Step-up inside a session: the password, plus a code when `needCode`.
   * ONE reserved attempt covers both, so a known password never resets the
   * counter for code guessing. Throws REAUTH_REQUIRED /
   * REAUTH_PASSWORD_INVALID / TWO_FACTOR_CODE_INVALID / TWO_FACTOR_LOCKED.
   */
  async checkStepUp(
    user: SecurityUser,
    input: { password?: string; code?: string; needCode: boolean },
    opts: { purpose: string; meta?: RequestMeta },
  ): Promise<void> {
    this.assertNotLocked(user, 'session');
    // Incomplete forms are answered without spending an attempt.
    if (!input.password) {
      throw new ForbiddenException({
        code: 'REAUTH_REQUIRED',
        message: 'Confirm your password to continue',
      });
    }
    if (input.needCode && !input.code) throw codeInvalid('session');

    const failed = await this.attempt(
      user,
      'session',
      opts.purpose,
      opts.meta,
      async () => {
        if (!(await bcrypt.compare(input.password!, user.password_hash))) {
          return 'password';
        }
        if (
          input.needCode &&
          !(await this.consumeCode(user, input.code!, opts.meta))
        ) {
          return 'two_factor_code';
        }
        return null;
      },
    );
    if (failed === 'password') {
      throw new ForbiddenException({
        code: 'REAUTH_PASSWORD_INVALID',
        message: 'The password is not correct',
      });
    }
    if (failed) throw codeInvalid('session');
  }

  /**
   * Second sign-in step: an app code (replay-safe) or a recovery code
   * (consumed). Throws TWO_FACTOR_CODE_INVALID / TWO_FACTOR_LOCKED.
   */
  async checkLoginCode(
    user: SecurityUser,
    code: string,
    meta?: RequestMeta,
  ): Promise<void> {
    const failed = await this.attempt(user, 'login', 'login', meta, async () =>
      (await this.consumeCode(user, code, meta)) ? null : 'two_factor_code',
    );
    if (failed) throw codeInvalid('login');
  }

  /** True when the code was accepted (and is now spent). */
  private async consumeCode(
    user: SecurityUser,
    code: string,
    meta?: RequestMeta,
  ): Promise<boolean> {
    if (!this.isEnabled(user)) return false;
    if (looksLikeRecoveryCode(code)) {
      const hash = hashRecoveryCode(code);
      if (!user.totp_recovery_hashes.includes(hash)) return false;
      // Conditional write: a concurrent use of the same code matches 0 rows.
      const res = await this.prisma.user.updateMany({
        where: { id: user.id, totp_recovery_hashes: { has: hash } },
        data: {
          totp_recovery_hashes: user.totp_recovery_hashes.filter(
            (h) => h !== hash,
          ),
        },
      });
      if (res.count !== 1) return false;
      await this.audit.record({
        actor: { id: user.id, email: user.email, role: user.role },
        action: 'two_factor.recovery_used',
        targetType: 'user',
        targetId: user.id,
        targetLabel: user.email,
        meta,
      });
      // The most suspicious 2FA event: always tell the owner.
      this.audit.alert(
        [user.email],
        'recovery_code_used',
        { actorEmail: user.email, meta },
        await this.audit.localeFor(user.id),
      );
      return true;
    }
    const secret = this.crypto.decrypt(user.totp_secret);
    if (!secret) return false;
    const step = verifyTotp(secret, code, {
      lastUsedStep: user.totp_last_step,
    });
    if (step === null) return false;
    // Conditional write: the same code sent twice in parallel wins only once.
    const res = await this.prisma.user.updateMany({
      where: {
        id: user.id,
        OR: [{ totp_last_step: null }, { totp_last_step: { lt: step } }],
      },
      data: { totp_last_step: step },
    });
    return res.count === 1;
  }

  // ── Login challenge ──────────────────────────────────────────────────────

  async issueChallenge(userId: string) {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { tokens_valid_after: true },
    });
    // Same rule as access tokens: never born at or before the cutoff second
    // (e.g. signing in right after enabling 2FA).
    const now = Math.floor(Date.now() / 1000);
    const cutoff = row?.tokens_valid_after;
    const iat = cutoff
      ? Math.max(now, Math.floor(cutoff.getTime() / 1000) + 1)
      : now;
    const challenge_token = await this.jwt.signAsync(
      { sub: userId, type: CHALLENGE_TYPE, iat },
      {
        secret: this.config.get<string>('JWT_SECRET')!,
        expiresIn: CHALLENGE_TTL_SECONDS,
      },
    );
    return {
      requires_2fa: true as const,
      challenge_token,
      expires_in: CHALLENGE_TTL_SECONDS,
    };
  }

  /** Second sign-in step; returns the user to mint tokens for. */
  async verifyLogin(
    challengeToken: string,
    code: string,
    meta?: RequestMeta,
  ): Promise<SecurityUser> {
    const invalid = () =>
      new UnauthorizedException({
        code: 'TWO_FACTOR_CHALLENGE_INVALID',
        message: 'This sign-in attempt expired. Please sign in again.',
      });
    let payload: { sub?: string; type?: string; iat?: number };
    try {
      payload = await this.jwt.verifyAsync(challengeToken, {
        secret: this.config.get<string>('JWT_SECRET')!,
      });
    } catch {
      throw invalid();
    }
    if (payload.type !== CHALLENGE_TYPE || !payload.sub) throw invalid();
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: SECURITY_USER_SELECT,
    });
    if (!user || user.status !== 'ACTIVE' || !this.isEnabled(user))
      throw invalid();
    // A password change / block after the challenge was issued kills it.
    const cutoff = user.tokens_valid_after;
    if (cutoff && (payload.iat ?? 0) <= Math.floor(cutoff.getTime() / 1000)) {
      throw invalid();
    }
    await this.checkLoginCode(user, code, meta);
    return user;
  }

  // ── Management ───────────────────────────────────────────────────────────

  private assertStaff(user: SecurityUser) {
    if (user.role === UserRole.CUSTOMER) {
      throw new ForbiddenException({
        code: 'TWO_FACTOR_NOT_AVAILABLE',
        message:
          'Two-factor authentication is available for dashboard accounts only',
      });
    }
  }

  async status(userId: string) {
    const user = await this.loadUser(userId);
    return {
      enabled: this.isEnabled(user),
      enabled_at: user.totp_enabled_at,
      recovery_codes_remaining: this.isEnabled(user)
        ? user.totp_recovery_hashes.length
        : 0,
    };
  }

  async beginSetup(
    userId: string,
    password: string | undefined,
    meta?: RequestMeta,
  ) {
    const user = await this.loadUser(userId);
    this.assertStaff(user);
    if (this.isEnabled(user)) {
      throw new ConflictException({
        code: 'TWO_FACTOR_ALREADY_ENABLED',
        message: 'Two-factor authentication is already on',
      });
    }
    await this.checkStepUp(
      user,
      { password, needCode: false },
      { purpose: '2fa_setup', meta },
    );

    const secret = generateTotpSecret();
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        totp_secret: this.crypto.encrypt(secret),
        totp_enabled_at: null,
        totp_last_step: null,
        totp_recovery_hashes: [],
      },
    });
    const cfg = await this.prisma.platformConfig.findFirst({
      select: { platform_name: true },
    });
    const issuer = cfg?.platform_name?.trim() || 'ShopsDoor';
    const url = otpauthUrl(secret, user.email, issuer);
    const qr_data_url = await QRCode.toDataURL(url, { margin: 1, width: 240 });
    return { secret, otpauth_url: url, qr_data_url };
  }

  /**
   * Confirms the pending secret with a first code. Returns the recovery codes
   * (shown once). The caller revokes older tokens and returns a fresh pair.
   */
  async enable(userId: string, code: string, meta?: RequestMeta) {
    const user = await this.loadUser(userId);
    this.assertStaff(user);
    if (this.isEnabled(user)) {
      throw new ConflictException({
        code: 'TWO_FACTOR_ALREADY_ENABLED',
        message: 'Two-factor authentication is already on',
      });
    }
    const secret = this.crypto.decrypt(user.totp_secret);
    if (!secret) {
      throw new BadRequestException({
        code: 'TWO_FACTOR_SETUP_MISSING',
        message: 'Start the setup again',
      });
    }
    let step: number | null = null;
    const failed = await this.attempt(
      user,
      'session',
      '2fa_enable',
      meta,
      () => {
        step = verifyTotp(secret, code ?? '');
        return Promise.resolve(step === null ? 'two_factor_code' : null);
      },
    );
    if (failed || step === null) throw codeInvalid('session');
    const recovery = generateRecoveryCodes();
    const now = new Date();
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        totp_enabled_at: now,
        totp_last_step: step,
        totp_recovery_hashes: recovery.map(hashRecoveryCode),
        reauth_failed_count: 0,
        reauth_locked_until: null,
        // Sign out every other session: one opened with a stolen password
        // must not survive turning 2FA on.
        tokens_valid_after: now,
      },
    });
    await this.audit.record({
      actor: { id: user.id, email: user.email, role: user.role },
      action: 'two_factor.enabled',
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email,
      meta,
    });
    this.audit.alert(
      [user.email],
      'two_factor_enabled',
      { actorEmail: user.email, meta },
      await this.audit.localeFor(user.id),
    );
    return {
      recovery_codes: recovery,
      user: { ...user, tokens_valid_after: now },
    };
  }

  async disable(
    userId: string,
    password: string | undefined,
    code: string | undefined,
    meta?: RequestMeta,
  ) {
    const user = await this.loadUser(userId);
    if (!this.isEnabled(user)) {
      throw new BadRequestException({
        code: 'TWO_FACTOR_NOT_ENABLED',
        message: 'Two-factor authentication is not on',
      });
    }
    await this.checkStepUp(
      user,
      { password, code, needCode: true },
      { purpose: '2fa_disable', meta },
    );
    await this.clear(user.id);
    await this.audit.record({
      actor: { id: user.id, email: user.email, role: user.role },
      action: 'two_factor.disabled',
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email,
      meta,
    });
    this.audit.alert(
      [user.email],
      'two_factor_disabled',
      { actorEmail: user.email, meta },
      await this.audit.localeFor(user.id),
    );
    return { enabled: false };
  }

  async regenerateRecoveryCodes(
    userId: string,
    password: string | undefined,
    code: string | undefined,
    meta?: RequestMeta,
  ) {
    const user = await this.loadUser(userId);
    if (!this.isEnabled(user)) {
      throw new BadRequestException({
        code: 'TWO_FACTOR_NOT_ENABLED',
        message: 'Two-factor authentication is not on',
      });
    }
    await this.checkStepUp(
      user,
      { password, code, needCode: true },
      { purpose: '2fa_recovery', meta },
    );
    const recovery = generateRecoveryCodes();
    await this.prisma.user.update({
      where: { id: user.id },
      data: { totp_recovery_hashes: recovery.map(hashRecoveryCode) },
    });
    await this.audit.record({
      actor: { id: user.id, email: user.email, role: user.role },
      action: 'two_factor.recovery_regenerated',
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email,
      meta,
    });
    this.audit.alert(
      [user.email],
      'recovery_codes_regenerated',
      { actorEmail: user.email, meta },
      await this.audit.localeFor(user.id),
    );
    return { recovery_codes: recovery };
  }

  /** Turns 2FA off for a user (own disable, or an admin reset). */
  async clear(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        totp_secret: null,
        totp_enabled_at: null,
        totp_last_step: null,
        totp_recovery_hashes: [],
        auth_failed_count: 0,
        auth_locked_until: null,
        reauth_failed_count: 0,
        reauth_locked_until: null,
      },
    });
  }
}

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { verifyWithRotation } from '../../common/security/jwt-secrets';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SecurityAuditService } from './security-audit.service';
import { TwoFactorService, type SecurityUser } from './two-factor.service';
import type { RequestMeta } from './request-meta';
import { MagicLinkService } from '../auth/magic-link.service';

export interface ReauthInput {
  current_password?: string;
  totp_code?: string;
  /** Short-lived grant from POST /admin/reauth (admin user management only). */
  reauth_token?: string;
}

const GRANT_TYPE = 'reauth_grant';
/** How long one admin confirmation covers user-management actions. */
export const GRANT_TTL_SECONDS = 300;

/**
 * Step-up check before a sensitive change (payment keys, payout account):
 * the current password, plus a 2FA code when the account has 2FA on.
 * With `require2fa`, an account WITHOUT 2FA is refused outright.
 */
@Injectable()
export class ReauthService {
  constructor(
    private readonly twoFactor: TwoFactorService,
    private readonly prisma: PrismaService,
    private readonly audit: SecurityAuditService,
    private readonly magicLinks: MagicLinkService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * "Sudo mode" for admin user management: one confirmation (password + 2FA)
   * yields a 5-minute grant, so bulk actions work although a TOTP code is
   * single-use. Payment-key changes never accept it — they always re-ask.
   */
  async grant(userId: string, input: ReauthInput, meta?: RequestMeta) {
    const user = await this.verify(userId, input, {
      purpose: 'reauth.grant',
      require2fa: true,
      meta,
    });
    const now = Math.floor(Date.now() / 1000);
    const cutoff = user.tokens_valid_after;
    const iat = cutoff
      ? Math.max(now, Math.floor(cutoff.getTime() / 1000) + 1)
      : now;
    const reauth_token = await this.jwt.signAsync(
      { sub: user.id, type: GRANT_TYPE, iat },
      {
        secret: this.config.get<string>('JWT_SECRET')!,
        expiresIn: GRANT_TTL_SECONDS,
      },
    );
    await this.audit.record({
      actor: { id: user.id, email: user.email, role: user.role },
      action: 'reauth.granted',
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email,
      fields: [`ttl: ${GRANT_TTL_SECONDS}s`],
      meta,
    });
    return { reauth_token, expires_in: GRANT_TTL_SECONDS };
  }

  /** Accepts a valid grant of THIS user, or throws REAUTH_REQUIRED. */
  async verifyGrant(userId: string, token: string): Promise<SecurityUser> {
    const expired = () =>
      new ForbiddenException({
        code: 'REAUTH_REQUIRED',
        message: 'Confirm your password to continue',
      });
    let payload: { sub?: string; type?: string; iat?: number };
    try {
      payload = await verifyWithRotation(this.jwt, this.config, 'access', token);
    } catch {
      throw expired();
    }
    if (payload.type !== GRANT_TYPE || payload.sub !== userId) throw expired();
    const user = await this.twoFactor.loadUser(userId);
    if (user.status !== 'ACTIVE' || !this.twoFactor.isEnabled(user)) {
      throw expired();
    }
    // Sign-out everywhere, a password change or a re-auth lock kill grants.
    const cutoff = user.tokens_valid_after;
    if (cutoff && (payload.iat ?? 0) <= Math.floor(cutoff.getTime() / 1000)) {
      throw expired();
    }
    return user;
  }

  /** Admin step-up: a grant when given, otherwise password + 2FA. */
  async verifyAdmin(
    userId: string,
    input: ReauthInput,
    opts: { purpose: string; meta?: RequestMeta },
  ): Promise<SecurityUser> {
    if (input.reauth_token) return this.verifyGrant(userId, input.reauth_token);
    return this.verify(userId, input, { ...opts, require2fa: true });
  }

  async verify(
    userId: string,
    input: ReauthInput,
    opts: { purpose: string; require2fa?: boolean; meta?: RequestMeta },
  ): Promise<SecurityUser> {
    const user = await this.twoFactor.loadUser(userId);
    this.twoFactor.assertNotLocked(user, 'session');
    const enabled = this.twoFactor.isEnabled(user);
    if (opts.require2fa && !enabled) {
      throw new ForbiddenException({
        code: 'REAUTH_2FA_REQUIRED',
        message:
          'Turn on two-factor authentication before changing these settings',
      });
    }
    // One reserved attempt covers password + code (see checkStepUp).
    await this.twoFactor.checkStepUp(
      user,
      {
        password: input.current_password,
        code: input.totp_code,
        needCode: enabled,
      },
      { purpose: opts.purpose, meta: opts.meta },
    );
    return user;
  }

  /**
   * Admin resets another account's 2FA (lost phone AND recovery codes). The
   * admin re-authenticates with their own password + 2FA first.
   */
  async adminResetTwoFactor(
    adminId: string,
    targetUserId: string,
    input: ReauthInput,
    meta?: RequestMeta,
  ) {
    if (adminId === targetUserId) {
      throw new BadRequestException({
        code: 'TWO_FACTOR_RESET_SELF',
        message:
          'Use your recovery codes to reset your own two-factor authentication',
      });
    }
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, email: true, role: true, totp_enabled_at: true },
    });
    if (!target) {
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }
    const admin = await this.verifyAdmin(adminId, input, {
      purpose: '2fa_admin_reset',
      meta,
    });
    await this.twoFactor.clear(target.id);
    // A reset means the device (maybe the account) is lost: sign the target
    // out everywhere and kill any mailed login link.
    await this.prisma.user.update({
      where: { id: target.id },
      data: { tokens_valid_after: new Date() },
    });
    await this.magicLinks.invalidateForUser(target.id);
    await this.audit.record({
      actor: { id: admin.id, email: admin.email, role: UserRole.ADMIN },
      action: 'two_factor.reset_by_admin',
      targetType: 'user',
      targetId: target.id,
      targetLabel: target.email,
      meta,
    });
    this.audit.alert(
      [target.email],
      'two_factor_disabled',
      { actorEmail: admin.email, meta },
      await this.audit.localeFor(target.id),
    );
    return { enabled: false };
  }
}

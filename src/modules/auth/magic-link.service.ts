import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { LoginTokenPurpose, type User } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** Default lifetime of a magic login link. */
export const MAGIC_LINK_TTL_HOURS = 72;
/** Lifetime of an email verification link (SPEC §2). */
export const EMAIL_VERIFY_TTL_HOURS = 24;

// base64url of 32 random bytes is 43 characters; anything far outside that
// shape is rejected before touching the database.
const RAW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

/**
 * Whether an account may hold a session: ACTIVE, or PENDING for staff roles
 * (self-registered, email not verified yet; SPEC §2). Customers are never
 * PENDING through self-registration, so a PENDING customer stays locked.
 */
export function loginAllowed(user: {
  status: User['status'];
  role: User['role'];
}): boolean {
  if (user.status === 'ACTIVE') return true;
  return user.status === 'PENDING' && user.role !== 'CUSTOMER';
}

/** sha256 hex of a raw magic token: the only form ever stored. */
export function hashLoginToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Single-use, short-lived login links mailed with auto-created accounts.
 * The raw token exists only in the email (and the URL the user clicks); the
 * database keeps its sha256. Raw tokens must never be logged.
 */
@Injectable()
export class MagicLinkService {
  constructor(private readonly prisma: PrismaService) {}

  /** Creates a token for the user and returns the raw (URL-safe) value. */
  async issue(
    userId: string,
    opts: {
      storeId?: string | null;
      ttlHours?: number;
      purpose?: LoginTokenPurpose;
    } = {},
  ): Promise<string> {
    const purpose = opts.purpose ?? LoginTokenPurpose.MAGIC_LOGIN;
    const ttlHours =
      opts.ttlHours ??
      (purpose === LoginTokenPurpose.EMAIL_VERIFY
        ? EMAIL_VERIFY_TTL_HOURS
        : MAGIC_LINK_TTL_HOURS);
    const raw = randomBytes(32).toString('base64url');
    const now = new Date();

    // Opportunistic cleanup of this user's dead rows (indexed by user_id).
    await this.prisma.loginToken.deleteMany({
      where: {
        user_id: userId,
        OR: [{ expires_at: { lt: now } }, { used_at: { not: null } }],
      },
    });

    await this.prisma.loginToken.create({
      data: {
        user_id: userId,
        token_hash: hashLoginToken(raw),
        purpose,
        store_id: opts.storeId ?? null,
        expires_at: new Date(now.getTime() + ttlHours * 60 * 60 * 1000),
      },
    });
    return raw;
  }

  /**
   * The account a live (unused, unexpired) token belongs to, WITHOUT
   * redeeming it: lets the caller refuse a link opened in the wrong store
   * while leaving it usable in the right one. Null for anything not live.
   */
  async peek(
    raw: unknown,
  ): Promise<{ userId: string; role: User['role']; storeId: string | null } | null> {
    if (typeof raw !== 'string' || !RAW_TOKEN_PATTERN.test(raw)) return null;
    const row = await this.prisma.loginToken.findFirst({
      where: {
        token_hash: hashLoginToken(raw),
        purpose: LoginTokenPurpose.MAGIC_LOGIN,
        used_at: null,
        expires_at: { gt: new Date() },
      },
      select: { user: { select: { id: true, role: true, store_id: true } } },
    });
    if (!row) return null;
    return {
      userId: row.user.id,
      role: row.user.role,
      storeId: row.user.store_id,
    };
  }

  /**
   * Redeems a raw token. Atomic single use: the conditional update only
   * matches an unused, unexpired token, so two concurrent clicks cannot both
   * win. Returns the user only when the account is ACTIVE; null for unknown,
   * expired, used or inactive alike (callers answer all of them the same).
   * A PENDING staff account (email not verified yet) may still use its
   * links: it can sign in during the grace period, and the verification
   * link itself is what moves it to ACTIVE.
   */
  async consume(
    raw: unknown,
    purpose: LoginTokenPurpose = LoginTokenPurpose.MAGIC_LOGIN,
  ): Promise<User | null> {
    if (typeof raw !== 'string' || !RAW_TOKEN_PATTERN.test(raw)) return null;
    const token_hash = hashLoginToken(raw);
    const now = new Date();

    const claimed = await this.prisma.loginToken.updateMany({
      where: {
        token_hash,
        purpose,
        used_at: null,
        expires_at: { gt: now },
      },
      data: { used_at: now },
    });
    if (claimed.count !== 1) return null;

    const row = await this.prisma.loginToken.findUnique({
      where: { token_hash },
      select: { user: true },
    });
    const user = row?.user;
    if (!user || !loginAllowed(user)) return null;
    return user;
  }

  /**
   * Verification links issued to the user in the last hour (the resend
   * rate limit: 3/hour/user).
   */
  async countRecent(userId: string, purpose: LoginTokenPurpose): Promise<number> {
    return this.prisma.loginToken.count({
      where: {
        user_id: userId,
        purpose,
        created_at: { gt: new Date(Date.now() - 60 * 60 * 1000) },
      },
    });
  }

  /**
   * Drops every outstanding token of the user. Called whenever the password
   * changes or is reset, so a mailed link never outlives the password it was
   * sent with.
   */
  async invalidateForUser(userId: string): Promise<void> {
    await this.prisma.loginToken.deleteMany({ where: { user_id: userId } });
  }
}

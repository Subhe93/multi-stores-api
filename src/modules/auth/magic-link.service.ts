import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { LoginTokenPurpose, type User } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** Default lifetime of a magic login link. */
export const MAGIC_LINK_TTL_HOURS = 72;

// base64url of 32 random bytes is 43 characters; anything far outside that
// shape is rejected before touching the database.
const RAW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

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
    opts: { storeId?: string | null; ttlHours?: number } = {},
  ): Promise<string> {
    const ttlHours = opts.ttlHours ?? MAGIC_LINK_TTL_HOURS;
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
        purpose: LoginTokenPurpose.MAGIC_LOGIN,
        store_id: opts.storeId ?? null,
        expires_at: new Date(now.getTime() + ttlHours * 60 * 60 * 1000),
      },
    });
    return raw;
  }

  /**
   * Redeems a raw token. Atomic single use: the conditional update only
   * matches an unused, unexpired token, so two concurrent clicks cannot both
   * win. Returns the user only when the account is ACTIVE; null for unknown,
   * expired, used or inactive alike (callers answer all of them the same).
   */
  async consume(raw: unknown): Promise<User | null> {
    if (typeof raw !== 'string' || !RAW_TOKEN_PATTERN.test(raw)) return null;
    const token_hash = hashLoginToken(raw);
    const now = new Date();

    const claimed = await this.prisma.loginToken.updateMany({
      where: {
        token_hash,
        purpose: LoginTokenPurpose.MAGIC_LOGIN,
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
    if (!user || user.status !== 'ACTIVE') return null;
    return user;
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

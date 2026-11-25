import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { jwtSecrets } from '../../common/security/jwt-secrets';

/**
 * Review link token (M171).
 *
 * Lets the buyer of ONE order line write (or edit) the review of that line's
 * product without a session, so the link can be handed over outside the
 * storefront. Same construction as the guest order token: an HS256 JWT signed
 * with the access secret (rotation aware) that carries a `type` claim. Every
 * reader of access tokens (JwtStrategy, the guest order reader) rejects a
 * token with another `type`, so it is never a session and opens only the two
 * `reviews/link` routes. It holds ids only (no email, no name). It is not
 * single use: the same link edits the buyer's own review, nothing else.
 *
 * The token travels in JSON bodies only and is never logged.
 */

export const REVIEW_LINK_TOKEN_TYPE = 'review_link';

/** Lifetime of a review link: 90 days. */
export const REVIEW_LINK_TTL_SECONDS = 90 * 24 * 60 * 60;

/** Longest token accepted (a real one is about 450 characters). */
export const REVIEW_LINK_TOKEN_MAX_LENGTH = 1024;

export const REVIEW_LINK_INVALID = {
  code: 'REVIEW_LINK_INVALID',
  message: 'This review link is no longer valid.',
} as const;

/** What a review link is bound to. */
export interface ReviewLinkClaims {
  /** User id of the order's customer. */
  userId: string;
  storeId: string;
  orderId: string;
  orderItemId: string;
}

/** Verified claims, with the instant the link stops working. */
export interface VerifiedReviewLink extends ReviewLinkClaims {
  expiresAt: string;
}

type RawClaims = {
  sub?: unknown;
  type?: unknown;
  sid?: unknown;
  oid?: unknown;
  oi?: unknown;
  exp?: unknown;
};

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

@Injectable()
export class ReviewLinkTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /** A token good only for this order line, and when it stops working. */
  async sign(
    claims: ReviewLinkClaims,
  ): Promise<{ token: string; expires_at: string }> {
    const [secret] = jwtSecrets(this.config, 'access');
    if (!secret) throw new Error('No access JWT secret configured');
    const token = await this.jwt.signAsync(
      {
        sub: claims.userId,
        type: REVIEW_LINK_TOKEN_TYPE,
        sid: claims.storeId,
        oid: claims.orderId,
        oi: claims.orderItemId,
      },
      {
        secret,
        algorithm: 'HS256',
        expiresIn: REVIEW_LINK_TTL_SECONDS,
      },
    );
    return {
      token,
      expires_at: new Date(
        Date.now() + REVIEW_LINK_TTL_SECONDS * 1000,
      ).toISOString(),
    };
  }

  /**
   * The claims of a review link, or 401 REVIEW_LINK_INVALID for anything
   * else (missing, over-long, malformed, expired, wrong signature, a session
   * or any other purpose token). One answer for every failure.
   */
  async verify(token: string | null | undefined): Promise<VerifiedReviewLink> {
    const invalid = () => new UnauthorizedException(REVIEW_LINK_INVALID);
    if (
      typeof token !== 'string' ||
      !token ||
      token.length > REVIEW_LINK_TOKEN_MAX_LENGTH
    ) {
      throw invalid();
    }
    let payload: RawClaims | null = null;
    for (const secret of jwtSecrets(this.config, 'access')) {
      try {
        payload = await this.jwt.verifyAsync<RawClaims>(token, {
          secret,
          algorithms: ['HS256'],
        });
        break;
      } catch {
        // Try the previous secret (rotation), then give up.
      }
    }
    if (
      !payload ||
      payload.type !== REVIEW_LINK_TOKEN_TYPE ||
      !nonEmpty(payload.sub) ||
      !nonEmpty(payload.sid) ||
      !nonEmpty(payload.oid) ||
      !nonEmpty(payload.oi) ||
      typeof payload.exp !== 'number'
    ) {
      throw invalid();
    }
    return {
      userId: payload.sub,
      storeId: payload.sid,
      orderId: payload.oid,
      orderItemId: payload.oi,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    };
  }
}

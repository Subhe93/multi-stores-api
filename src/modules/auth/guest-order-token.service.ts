import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { jwtSecrets } from '../../common/security/jwt-secrets';

/**
 * Guest order token.
 *
 * A guest checkout (POST /orders/guest) never signs anyone in: the order is
 * attached to a customer record found or created by email, and the shopper
 * gets this token instead of a session. It is bound to ONE order and opens
 * only that order's payment and confirmation routes (the guest routes that
 * use GuestOrderGuard).
 *
 * It is signed with the access secret (rotation aware) and carries
 * `type: 'guest_order'`. Every reader of access tokens (JwtStrategy, the
 * storefront viewer gate) rejects a token that has a `type`, so it is not a
 * session and opens no existing route. There is no refresh token: after 24
 * hours it is gone, and the order confirmation email is what remains.
 */

export const GUEST_ORDER_TOKEN_TYPE = 'guest_order';

/** Lifetime: long enough to pay and read the confirmation, not a session. */
export const GUEST_ORDER_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export const GUEST_TOKEN_INVALID = {
  code: 'GUEST_TOKEN_INVALID',
  message: 'This order link is no longer valid.',
} as const;

/** What a verified guest token says. */
export interface GuestOrderClaims {
  /** The user the order's customer record belongs to. */
  userId: string;
  orderId: string;
  storeId: string | null;
}

type RawClaims = {
  sub?: unknown;
  type?: unknown;
  oid?: unknown;
  sid?: unknown;
};

@Injectable()
export class GuestOrderTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /** A token good only for `orderId`, and when it stops working. */
  async sign(claims: GuestOrderClaims): Promise<{
    guest_token: string;
    guest_token_expires_at: string;
  }> {
    const [secret] = jwtSecrets(this.config, 'access');
    if (!secret) throw new Error('No access JWT secret configured');
    const guest_token = await this.jwt.signAsync(
      {
        sub: claims.userId,
        type: GUEST_ORDER_TOKEN_TYPE,
        oid: claims.orderId,
        sid: claims.storeId,
      },
      {
        secret,
        algorithm: 'HS256',
        expiresIn: GUEST_ORDER_TOKEN_TTL_SECONDS,
      },
    );
    return {
      guest_token,
      guest_token_expires_at: new Date(
        Date.now() + GUEST_ORDER_TOKEN_TTL_SECONDS * 1000,
      ).toISOString(),
    };
  }

  /**
   * The claims of a guest token, or 401 GUEST_TOKEN_INVALID for anything
   * else (missing, malformed, expired, wrong signature, a session or any
   * other purpose token). One answer for every failure.
   */
  async verify(token: string | null | undefined): Promise<GuestOrderClaims> {
    const invalid = () => new UnauthorizedException(GUEST_TOKEN_INVALID);
    if (!token) throw invalid();
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
      payload.type !== GUEST_ORDER_TOKEN_TYPE ||
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      typeof payload.oid !== 'string' ||
      !payload.oid
    ) {
      throw invalid();
    }
    return {
      userId: payload.sub,
      orderId: payload.oid,
      storeId: typeof payload.sid === 'string' ? payload.sid : null,
    };
  }
}

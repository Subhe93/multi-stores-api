import { createHmac } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

/** Audience (purpose) claim of a storefront edit-hint token. */
export const EDIT_HINT_AUDIENCE = 'storefront-edit-hint';

/** Lifetime of an edit-hint token (seconds): 30 days. */
export const EDIT_HINT_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Claims of an edit-hint token. Deliberately has no `sub`/`role`. */
export interface EditHintClaims {
  store_id: string;
  user_id: string;
}

/**
 * Signs and verifies the "edit hint" token the dashboard hands to the
 * storefront so the store owner sees an "Edit" button on their own shop.
 *
 * The token only tells the storefront "this browser belongs to the owner of
 * store X"; it grants no API access. It is signed with a secret DERIVED from
 * JWT_SECRET (HMAC with a fixed purpose label), never with JWT_SECRET
 * itself, so the regular passport JWT guard rejects it on signature, and it
 * carries a dedicated `aud` claim checked on verify.
 */
@Injectable()
export class EditHintTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  private secret(): string {
    const base = this.config.get<string>('JWT_SECRET');
    if (!base) throw new Error('JWT_SECRET is not configured');
    return createHmac('sha256', base)
      .update(`purpose:${EDIT_HINT_AUDIENCE}`)
      .digest('base64url');
  }

  sign(claims: EditHintClaims): { token: string; expires_in: number } {
    const token = this.jwt.sign(
      { store_id: claims.store_id, user_id: claims.user_id },
      {
        secret: this.secret(),
        audience: EDIT_HINT_AUDIENCE,
        expiresIn: EDIT_HINT_TTL_SECONDS,
      },
    );
    return { token, expires_in: EDIT_HINT_TTL_SECONDS };
  }

  /** The token's claims, or null when it is malformed, forged or expired. */
  verify(token: string | null | undefined): EditHintClaims | null {
    if (!token || token.length > 2048) return null;
    try {
      const payload = this.jwt.verify<Partial<EditHintClaims>>(token, {
        secret: this.secret(),
        audience: EDIT_HINT_AUDIENCE,
        algorithms: ['HS256'],
      });
      if (
        typeof payload.store_id !== 'string' ||
        typeof payload.user_id !== 'string' ||
        !payload.store_id ||
        !payload.user_id
      ) {
        return null;
      }
      return { store_id: payload.store_id, user_id: payload.user_id };
    } catch {
      return null;
    }
  }
}

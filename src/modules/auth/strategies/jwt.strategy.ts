import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { PrismaService } from '../../../prisma/prisma.service';
import type { RequestUser } from '../../../common/decorators/current-user.decorator';
import {
  tokenIssuedAfterCutoff,
  tokenStoreMatches,
  type AuthTokenPayload,
} from '../auth.service';
import { loginAllowed } from '../magic-link.service';
import { jwtSecrets } from '../../../common/security/jwt-secrets';
import {
  ACCOUNT_EMAIL_UNVERIFIED_EXPIRED,
  graceExempt,
  graceExpired,
  isUnverifiedStaff,
} from '../../../common/guards/verified-account.guard';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private prisma: PrismaService,
    jwtService: JwtService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // HMAC only: the secrets are strings, never public keys.
      algorithms: ['HS256'],
      // Secret rotation: a token signed with the previous JWT_SECRET keeps
      // verifying while JWT_SECRET_PREVIOUS is set. The provider picks the
      // secret the token was signed with; passport then verifies with it.
      secretOrKeyProvider: (
        _req: unknown,
        rawToken: string,
        done: (err: unknown, secret?: string) => void,
      ) => {
        const [current, ...rest] = jwtSecrets(configService, 'access');
        void (async () => {
          for (const secret of rest) {
            try {
              await jwtService.verifyAsync(rawToken, { secret, algorithms: ['HS256'] });
              return done(null, secret);
            } catch {
              // Not this one; fall through to the current secret so the
              // real verification error (expired, bad signature) surfaces.
            }
          }
          done(null, current);
        })();
      },
      // The request is needed for the grace-period rule (method + path).
      passReqToCallback: true,
    });
  }

  async validate(
    req: Pick<Request, 'method' | 'originalUrl' | 'url'> | undefined,
    payload: Partial<AuthTokenPayload> & { type?: string; iat?: number },
  ): Promise<RequestUser> {
    // Purpose tokens signed with the same secret (password reset carries
    // `type`) are not access tokens.
    if (!payload.sub || payload.type !== undefined) {
      throw new UnauthorizedException();
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        store_id: true,
        tokens_valid_after: true,
        email_verified_at: true,
        created_at: true,
      },
    });

    // ACTIVE, or PENDING for staff (email unverified, SPEC §2).
    if (!user || !loginAllowed(user)) {
      throw new UnauthorizedException();
    }
    // A customer token without the store_id claim predates per-store
    // accounts; reject it so the customer logs in again on the store.
    if (!tokenStoreMatches(payload, user)) {
      throw new UnauthorizedException();
    }
    // Issued before the last block / password reset / password change.
    if (!tokenIssuedAfterCutoff(payload, user)) {
      throw new UnauthorizedException();
    }

    // Grace period over: a PENDING staff account may only read, verify,
    // resend, log out and read its profile.
    if (
      isUnverifiedStaff(user) &&
      graceExpired(user.created_at) &&
      req &&
      !graceExempt(req.method ?? 'GET', req.originalUrl ?? req.url ?? '')
    ) {
      throw new ForbiddenException(ACCOUNT_EMAIL_UNVERIFIED_EXPIRED);
    }

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      storeId: user.store_id,
    };
  }
}

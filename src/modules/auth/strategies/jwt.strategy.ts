import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { PrismaService } from '../../../prisma/prisma.service';
import type { RequestUser } from '../../../common/decorators/current-user.decorator';
import {
  tokenIssuedAfterCutoff,
  tokenStoreMatches,
  type AuthTokenPayload,
} from '../auth.service';
import { loginAllowed } from '../magic-link.service';
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
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET')!,
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

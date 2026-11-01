import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import type { RequestUser } from '../../../common/decorators/current-user.decorator';
import {
  tokenIssuedAfterCutoff,
  tokenStoreMatches,
  type AuthTokenPayload,
} from '../auth.service';

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
    });
  }

  async validate(
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
      },
    });

    if (!user || user.status !== 'ACTIVE') {
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

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      storeId: user.store_id,
    };
  }
}

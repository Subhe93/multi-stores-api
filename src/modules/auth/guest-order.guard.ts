import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import {
  GUEST_TOKEN_INVALID,
  GuestOrderTokenService,
  type GuestOrderClaims,
} from './guest-order-token.service';

type GuestRequest = Request & { guestOrder?: GuestOrderClaims };

/** `Authorization: Bearer <token>` of a request, or null. */
function bearerOf(req: Pick<Request, 'headers'>): string | null {
  const header = req.headers?.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Guards the guest order routes: the bearer must be a valid guest order
 * token (never a session token) whose customer account is still an ACTIVE
 * customer. The claims land on the request for `@GuestOrder()`; the route
 * still has to check that the order it serves is the token's order
 * (assertGuestOrder). Every failure is the same 401 GUEST_TOKEN_INVALID.
 */
@Injectable()
export class GuestOrderGuard implements CanActivate {
  constructor(
    private readonly tokens: GuestOrderTokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<GuestRequest>();
    const claims = await this.tokens.verify(bearerOf(req));
    const user = await this.prisma.user.findUnique({
      where: { id: claims.userId },
      select: { role: true, status: true },
    });
    // A blocked or removed account loses its guest links too.
    if (!user || user.role !== UserRole.CUSTOMER || user.status !== 'ACTIVE') {
      throw new UnauthorizedException(GUEST_TOKEN_INVALID);
    }
    req.guestOrder = claims;
    return true;
  }
}

/** The verified guest token claims of the request (after GuestOrderGuard). */
export const GuestOrder = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): GuestOrderClaims => {
    const claims = ctx.switchToHttp().getRequest<GuestRequest>().guestOrder;
    if (!claims) throw new UnauthorizedException(GUEST_TOKEN_INVALID);
    return claims;
  },
);

/**
 * 401 GUEST_TOKEN_INVALID unless `orderId` is the order the token was
 * issued for: a guest token never reads or pays any other order, not even
 * another order of the same customer.
 */
export function assertGuestOrder(
  claims: GuestOrderClaims,
  orderId: string,
): void {
  if (!orderId || claims.orderId !== orderId) {
    throw new UnauthorizedException(GUEST_TOKEN_INVALID);
  }
}

import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';

/**
 * JWT auth that tolerates anonymous callers. No Authorization header means
 * "guest" (request.user stays undefined); a header that is present but
 * invalid is still rejected with 401, so an expired token never silently
 * downgrades a logged-in customer to a guest checkout.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.headers.authorization) return true;
    return super.canActivate(context);
  }
}

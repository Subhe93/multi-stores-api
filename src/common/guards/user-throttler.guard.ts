import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * ThrottlerGuard that counts per signed-in user instead of per IP, so users
 * behind one shared IP do not share a budget. Apply it after the auth guard
 * (method-level `@UseGuards` runs after the controller's guards); without a
 * user it falls back to the IP.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as { id?: string } | undefined;
    return Promise.resolve(user?.id ? `user:${user.id}` : String(req.ip));
  }
}

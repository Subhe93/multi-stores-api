import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole, UserStatus } from '@prisma/client';
import {
  VERIFIED_ACCOUNT_KEY,
  type VerifiedAccountOptions,
} from '../decorators/verified-account.decorator';
import type { RequestUser } from '../decorators/current-user.decorator';

/** Days a PENDING staff account may keep working before every write locks. */
export const VERIFICATION_GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export const ACCOUNT_EMAIL_UNVERIFIED = {
  code: 'ACCOUNT_EMAIL_UNVERIFIED',
  message: 'Verify your email address to do this.',
} as const;

export const ACCOUNT_EMAIL_UNVERIFIED_EXPIRED = {
  code: 'ACCOUNT_EMAIL_UNVERIFIED_EXPIRED',
  message:
    'Your email address is still unverified after the grace period. Verify it to continue.',
} as const;

/** A self-registered staff account that has not verified its email yet. */
export function isUnverifiedStaff(user: {
  role: UserRole;
  status: UserStatus;
}): boolean {
  return user.role !== UserRole.CUSTOMER && user.status === UserStatus.PENDING;
}

/** When a PENDING account's grace period ends (created_at + 7 days). */
export function verificationDeadline(createdAt: Date): Date {
  return new Date(createdAt.getTime() + VERIFICATION_GRACE_DAYS * DAY_MS);
}

export function graceExpired(createdAt: Date, now = new Date()): boolean {
  return now.getTime() >= verificationDeadline(createdAt).getTime();
}

/**
 * Requests a PENDING account past the grace period may still make: anything
 * read-only, plus verification, resend, logout and the profile read.
 */
export function graceExempt(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  const p = path.split('?')[0].replace(/\/+$/, '');
  return /\/auth\/(verify-email|resend-verification|logout|me)$/.test(p);
}

/**
 * 403 ACCOUNT_EMAIL_UNVERIFIED on routes decorated with @VerifiedAccount()
 * when the caller is a PENDING staff account (customers are never PENDING
 * through self-registration and are not affected). Routes without the
 * decorator pass through. Runs after AuthGuard('jwt').
 */
@Injectable()
export class VerifiedAccountGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.getAllAndOverride<
      VerifiedAccountOptions | undefined
    >(VERIFIED_ACCOUNT_KEY, [context.getHandler(), context.getClass()]);
    if (!options) return true;

    const req = context.switchToHttp().getRequest<{
      user?: RequestUser;
      params?: Record<string, string>;
      body?: unknown;
    }>();
    const user = req.user;
    if (!user || !isUnverifiedStaff(user)) return true;

    if (!locked(options, req)) return true;
    throw new ForbiddenException(ACCOUNT_EMAIL_UNVERIFIED);
  }
}

function locked(
  options: VerifiedAccountOptions,
  req: { params?: Record<string, string>; body?: unknown },
): boolean {
  const conditional = options.fields?.length || options.when;
  if (!conditional) return true;
  if (options.fields?.length) {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (options.fields.some((f) => body[f] !== undefined)) return true;
  }
  return options.when ? options.when(req) : false;
}

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole, UserStatus } from '@prisma/client';
import {
  VerifiedAccountGuard,
  graceExempt,
  graceExpired,
  isUnverifiedStaff,
  verificationDeadline,
} from './verified-account.guard';
import { VERIFIED_ACCOUNT_KEY, type VerifiedAccountOptions } from '../decorators';

// SPEC §2: locked actions for PENDING (unverified) staff accounts and the
// 7-day grace period rules the JWT strategy applies.

function context(
  request: Record<string, unknown>,
  options: VerifiedAccountOptions | undefined,
) {
  const reflector = {
    getAllAndOverride: jest.fn((key: string) =>
      key === VERIFIED_ACCOUNT_KEY ? options : undefined,
    ),
  } as unknown as Reflector;
  const ctx = {
    getHandler: () => 'h',
    getClass: () => 'c',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { guard: new VerifiedAccountGuard(reflector), ctx };
}

const pending = {
  id: 'u1',
  email: 'a@b.se',
  role: UserRole.CREATOR,
  status: UserStatus.PENDING,
  storeId: null,
};
const active = { ...pending, status: UserStatus.ACTIVE };

function expectLocked(fn: () => boolean) {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ForbiddenException);
  expect((err as ForbiddenException).getResponse()).toMatchObject({
    code: 'ACCOUNT_EMAIL_UNVERIFIED',
  });
}

describe('VerifiedAccountGuard', () => {
  it('passes routes without @VerifiedAccount and verified users', () => {
    const open = context({ user: pending }, undefined);
    expect(open.guard.canActivate(open.ctx)).toBe(true);
    const verified = context({ user: active, body: {} }, {});
    expect(verified.guard.canActivate(verified.ctx)).toBe(true);
  });

  it('locks a PENDING staff account on a locked route (403 ACCOUNT_EMAIL_UNVERIFIED)', () => {
    const { guard, ctx } = context({ user: pending, body: {} }, {});
    expectLocked(() => guard.canActivate(ctx));
  });

  it('with `fields`, locks only when one of them is in the body', () => {
    const opts = { fields: ['is_active', 'custom_domain'] };
    const name = context({ user: pending, body: { name: 'X' } }, opts);
    expect(name.guard.canActivate(name.ctx)).toBe(true);
    const toggle = context({ user: pending, body: { is_active: false } }, opts);
    expectLocked(() => toggle.guard.canActivate(toggle.ctx));
  });

  it('with `when`, locks when the predicate says so', () => {
    const opts: VerifiedAccountOptions = {
      when: (req) => req.params?.appKey === 'feeds',
    };
    const other = context({ user: pending, params: { appKey: 'b2b' } }, opts);
    expect(other.guard.canActivate(other.ctx)).toBe(true);
    const feeds = context({ user: pending, params: { appKey: 'feeds' } }, opts);
    expectLocked(() => feeds.guard.canActivate(feeds.ctx));
  });

  it('a PENDING customer is not a staff case', () => {
    const customer = { ...pending, role: UserRole.CUSTOMER, storeId: 's1' };
    expect(isUnverifiedStaff(customer)).toBe(false);
    const { guard, ctx } = context({ user: customer, body: {} }, {});
    expect(guard.canActivate(ctx)).toBe(true);
  });
});

describe('grace period helpers', () => {
  const created = new Date('2026-11-01T00:00:00Z');

  it('deadline is created_at + 7 days', () => {
    expect(verificationDeadline(created).toISOString()).toBe(
      '2026-11-08T00:00:00.000Z',
    );
    expect(graceExpired(created, new Date('2026-11-07T23:59:59Z'))).toBe(false);
    expect(graceExpired(created, new Date('2026-11-08T00:00:00Z'))).toBe(true);
  });

  it('after the grace period only reads, verify, resend, logout and profile stay open', () => {
    expect(graceExempt('GET', '/api/stores/my/store')).toBe(true);
    expect(graceExempt('POST', '/api/auth/verify-email')).toBe(true);
    expect(graceExempt('POST', '/api/auth/resend-verification')).toBe(true);
    expect(graceExempt('POST', '/api/auth/logout')).toBe(true);
    expect(graceExempt('GET', '/api/auth/me?x=1')).toBe(true);
    expect(graceExempt('POST', '/api/stores')).toBe(false);
    expect(graceExempt('PUT', '/api/stores/my/store')).toBe(false);
    expect(graceExempt('DELETE', '/api/products/p1')).toBe(false);
  });
});

import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  REVIEW_LINK_TOKEN_MAX_LENGTH,
  REVIEW_LINK_TOKEN_TYPE,
  REVIEW_LINK_TTL_SECONDS,
  ReviewLinkTokenService,
} from './review-link-token.service';
import {
  GUEST_ORDER_TOKEN_TYPE,
  GuestOrderTokenService,
} from '../auth/guest-order-token.service';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { TEST_JWT_SECRET, fakeConfig } from './reviews-fake-db.mockspec';

const jwt = new JwtService({});
const claims = {
  userId: 'user-1',
  storeId: 'store-1',
  orderId: 'order-1',
  orderItemId: 'item-1',
};

function service(extra: Record<string, string | undefined> = {}) {
  return new ReviewLinkTokenService(
    jwt,
    fakeConfig(extra) as unknown as ConfigService,
  );
}

async function expectInvalid(p: Promise<unknown>) {
  await expect(p).rejects.toBeInstanceOf(UnauthorizedException);
  await p.catch((e: UnauthorizedException) =>
    expect(e.getResponse()).toEqual({
      code: 'REVIEW_LINK_INVALID',
      message: 'This review link is no longer valid.',
    }),
  );
}

const signRaw = (payload: object, secret = TEST_JWT_SECRET, expiresIn = 600) =>
  jwt.signAsync(payload, { secret, algorithm: 'HS256', expiresIn });

describe('ReviewLinkTokenService', () => {
  it('round trip: the four ids and the expiry, 90 days', async () => {
    const svc = service();
    const before = Date.now();
    const { token, expires_at } = await svc.sign(claims);
    const out = await svc.verify(token);
    expect(out).toMatchObject(claims);
    const ttlMs = REVIEW_LINK_TTL_SECONDS * 1000;
    expect(REVIEW_LINK_TTL_SECONDS).toBe(90 * 24 * 60 * 60);
    expect(new Date(expires_at).getTime()).toBeGreaterThanOrEqual(
      before + ttlMs,
    );
    expect(
      Math.abs(
        new Date(out.expiresAt).getTime() - new Date(expires_at).getTime(),
      ),
    ).toBeLessThan(2000);
    expect(token.length).toBeLessThan(REVIEW_LINK_TOKEN_MAX_LENGTH);
  });

  it('holds ids and the type only (no email, no name)', async () => {
    const { token } = await service().sign(claims);
    const payload = jwt.decode<Record<string, unknown>>(token);
    expect(Object.keys(payload).sort()).toEqual(
      ['exp', 'iat', 'oi', 'oid', 'sid', 'sub', 'type'].sort(),
    );
    expect(payload.type).toBe(REVIEW_LINK_TOKEN_TYPE);
  });

  it('expired -> 401', async () => {
    const token = await signRaw(
      {
        sub: 'u',
        type: REVIEW_LINK_TOKEN_TYPE,
        sid: 's',
        oid: 'o',
        oi: 'i',
      },
      TEST_JWT_SECRET,
      -10,
    );
    await expectInvalid(service().verify(token));
  });

  it('missing, empty, malformed and over-long tokens -> 401', async () => {
    const svc = service();
    await expectInvalid(svc.verify(undefined));
    await expectInvalid(svc.verify(null));
    await expectInvalid(svc.verify(''));
    await expectInvalid(svc.verify('not-a-jwt'));
    await expectInvalid(svc.verify(42 as unknown as string));
    const { token } = await svc.sign(claims);
    await expectInvalid(
      svc.verify(token + 'a'.repeat(REVIEW_LINK_TOKEN_MAX_LENGTH)),
    );
  });

  it('forged signature or another secret -> 401', async () => {
    const svc = service();
    const { token } = await svc.sign(claims);
    const [h, p, s] = token.split('.');
    const flipped = s.startsWith('A') ? `B${s.slice(1)}` : `A${s.slice(1)}`;
    await expectInvalid(svc.verify(`${h}.${p}.${flipped}`));
    const foreign = await signRaw(
      { sub: 'u', type: REVIEW_LINK_TOKEN_TYPE, sid: 's', oid: 'o', oi: 'i' },
      'another-secret-0123456789abcdefgh',
    );
    await expectInvalid(svc.verify(foreign));
    // An unsigned token (alg none) is never accepted.
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`;
    await expectInvalid(svc.verify(none));
  });

  it('wrong type: a guest-order token and an access token -> 401', async () => {
    const svc = service();
    const guest = await new GuestOrderTokenService(
      jwt,
      fakeConfig() as unknown as ConfigService,
    ).sign({ userId: 'u', orderId: 'o', storeId: 's' });
    await expectInvalid(svc.verify(guest.guest_token));
    const access = await signRaw({
      sub: 'u',
      email: 'a@example.test',
      role: 'CUSTOMER',
      store_id: 's',
    });
    await expectInvalid(svc.verify(access));
    const typed = await signRaw({
      sub: 'u',
      type: GUEST_ORDER_TOKEN_TYPE,
      sid: 's',
      oid: 'o',
      oi: 'i',
    });
    await expectInvalid(svc.verify(typed));
  });

  it.each(['sub', 'sid', 'oid', 'oi'])(
    'a token without %s (or with an empty / non-string one) -> 401',
    async (key) => {
      const full = {
        sub: 'u',
        type: REVIEW_LINK_TOKEN_TYPE,
        sid: 's',
        oid: 'o',
        oi: 'i',
      };
      const { [key as keyof typeof full]: _omit, ...missing } = full;
      void _omit;
      await expectInvalid(service().verify(await signRaw(missing)));
      await expectInvalid(
        service().verify(await signRaw({ ...full, [key]: '' })),
      );
      await expectInvalid(
        service().verify(await signRaw({ ...full, [key]: 7 })),
      );
    },
  );

  it('rotation: a token signed with the previous secret still verifies', async () => {
    const old = 'previous-secret-0123456789abcdefgh';
    const { token } = await service({ JWT_SECRET: old }).sign(claims);
    // After the rotation: new current secret, old one kept as previous.
    await expect(
      service({ JWT_SECRET_PREVIOUS: old }).verify(token),
    ).resolves.toMatchObject(claims);
    // Grace window closed.
    await expectInvalid(service().verify(token));
    // New tokens are always signed with the current secret.
    const fresh = await service({ JWT_SECRET_PREVIOUS: old }).sign(claims);
    await expect(service().verify(fresh.token)).resolves.toMatchObject(claims);
  });

  it('signing without a secret fails loudly', async () => {
    await expect(
      service({ JWT_SECRET: undefined }).sign(claims),
    ).rejects.toThrow('No access JWT secret configured');
  });

  describe('is never a session', () => {
    it('JwtStrategy rejects a review-link payload (it carries `type`)', async () => {
      const { token } = await service().sign(claims);
      const prisma = { user: { findUnique: jest.fn() } };
      const strategy = new JwtStrategy(
        fakeConfig() as unknown as ConfigService,
        prisma as never,
        jwt,
      );
      await expect(
        strategy.validate(undefined, jwt.decode(token)),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      // Rejected before any account lookup.
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('the guest-order reader rejects a review-link token', async () => {
      const { token } = await service().sign(claims);
      await expect(
        new GuestOrderTokenService(
          jwt,
          fakeConfig() as unknown as ConfigService,
        ).verify(token),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});

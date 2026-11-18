import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import { AuthService } from '../auth/auth.service';
import type { AccountCredentialsService } from '../auth/account-credentials.service';
import type { AccountLinksService } from '../auth/account-links.service';
import type { MagicLinkService } from '../auth/magic-link.service';
import {
  GUEST_ORDER_TOKEN_TTL_SECONDS,
  GuestOrderTokenService,
} from '../auth/guest-order-token.service';
import { GuestOrderGuard, assertGuestOrder } from '../auth/guest-order.guard';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import type { DesignerCartService } from '../designer/designer-cart.service';
import type { MailService } from '../mail/mail.service';
import type { TwoFactorService } from '../security/two-factor.service';
import type { TurnstileService } from '../../common/security/turnstile.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PaymentsService } from '../payments/payments.service';
import { PaymentsController } from '../payments/payments.controller';
import type { PaymentKeysGuardService } from '../security/payment-keys-guard.service';
import type { StorefrontGateService } from '../storefront/storefront-gate.service';
import type { GuestOrderDto } from './dto/guest-order.dto';
import { GuestOrderService } from './guest-order.service';
import { forGuest } from './guest-order-view';
import { OrdersGuestController } from './orders-guest.controller';
import type { OrdersService } from './orders.service';

// Guest checkout (POST /orders/guest): one public call places an order
// without signing anyone in. A new email gets a customer record but no
// credentials email and no session; a known email is never blocked and
// nothing of its account is read, changed or returned. The answer carries
// a token bound to that one order.

const SECRET = 'access-secret-for-specs';
const PREVIOUS = 'previous-access-secret';

const configOf = (values: Record<string, string | undefined>) =>
  ({
    get: (key: string) => values[key],
  }) as unknown as ConfigService;

const tokensOf = (values: Record<string, string | undefined> = {}) =>
  new GuestOrderTokenService(
    new JwtService({}),
    configOf({ JWT_SECRET: SECRET, ...values }),
  );

type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  role: UserRole;
  status: string;
  store_id: string | null;
};
type CustomerRow = {
  id: string;
  user_id: string;
  first_name: string;
  last_name: string;
  phone?: string;
};
type AddressRow = Record<string, unknown> & { id: string };

const STORE = {
  id: 's1',
  slug: 'shop',
  name: 'Shop',
  primaryLocale: 'en',
  isActive: true,
  base: 'https://shop.example',
};

function build(
  seed: {
    users?: UserRow[];
    customers?: CustomerRow[];
    addresses?: AddressRow[];
    captcha?: 'ok' | 'fail';
    designer?: boolean;
  } = {},
) {
  const users = [...(seed.users ?? [])];
  const customers = [...(seed.customers ?? [])];
  const addresses = [...(seed.addresses ?? [])];
  let seq = 0;
  const prisma = {
    user: {
      findUnique: jest.fn(
        ({
          where,
        }: {
          where: {
            id?: string;
            store_id_email?: { store_id: string; email: string };
          };
        }) =>
          Promise.resolve(
            users.find((u) =>
              where.store_id_email
                ? u.store_id === where.store_id_email.store_id &&
                  u.email === where.store_id_email.email
                : u.id === where.id,
            ) ?? null,
          ),
      ),
      findFirst: jest.fn(() => Promise.resolve(null)),
      create: jest.fn(
        ({
          data,
        }: {
          data: Omit<UserRow, 'id'> & {
            customer: { create: Omit<CustomerRow, 'id' | 'user_id'> };
          };
        }) => {
          const { customer, ...row } = data;
          const user = { ...row, id: `u-new-${++seq}` };
          users.push(user);
          const profile = {
            ...customer.create,
            id: `c-new-${seq}`,
            user_id: user.id,
          };
          customers.push(profile);
          return Promise.resolve({
            id: user.id,
            customer: { id: profile.id },
          });
        },
      ),
      update: jest.fn(),
    },
    customer: {
      findUnique: jest.fn(({ where }: { where: { user_id: string } }) =>
        Promise.resolve(
          customers.find((c) => c.user_id === where.user_id) ?? null,
        ),
      ),
      create: jest.fn(({ data }: { data: Omit<CustomerRow, 'id'> }) => {
        const row = { ...data, id: `c-new-${++seq}` };
        customers.push(row);
        return Promise.resolve({ id: row.id });
      }),
      update: jest.fn(),
    },
    address: {
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          addresses.find((a) =>
            Object.entries(where).every(([k, v]) => (a[k] ?? null) === v),
          ) ?? null,
        ),
      ),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: `a-new-${++seq}` };
        addresses.push(row);
        return Promise.resolve({ id: row.id });
      }),
      update: jest.fn(),
    },
    cart: { findUnique: jest.fn(), update: jest.fn(), deleteMany: jest.fn() },
    cartItem: { deleteMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    storeDomain: { findMany: jest.fn(() => Promise.resolve([])) },
    store: { findUnique: jest.fn(() => Promise.resolve(null)) },
  };
  const mail = {
    sendWelcome: jest.fn(),
    dispatchOrderEmail: jest.fn(),
  };
  const magicLinks = { issue: jest.fn(), create: jest.fn() };
  const credentials = { send: jest.fn(() => Promise.resolve()) };
  const links = {
    resolveRequestStore: jest.fn((slug?: string | null, host?: string | null) =>
      Promise.resolve(slug || host ? STORE : null),
    ),
  };
  const turnstile = {
    customersEnabled: false,
    verifyCustomer: jest.fn(() =>
      seed.captcha === 'fail'
        ? Promise.reject(
            Object.assign(new Error('captcha'), {
              response: { code: 'AUTH_CAPTCHA_FAILED' },
            }),
          )
        : Promise.resolve(),
    ),
  };
  const jwt = new JwtService({});
  const signSpy = jest.spyOn(jwt, 'signAsync');
  const config = configOf({ JWT_SECRET: SECRET });
  const auth = new AuthService(
    prisma as unknown as PrismaService,
    jwt,
    config,
    mail as unknown as MailService,
    magicLinks as unknown as MagicLinkService,
    links as unknown as AccountLinksService,
    credentials as unknown as AccountCredentialsService,
    {} as TwoFactorService,
    turnstile as unknown as TurnstileService,
  );
  const orders = {
    create: jest.fn(
      (userId: string, dto: { address_id: string; store_id: string }) =>
        Promise.resolve({
          id: 'o1',
          order_number: 'ORD-1',
          store_id: dto.store_id,
          address_id: dto.address_id,
          total: 100,
          items: [{ id: 'i1', quantity: 1 }],
          // create() answers the buyer view, which carries the account.
          customer: {
            id: customers.find((c) => c.user_id === userId)?.id,
            first_name: 'Account',
            last_name: 'Owner',
            phone: '+46700000000',
            user: { email: 'owner@example.com', status: 'ACTIVE' },
          },
        }),
    ),
    releaseStaleOrdersOfCustomer: jest.fn(() => Promise.resolve()),
    findById: jest.fn(),
  };
  const designerCart = {
    verifySessionDesigns: jest.fn(() => Promise.resolve(new Set(['d1']))),
  };
  const tokens = new GuestOrderTokenService(new JwtService({}), config);
  const service = new GuestOrderService(
    prisma as unknown as PrismaService,
    auth,
    orders as unknown as OrdersService,
    tokens,
    seed.designer
      ? (designerCart as unknown as DesignerCartService)
      : undefined,
  );
  return {
    service,
    prisma,
    users,
    customers,
    addresses,
    mail,
    magicLinks,
    credentials,
    links,
    turnstile,
    orders,
    designerCart,
    tokens,
    signSpy,
  };
}

const dto = (over: Partial<GuestOrderDto> = {}): GuestOrderDto => ({
  email: 'New.Buyer@Example.com',
  first_name: 'New',
  last_name: 'Buyer',
  store_slug: 'shop',
  store_id: 's1',
  payment_method: 'STRIPE',
  address: {
    full_name: 'New Buyer',
    line1: 'Main street 1',
    city: 'Stockholm',
    postal_code: '11122',
    country_code: 'se',
  },
  lines: [{ product_id: 'p1', quantity: 2 }],
  ...over,
});

const existingAccount = (status = 'ACTIVE') => ({
  users: [
    {
      id: 'u-old',
      email: 'returning@example.com',
      password_hash: 'hash-of-the-owner',
      role: UserRole.CUSTOMER,
      status,
      store_id: 's1',
    },
  ],
  customers: [
    {
      id: 'c-old',
      user_id: 'u-old',
      first_name: 'Account',
      last_name: 'Owner',
      phone: '+46700000000',
    },
  ],
});

describe('POST /orders/guest: a new email', () => {
  it('creates a customer record, places the order from the request and answers with a guest token', async () => {
    const b = build();
    const res = await b.service.place(dto(), { ip: '1.2.3.4' });

    // A customer record exists (the schema needs one), normalised email.
    expect(b.users).toHaveLength(1);
    expect(b.users[0]).toMatchObject({
      email: 'new.buyer@example.com',
      role: UserRole.CUSTOMER,
      status: 'ACTIVE',
      store_id: 's1',
    });
    expect(b.customers[0]).toMatchObject({
      first_name: 'New',
      last_name: 'Buyer',
    });
    // The order is built from the lines and the address of the request.
    const [userId, orderDto, opts] = b.orders.create.mock
      .calls[0] as unknown as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(userId).toBe(b.users[0].id);
    expect(orderDto).toEqual({
      address_id: b.addresses[0].id,
      store_id: 's1',
      payment_method: 'STRIPE',
    });
    expect(opts).toEqual({
      lines: [{ product_id: 'p1', quantity: 2 }],
      verifiedDesignIds: [],
    });
    expect(b.addresses[0]).toMatchObject({
      customer_id: b.customers[0].id,
      full_name: 'New Buyer',
      line1: 'Main street 1',
      line2: null,
      city: 'Stockholm',
      state: null,
      postal_code: '11122',
      country_code: 'SE',
      is_default: false,
    });
    expect(b.orders.releaseStaleOrdersOfCustomer).toHaveBeenCalledWith(
      b.customers[0].id,
    );
    // Answer: the order without the customer object, plus the token.
    expect(Object.keys(res).sort()).toEqual([
      'guest_token',
      'guest_token_expires_at',
      'order',
    ]);
    expect('customer' in res.order).toBe(false);
    expect(res.order).toMatchObject({ id: 'o1', order_number: 'ORD-1' });
    await expect(b.tokens.verify(res.guest_token)).resolves.toEqual({
      userId: b.users[0].id,
      orderId: 'o1',
      storeId: 's1',
    });
  });

  it('sends no credentials email, no magic link, and opens no session', async () => {
    const b = build();
    const res = await b.service.place(dto());
    expect(b.credentials.send).not.toHaveBeenCalled();
    expect(b.magicLinks.issue).not.toHaveBeenCalled();
    expect(b.magicLinks.create).not.toHaveBeenCalled();
    expect(b.mail.sendWelcome).not.toHaveBeenCalled();
    // AuthService signed nothing (no access / refresh token).
    expect(b.signSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(res)).not.toMatch(/access_token|refresh_token/);
    // The stored password is a hash of a value nobody was told.
    expect(b.users[0].password_hash).toMatch(/^\$2[aby]\$/);
  });
});

describe('POST /orders/guest: an email that already has an account', () => {
  it('is not blocked: the order goes through on the existing customer record', async () => {
    const b = build(existingAccount());
    const res = await b.service.place(
      dto({ email: 'Returning@Example.com', first_name: 'Someone' }),
    );
    expect(res.order).toMatchObject({ id: 'o1' });
    expect(b.orders.create.mock.calls[0][0]).toBe('u-old');
    await expect(b.tokens.verify(res.guest_token)).resolves.toMatchObject({
      userId: 'u-old',
      orderId: 'o1',
    });
  });

  it('never creates, updates or reads the account: no new user, profile untouched, cart untouched', async () => {
    const b = build(existingAccount());
    await b.service.place(
      dto({
        email: 'returning@example.com',
        first_name: 'Someone',
        last_name: 'Else',
        phone: '+10000000',
      }),
    );
    expect(b.prisma.user.create).not.toHaveBeenCalled();
    expect(b.prisma.user.update).not.toHaveBeenCalled();
    expect(b.prisma.customer.create).not.toHaveBeenCalled();
    expect(b.prisma.customer.update).not.toHaveBeenCalled();
    expect(b.users[0].password_hash).toBe('hash-of-the-owner');
    expect(b.customers[0]).toEqual(existingAccount().customers[0]);
    // The server cart of the account is neither read nor emptied.
    expect(b.prisma.cart.findUnique).not.toHaveBeenCalled();
    expect(b.prisma.cart.update).not.toHaveBeenCalled();
    expect(b.prisma.cart.deleteMany).not.toHaveBeenCalled();
    expect(b.prisma.cartItem.deleteMany).not.toHaveBeenCalled();
    expect(b.credentials.send).not.toHaveBeenCalled();
    expect(b.signSpy).not.toHaveBeenCalled();
  });

  it('answers in the same shape as for a new email, with nothing of the account in it', async () => {
    const fresh = build();
    const known = build(existingAccount());
    const a = await fresh.service.place(dto());
    const k = await known.service.place(
      dto({ email: 'returning@example.com' }),
    );
    const shape = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(shape)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v as object)
                .sort(([x], [y]) => x.localeCompare(y))
                .map(([key, value]) => [key, shape(value)]),
            )
          : typeof v;
    expect(shape(k)).toEqual(shape(a));
    const body = JSON.stringify(k);
    for (const secret of [
      'Account',
      'Owner',
      '+46700000000',
      'owner@example',
    ]) {
      expect(body).not.toContain(secret);
    }
  });

  it('a blocked account cannot be ordered for (400 GUEST_ORDER_NOT_ALLOWED)', async () => {
    const b = build(existingAccount('SUSPENDED'));
    await expect(
      b.service.place(dto({ email: 'returning@example.com' })),
    ).rejects.toMatchObject({ response: { code: 'GUEST_ORDER_NOT_ALLOWED' } });
    expect(b.orders.create).not.toHaveBeenCalled();
    expect(b.prisma.address.create).not.toHaveBeenCalled();
  });

  it('an account without a profile row gets one, so it can order', async () => {
    const seed = existingAccount();
    const b = build({ users: seed.users, customers: [] });
    await b.service.place(dto({ email: 'returning@example.com' }));
    expect(b.prisma.customer.create).toHaveBeenCalledTimes(1);
    expect(b.customers[0].user_id).toBe('u-old');
    expect(b.prisma.user.create).not.toHaveBeenCalled();
  });

  it('an identical address row of that customer is reused, another one is added as non-default', async () => {
    const seed = existingAccount();
    const b = build({
      ...seed,
      addresses: [
        {
          id: 'a-old',
          customer_id: 'c-old',
          full_name: 'New Buyer',
          line1: 'Main street 1',
          line2: null,
          city: 'Stockholm',
          state: null,
          postal_code: '11122',
          country_code: 'SE',
          phone: null,
          company_name: null,
          org_number: null,
          buyer_reference: null,
          is_default: true,
        },
      ],
    });
    await b.service.place(dto({ email: 'returning@example.com' }));
    expect(b.prisma.address.create).not.toHaveBeenCalled();
    expect(
      (b.orders.create.mock.calls[0][1] as { address_id: string }).address_id,
    ).toBe('a-old');

    await b.service.place(
      dto({
        email: 'returning@example.com',
        address: { ...dto().address, line1: 'Other street 9' },
      }),
    );
    expect(b.addresses).toHaveLength(2);
    expect(b.addresses[1]).toMatchObject({
      line1: 'Other street 9',
      is_default: false,
    });
    expect(b.prisma.address.update).not.toHaveBeenCalled();
  });
});

describe('POST /orders/guest: refusals and pass-through', () => {
  it('no store context: 400 STORE_REQUIRED, nothing created', async () => {
    const b = build();
    await expect(
      b.service.place(dto({ store_slug: undefined, hostname: undefined })),
    ).rejects.toMatchObject({ response: { code: 'STORE_REQUIRED' } });
    expect(b.users).toHaveLength(0);
  });

  it('the checkout store is not the order store: 400 GUEST_ORDER_STORE_MISMATCH, no order', async () => {
    const b = build();
    await expect(
      b.service.place(dto({ store_id: 'another-store' })),
    ).rejects.toMatchObject({
      response: { code: 'GUEST_ORDER_STORE_MISMATCH' },
    });
    expect(b.orders.create).not.toHaveBeenCalled();
    expect(b.prisma.address.create).not.toHaveBeenCalled();
  });

  it('a failed captcha stops before any account lookup', async () => {
    const b = build({ captcha: 'fail' });
    await expect(
      b.service.place(dto(), { ip: '9.9.9.9' }),
    ).rejects.toMatchObject({ response: { code: 'AUTH_CAPTCHA_FAILED' } });
    expect(b.turnstile.verifyCustomer).toHaveBeenCalledWith(
      undefined,
      '9.9.9.9',
      [],
    );
    expect(b.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(b.users).toHaveLength(0);
  });

  it('an order error passes through unchanged (line errors keep line_index)', async () => {
    const b = build();
    const error = Object.assign(new Error('stock'), {
      response: { code: 'ORDER_INSUFFICIENT_STOCK', line_index: 0 },
    });
    b.orders.create.mockRejectedValueOnce(error);
    await expect(b.service.place(dto())).rejects.toBe(error);
  });

  it('every order field of the request reaches create(); the viewer and the tracking context too', async () => {
    const b = build();
    const preLiveViewer = jest.fn();
    const trackingContext = { fbp: 'fb.1.2.3' };
    await b.service.place(
      dto({
        hostname: 'shop.example',
        locale: 'sv',
        payment_method: 'COD',
        coupon_code: 'WELCOME',
        notes: 'Ring the bell',
        shipping_method_id: 'std',
        market_key: 'eu',
        buyer_type: 'COMPANY',
        company: { company_name: 'ACME' } as never,
        expect_reverse_charge: true,
      }),
      { preLiveViewer, trackingContext },
    );
    const [, orderDto, opts] = b.orders.create.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(orderDto).toEqual({
      address_id: b.addresses[0].id,
      store_id: 's1',
      payment_method: 'COD',
      coupon_code: 'WELCOME',
      notes: 'Ring the bell',
      shipping_method_id: 'std',
      market_key: 'eu',
      hostname: 'shop.example',
      locale: 'sv',
      buyer_type: 'COMPANY',
      company: { company_name: 'ACME' },
      expect_reverse_charge: true,
    });
    expect(opts.preLiveViewer).toBe(preLiveViewer);
    expect(opts.trackingContext).toBe(trackingContext);
  });

  it('designer lines: the design token is verified without a customer, and only verified designs are trusted', async () => {
    const b = build({ ...existingAccount(), designer: true });
    await b.service.place(
      dto({
        email: 'returning@example.com',
        lines: [
          {
            product_id: 'p1',
            quantity: 1,
            design_id: 'd1',
            design_token: 'tok',
          },
        ],
      }),
    );
    expect(b.designerCart.verifySessionDesigns).toHaveBeenCalledWith(
      's1',
      [
        {
          product_id: 'p1',
          custom_product_id: null,
          variant_id: null,
          design_id: 'd1',
          design_token: 'tok',
        },
      ],
      // Never the account's customer id: knowing an email opens no design.
      null,
    );
    expect(
      (
        b.orders.create.mock.calls[0] as unknown as [unknown, unknown, object]
      )[2],
    ).toMatchObject({ verifiedDesignIds: ['d1'] });
  });
});

describe('guest order token', () => {
  it('carries the order, expires in 24 hours and verifies', async () => {
    const tokens = tokensOf();
    const before = Date.now();
    const signed = await tokens.sign({
      userId: 'u1',
      orderId: 'o1',
      storeId: 's1',
    });
    const payload = new JwtService({}).decode<Record<string, unknown>>(
      signed.guest_token,
    );
    expect(payload).toMatchObject({
      sub: 'u1',
      type: 'guest_order',
      oid: 'o1',
      sid: 's1',
    });
    expect((payload.exp as number) - (payload.iat as number)).toBe(
      GUEST_ORDER_TOKEN_TTL_SECONDS,
    );
    const expires = new Date(signed.guest_token_expires_at).getTime();
    expect(expires - before).toBeGreaterThanOrEqual(24 * 3600 * 1000 - 5);
    expect(expires - before).toBeLessThan(24 * 3600 * 1000 + 5000);
    await expect(tokens.verify(signed.guest_token)).resolves.toEqual({
      userId: 'u1',
      orderId: 'o1',
      storeId: 's1',
    });
  });

  it('a token signed with the previous secret keeps verifying during a rotation', async () => {
    const old = tokensOf({ JWT_SECRET: PREVIOUS });
    const signed = await old.sign({
      userId: 'u1',
      orderId: 'o1',
      storeId: 's1',
    });
    const rotated = tokensOf({ JWT_SECRET_PREVIOUS: PREVIOUS });
    await expect(rotated.verify(signed.guest_token)).resolves.toMatchObject({
      orderId: 'o1',
    });
    // Without the previous secret it is gone.
    await expect(tokensOf().verify(signed.guest_token)).rejects.toMatchObject({
      response: { code: 'GUEST_TOKEN_INVALID' },
    });
  });

  it('rejects everything else with 401 GUEST_TOKEN_INVALID', async () => {
    const tokens = tokensOf();
    const jwt = new JwtService({});
    const sign = (payload: object, secret = SECRET, expiresIn = 60) =>
      jwt.signAsync(payload, { secret, algorithm: 'HS256', expiresIn });
    const bad = [
      null,
      undefined,
      '',
      'not-a-jwt',
      // A session access token (no type).
      await sign({
        sub: 'u1',
        email: 'a@b.c',
        role: 'CUSTOMER',
        store_id: 's1',
      }),
      // Another purpose token.
      await sign({ sub: 'u1', type: 'password_reset', oid: 'o1' }),
      // Missing order.
      await sign({ sub: 'u1', type: 'guest_order' }),
      // Wrong signature.
      await sign({ sub: 'u1', type: 'guest_order', oid: 'o1' }, 'other-secret'),
      // Expired.
      await sign({ sub: 'u1', type: 'guest_order', oid: 'o1' }, SECRET, -10),
    ];
    for (const token of bad) {
      await expect(tokens.verify(token)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      await expect(tokens.verify(token)).rejects.toMatchObject({
        response: { code: 'GUEST_TOKEN_INVALID' },
      });
    }
  });

  it('is not a session: JwtStrategy rejects its payload before any user lookup', async () => {
    const signed = await tokensOf().sign({
      userId: 'u1',
      orderId: 'o1',
      storeId: 's1',
    });
    const jwt = new JwtService({});
    const payload = await jwt.verifyAsync<Record<string, unknown>>(
      signed.guest_token,
      { secret: SECRET },
    );
    const prisma = { user: { findUnique: jest.fn() } };
    const strategy = new JwtStrategy(
      configOf({ JWT_SECRET: SECRET }),
      prisma as unknown as PrismaService,
      jwt,
    );
    await expect(
      strategy.validate(undefined, payload as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('guest routes: the token opens its own order only', () => {
  const contextOf = (authorization?: string) => {
    const req: Record<string, unknown> = {
      headers: authorization ? { authorization } : {},
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    return { ctx, req };
  };
  const guardOf = (user: { role: UserRole; status: string } | null) => {
    const prisma = {
      user: { findUnique: jest.fn(() => Promise.resolve(user)) },
    };
    return new GuestOrderGuard(tokensOf(), prisma as unknown as PrismaService);
  };
  const tokenFor = async (orderId = 'o1', userId = 'u1') =>
    (await tokensOf().sign({ userId, orderId, storeId: 's1' })).guest_token;
  const activeCustomer: { role: UserRole; status: string } = {
    role: UserRole.CUSTOMER,
    status: 'ACTIVE',
  };

  it('guard: a valid token of an active customer passes and lands on the request', async () => {
    const { ctx, req } = contextOf(`Bearer ${await tokenFor()}`);
    await expect(guardOf(activeCustomer).canActivate(ctx)).resolves.toBe(true);
    expect(req.guestOrder).toEqual({
      userId: 'u1',
      orderId: 'o1',
      storeId: 's1',
    });
  });

  it('guard: no bearer, a session token, a blocked or missing account: 401 GUEST_TOKEN_INVALID', async () => {
    const session = await new JwtService({}).signAsync(
      { sub: 'u1', email: 'a@b.c', role: 'CUSTOMER', store_id: 's1' },
      { secret: SECRET },
    );
    const cases: [string | undefined, typeof activeCustomer | null][] = [
      [undefined, activeCustomer],
      ['Bearer', activeCustomer],
      [`Basic ${await tokenFor()}`, activeCustomer],
      [`Bearer ${session}`, activeCustomer],
      [
        `Bearer ${await tokenFor()}`,
        { ...activeCustomer, status: 'SUSPENDED' },
      ],
      [
        `Bearer ${await tokenFor()}`,
        { ...activeCustomer, role: UserRole.ADMIN },
      ],
      [`Bearer ${await tokenFor()}`, null],
    ];
    for (const [header, user] of cases) {
      await expect(
        guardOf(user).canActivate(contextOf(header).ctx),
      ).rejects.toMatchObject({ response: { code: 'GUEST_TOKEN_INVALID' } });
    }
  });

  it('assertGuestOrder: only the order of the token', () => {
    const claims = { userId: 'u1', orderId: 'o1', storeId: 's1' };
    expect(() => assertGuestOrder(claims, 'o1')).not.toThrow();
    for (const other of ['o2', '', 'O1']) {
      expect(() => assertGuestOrder(claims, other)).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'GUEST_TOKEN_INVALID' }),
        }),
      );
    }
  });

  it('GET /orders/guest/:id: the own order in the guest view; any other id or a vanished order is the same 401', async () => {
    const b = build();
    const claims = { userId: 'u1', orderId: 'o1', storeId: 's1' };
    b.orders.findById.mockResolvedValue({
      id: 'o1',
      items: [],
      customer: { first_name: 'Account' },
    });
    const controller = new OrdersGuestController(
      b.service,
      {} as StorefrontGateService,
    );
    const view = await controller.read(claims, 'o1');
    expect(view).toEqual({ id: 'o1', items: [] });
    // Read as the customer of the token: the buyer view, never staff data.
    expect(b.orders.findById).toHaveBeenCalledWith(
      'o1',
      'u1',
      UserRole.CUSTOMER,
    );

    b.orders.findById.mockClear();
    await expect(controller.read(claims, 'o2')).rejects.toMatchObject({
      response: { code: 'GUEST_TOKEN_INVALID' },
    });
    expect(b.orders.findById).not.toHaveBeenCalled();

    b.orders.findById.mockRejectedValue(new Error('ORDER_NOT_FOUND'));
    await expect(controller.read(claims, 'o1')).rejects.toMatchObject({
      response: { code: 'GUEST_TOKEN_INVALID' },
    });
  });

  it('payments: create-intent and confirm run the customer service methods for the token order only', async () => {
    const payments = {
      createPaymentIntentForOrder: jest.fn(() =>
        Promise.resolve({ client_secret: 'cs' }),
      ),
      confirmOrderPayment: jest.fn(() => Promise.resolve({ status: 'paid' })),
    };
    const gate = { viewerFromHeader: jest.fn(() => Promise.resolve(null)) };
    const controller = new PaymentsController(
      payments as unknown as PaymentsService,
      {} as PaymentKeysGuardService,
      gate as unknown as StorefrontGateService,
    );
    const claims = { userId: 'u1', orderId: 'o1', storeId: 's1' };

    await expect(
      controller.guestCreateIntent(claims, { order_id: 'o1' }),
    ).resolves.toEqual({ client_secret: 'cs' });
    expect(payments.createPaymentIntentForOrder).toHaveBeenCalledWith(
      'u1',
      'o1',
      undefined,
    );
    await expect(
      Promise.resolve(controller.guestConfirm(claims, { order_id: 'o1' })),
    ).resolves.toEqual({ status: 'paid' });
    expect(payments.confirmOrderPayment).toHaveBeenCalledWith('u1', 'o1');

    payments.createPaymentIntentForOrder.mockClear();
    payments.confirmOrderPayment.mockClear();
    await expect(
      controller.guestCreateIntent(claims, { order_id: 'o2' }),
    ).rejects.toMatchObject({ response: { code: 'GUEST_TOKEN_INVALID' } });
    expect(() => controller.guestConfirm(claims, { order_id: 'o2' })).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'GUEST_TOKEN_INVALID' }),
      }),
    );
    expect(payments.createPaymentIntentForOrder).not.toHaveBeenCalled();
    expect(payments.confirmOrderPayment).not.toHaveBeenCalled();
  });
});

describe('forGuest', () => {
  it('drops the customer object and keeps every other key', () => {
    expect(
      forGuest({ id: 'o1', total: 5, customer: { first_name: 'A' } }),
    ).toEqual({ id: 'o1', total: 5 });
    expect(forGuest({ id: 'o1' })).toEqual({ id: 'o1' });
    expect(forGuest(null)).toBeNull();
  });
});

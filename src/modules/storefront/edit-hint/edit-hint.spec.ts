import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { JwtStrategy } from '../../auth/strategies/jwt.strategy';
import type { PrismaService } from '../../../prisma/prisma.service';
import { StoreType } from '@prisma/client';
import { StorefrontService } from '../storefront.service';
import {
  EDIT_HINT_AUDIENCE,
  EDIT_HINT_TTL_SECONDS,
  EditHintTokenService,
} from './edit-hint-token.service';
import { StorefrontEditTargetService } from './storefront-edit-target.service';
import { bearerToken } from './storefront-edit-hint.controller';
import { parseStorefrontPath } from './storefront-path';

const ENV: Record<string, string> = {
  JWT_SECRET: 'session-secret-for-tests',
  JWT_REFRESH_SECRET: 'refresh-secret-for-tests',
  DASHBOARD_URL: 'https://dash.test/',
};
const config = {
  get: (key: string) => ENV[key],
} as unknown as ConfigService;

const tokens = new EditHintTokenService(new JwtService({}), config);

describe('EditHintTokenService', () => {
  it('round-trips store_id + user_id with a 30-day expiry and its own aud', () => {
    const { token, expires_in } = tokens.sign({
      store_id: 'store-1',
      user_id: 'user-1',
    });
    expect(expires_in).toBe(EDIT_HINT_TTL_SECONDS);
    expect(tokens.verify(token)).toEqual({
      store_id: 'store-1',
      user_id: 'user-1',
    });
    const decoded = new JwtService({}).decode<Record<string, unknown>>(token);
    expect(decoded.aud).toBe(EDIT_HINT_AUDIENCE);
    expect(decoded.sub).toBeUndefined();
    expect(Number(decoded.exp) - Number(decoded.iat)).toBe(30 * 24 * 60 * 60);
  });

  it('rejects empty, garbage, tampered and expired tokens', () => {
    expect(tokens.verify(null)).toBeNull();
    expect(tokens.verify('')).toBeNull();
    expect(tokens.verify('not.a.jwt')).toBeNull();
    const { token } = tokens.sign({ store_id: 's', user_id: 'u' });
    const [h, , sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        store_id: 'other',
        user_id: 'u',
        aud: EDIT_HINT_AUDIENCE,
      }),
    ).toString('base64url');
    expect(tokens.verify(`${h}.${forged}.${sig}`)).toBeNull();

    jest.useFakeTimers({ now: Date.now() });
    try {
      jest.setSystemTime(Date.now() + (EDIT_HINT_TTL_SECONDS + 60) * 1000);
      expect(tokens.verify(token)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a session JWT (JWT_SECRET) presented as an edit hint', () => {
    const session = new JwtService({ secret: ENV.JWT_SECRET }).sign({
      store_id: 's',
      user_id: 'u',
      aud: EDIT_HINT_AUDIENCE,
    });
    expect(tokens.verify(session)).toBeNull();
  });

  it('rejects a token with the right secret but another audience', () => {
    // Re-sign with the derived secret by borrowing a valid token's secret
    // path: a token minted for another purpose must not verify.
    const svc = tokens as unknown as { secret(): string };
    const other = new JwtService({}).sign(
      { store_id: 's', user_id: 'u' },
      { secret: svc.secret(), audience: 'something-else' },
    );
    expect(tokens.verify(other)).toBeNull();
  });

  it('cannot be verified with the session or refresh secrets', () => {
    const { token } = tokens.sign({ store_id: 's', user_id: 'u' });
    const verifyWith = (secret: string) => () => {
      new JwtService({ secret }).verify(token);
    };
    expect(verifyWith(ENV.JWT_SECRET)).toThrow();
    expect(verifyWith(ENV.JWT_REFRESH_SECRET)).toThrow();
  });
});

describe('JwtStrategy (normal API guard) vs edit-hint tokens', () => {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'user-1',
        email: 'c@test',
        role: 'CREATOR',
        status: 'ACTIVE',
      }),
    },
  } as unknown as PrismaService;
  const strategy = new JwtStrategy(config, prisma);

  /** Runs the passport strategy on a bearer token: 'success' | 'fail'. */
  function authenticate(token: string): Promise<'success' | 'fail'> {
    return new Promise((resolve, reject) => {
      const s = strategy as unknown as {
        success: () => void;
        fail: () => void;
        error: (e: unknown) => void;
        authenticate: (req: unknown, opts: unknown) => void;
      };
      s.success = () => resolve('success');
      s.fail = () => resolve('fail');
      s.error = (e) => reject(e as Error);
      s.authenticate({ headers: { authorization: `Bearer ${token}` } }, {});
    });
  }

  it('accepts a regular session token (control)', async () => {
    const session = new JwtService({ secret: ENV.JWT_SECRET }).sign({
      sub: 'user-1',
      email: 'c@test',
      role: 'CREATOR',
    });
    await expect(authenticate(session)).resolves.toBe('success');
  });

  it('rejects an edit-hint token', async () => {
    const { token } = tokens.sign({ store_id: 'store-1', user_id: 'user-1' });
    await expect(authenticate(token)).resolves.toBe('fail');
  });
});

describe('bearerToken', () => {
  it('extracts the bearer value only', () => {
    expect(bearerToken('Bearer abc.def')).toBe('abc.def');
    expect(bearerToken('bearer   x')).toBe('x');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken('Bearer a b')).toBeNull();
  });
});

describe('parseStorefrontPath', () => {
  it.each([
    ['/', { kind: 'home' }],
    ['', { kind: 'unknown' }],
    ['/sv', { kind: 'home' }],
    ['/en/', { kind: 'home' }],
    ['/products', { kind: 'catalog' }],
    ['/products/mug', { kind: 'product', slug: 'mug' }],
    ['/de/products/tasse', { kind: 'product', slug: 'tasse' }],
    [
      '/products/studentskylt-m%C3%A5lad',
      { kind: 'product', slug: 'studentskylt-målad' },
    ],
    ['/products/a/b', { kind: 'unknown' }],
    ['/collections', { kind: 'collections' }],
    ['/collections/a/b', { kind: 'collection', path: ['a', 'b'] }],
    ['/ar/collections/a', { kind: 'collection', path: ['a'] }],
    ['/about-us', { kind: 'page', slug: 'about-us' }],
    ['/fr/about-us', { kind: 'page', slug: 'about-us' }],
    ['/cart', { kind: 'private' }],
    ['/checkout/kustom/confirmation', { kind: 'private' }],
    ['/account/orders/1', { kind: 'private' }],
    ['/auth/login', { kind: 'private' }],
    ['/sv/cart', { kind: 'private' }],
    ['/p', { kind: 'unknown' }],
    ['/legal/terms', { kind: 'unknown' }],
    ['/a/b', { kind: 'unknown' }],
    ['/products/%E0%A4%A', { kind: 'unknown' }],
    ['/products/mug?x=1#y', { kind: 'product', slug: 'mug' }],
    ['products/mug', { kind: 'unknown' }],
  ])('%s', (path, expected) => {
    expect(parseStorefrontPath(path)).toEqual(expected);
  });

  it('treats an over-long path as unknown', () => {
    expect(parseStorefrontPath('/' + 'a'.repeat(2000))).toEqual({
      kind: 'unknown',
    });
  });
});

describe('StorefrontEditTargetService.resolve', () => {
  const STORE = {
    id: 'store-1',
    slug: 'namez-se',
    creator_id: 'creator-1',
    store_type: 'MARKETPLACE',
    is_active: true,
    creator: {
      user_id: 'user-1',
      user: { role: 'CREATOR', status: 'ACTIVE' },
    },
  };

  function setup(
    overrides: {
      store?: unknown;
      storefront?: Partial<Record<keyof StorefrontService, jest.Mock>>;
      homeDraft?: { id: string } | null;
    } = {},
  ) {
    const prisma = {
      store: {
        findUnique: jest
          .fn()
          .mockResolvedValue('store' in overrides ? overrides.store : STORE),
      },
      page: {
        findFirst: jest.fn().mockResolvedValue(overrides.homeDraft ?? null),
      },
    } as unknown as PrismaService;
    const storefront = {
      getPublishedPage: jest.fn().mockResolvedValue(null),
      getPage: jest.fn().mockRejectedValue(new Error('404')),
      getCreatorCategories: jest.fn().mockResolvedValue([]),
      resolveProductRef: jest.fn().mockResolvedValue(null),
      ...overrides.storefront,
    } as unknown as StorefrontService;
    const svc = new StorefrontEditTargetService(
      prisma,
      storefront,
      tokens,
      config,
    );
    return { svc, prisma, storefront };
  }

  const ownerToken = () =>
    tokens.sign({ store_id: 'store-1', user_id: 'user-1' }).token;

  describe('authorization (401 → the storefront forgets the token)', () => {
    it('no or invalid token', async () => {
      const { svc, prisma } = setup();
      await expect(svc.resolve('namez-se', null, '/')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      await expect(
        svc.resolve('namez-se', 'garbage', '/'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      // A bad token never reaches the database.
      const findStore = (prisma.store as unknown as { findUnique: jest.Mock })
        .findUnique;
      expect(findStore).not.toHaveBeenCalled();
    });

    it.each([
      ['unknown store', null],
      ['token for another store', { ...STORE, id: 'store-2' }],
      ['inactive store', { ...STORE, is_active: false }],
      [
        'store now owned by another user',
        { ...STORE, creator: { ...STORE.creator, user_id: 'user-2' } },
      ],
      [
        'user is no longer a creator',
        {
          ...STORE,
          creator: {
            ...STORE.creator,
            user: { role: 'CUSTOMER', status: 'ACTIVE' },
          },
        },
      ],
      [
        'suspended user',
        {
          ...STORE,
          creator: {
            ...STORE.creator,
            user: { role: 'CREATOR', status: 'SUSPENDED' },
          },
        },
      ],
    ])('%s', async (_label, store) => {
      const { svc } = setup({ store });
      await expect(
        svc.resolve('namez-se', ownerToken(), '/'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  it('own product → products/own editor', async () => {
    const resolveProductRef = jest
      .fn()
      .mockResolvedValue({ kind: 'own', id: 'p1' });
    const { svc } = setup({ storefront: { resolveProductRef } });
    await expect(
      svc.resolve('namez-se', ownerToken(), '/sv/products/skylt'),
    ).resolves.toEqual({
      edit_url: 'https://dash.test/creator/products/own/p1',
      label_kind: 'product',
    });
    expect(resolveProductRef).toHaveBeenCalledWith(
      expect.objectContaining({ creator_id: 'creator-1' }),
      'skylt',
    );
  });

  it('custom product → custom-products editor', async () => {
    const { svc } = setup({
      storefront: {
        resolveProductRef: jest
          .fn()
          .mockResolvedValue({ kind: 'custom', id: 'cp1' }),
      },
    });
    await expect(
      svc.resolve('namez-se', ownerToken(), '/products/x'),
    ).resolves.toEqual({
      edit_url: 'https://dash.test/creator/custom-products/cp1',
      label_kind: 'product',
    });
  });

  it('missing product → dashboard home', async () => {
    const { svc } = setup();
    await expect(
      svc.resolve('namez-se', ownerToken(), '/products/gone'),
    ).resolves.toEqual({
      edit_url: 'https://dash.test/creator',
      label_kind: 'dashboard',
    });
  });

  it('hierarchical collection → category editor of the leaf', async () => {
    const tree = [
      {
        id: 'c-root',
        slug: 'studenten',
        children: [{ id: 'c-leaf', slug: 'skyltar', children: [] }],
      },
      { id: 'c-other', slug: 'skyltar', children: [] },
    ];
    const { svc } = setup({
      storefront: { getCreatorCategories: jest.fn().mockResolvedValue(tree) },
    });
    await expect(
      svc.resolve('namez-se', ownerToken(), '/collections/studenten/skyltar'),
    ).resolves.toEqual({
      edit_url: 'https://dash.test/creator/categories/c-leaf',
      label_kind: 'collection',
    });
    await expect(
      svc.resolve('namez-se', ownerToken(), '/collections/skyltar'),
    ).resolves.toMatchObject({
      edit_url: 'https://dash.test/creator/categories/c-other',
    });
    await expect(
      svc.resolve('namez-se', ownerToken(), '/collections/studenten/nope'),
    ).resolves.toMatchObject({ label_kind: 'dashboard' });
  });

  it('home → published HOME, else draft HOME, else the pages list', async () => {
    const published = setup({
      storefront: {
        getPublishedPage: jest.fn().mockResolvedValue({ id: 'home-1' }),
      },
    });
    await expect(
      published.svc.resolve('namez-se', ownerToken(), '/'),
    ).resolves.toEqual({
      edit_url: 'https://dash.test/builder/home-1',
      label_kind: 'page',
    });
    const draft = setup({ homeDraft: { id: 'home-draft' } });
    await expect(
      draft.svc.resolve('namez-se', ownerToken(), '/en'),
    ).resolves.toMatchObject({
      edit_url: 'https://dash.test/builder/home-draft',
    });
    const none = setup();
    await expect(
      none.svc.resolve('namez-se', ownerToken(), '/'),
    ).resolves.toMatchObject({ edit_url: 'https://dash.test/creator/pages' });
  });

  it('root page: v2 with sections wins, else legacy, else empty v2', async () => {
    const v2 = { id: 'v2-1', snapshot: { sections: [{ id: 's' }] } };
    const legacy = { id: 'legacy-1' };
    const both = setup({
      storefront: {
        getPublishedPage: jest.fn().mockResolvedValue(v2),
        getPage: jest.fn().mockResolvedValue(legacy),
      },
    });
    await expect(
      both.svc.resolve('namez-se', ownerToken(), '/om-oss'),
    ).resolves.toEqual({
      edit_url: 'https://dash.test/builder/v2-1',
      label_kind: 'page',
    });
    const getPublished = (
      both.storefront as unknown as { getPublishedPage: jest.Mock }
    ).getPublishedPage;
    expect(getPublished).toHaveBeenCalledWith('namez-se', {
      type: 'SLUG',
      slug: 'om-oss',
    });

    const emptyV2 = setup({
      storefront: {
        getPublishedPage: jest
          .fn()
          .mockResolvedValue({ id: 'v2-2', snapshot: { sections: [] } }),
        getPage: jest.fn().mockResolvedValue(legacy),
      },
    });
    await expect(
      emptyV2.svc.resolve('namez-se', ownerToken(), '/om-oss'),
    ).resolves.toMatchObject({
      edit_url: 'https://dash.test/creator/pages/legacy-1',
    });

    const onlyEmptyV2 = setup({
      storefront: {
        getPublishedPage: jest
          .fn()
          .mockResolvedValue({ id: 'v2-3', snapshot: { sections: [] } }),
      },
    });
    await expect(
      onlyEmptyV2.svc.resolve('namez-se', ownerToken(), '/om-oss'),
    ).resolves.toMatchObject({ edit_url: 'https://dash.test/builder/v2-3' });

    const none = setup();
    await expect(
      none.svc.resolve('namez-se', ownerToken(), '/om-oss'),
    ).resolves.toMatchObject({ label_kind: 'dashboard' });
  });

  it('catalog → CATALOG_TEMPLATE builder, else the products list', async () => {
    const withTemplate = setup({
      storefront: {
        getPublishedPage: jest.fn().mockResolvedValue({ id: 'cat-1' }),
      },
    });
    await expect(
      withTemplate.svc.resolve('namez-se', ownerToken(), '/products'),
    ).resolves.toMatchObject({ edit_url: 'https://dash.test/builder/cat-1' });
    const plain = setup();
    await expect(
      plain.svc.resolve('namez-se', ownerToken(), '/products'),
    ).resolves.toMatchObject({
      edit_url: 'https://dash.test/creator/products',
    });
  });

  it('cart / checkout / account → no button', async () => {
    const { svc } = setup();
    for (const path of ['/cart', '/sv/checkout', '/account/orders']) {
      await expect(
        svc.resolve('namez-se', ownerToken(), path),
      ).resolves.toEqual({ edit_url: null, label_kind: null });
    }
  });

  it('unknown path → dashboard home', async () => {
    const { svc } = setup();
    await expect(
      svc.resolve('namez-se', ownerToken(), '/legal/terms'),
    ).resolves.toEqual({
      edit_url: 'https://dash.test/creator',
      label_kind: 'dashboard',
    });
    await expect(
      svc.resolve('namez-se', ownerToken(), undefined),
    ).resolves.toMatchObject({ label_kind: 'dashboard' });
  });
});

describe('StorefrontService.resolveProductRef (same lookup as getProduct)', () => {
  function build(own: { id: string } | null, custom: { id: string } | null) {
    const prisma = {
      product: { findFirst: jest.fn().mockResolvedValue(own) },
      customProduct: { findFirst: jest.fn().mockResolvedValue(custom) },
    };
    const service = new StorefrontService(
      prisma as unknown as PrismaService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, prisma };
  }
  const query = {
    where: {
      creator_id: 'creator-1',
      status: 'PUBLISHED',
      translations: { some: { slug: 'mug' } },
    },
    orderBy: { updated_at: 'desc' },
    select: { id: true },
  };

  it('own product first, with the product page query', async () => {
    const { service, prisma } = build({ id: 'p1' }, { id: 'cp1' });
    await expect(
      service.resolveProductRef(
        { creator_id: 'creator-1', store_type: StoreType.MARKETPLACE },
        'mug',
      ),
    ).resolves.toEqual({ kind: 'own', id: 'p1' });
    expect(prisma.product.findFirst).toHaveBeenCalledWith(query);
    expect(prisma.customProduct.findFirst).not.toHaveBeenCalled();
  });

  it('falls back to a custom product', async () => {
    const { service, prisma } = build(null, { id: 'cp1' });
    await expect(
      service.resolveProductRef(
        { creator_id: 'creator-1', store_type: StoreType.MARKETPLACE },
        'mug',
      ),
    ).resolves.toEqual({ kind: 'custom', id: 'cp1' });
    expect(prisma.customProduct.findFirst).toHaveBeenCalledWith(query);
  });

  it('INDEPENDENT stores never serve custom products', async () => {
    const { service, prisma } = build(null, { id: 'cp1' });
    await expect(
      service.resolveProductRef(
        { creator_id: 'creator-1', store_type: StoreType.INDEPENDENT },
        'mug',
      ),
    ).resolves.toBeNull();
    expect(prisma.customProduct.findFirst).not.toHaveBeenCalled();
  });
});

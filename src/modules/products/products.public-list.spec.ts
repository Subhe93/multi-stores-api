import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ProductStatus, UserRole } from '@prisma/client';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import {
  PUBLIC_PRODUCT_LIST_SELECT,
  ProductsService,
  redactProductForNonOwner,
} from './products.service';
import { ProductsController } from './products.controller';
import { ProductTranslationDto } from './dto/product.dto';
import { AuthGuard } from '@nestjs/passport';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ROLES_KEY } from '../../common/decorators';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  publicCreatorCategory,
  publicVariant,
} from '../storefront/storefront.service';
import { DirectoryRunDto } from '../importer/dto/run.dto';

// M4.4 fixer B: GET /products no longer leaks drafts, cost prices or
// importer identities; non-owner product reads are redacted; storefront
// payload helpers drop external_ref and collection internals.
// Supplier privacy: GET /products and GET /products/:id are for signed-in
// providers (own products), creators (to import) and admins only.

function setup(approvalRequired = false) {
  const findMany = jest.fn((_args: unknown) => Promise.resolve([{ id: 'p1' }]));
  const count = jest.fn((_args: unknown) => Promise.resolve(1));
  const prisma = {
    product: { findMany, count },
    creator: {
      findUnique: jest.fn(({ where }: { where: { user_id: string } }) =>
        Promise.resolve(where.user_id === 'u-creator' ? { id: 'c1' } : null),
      ),
    },
    provider: {
      findUnique: jest.fn(({ where }: { where: { user_id: string } }) =>
        Promise.resolve(where.user_id === 'u-provider' ? { id: 'pr1' } : null),
      ),
    },
    platformConfig: {
      findFirst: jest.fn(() =>
        Promise.resolve({ require_provider_approval: approvalRequired }),
      ),
    },
  };
  const svc = new ProductsService(
    prisma as unknown as PrismaService,
    {} as never,
    {} as never,
    {} as never,
  );
  const lastArgs = () =>
    findMany.mock.calls[findMany.mock.calls.length - 1][0] as {
      where: Record<string, unknown>;
      select?: unknown;
      include?: unknown;
    };
  return { svc, prisma, lastArgs };
}

const CREATOR = { userId: 'u-creator', role: UserRole.CREATOR };
const PROVIDER = { userId: 'u-provider', role: UserRole.PROVIDER };

describe('GET /products (listForViewer)', () => {
  // Supplier privacy: the provider catalogue (cost price = base_price, stock)
  // is never public; anonymous callers get 401 from the JWT guard, customers
  // 403 from the roles guard.
  it.each(['findAll', 'findById'])(
    '%s requires a signed-in PROVIDER / CREATOR / ADMIN',
    (name) => {
      const fn = (
        ProductsController.prototype as unknown as Record<string, object>
      )[name];
      const guards = Reflect.getMetadata(GUARDS_METADATA, fn) as unknown[];
      expect(guards).toHaveLength(2);
      expect(guards[0]).toBe(AuthGuard('jwt'));
      expect(guards[1]).toBe(RolesGuard);
      expect(guards).not.toContain(OptionalJwtAuthGuard);
      expect(Reflect.getMetadata(ROLES_KEY, fn)).toEqual([
        UserRole.PROVIDER,
        UserRole.CREATOR,
        UserRole.ADMIN,
      ]);
    },
  );

  it('no viewer or a CUSTOMER: 403 PRODUCT_LIST_FORBIDDEN, nothing read', async () => {
    const { svc, prisma } = setup();
    for (const viewer of [
      undefined,
      {},
      { role: UserRole.CREATOR },
      { userId: 'u-cust', role: UserRole.CUSTOMER },
    ]) {
      await expect(
        svc.listForViewer({ owner_type: 'provider' }, viewer),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'PRODUCT_LIST_FORBIDDEN' },
      });
    }
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  it('CREATOR browsing: PUBLISHED provider products through the catalogue select', async () => {
    const { svc, lastArgs } = setup();
    await svc.listForViewer({ owner_type: 'provider', search: 'mug' }, CREATOR);
    const args = lastArgs();
    expect(args.select).toBe(PUBLIC_PRODUCT_LIST_SELECT);
    expect(args.include).toBeUndefined();
    expect(args.where).toMatchObject({
      status: ProductStatus.PUBLISHED,
      provider_id: { not: null },
    });
    expect(args.where).not.toHaveProperty('creator_id');
  });

  it('CREATOR browsing: unverified providers stay hidden while approval is required (SPEC §4)', async () => {
    const gated = setup(true);
    await gated.svc.listForViewer({ owner_type: 'provider' }, CREATOR);
    expect(gated.lastArgs().where).toMatchObject({
      provider: { verified: true },
    });
    const open = setup(false);
    await open.svc.listForViewer({ owner_type: 'provider' }, CREATOR);
    expect(open.lastArgs().where).not.toHaveProperty('provider');
  });

  it('the catalogue select has no cost price or importer identity', () => {
    const sel = PUBLIC_PRODUCT_LIST_SELECT as Record<string, unknown>;
    expect(sel).not.toHaveProperty('cost_price');
    expect(sel).not.toHaveProperty('external_ref');
    const variants = sel.variants as { select: Record<string, unknown> };
    expect(variants.select).not.toHaveProperty('external_ref');
  });

  it('CREATOR browsing: a draft filter or the creator catalogue answers empty', async () => {
    const { svc, prisma } = setup();
    expect(
      await svc.listForViewer({ status: ProductStatus.DRAFT }, CREATOR),
    ).toMatchObject({ data: [], meta: { total: 0 } });
    expect(
      await svc.listForViewer({ owner_type: 'creator' }, CREATOR),
    ).toMatchObject({ data: [] });
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  it('CREATOR browsing a provider_id: the published catalogue of that provider', async () => {
    const { svc, lastArgs } = setup();
    await svc.listForViewer({ provider_id: 'pr1' }, CREATOR);
    expect(lastArgs().select).toBe(PUBLIC_PRODUCT_LIST_SELECT);
    expect(lastArgs().where).toMatchObject({
      provider_id: 'pr1',
      status: ProductStatus.PUBLISHED,
    });
  });

  it("CREATOR: somebody else's creator_id is refused (PRODUCT_LIST_FORBIDDEN)", async () => {
    const { svc } = setup();
    await expect(
      svc.listForViewer({ creator_id: 'c2' }, CREATOR),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'PRODUCT_LIST_FORBIDDEN' },
    });
  });

  it('CREATOR: its own creator_id gives the full rows (dashboard)', async () => {
    const { svc, lastArgs } = setup();
    await svc.listForViewer({ creator_id: 'c1', limit: 200 }, CREATOR);
    const args = lastArgs();
    expect(args.select).toBeUndefined();
    expect(args.where).toEqual({ creator_id: 'c1' });
  });

  it('PROVIDER without provider_id: its own catalogue only, in full rows', async () => {
    const { svc, lastArgs } = setup();
    await svc.listForViewer(
      { owner_type: 'provider', status: ProductStatus.DRAFT },
      PROVIDER,
    );
    expect(lastArgs().select).toBeUndefined();
    expect(lastArgs().where).toEqual({
      provider_id: 'pr1',
      status: ProductStatus.DRAFT,
    });
  });

  it('PROVIDER with its own provider_id: full rows', async () => {
    const { svc, lastArgs } = setup();
    await svc.listForViewer(
      { provider_id: 'pr1', status: ProductStatus.DRAFT },
      PROVIDER,
    );
    expect(lastArgs().where).toEqual({
      provider_id: 'pr1',
      status: ProductStatus.DRAFT,
    });
  });

  it("PROVIDER: a competitor's provider_id or any creator_id is refused", async () => {
    const { svc, prisma } = setup();
    await expect(
      svc.listForViewer({ provider_id: 'pr-other' }, PROVIDER),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'PRODUCT_LIST_FORBIDDEN' },
    });
    await expect(
      svc.listForViewer({ creator_id: 'c1' }, PROVIDER),
    ).rejects.toMatchObject({ status: 403 });
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  it('PROVIDER without a provider profile: an empty page', async () => {
    const { svc, prisma } = setup();
    expect(
      await svc.listForViewer(
        { page: 2, limit: 5 },
        { userId: 'u-nobody', role: UserRole.PROVIDER },
      ),
    ).toEqual({
      data: [],
      meta: { total: 0, page: 2, limit: 5, totalPages: 0 },
    });
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  it('admins keep the full listing with any filter', async () => {
    const { svc, lastArgs } = setup();
    await svc.listForViewer(
      { status: ProductStatus.DRAFT },
      { userId: 'u-admin', role: UserRole.ADMIN },
    );
    expect(lastArgs().select).toBeUndefined();
    expect(lastArgs().where).toEqual({ status: ProductStatus.DRAFT });
  });
});

describe('GET /products/:id (findById visibility)', () => {
  function byIdSetup(row: Record<string, unknown>) {
    const findUnique = jest.fn(() =>
      Promise.resolve({
        id: 'p1',
        cost_price: 12,
        external_ref: 'woo:x',
        base_price: 45,
        stock_quantity: 40,
        translations: [{ locale: 'sv', title: 'T', email_note: 'note' }],
        variants: [{ id: 'v1', external_ref: 'woo:v', stock_quantity: 4 }],
        videos: [],
        stories: [],
        ...row,
      }),
    );
    const prisma = {
      product: { findUnique },
      creator: {
        findUnique: jest.fn(({ where }: { where: { user_id: string } }) =>
          Promise.resolve(where.user_id === 'u-creator' ? { id: 'c1' } : null),
        ),
      },
      provider: {
        findUnique: jest.fn(({ where }: { where: { user_id: string } }) =>
          Promise.resolve(
            where.user_id === 'u-provider' ? { id: 'pr1' } : null,
          ),
        ),
      },
    };
    const svc = new ProductsService(
      prisma as unknown as PrismaService,
      {} as never,
      {} as never,
      {} as never,
    );
    return { svc };
  }
  const providerProduct = (status: ProductStatus, provider_id = 'pr1') => ({
    provider_id,
    creator_id: null,
    status,
  });

  it('CREATOR on a PUBLISHED provider product: the redacted row', async () => {
    const { svc } = byIdSetup(providerProduct(ProductStatus.PUBLISHED));
    const p = (await svc.findById(
      'p1',
      'u-creator',
      UserRole.CREATOR,
    )) as Record<string, unknown>;
    expect(p).not.toHaveProperty('cost_price');
    expect(p).not.toHaveProperty('external_ref');
    expect(JSON.stringify(p)).not.toContain('email_note');
    expect(JSON.stringify(p)).not.toContain('woo:');
    // The creator still sees its cost (the provider price) and stock.
    expect(p).toMatchObject({ base_price: 45, stock_quantity: 40 });
  });

  it.each([
    [
      'CREATOR on a DRAFT provider product',
      providerProduct(ProductStatus.DRAFT),
      'u-creator',
      UserRole.CREATOR,
    ],
    [
      'CREATOR on another creator product',
      { provider_id: null, creator_id: 'c2', status: ProductStatus.PUBLISHED },
      'u-creator',
      UserRole.CREATOR,
    ],
    [
      'PROVIDER on a competitor product',
      providerProduct(ProductStatus.PUBLISHED, 'pr2'),
      'u-provider',
      UserRole.PROVIDER,
    ],
    [
      'PROVIDER on a creator product',
      { provider_id: null, creator_id: 'c1', status: ProductStatus.PUBLISHED },
      'u-provider',
      UserRole.PROVIDER,
    ],
    [
      'CUSTOMER on a published provider product',
      providerProduct(ProductStatus.PUBLISHED),
      'u-cust',
      UserRole.CUSTOMER,
    ],
  ])('%s: 404 PRODUCT_NOT_FOUND', async (_label, row, userId, role) => {
    const { svc } = byIdSetup(row);
    await expect(svc.findById('p1', userId, role)).rejects.toMatchObject({
      status: 404,
      response: { code: 'PRODUCT_NOT_FOUND' },
    });
  });

  it.each([
    [
      'the owning provider',
      providerProduct(ProductStatus.DRAFT),
      'u-provider',
      UserRole.PROVIDER,
    ],
    [
      'the owning creator',
      { provider_id: null, creator_id: 'c1', status: ProductStatus.DRAFT },
      'u-creator',
      UserRole.CREATOR,
    ],
    [
      'an admin',
      providerProduct(ProductStatus.DRAFT, 'pr9'),
      'u-admin',
      UserRole.ADMIN,
    ],
  ])('%s gets the full row', async (_label, row, userId, role) => {
    const { svc } = byIdSetup(row);
    const p = (await svc.findById('p1', userId, role)) as Record<
      string,
      unknown
    >;
    expect(p).toMatchObject({ cost_price: 12, external_ref: 'woo:x' });
  });
});

describe('redactProductForNonOwner', () => {
  it('drops cost price, importer refs and collection internals', () => {
    const out = redactProductForNonOwner({
      id: 'p1',
      cost_price: 5,
      external_ref: 'woo:shop:product:1',
      variants: [{ id: 'v1', external_ref: 'woo:shop:variation:2', sku: 'A' }],
      creator_categories: [
        {
          creator_category_id: 'cc1',
          creator_category: {
            id: 'cc1',
            slug: 'mugs',
            external_ref: 'woo:shop:product_cat:3',
            creator_id: 'c1',
            match_rule: 'MANUAL',
            match_tags: ['x'],
            match_tag_ids: ['x'],
          },
        },
      ],
    }) as Record<string, unknown>;
    expect(out).not.toHaveProperty('cost_price');
    expect(out).not.toHaveProperty('external_ref');
    expect(out.variants).toEqual([{ id: 'v1', sku: 'A' }]);
    expect(out.creator_categories).toEqual([
      {
        creator_category_id: 'cc1',
        creator_category: { id: 'cc1', slug: 'mugs' },
      },
    ]);
  });
});

describe('storefront public shapes', () => {
  it('publicVariant drops external_ref only', () => {
    expect(
      publicVariant({ id: 'v1', external_ref: 'woo:x', price_adjustment: 1 }),
    ).toEqual({ id: 'v1', price_adjustment: 1 });
  });

  it('publicCreatorCategory keeps what the web reads', () => {
    expect(
      publicCreatorCategory({
        id: 'cc1',
        slug: 's',
        parent_id: null,
        noindex_when_empty: true,
        is_active: true,
        external_ref: 'woo:x',
        creator_id: 'c1',
        match_rule: 'TAGS',
        match_tags: ['a'],
        match_tag_ids: ['a'],
      }),
    ).toEqual({
      id: 'cc1',
      slug: 's',
      parent_id: null,
      noindex_when_empty: true,
      is_active: true,
    });
  });
});

describe('DTO limits', () => {
  it('short_description is capped at 10 000 characters (description is not)', async () => {
    const base = { locale: 'en', title: 't', description: 'd', slug: 's' };
    const ok = plainToInstance(ProductTranslationDto, {
      ...base,
      short_description: 'x'.repeat(10_000),
    });
    expect(await validate(ok)).toHaveLength(0);
    const tooLong = plainToInstance(ProductTranslationDto, {
      ...base,
      short_description: 'x'.repeat(10_001),
    });
    const errs = await validate(tooLong);
    expect(errs.map((e) => e.property)).toEqual(['short_description']);
    const nulled = plainToInstance(ProductTranslationDto, {
      ...base,
      short_description: null,
    });
    expect(await validate(nulled)).toHaveLength(0);
  });

  it('meta_title is capped at 255 and meta_desc at 1000 characters', async () => {
    const base = { locale: 'en', title: 't', description: 'd', slug: 's' };
    const ok = plainToInstance(ProductTranslationDto, {
      ...base,
      meta_title: 'x'.repeat(255),
      meta_desc: 'x'.repeat(1000),
    });
    expect(await validate(ok)).toHaveLength(0);
    const tooLong = plainToInstance(ProductTranslationDto, {
      ...base,
      meta_title: 'x'.repeat(256),
      meta_desc: 'x'.repeat(1001),
    });
    expect((await validate(tooLong)).map((e) => e.property)).toEqual([
      'meta_title',
      'meta_desc',
    ]);
  });

  it('the admin directory run takes a relative name only', async () => {
    const id = '7c1f3a2e-1d2b-4c3d-8e4f-5a6b7c8d9e0f';
    const ok = plainToInstance(DirectoryRunDto, {
      source_id: id,
      directory: 'namez/2026-10-15',
    });
    expect(await validate(ok)).toHaveLength(0);
    for (const directory of ['/srv/x', 'C:\\x', '\\\\h\\s', '../x']) {
      const bad = plainToInstance(DirectoryRunDto, {
        source_id: id,
        directory,
      });
      expect((await validate(bad)).map((e) => e.property)).toEqual([
        'directory',
      ]);
    }
  });
});

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
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt.guard';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  publicCreatorCategory,
  publicVariant,
} from '../storefront/storefront.service';
import { DirectoryRunDto } from '../importer/dto/run.dto';

// M4.4 fixer B: GET /products no longer leaks drafts, cost prices or
// importer identities; non-owner product reads are redacted; storefront
// payload helpers drop external_ref and collection internals.

function setup() {
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

describe('GET /products (listForViewer)', () => {
  it('uses the optional JWT guard', () => {
    const fn = (
      ProductsController.prototype as unknown as Record<string, object>
    ).findAll;
    expect(Reflect.getMetadata(GUARDS_METADATA, fn)).toEqual([
      OptionalJwtAuthGuard,
    ]);
  });

  it('anonymous: PUBLISHED provider products through the public select', async () => {
    const { svc, lastArgs } = setup();
    await svc.listForViewer({ owner_type: 'provider', search: 'mug' });
    const args = lastArgs();
    expect(args.select).toBe(PUBLIC_PRODUCT_LIST_SELECT);
    expect(args.include).toBeUndefined();
    expect(args.where).toMatchObject({
      status: ProductStatus.PUBLISHED,
      provider_id: { not: null },
    });
    expect(args.where).not.toHaveProperty('creator_id');
  });

  it('the public select has no cost price or importer identity', () => {
    const sel = PUBLIC_PRODUCT_LIST_SELECT as Record<string, unknown>;
    expect(sel).not.toHaveProperty('cost_price');
    expect(sel).not.toHaveProperty('external_ref');
    const variants = sel.variants as { select: Record<string, unknown> };
    expect(variants.select).not.toHaveProperty('external_ref');
  });

  it('anonymous: a draft filter or the creator catalogue answers empty', async () => {
    const { svc, prisma } = setup();
    expect(
      await svc.listForViewer({ status: ProductStatus.DRAFT }),
    ).toMatchObject({ data: [], meta: { total: 0 } });
    expect(await svc.listForViewer({ owner_type: 'creator' })).toMatchObject({
      data: [],
    });
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  it("refuses somebody else's creator_id (PRODUCT_LIST_FORBIDDEN)", async () => {
    const { svc } = setup();
    await expect(svc.listForViewer({ creator_id: 'c1' })).rejects.toMatchObject(
      { status: 403, response: { code: 'PRODUCT_LIST_FORBIDDEN' } },
    );
    await expect(
      svc.listForViewer(
        { creator_id: 'c2' },
        { userId: 'u-creator', role: UserRole.CREATOR },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('the owning creator gets the full rows of their catalogue (dashboard)', async () => {
    const { svc, lastArgs } = setup();
    await svc.listForViewer(
      { creator_id: 'c1', limit: 200 },
      { userId: 'u-creator', role: UserRole.CREATOR },
    );
    const args = lastArgs();
    expect(args.select).toBeUndefined();
    expect(args.where).toEqual({ creator_id: 'c1' });
  });

  it('the owning provider gets full rows for their provider_id', async () => {
    const { svc, lastArgs } = setup();
    await svc.listForViewer(
      { provider_id: 'pr1', status: ProductStatus.DRAFT },
      { userId: 'u-provider', role: UserRole.PROVIDER },
    );
    expect(lastArgs().where).toEqual({
      provider_id: 'pr1',
      status: ProductStatus.DRAFT,
    });
  });

  it('another provider filtering by provider_id gets the public view', async () => {
    const { svc, lastArgs } = setup();
    await svc.listForViewer(
      { provider_id: 'pr1' },
      { userId: 'u-creator', role: UserRole.CREATOR },
    );
    expect(lastArgs().select).toBe(PUBLIC_PRODUCT_LIST_SELECT);
    expect(lastArgs().where).toMatchObject({
      provider_id: 'pr1',
      status: ProductStatus.PUBLISHED,
    });
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

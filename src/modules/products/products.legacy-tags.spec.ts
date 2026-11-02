import 'reflect-metadata';
import { UserRole } from '@prisma/client';
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validate } from 'class-validator';
import { ProductsService } from './products.service';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RedirectsService } from '../redirects/redirects.service';
import { storeRow, table } from '../../common/slug/__fixtures__/fake-slug-db';

// Tags rename (2026-11-02): legacy `ProductTag` strings are retired. The
// `tags` field stays on the create / update DTOs for one deploy window so an
// older dashboard (or any API client) is not rejected by the global
// ValidationPipe (`whitelist` + `forbidNonWhitelisted`, see main.ts), but the
// service ignores it: nothing is written to `ProductTag`.

type Row = Record<string, unknown>;

/** Same options as main.ts: unknown keys are errors, `tags` must not be one. */
const PIPE = { whitelist: true, forbidNonWhitelisted: true };

const TRANSLATION = { locale: 'sv', title: 'Mugg', description: '', slug: '' };

function setup(product: Row | null = null) {
  const productTag = {
    createMany: jest.fn(() => Promise.resolve({ count: 0 })),
    deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
  };
  const productTranslation = table([]);
  const tx = {
    product: { create: jest.fn(() => Promise.resolve({ id: 'dup-p' })) },
    productTranslation: {
      createMany: jest.fn(() => Promise.resolve({})),
      findFirst: productTranslation.findFirst,
    },
    customProductTranslation: table([]),
    productTag,
    productAttribute: { createMany: jest.fn() },
    productVariant: { create: jest.fn() },
    productImage: { createMany: jest.fn() },
    productFaq: { create: jest.fn() },
    productCustomField: { create: jest.fn() },
  };
  const prisma = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    store: table([storeRow('s1', 'c1', 'sv')]),
    product: {
      findUnique: jest.fn(() => Promise.resolve(product)),
      create: jest.fn((args: { data: Row }) =>
        Promise.resolve({ id: 'new-p', ...args.data }),
      ),
      update: jest.fn(() => Promise.resolve({})),
    },
    productTranslation: {
      ...productTranslation,
      findMany: jest.fn(() => Promise.resolve([])),
      deleteMany: jest.fn(),
      createMany: jest.fn(() => Promise.resolve({})),
    },
    productTag,
    customProductTranslation: tx.customProductTranslation,
    $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  };
  const redirects = {
    applySlugChangeRedirects: jest.fn(() => Promise.resolve(null)),
    releaseLivePaths: jest.fn(() => Promise.resolve(0)),
  };
  const svc = new ProductsService(
    prisma as unknown as PrismaService,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    redirects as unknown as RedirectsService,
  );
  const internals = svc as unknown as Record<string, unknown>;
  internals.checkOwnership = jest.fn(() => Promise.resolve());
  internals.assertTaxClassAllowed = jest.fn(() => Promise.resolve());
  internals.assertShippingProfileAllowed = jest.fn(() => Promise.resolve());
  internals.syncVariantsAndImages = jest.fn(() => Promise.resolve());
  internals.revalidateForCreator = jest.fn(() => Promise.resolve());
  internals.findById = jest.fn((id: string) => Promise.resolve({ id }));
  return { svc, prisma, productTag };
}

describe('deprecated product `tags` field (tags rename)', () => {
  it('CreateProductDto / UpdateProductDto still accept `tags` under the global whitelist', async () => {
    const classes: ClassConstructor<object>[] = [
      CreateProductDto,
      UpdateProductDto,
    ];
    for (const cls of classes) {
      const withTags = plainToInstance(cls, {
        translations: [TRANSLATION],
        tags: ['gift', 'summer'],
      });
      const errors = await validate(withTags, {
        ...PIPE,
        skipMissingProperties: true,
      });
      expect(errors.map((e) => e.property)).toEqual([]);
      // Sanity: a truly unknown key is still rejected by the same options.
      const unknown = plainToInstance(cls, {
        translations: [TRANSLATION],
        nope: 1,
      });
      const bad = await validate(unknown, {
        ...PIPE,
        skipMissingProperties: true,
      });
      expect(bad.map((e) => e.property)).toEqual(['nope']);
    }
  });

  it('create ignores `tags`: no ProductTag write, nothing of it in the product row', async () => {
    const { svc, prisma, productTag } = setup();
    await svc.create('u', UserRole.CREATOR, {
      translations: [TRANSLATION],
      tags: ['gift', 'summer'],
    } as never);
    expect(prisma.product.create).toHaveBeenCalledTimes(1);
    const data = (
      prisma.product.create.mock.calls[0] as unknown as [{ data: Row }]
    )[0].data;
    expect(data).not.toHaveProperty('tags');
    expect(productTag.createMany).not.toHaveBeenCalled();
    expect(productTag.deleteMany).not.toHaveBeenCalled();
  });

  it('update ignores `tags`: existing ProductTag rows are neither deleted nor rewritten', async () => {
    const { svc, prisma, productTag } = setup({
      id: 'p1',
      creator_id: 'c1',
      status: 'DRAFT',
      variant_option_config: null,
    });
    await svc.update('p1', 'u', UserRole.CREATOR, {
      tags: ['gift'],
    } as never);
    expect(prisma.product.update).toHaveBeenCalledTimes(1);
    const data = (
      prisma.product.update.mock.calls[0] as unknown as [{ data: Row }]
    )[0].data;
    expect(data).not.toHaveProperty('tags');
    expect(productTag.createMany).not.toHaveBeenCalled();
    expect(productTag.deleteMany).not.toHaveBeenCalled();
  });
});

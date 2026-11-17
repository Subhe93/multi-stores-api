import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UserRole } from '@prisma/client';
import { ProductsService } from './products.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
import { UpdateOrderStatusDto } from '../orders/dto/order.dto';

// "Physical product" setting (Product.requires_shipping): an optional
// boolean on create / update (absent = column default true / keep the
// value) and copied by duplicate(). The fulfil action's `notify_customer`
// is validated the same way.

const errorsFor = (cls: new () => object, body: Record<string, unknown>) =>
  validateSync(plainToInstance(cls, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).filter((e) => e.property === Object.keys(body)[0]);

describe('requires_shipping on the product DTOs', () => {
  it.each([
    ['CreateProductDto', CreateProductDto],
    ['UpdateProductDto', UpdateProductDto],
  ])('%s accepts a boolean and rejects anything else', (_name, cls) => {
    expect(errorsFor(cls, { requires_shipping: false })).toEqual([]);
    expect(errorsFor(cls, { requires_shipping: true })).toEqual([]);
    for (const bad of ['false', 0, null, {}]) {
      expect(errorsFor(cls, { requires_shipping: bad })).toHaveLength(
        bad === null ? 0 : 1,
      );
    }
  });

  it('is optional: an absent key is not a validation error', () => {
    const errors = validateSync(plainToInstance(UpdateProductDto, {}), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.some((e) => e.property === 'requires_shipping')).toBe(false);
  });

  it('survives the whitelist (reaches the service)', () => {
    const dto = plainToInstance(UpdateProductDto, { requires_shipping: false });
    expect(
      validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }),
    ).toEqual([]);
    expect(dto.requires_shipping).toBe(false);
  });
});

describe('notify_customer on UpdateOrderStatusDto', () => {
  it('accepts a boolean, rejects a string, is optional', () => {
    const check = (body: Record<string, unknown>) =>
      validateSync(plainToInstance(UpdateOrderStatusDto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
    expect(check({ status: 'DELIVERED' })).toEqual([]);
    expect(check({ status: 'DELIVERED', notify_customer: false })).toEqual([]);
    expect(check({ status: 'DELIVERED', notify_customer: true })).toEqual([]);
    const bad = check({ status: 'DELIVERED', notify_customer: 'no' });
    expect(bad.map((e) => e.property)).toEqual(['notify_customer']);
  });
});

describe('ProductsService.duplicate', () => {
  function setup(source: Record<string, unknown>) {
    const tx = {
      product: {
        create: jest.fn((_args: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'new-product' }),
        ),
      },
      productTranslation: { createMany: jest.fn() },
      productCreatorCategory: { createMany: jest.fn() },
      productAttribute: { createMany: jest.fn() },
      productVariant: { create: jest.fn() },
      productImage: { createMany: jest.fn() },
      productFaq: { create: jest.fn() },
      productCustomField: { create: jest.fn() },
    };
    const prisma = {
      product: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            id: 'src',
            translations: [],
            images: [],
            attributes: [],
            variants: [],
            creator_categories: [],
            faqs: [],
            custom_fields: [],
            shipping_profile_id: 'sp1',
            variant_option_config: null,
            ...source,
          }),
        ),
      },
      $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    };
    const svc = new ProductsService(
      prisma as unknown as PrismaService,
      {} as never,
      {} as never,
      {} as never,
    );
    const internals = svc as unknown as Record<string, unknown>;
    internals.checkOwnership = jest.fn(() => Promise.resolve());
    internals.assertShippingProfileAllowed = jest.fn(() => Promise.resolve());
    internals.findById = jest.fn((id: string) => Promise.resolve({ id }));
    return { svc, tx };
  }

  it.each([false, true])('copies requires_shipping = %s', async (flag) => {
    const { svc, tx } = setup({ requires_shipping: flag });
    await svc.duplicate('src', 'u', UserRole.ADMIN);
    const data = tx.product.create.mock.calls[0][0].data;
    expect(data.requires_shipping).toBe(flag);
    // The stored profile is copied too: the flag never clears it.
    expect(data.shipping_profile_id).toBe('sp1');
  });
});

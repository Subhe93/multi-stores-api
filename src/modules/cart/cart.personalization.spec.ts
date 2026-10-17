import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CartService } from './cart.service';
import { PrismaService } from '../../prisma/prisma.service';
import { buildPersonalizationCore } from '../personalization/__fixtures__/personalization-service.factory';
import { TaxService } from '../taxes/tax.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { B2bService } from '../b2b/b2b.service';

// M4.0 bug 1 (cart line signature): lines with different personalization
// never merge, the bundle check counts only the matching line, field rules
// apply on add/update (K2), and a product without fields keeps the exact
// pre-M4.0 Prisma calls.

type Row = {
  id: string;
  cart_id: string;
  product_id: string | null;
  variant_id: string | null;
  custom_product_id: string | null;
  bundle_offer_id: string | null;
  quantity: number;
  custom_fields: unknown;
};

const FIELDS = [
  {
    id: 'f1',
    product_id: 'p1',
    name: 'name_1',
    type: 'TEXT',
    is_required: true,
    options: null,
    validation_rules: { max_length: 11 },
    linked_validation: null,
    sort_order: 0,
    translations: [{ locale: 'sv', label: 'Namn' }],
  },
];

const KEYS = [
  'cart_id',
  'product_id',
  'variant_id',
  'custom_product_id',
  'bundle_offer_id',
] as const;

function makePrisma(fields: unknown[], seed: Row[] = []) {
  const rows: Row[] = seed.map((r) => ({ ...r }));
  let n = rows.length;
  const matches = (r: Row, where: Record<string, unknown>) =>
    KEYS.every((k) => !(k in where) || r[k] === where[k]) &&
    (!where.id ||
      (typeof where.id === 'string'
        ? r.id === where.id
        : r.id !== (where.id as { not: string }).not));
  const prisma = {
    rows,
    customer: {
      findUnique: jest.fn(() => Promise.resolve({ id: 'cust1' })),
    },
    cart: { findUnique: jest.fn(() => Promise.resolve({ id: 'cart1' })) },
    productCustomField: { findMany: jest.fn(() => Promise.resolve(fields)) },
    customProduct: { findMany: jest.fn(() => Promise.resolve([])) },
    bundleOffer: { findUnique: jest.fn(() => Promise.resolve({ id: 'b1' })) },
    cartItem: {
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(rows.find((r) => matches(r, where)) ?? null),
      ),
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(rows.filter((r) => matches(r, where))),
      ),
      create: jest.fn(({ data }: { data: Partial<Row> }) => {
        const defaults: Row = {
          id: `r${++n}`,
          cart_id: 'cart1',
          product_id: null,
          variant_id: null,
          custom_product_id: null,
          bundle_offer_id: null,
          quantity: 1,
          custom_fields: null,
        };
        const row: Row = { ...defaults, ...data };
        rows.push(row);
        return Promise.resolve(row);
      }),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
          const row = rows.find((r) => r.id === where.id)!;
          Object.assign(row, data);
          return Promise.resolve(row);
        },
      ),
      delete: jest.fn(({ where }: { where: { id: string } }) => {
        rows.splice(
          rows.findIndex((r) => r.id === where.id),
          1,
        );
        return Promise.resolve({});
      }),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return prisma;
}

function build(fields: unknown[] = FIELDS, seed: Row[] = []) {
  const prisma = makePrisma(fields, seed);
  const service = new CartService(
    prisma as unknown as PrismaService,
    {} as TaxService,
    {
      resolve: jest.fn(() => Promise.resolve(null)),
    } as unknown as MarketsContextService,
    new MarketPricingService(prisma as unknown as PrismaService),
    {} as B2bService,
    buildPersonalizationCore(prisma).core,
  );
  const internals = service as unknown as Record<string, jest.Mock>;
  jest.spyOn(service, 'getCart').mockResolvedValue({} as never);
  internals.assertAvailableInMarket = jest.fn(() => Promise.resolve());
  internals.validateBundleOffer = jest.fn(() => Promise.resolve({ id: 'b1' }));
  internals.assertBundleQuantityValid = jest.fn();
  return { service, prisma, internals };
}

const add = (
  service: CartService,
  custom_fields: unknown,
  extra: Record<string, unknown> = {},
) =>
  service.addItem(
    'u1',
    { product_id: 'p1', quantity: 1, custom_fields, ...extra } as never,
    'sv',
  );

const row = (over: Partial<Row>): Row => ({
  id: 'r0',
  cart_id: 'cart1',
  product_id: 'p1',
  variant_id: null,
  custom_product_id: null,
  bundle_offer_id: null,
  quantity: 1,
  custom_fields: null,
  ...over,
});

describe('CartService line signature (M4.0)', () => {
  it('same fields → one row, quantities summed', async () => {
    const { service, prisma } = build();
    await add(service, { f1: 'ANNA' });
    await add(service, { f1: ' ANNA ' });
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]).toMatchObject({
      quantity: 2,
      custom_fields: { f1: 'ANNA' },
    });
  });

  it('different fields → two rows', async () => {
    const { service, prisma } = build();
    await add(service, { f1: 'ANNA' });
    await add(service, { f1: 'OLLE' });
    expect(prisma.rows.map((r) => r.custom_fields)).toEqual([
      { f1: 'ANNA' },
      { f1: 'OLLE' },
    ]);
  });

  it('a legacy row {"f1":"Anna "} with a stale key merges with a new "Anna"', async () => {
    const { service, prisma } = build(FIELDS, [
      row({ custom_fields: { f1: 'Anna ', gone: 'x' } }),
    ]);
    await add(service, { f1: 'Anna' });
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0].quantity).toBe(2);
  });

  it('the bundle check counts only the line with the same personalization', async () => {
    const { service, internals, prisma } = build(FIELDS, [
      row({
        id: 'a',
        bundle_offer_id: 'b1',
        quantity: 3,
        custom_fields: { f1: 'ANNA' },
      }),
      row({
        id: 'b',
        bundle_offer_id: 'b1',
        quantity: 5,
        custom_fields: { f1: 'OLLE' },
      }),
    ]);
    await add(service, { f1: 'OLLE' }, { bundle_offer_id: 'b1', quantity: 2 });
    expect(internals.assertBundleQuantityValid).toHaveBeenCalledWith(
      { id: 'b1' },
      7,
    );
    // The merge target is looked up once and reused for the bundle check.
    expect(prisma.cartItem.findMany).toHaveBeenCalledTimes(1);
  });

  it('K2: a required field missing on add is a coded 400 and nothing is written', async () => {
    const { service, prisma } = build();
    await expect(add(service, {})).rejects.toBeInstanceOf(BadRequestException);
    await add(service, {}).catch((e: BadRequestException) => {
      expect(e.getResponse()).toMatchObject({
        code: 'CUSTOM_FIELD_REQUIRED',
        params: { label: 'Namn' },
        field_id: 'f1',
      });
    });
    expect(prisma.cartItem.create).not.toHaveBeenCalled();
  });

  it('update with custom_fields is validated', async () => {
    const { service } = build(FIELDS, [row({ custom_fields: { f1: 'ANNA' } })]);
    await expect(
      service.updateItem('u1', 'r0', { custom_fields: { f1: 'X'.repeat(12) } }),
    ).rejects.toMatchObject({
      response: { code: 'CUSTOM_FIELD_TOO_LONG', params: { max: 11 } },
    });
  });

  it('update with custom_fields equal to another line merges into it and deletes the source', async () => {
    const { service, prisma } = build(FIELDS, [
      row({ id: 'a', quantity: 2, custom_fields: { f1: 'ANNA' } }),
      row({ id: 'b', quantity: 3, custom_fields: { f1: 'OLLE' } }),
    ]);
    await service.updateItem('u1', 'b', { custom_fields: { f1: 'ANNA' } });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.rows).toEqual([
      expect.objectContaining({ id: 'a', quantity: 5 }),
    ]);
  });

  it('update with new custom_fields that collide with nothing stores them normalized', async () => {
    const { service, prisma } = build(FIELDS, [
      row({ id: 'a', custom_fields: { f1: 'ANNA' } }),
    ]);
    await service.updateItem('u1', 'a', { custom_fields: { f1: ' EVA ' } });
    expect(prisma.rows[0].custom_fields).toEqual({ f1: 'EVA' });
  });

  it('quantity-only updates are unchanged (no field read)', async () => {
    const { service, prisma } = build(FIELDS, [row({ id: 'a' })]);
    await service.updateItem('u1', 'a', { quantity: 4 });
    expect(prisma.productCustomField.findMany).not.toHaveBeenCalled();
    expect(prisma.rows[0].quantity).toBe(4);
  });

  describe('G0: product without fields', () => {
    it('create args are exactly the pre-M4.0 ones (incl. {} and undefined)', async () => {
      const { service, prisma } = build([]);
      await add(service, {});
      await service.addItem('u1', {
        product_id: 'p2',
        quantity: 1,
      } as never);
      expect(prisma.cartItem.create.mock.calls.map((c) => c[0])).toEqual([
        {
          data: {
            cart_id: 'cart1',
            product_id: 'p1',
            quantity: 1,
            custom_fields: {},
          },
        },
        { data: { cart_id: 'cart1', product_id: 'p2', quantity: 1 } },
      ]);
      const second = prisma.cartItem.create.mock.calls[1][0] as {
        data: Record<string, unknown>;
      };
      expect('custom_fields' in second.data).toBe(false);
    });

    it('merging uses the old five-column findFirst (no findMany)', async () => {
      const { service, prisma } = build([]);
      await add(service, {});
      await add(service, {});
      expect(prisma.cartItem.findMany).not.toHaveBeenCalled();
      expect(prisma.cartItem.findFirst).toHaveBeenLastCalledWith({
        where: {
          cart_id: 'cart1',
          product_id: 'p1',
          variant_id: null,
          custom_product_id: null,
          bundle_offer_id: null,
        },
      });
      expect(prisma.rows).toHaveLength(1);
      expect(prisma.rows[0].quantity).toBe(2);
    });

    it('any sent object is stored verbatim, as before M4.0', async () => {
      const { service, prisma } = build([]);
      const sent = { note: ' keep me ', nested: { a: 1 } };
      await add(service, sent);
      expect(prisma.rows[0].custom_fields).toBe(sent);
    });

    it('a bare null is stored as DbNull instead of failing', async () => {
      const { service, prisma } = build([]);
      await add(service, null);
      expect(prisma.rows[0].custom_fields).toBe(Prisma.DbNull);
    });
  });
});

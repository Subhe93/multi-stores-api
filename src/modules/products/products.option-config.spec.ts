/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { HttpException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ProductsService } from './products.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';

// M4.1 fixes, product writes: variant_option_config is checked against the
// personalization app (validator wired in, variation-card gate with the
// "unchanged values accepted" rule, option rename/delete refused while
// fields read the option), and duplicate() remaps a legacy id link target.

type Row = Record<string, unknown>;

const OPTIONS = [
  { name: 'Färg', values: ['Röd', 'Blå'], style: 'color' },
  { name: 'Välj antal', values: ['1 produkt', '2 produkter'] },
];

const REPEATER = {
  id: 'r1',
  name: 'dnc_items',
  parent_id: null,
  type: 'REPEATER',
  conditions: null,
  pricing: null,
  repeat: {
    count: { option: 'Välj antal' },
    start_index: 2,
    max: 5,
    lead: { options: ['Färg'] },
  },
  ui: null,
};

function setup(
  opts: {
    appOn?: boolean;
    config?: unknown;
    creatorId?: string | null;
    fields?: Row[];
  } = {},
) {
  const product = {
    id: 'p1',
    creator_id: opts.creatorId === undefined ? 'c1' : opts.creatorId,
    provider_id: null,
    base_price: 100,
    variant_option_config: opts.config ?? OPTIONS,
  };
  const prisma = {
    product: {
      findUnique: jest.fn(() => Promise.resolve(product)),
      update: jest.fn(() => Promise.resolve(product)),
    },
    store: { findUnique: jest.fn(() => Promise.resolve({ id: 's1' })) },
    productCustomField: {
      findMany: jest.fn(() => Promise.resolve(opts.fields ?? [REPEATER])),
    },
  };
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(!!opts.appOn)),
  };
  const svc = new ProductsService(
    prisma as unknown as PrismaService,
    {} as never,
    { revalidateStoreByCreatorId: jest.fn() } as never,
    { assertClassAssignable: jest.fn() } as never,
    storeApps as unknown as StoreAppsService,
  );
  const internals = svc as unknown as Record<string, unknown>;
  internals.checkOwnership = jest.fn(() => Promise.resolve());
  internals.findById = jest.fn((id: string) => Promise.resolve({ id }));
  return { svc, prisma, storeApps };
}

async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const e = err as HttpException;
    return { status: e.getStatus(), body: e.getResponse() as Row };
  }
  return null;
}

const update = (svc: ProductsService, variant_option_config: unknown) =>
  svc.update('p1', 'u1', UserRole.CREATOR, {
    variant_option_config,
  } as never);

describe('ProductsService variant_option_config write (M4.1)', () => {
  it('an unchanged config passes (no app lookup)', async () => {
    const { svc, prisma, storeApps } = setup();
    await update(svc, OPTIONS);
    expect(prisma.product.update).toHaveBeenCalledTimes(1);
    expect(storeApps.isEnabled).not.toHaveBeenCalled();
  });

  it('renaming an option read by a field → 409 PERSONALIZATION_OPTION_IN_USE', async () => {
    const { svc, prisma } = setup();
    const res = await failure(
      update(svc, [{ ...OPTIONS[0], name: 'Colour' }, OPTIONS[1]]),
    );
    expect(res).toEqual({
      status: 409,
      body: expect.objectContaining({
        code: 'PERSONALIZATION_OPTION_IN_USE',
        params: { fields: ['dnc_items'], options: ['Färg'] },
      }),
    });
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it('deleting the count option → 409 as well; an unrelated option change passes', async () => {
    const { svc } = setup();
    expect((await failure(update(svc, [OPTIONS[0]])))?.body).toMatchObject({
      code: 'PERSONALIZATION_OPTION_IN_USE',
      params: { options: ['Välj antal'] },
    });
    const ok = setup();
    await update(ok.svc, [
      { ...OPTIONS[0], values: ['Röd', 'Blå', 'Grön'] },
      OPTIONS[1],
    ]);
    expect(ok.prisma.product.update).toHaveBeenCalledTimes(1);
  });

  it('new card keys with the app off → 403 PERSONALIZATION_APP_REQUIRED', async () => {
    const { svc } = setup();
    const res = await failure(
      update(svc, [
        { ...OPTIONS[0], style: 'card', valueMeta: { Röd: { badge: 'Ny' } } },
        OPTIONS[1],
      ]),
    );
    expect(res?.status).toBe(403);
    expect(res?.body).toMatchObject({ code: 'PERSONALIZATION_APP_REQUIRED' });
  });

  it('stored card keys sent back unchanged are accepted with the app off', async () => {
    const cards = [
      { ...OPTIONS[0], style: 'card', valueMeta: { Röd: { badge: 'Ny' } } },
      OPTIONS[1],
    ];
    const { svc, prisma } = setup({ config: cards });
    await update(svc, cards);
    expect(prisma.product.update).toHaveBeenCalledTimes(1);
  });

  it('card keys with the app on are stored', async () => {
    const { svc, prisma } = setup({ appOn: true });
    await update(svc, [
      { ...OPTIONS[0], style: 'card', valueMeta: { Röd: { badge: 'Ny' } } },
      OPTIONS[1],
    ]);
    expect(prisma.product.update).toHaveBeenCalledTimes(1);
  });

  it('card keys on a provider product → 400 PERSONALIZATION_CREATOR_PRODUCT_ONLY', async () => {
    const { svc } = setup({ creatorId: null, appOn: true });
    const res = await failure(
      update(svc, [{ ...OPTIONS[0], style: 'card' }, OPTIONS[1]]),
    );
    expect(res?.body).toMatchObject({
      code: 'PERSONALIZATION_CREATOR_PRODUCT_ONLY',
    });
  });

  it('a malformed valueMeta → 400 PERSONALIZATION_CONFIG_INVALID under variant_option_config', async () => {
    const { svc } = setup({ appOn: true });
    const res = await failure(
      update(svc, [
        { ...OPTIONS[0], valueMeta: { Röd: { count: 1000 } } },
        OPTIONS[1],
      ]),
    );
    expect(res).toEqual({
      status: 400,
      body: expect.objectContaining({
        code: 'PERSONALIZATION_CONFIG_INVALID',
        errors: [
          {
            path: 'variant_option_config[0].valueMeta.Röd.count',
            code: 'OUT_OF_RANGE',
            params: { min: 0, max: 100 },
          },
        ],
      }),
    });
  });
});

describe('ProductsService.duplicate legacy link target (M4.1)', () => {
  it('a link that targets a field id points at the copy by name', async () => {
    const created: Row[] = [];
    const tx = {
      product: { create: jest.fn(() => Promise.resolve({ id: 'new' })) },
      productTranslation: { createMany: jest.fn() },
      productTag: { createMany: jest.fn() },
      productAttribute: { createMany: jest.fn() },
      productVariant: { create: jest.fn() },
      productImage: { createMany: jest.fn() },
      productFaq: { create: jest.fn() },
      productCustomField: {
        create: jest.fn((args: { data: Row }) => {
          created.push(args.data);
          return Promise.resolve({ id: `clone-${created.length}` });
        }),
      },
    };
    const field = (id: string, name: string, link: unknown) => ({
      id,
      name,
      type: 'TEXT',
      is_required: false,
      placeholder: null,
      options: null,
      validation_rules: null,
      linked_validation: link,
      sort_order: 0,
      parent_id: null,
      conditions: null,
      pricing: null,
      repeat: null,
      ui: null,
      preset_key: null,
      preset_ref: null,
      translations: [],
    });
    const prisma = {
      product: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            id: 'src',
            translations: [],
            images: [],
            attributes: [],
            variants: [],
            tags: [],
            faqs: [],
            custom_fields: [
              field('id-a', 'name_1', null),
              field('id-b', 'name_2', {
                type: 'equal_length',
                target: 'id-a',
                fill_char: '❤',
              }),
              field('id-c', 'name_3', {
                type: 'max_combined',
                target_field_id: 'id-a',
                max: 20,
              }),
            ],
            shipping_profile_id: null,
            variant_option_config: null,
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
    await svc.duplicate('src', 'u', UserRole.ADMIN);
    expect(created.map((c) => c.linked_validation)).toEqual([
      null,
      { type: 'equal_length', target: 'name_1', fill_char: '❤' },
      { type: 'max_combined', target: 'name_1', max: 20 },
    ]);
  });
});

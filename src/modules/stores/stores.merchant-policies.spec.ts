import 'reflect-metadata';
import { Prisma, UserRole } from '@prisma/client';
import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { StoresService } from './stores.service';
import { StoresController } from './stores.controller';
import { MerchantPoliciesDto } from './dto/store.dto';
import { ownerStorePayload, publicStoreRow } from './store-secrets';
import { ROLES_KEY } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RevalidationService } from '../../common/revalidation/revalidation.service';
import type { OrdersService } from '../orders/orders.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { MarketsService } from '../markets/markets.service';
import type { MarketsContextService } from '../markets/markets-context.service';
import type { RedirectsService } from '../redirects/redirects.service';

// M170 C: PUT /stores/my/merchant-policies (handling time + return policies
// for structured data). Owner-only write of the caller's own store.

function build(store: { id: string } | null = { id: 's1' }) {
  const prisma = {
    store: {
      findFirst: jest.fn(() => Promise.resolve(store)),
      update: jest.fn((args: { data: { merchant_policies: unknown } }) =>
        Promise.resolve({
          id: 's1',
          merchant_policies:
            args.data.merchant_policies === Prisma.DbNull
              ? null
              : args.data.merchant_policies,
        }),
      ),
    },
  };
  const revalidation = {
    revalidateStoreById: jest.fn(() => Promise.resolve()),
    revalidateStoreBySlug: jest.fn(() => Promise.resolve()),
  };
  const service = new StoresService(
    prisma as unknown as PrismaService,
    revalidation as unknown as RevalidationService,
    {} as OrdersService,
    {} as StoreAppsService,
    {} as MarketsService,
    {} as MarketsContextService,
    {} as RedirectsService,
  );
  return { service, prisma, revalidation };
}

const body = {
  handling: { min_days: 1, max_days: 2 },
  returns: [{ countries: ['se'], category: 'finite', days: 14, fees: 'free' }],
};

describe('StoresService.updateMerchantPolicies', () => {
  it('writes the normalised value on the own store and revalidates it', async () => {
    const { service, prisma, revalidation } = build();
    const res = await service.updateMerchantPolicies('u1', body);
    expect(prisma.store.findFirst).toHaveBeenCalledWith({
      where: { creator: { user_id: 'u1' } },
      select: { id: true },
    });
    const stored = {
      handling: { min_days: 1, max_days: 2 },
      returns: [
        { countries: ['SE'], category: 'finite', days: 14, fees: 'free' },
      ],
    };
    expect(prisma.store.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { merchant_policies: stored },
      select: { id: true, merchant_policies: true },
    });
    expect(res).toEqual({ id: 's1', merchant_policies: stored });
    expect(revalidation.revalidateStoreById).toHaveBeenCalledWith('s1');
  });

  it('an empty body clears the column to SQL NULL', async () => {
    for (const empty of [{}, { returns: [] }, { handling: null }]) {
      const { service, prisma, revalidation } = build();
      const res = await service.updateMerchantPolicies('u1', empty);
      const args = (
        prisma.store.update.mock.calls[0] as unknown as [
          { data: { merchant_policies: unknown } },
        ]
      )[0];
      expect(args.data.merchant_policies).toBe(Prisma.DbNull);
      expect(res).toEqual({ id: 's1', merchant_policies: null });
      expect(revalidation.revalidateStoreById).toHaveBeenCalledWith('s1');
    }
  });

  it('an invalid body is a coded 400 with fields and nothing is written', async () => {
    const { service, prisma, revalidation } = build();
    await expect(
      service.updateMerchantPolicies('u1', {
        handling: { min_days: 4, max_days: 1 },
        returns: [{ countries: ['SE'], category: 'finite' }],
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: {
        code: 'MERCHANT_POLICIES_INVALID',
        fields: ['handling.max_days', 'returns.0.days'],
      },
    });
    expect(prisma.store.update).not.toHaveBeenCalled();
    expect(revalidation.revalidateStoreById).not.toHaveBeenCalled();
  });

  it('a user without a store gets 404 and nothing is written', async () => {
    const { service, prisma } = build(null);
    await expect(
      service.updateMerchantPolicies('u1', body),
    ).rejects.toMatchObject({ response: { code: 'STORE_NOT_FOUND' } });
    expect(prisma.store.update).not.toHaveBeenCalled();
  });
});

describe('PUT /stores/my/merchant-policies route', () => {
  const handler = Object.getOwnPropertyDescriptor(
    StoresController.prototype,
    'updateMerchantPolicies',
  )?.value as (...args: unknown[]) => unknown;

  it('is a PUT on my/merchant-policies', () => {
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      'my/merchant-policies',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.PUT,
    );
  });

  it('is behind the JWT + roles guards, creators only', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[];
    expect(guards).toHaveLength(2);
    expect(guards).toContain(RolesGuard);
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([UserRole.CREATOR]);
  });

  it('passes the signed-in user and the body to the service', () => {
    const storesService = { updateMerchantPolicies: jest.fn(() => 'ok') };
    const controller = new StoresController(
      storesService as unknown as StoresService,
      {} as never,
      {} as never,
      {} as never,
    );
    expect(controller.updateMerchantPolicies('u1', body as never)).toBe('ok');
    expect(storesService.updateMerchantPolicies).toHaveBeenCalledWith(
      'u1',
      body,
    );
  });
});

describe('MerchantPoliciesDto (shape guard)', () => {
  const errorsOf = async (plain: object) =>
    (await validate(plainToInstance(MerchantPoliciesDto, plain))).map(
      (e) => e.property,
    );

  it('accepts the documented shapes, empty and null included', async () => {
    expect(await errorsOf(body)).toEqual([]);
    expect(await errorsOf({})).toEqual([]);
    expect(await errorsOf({ handling: null, returns: null })).toEqual([]);
  });

  it('rejects wrong container types and more than 10 policies', async () => {
    expect(await errorsOf({ handling: 'x' })).toEqual(['handling']);
    expect(await errorsOf({ returns: {} })).toEqual(['returns']);
    expect(await errorsOf({ returns: new Array(11).fill({}) })).toEqual([
      'returns',
    ]);
  });

  it('M172: personalized_no_returns is an optional boolean', async () => {
    for (const value of [true, false, null, undefined]) {
      expect(await errorsOf({ personalized_no_returns: value })).toEqual([]);
    }
    expect(await errorsOf({ personalized_no_returns: 'true' })).toEqual([
      'personalized_no_returns',
    ]);
  });
});

describe('merchant_policies visibility', () => {
  const row = {
    id: 's1',
    store_type: 'INDEPENDENT',
    cod_enabled: false,
    merchant_policies: { handling: { min_days: 1, max_days: 2 } },
  };

  it('the owner payload keeps the column', () => {
    expect(ownerStorePayload(row)).toHaveProperty(
      'merchant_policies',
      row.merchant_policies,
    );
  });

  it('the public store row drops it', () => {
    expect(publicStoreRow(row)).not.toHaveProperty('merchant_policies');
  });
});

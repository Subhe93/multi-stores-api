import { BadRequestException } from '@nestjs/common';
import { PromotionsService } from './promotions.service';
import { PromotionsController } from './promotions.controller';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

// Provider promotions are disabled until provider-funded discounts exist.

describe('provider promotions disabled', () => {
  it('rejects a provider-owned coupon as invalid before any store check', async () => {
    const prisma = {
      promotion: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'promo-1',
          provider_id: 'prov-1',
          creator_id: null,
          status: 'ACTIVE',
        }),
      },
    };
    const service = new PromotionsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      service.validateCoupon({ coupon_code: 'PROV10' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.validateCoupon({ coupon_code: 'PROV10' } as never),
    ).rejects.toMatchObject({
      response: { code: 'PROMOTION_COUPON_INVALID' },
    });
  });

  it('allows only creators to create or update promotions', () => {
    const proto = PromotionsController.prototype as unknown as Record<
      string,
      object
    >;
    const rolesOf = (name: string) =>
      Reflect.getMetadata(ROLES_KEY, proto[name]) as UserRole[];
    expect(rolesOf('create')).toEqual([UserRole.CREATOR]);
    expect(rolesOf('update')).toEqual([UserRole.CREATOR]);
  });
});

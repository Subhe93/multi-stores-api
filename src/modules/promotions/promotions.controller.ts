import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { PromotionsService } from './promotions.service';
import {
  CreatePromotionDto,
  UpdatePromotionDto,
  ValidateCouponDto,
  CouponPreviewDto,
} from './dto/promotion.dto';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller('promotions')
export class PromotionsController {
  constructor(private promotionsService: PromotionsService) {}

  @Post()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  // Providers may not create or edit promotions until provider-funded
  // discounts exist (a provider coupon was charged to the store owner).
  @Roles(UserRole.CREATOR)
  create(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
    @Body() dto: CreatePromotionDto,
  ) {
    return this.promotionsService.create(userId, role, dto);
  }

  @Get()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  findMyPromotions(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.promotionsService.findByOwner(
      userId,
      role,
      page ? +page : undefined,
      limit ? +limit : undefined,
    );
  }

  @Get(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  findById(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.promotionsService.findById(id, userId, role);
  }

  @Put(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  // Providers may not create or edit promotions until provider-funded
  // discounts exist (a provider coupon was charged to the store owner).
  @Roles(UserRole.CREATOR)
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePromotionDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.promotionsService.update(id, dto, userId, role);
  }

  @Delete(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR)
  delete(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.promotionsService.delete(id, userId, role);
  }

  // Public — validate coupon code. Throttled so the endpoint can't be used to
  // enumerate valid coupon codes (they are globally unique strings).
  @Post('validate-coupon')
  @Throttle({ default: { limit: 15, ttl: 60000 } })
  validateCoupon(@Body() dto: ValidateCouponDto) {
    return this.promotionsService.validateCouponForCart(dto);
  }

  // Public — product-page coupon banner. Its own throttle bucket (the
  // throttler keys per handler), so banner lookups never eat into the
  // cart's validate-coupon budget. Every unusable code answers the same
  // PROMOTION_COUPON_INVALID, so it reveals no more than validate-coupon.
  // Kept at validate-coupon's 15/min: the two buckets together are the
  // per-IP probing budget, and the banner debounces and caches its calls.
  @Post('coupon-preview')
  @Throttle({ default: { limit: 15, ttl: 60000 } })
  previewCoupon(@Body() dto: CouponPreviewDto) {
    return this.promotionsService.previewCoupon(dto);
  }
}

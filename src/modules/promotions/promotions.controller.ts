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
import { PromotionsService } from './promotions.service';
import {
  CreatePromotionDto,
  UpdatePromotionDto,
  ValidateCouponDto,
} from './dto/promotion.dto';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller('promotions')
export class PromotionsController {
  constructor(private promotionsService: PromotionsService) {}

  @Post()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR)
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
  @UseGuards(AuthGuard('jwt'))
  findById(@Param('id') id: string) {
    return this.promotionsService.findById(id);
  }

  @Put(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR)
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

  // Public — validate coupon code
  @Post('validate-coupon')
  validateCoupon(@Body() dto: ValidateCouponDto) {
    return this.promotionsService.validateCoupon(dto);
  }
}

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ShippingService } from './shipping.service';
import {
  CreateShippingProfileDto,
  CreateShippingZoneDto,
  UpdateShippingZoneDto,
  CalculateShippingDto,
  EstimateShippingDto,
} from './dto/shipping.dto';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller('shipping')
export class ShippingController {
  constructor(private shippingService: ShippingService) {}

  // Map the requester's role to the profile owner column used for scoping.
  // Admin gets no owner type — ownership checks are bypassed for them.
  private ownerTypeFor(role: UserRole): 'provider' | 'creator' | undefined {
    if (role === UserRole.PROVIDER) return 'provider';
    if (role === UserRole.CREATOR) return 'creator';
    return undefined;
  }

  @Post('profiles')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR)
  createProfile(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
    @Body() dto: CreateShippingProfileDto,
  ) {
    const ownerType = role === UserRole.PROVIDER ? 'provider' : 'creator';
    return this.shippingService.createProfile(userId, ownerType, dto);
  }

  @Get('profiles')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR)
  getProfiles(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    const ownerType = role === UserRole.PROVIDER ? 'provider' : 'creator';
    return this.shippingService.getProfiles(userId, ownerType);
  }

  @Post('profiles/:profileId/zones')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  addZone(
    @Param('profileId') profileId: string,
    @Body() dto: CreateShippingZoneDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.shippingService.addZone(profileId, dto, userId, this.ownerTypeFor(role));
  }

  @Put('zones/:id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  updateZone(
    @Param('id') id: string,
    @Body() dto: UpdateShippingZoneDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.shippingService.updateZone(id, dto, userId, this.ownerTypeFor(role));
  }

  @Put('profiles/:id/default')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR)
  setDefaultProfile(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    const ownerType = role === UserRole.PROVIDER ? 'provider' : 'creator';
    return this.shippingService.setDefaultProfile(id, userId, ownerType);
  }

  @Delete('profiles/:id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR)
  deleteProfile(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    const ownerType = role === UserRole.PROVIDER ? 'provider' : 'creator';
    return this.shippingService.deleteProfile(id, userId, ownerType);
  }

  @Delete('zones/:id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  deleteZone(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.shippingService.deleteZone(id, userId, this.ownerTypeFor(role));
  }

  // عام — حساب تكلفة الشحن
  @Post('calculate')
  calculate(@Body() dto: CalculateShippingDto) {
    return this.shippingService.calculate(dto);
  }

  // عام — تقدير الشحن بناءً على المنتجات والدولة
  @Post('estimate')
  estimate(@Body() dto: EstimateShippingDto) {
    return this.shippingService.calculateForItems(dto);
  }
}

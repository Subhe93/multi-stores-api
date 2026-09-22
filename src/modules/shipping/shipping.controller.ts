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
  CreateShippingMethodDto,
  UpdateShippingMethodDto,
  CalculateShippingDto,
  EstimateShippingDto,
} from './dto/shipping.dto';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

// Every owner-scoped route resolves the requester's User.id to the
// Provider.id / Creator.id that ShippingProfile.provider_id / creator_id
// reference (see ShippingService.resolveOwner). Admin routes resolve to no
// owner, which bypasses ownership checks in the service.
@Controller('shipping')
export class ShippingController {
  constructor(private shippingService: ShippingService) {}

  @Post('profiles')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR)
  async createProfile(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
    @Body() dto: CreateShippingProfileDto,
  ) {
    const { ownerId, ownerType } = await this.shippingService.requireOwner(
      userId,
      role,
    );
    return this.shippingService.createProfile(ownerId, ownerType, dto);
  }

  @Get('profiles')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR)
  async getProfiles(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    const { ownerId, ownerType } = await this.shippingService.requireOwner(
      userId,
      role,
    );
    return this.shippingService.getProfiles(ownerId, ownerType);
  }

  @Post('profiles/:profileId/zones')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  async addZone(
    @Param('profileId') profileId: string,
    @Body() dto: CreateShippingZoneDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    const owner = await this.shippingService.resolveOwner(userId, role);
    return this.shippingService.addZone(
      profileId,
      dto,
      owner?.ownerId,
      owner?.ownerType,
    );
  }

  @Put('zones/:id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  async updateZone(
    @Param('id') id: string,
    @Body() dto: UpdateShippingZoneDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    const owner = await this.shippingService.resolveOwner(userId, role);
    return this.shippingService.updateZone(
      id,
      dto,
      owner?.ownerId,
      owner?.ownerType,
    );
  }

  @Put('profiles/:id/default')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR)
  async setDefaultProfile(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    const { ownerId, ownerType } = await this.shippingService.requireOwner(
      userId,
      role,
    );
    return this.shippingService.setDefaultProfile(id, ownerId, ownerType);
  }

  @Delete('profiles/:id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR)
  async deleteProfile(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    const { ownerId, ownerType } = await this.shippingService.requireOwner(
      userId,
      role,
    );
    return this.shippingService.deleteProfile(id, ownerId, ownerType);
  }

  @Delete('zones/:id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  async deleteZone(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    const owner = await this.shippingService.resolveOwner(userId, role);
    return this.shippingService.deleteZone(
      id,
      owner?.ownerId,
      owner?.ownerType,
    );
  }

  // ── Methods (owner-scoped like zones; admin bypasses ownership) ───────────

  @Post('zones/:zoneId/methods')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  async addMethod(
    @Param('zoneId') zoneId: string,
    @Body() dto: CreateShippingMethodDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    const owner = await this.shippingService.resolveOwner(userId, role);
    return this.shippingService.addMethod(
      zoneId,
      dto,
      owner?.ownerId,
      owner?.ownerType,
    );
  }

  @Put('methods/:id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  async updateMethod(
    @Param('id') id: string,
    @Body() dto: UpdateShippingMethodDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    const owner = await this.shippingService.resolveOwner(userId, role);
    return this.shippingService.updateMethod(
      id,
      dto,
      owner?.ownerId,
      owner?.ownerType,
    );
  }

  @Delete('methods/:id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  async deleteMethod(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    const owner = await this.shippingService.resolveOwner(userId, role);
    return this.shippingService.deleteMethod(
      id,
      owner?.ownerId,
      owner?.ownerType,
    );
  }

  // Public: price one profile for a destination (legacy single-cost shape + methods)
  @Post('calculate')
  calculate(@Body() dto: CalculateShippingDto) {
    return this.shippingService.calculate(dto);
  }

  // Public: every shipping method for a set of products and a destination,
  // plus the legacy cost/estimated_days of the cheapest one.
  @Post('estimate')
  estimate(@Body() dto: EstimateShippingDto) {
    return this.shippingService.estimate(dto);
  }
}

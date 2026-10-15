import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { StoreAppsService } from './store-apps.service';
import {
  AdminStoreAppsQueryDto,
  SetStoreAppAvailableDto,
  UpdateMyStoreAppDto,
} from './dto/store-app.dto';

@Controller('stores')
export class StoreAppsController {
  constructor(private readonly storeApps: StoreAppsService) {}

  // Creator — every app with its state for my store
  @Get('my/apps')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  listMine(@CurrentUser('id') userId: string) {
    return this.storeApps.list(userId);
  }

  // Creator — toggle an app and/or replace its settings; returns the full
  // refreshed list (siblings' can_enable / blocked_reason change too)
  @Put('my/apps/:appKey')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  updateMine(
    @CurrentUser('id') userId: string,
    @Param('appKey') appKey: string,
    @Body() dto: UpdateMyStoreAppDto,
  ) {
    return this.storeApps.updateMine(userId, appKey, dto);
  }

  // Admin — every store with its apps (paginated, searchable overview)
  @Get('admin/apps')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  adminOverview(@Query() query: AdminStoreAppsQueryDto) {
    return this.storeApps.adminOverview(query);
  }

  // Admin — every app with its availability for a creator's store
  @Get('by-creator/:creatorId/apps')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  adminList(@Param('creatorId') creatorId: string) {
    return this.storeApps.adminList(creatorId);
  }

  // Admin — allow or withdraw an app for a creator's store
  @Put('by-creator/:creatorId/apps/:appKey/available')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  setAvailable(
    @Param('creatorId') creatorId: string,
    @Param('appKey') appKey: string,
    @Body() dto: SetStoreAppAvailableDto,
  ) {
    return this.storeApps.setAvailable(creatorId, appKey, dto.available);
  }
}

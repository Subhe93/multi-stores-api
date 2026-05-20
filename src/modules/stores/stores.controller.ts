import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { StoresService } from './stores.service';
import {
  CreateStoreDto,
  UpdateStoreDto,
  UpdateThemeDto,
  UpdateThemeSelectionDto,
  UpdateLanguageDto,
} from './dto/store.dto';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller('stores')
export class StoresController {
  constructor(private storesService: StoresService) {}

  // Admin — Get a creator's store by creator id
  @Get('by-creator/:creatorId')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  findByCreatorId(@Param('creatorId') creatorId: string) {
    return this.storesService.findByCreatorId(creatorId);
  }

  // Admin — Update a creator's store (including slug)
  @Put('by-creator/:creatorId')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  adminUpdate(@Param('creatorId') creatorId: string, @Body() dto: UpdateStoreDto) {
    return this.storesService.adminUpdateByCreatorId(creatorId, dto);
  }

  // Public — Get a store by its slug
  @Get(':slug')
  findBySlug(@Param('slug') slug: string) {
    return this.storesService.findBySlug(slug);
  }

  // Creator — إنشاء متجر
  @Post()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  create(@CurrentUser('id') userId: string, @Body() dto: CreateStoreDto) {
    return this.storesService.create(userId, dto);
  }

  // Creator — متجري
  @Get('my/store')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  getMyStore(@CurrentUser('id') userId: string) {
    return this.storesService.findByCreator(userId);
  }

  // Creator — تحديث المتجر
  @Put('my/store')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  update(@CurrentUser('id') userId: string, @Body() dto: UpdateStoreDto) {
    return this.storesService.update(userId, dto);
  }

  // Creator — تحديث الثيم
  @Put('my/theme')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  updateTheme(@CurrentUser('id') userId: string, @Body() dto: UpdateThemeDto) {
    return this.storesService.updateTheme(userId, dto);
  }

  // Creator — choose a built-in theme and/or override its tokens
  @Put('my/theme-selection')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  updateThemeSelection(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateThemeSelectionDto,
  ) {
    return this.storesService.updateThemeSelection(userId, dto);
  }

  // Creator — تحديث اللغات
  @Put('my/languages')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  updateLanguages(@CurrentUser('id') userId: string, @Body() dto: UpdateLanguageDto) {
    return this.storesService.updateLanguages(userId, dto);
  }
}

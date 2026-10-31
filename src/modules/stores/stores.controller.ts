import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  HttpCode,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AuthGuard } from '@nestjs/passport';
import { StoresService } from './stores.service';
import {
  CreateStoreDto,
  UpdateStoreDto,
  AdminUpdateStoreDto,
  UpdateThemeDto,
  UpdateThemeSelectionDto,
  UpdateLanguageDto,
} from './dto/store.dto';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';
import { EditHintTokenService } from '../storefront/edit-hint/edit-hint-token.service';

@Controller('stores')
export class StoresController {
  constructor(
    private storesService: StoresService,
    private editHintTokens: EditHintTokenService,
  ) {}

  // Admin — Get a creator's store by creator id
  @Get('by-creator/:creatorId')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  findByCreatorId(@Param('creatorId') creatorId: string) {
    return this.storesService.findByCreatorId(creatorId);
  }

  // Admin — Update a creator's store (including slug and store_type)
  @Put('by-creator/:creatorId')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  adminUpdate(
    @Param('creatorId') creatorId: string,
    @Body() dto: AdminUpdateStoreDto,
  ) {
    return this.storesService.adminUpdateByCreatorId(creatorId, dto);
  }

  // Public — Resolve a custom CNAME (e.g. shop.merchant.com) to its store slug.
  // Used by the storefront proxy on incoming requests; returns only the slug.
  // Declared before :slug so the path segment doesn't get swallowed.
  // Rate-limited per IP to deter enumeration of registered custom domains.
  @Get('by-domain/:host')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  findByDomain(@Param('host') host: string) {
    return this.storesService.findSlugByCustomDomain(host);
  }

  // Public — Get a store by its slug
  @Get(':slug')
  findBySlug(@Param('slug') slug: string) {
    return this.storesService.findBySlug(slug);
  }

  // Creator — Create a store
  @Post()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  create(@CurrentUser('id') userId: string, @Body() dto: CreateStoreDto) {
    return this.storesService.create(userId, dto);
  }

  // Creator — Edit-hint token for the own storefront (30 days). The
  // dashboard appends it to its "visit store" links so the storefront can
  // show the owner an "Edit" button; it grants no API access.
  @Post('my/edit-hint-token')
  @HttpCode(200)
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async createEditHintToken(@CurrentUser('id') userId: string) {
    const storeId = await this.storesService.findStoreIdByCreatorUser(userId);
    return this.editHintTokens.sign({ store_id: storeId, user_id: userId });
  }

  // Creator — My store
  @Get('my/store')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  getMyStore(@CurrentUser('id') userId: string) {
    return this.storesService.findByCreator(userId);
  }

  // Creator — Update the store
  @Put('my/store')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  update(@CurrentUser('id') userId: string, @Body() dto: UpdateStoreDto) {
    return this.storesService.update(userId, dto);
  }

  // Creator — Update the theme
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

  // Creator — Update languages
  @Put('my/languages')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  updateLanguages(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateLanguageDto,
  ) {
    return this.storesService.updateLanguages(userId, dto);
  }

  // Creator — manually flush the storefront cache for their own store
  @Post('my/cache/flush')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  flushCache(@CurrentUser('id') userId: string) {
    return this.storesService.flushCache(userId);
  }
}

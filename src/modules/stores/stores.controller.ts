import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  UseGuards,
  NotFoundException,
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
  TraderDetailsDto,
  AdminStoreStatusDto,
  AdminStoresQueryDto,
} from './dto/store.dto';
import {
  CurrentUser,
  Roles,
  VerifiedAccount,
  type RequestUser,
} from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { VerifiedAccountGuard } from '../../common/guards/verified-account.guard';
import { UserRole } from '@prisma/client';
import { EditHintTokenService } from '../storefront/edit-hint/edit-hint-token.service';
import { StoreLifecycleService } from './store-lifecycle.service';
import {
  StorefrontGateService,
  StorefrontViewerGuard,
  Viewer,
  type StorefrontViewer,
} from '../storefront/storefront-gate.service';
import { ReqMeta, type RequestMeta } from '../security/request-meta';

@Controller('stores')
export class StoresController {
  constructor(
    private storesService: StoresService,
    private editHintTokens: EditHintTokenService,
    private lifecycle: StoreLifecycleService,
    private gate: StorefrontGateService,
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

  // Admin — Detach a creator store's legacy external domain
  @Delete('by-creator/:creatorId/custom-domain')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  adminRemoveCustomDomain(@Param('creatorId') creatorId: string) {
    return this.storesService.adminRemoveCustomDomain(creatorId);
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

  // Public — Get a store by its slug. A non-LIVE store is 404 unless the
  // bearer token is the owner's / an admin's (SPEC §3 owner preview).
  @Get(':slug')
  @UseGuards(StorefrontViewerGuard)
  async findBySlug(
    @Viewer() viewer: StorefrontViewer | null,
    @Param('slug') slug: string,
  ) {
    const store = await this.storesService.findBySlug(slug);
    if (!(await this.gate.allows(store, viewer))) {
      throw new NotFoundException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });
    }
    return store;
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

  // Creator — Update the store. Status changes (is_active toggle) and the
  // custom domain are locked until the email is verified.
  @Put('my/store')
  @UseGuards(AuthGuard('jwt'), RolesGuard, VerifiedAccountGuard)
  @Roles(UserRole.CREATOR)
  @VerifiedAccount({ fields: ['is_active', 'custom_domain'] })
  update(@CurrentUser('id') userId: string, @Body() dto: UpdateStoreDto) {
    return this.storesService.update(userId, dto);
  }

  // Creator — Legal trader details (validated: Luhn org number, VAT format)
  @Put('my/trader-details')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  updateTraderDetails(
    @CurrentUser('id') userId: string,
    @Body() dto: TraderDetailsDto,
  ) {
    return this.lifecycle.updateTraderDetails(
      userId,
      dto as Record<string, unknown>,
    );
  }

  // Creator — Request go-live (auto-approved when the platform allows it)
  @Post('my/golive')
  @HttpCode(200)
  @UseGuards(AuthGuard('jwt'), RolesGuard, VerifiedAccountGuard)
  @Roles(UserRole.CREATOR)
  @VerifiedAccount()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  requestGoLive(@CurrentUser('id') userId: string) {
    return this.lifecycle.requestGoLive(userId);
  }

  // Creator — Detach the legacy external domain (allowed with Markets on too)
  @Delete('my/store/custom-domain')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  removeCustomDomain(@CurrentUser('id') userId: string) {
    return this.storesService.removeCustomDomain(userId);
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


// Admin store queue (SPEC §3): list by status and change a store's status.
@Controller('admin/stores')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminStoresController {
  constructor(private lifecycle: StoreLifecycleService) {}

  @Get()
  list(@Query() query: AdminStoresQueryDto) {
    return this.lifecycle.adminList(query);
  }

  @Put(':id/status')
  setStatus(
    @CurrentUser() admin: RequestUser,
    @ReqMeta() meta: RequestMeta,
    @Param('id') id: string,
    @Body() dto: AdminStoreStatusDto,
  ) {
    return this.lifecycle.adminSetStatus(id, dto.status, dto.reason, admin, meta);
  }
}

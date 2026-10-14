import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { MarketStatus, UserRole } from '@prisma/client';
import { CurrentUser, RequireApp, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequireAppGuard } from '../../common/guards/require-app.guard';
import { MarketsService } from './markets.service';
import { DomainsService } from './domains.service';
import {
  AddDomainDto,
  CreateMarketDto,
  SetMarketStatusDto,
  UpdateMarketDto,
  UpsertProductMarketPricesDto,
} from './dto/market.dto';

// Creator routes of the "markets" app. RequireAppGuard resolves the store
// from the creator JWT, so every route here answers 403 STORE_APP_NOT_ENABLED
// until the app is in effect for the store.
@Controller('markets')
@UseGuards(AuthGuard('jwt'), RolesGuard, RequireAppGuard)
@Roles(UserRole.CREATOR)
@RequireApp('markets')
export class MarketsController {
  constructor(
    private readonly markets: MarketsService,
    private readonly domains: DomainsService,
  ) {}

  @Get()
  list(@CurrentUser('id') userId: string) {
    return this.markets.list(userId);
  }

  // What the creator must point a custom hostname at.
  @Get('dns-target')
  dnsTarget() {
    return this.domains.dnsTarget();
  }

  @Get('fx-preview')
  fxPreview(@Query('from') from = '', @Query('to') to = '') {
    return this.markets.fxPreview(from, to);
  }

  @Get('products/:productId/prices')
  getProductPrices(
    @CurrentUser('id') userId: string,
    @Param('productId') productId: string,
  ) {
    return this.markets.getProductPrices(userId, productId);
  }

  @Put('products/:productId/prices')
  putProductPrices(
    @CurrentUser('id') userId: string,
    @Param('productId') productId: string,
    @Body() dto: UpsertProductMarketPricesDto,
  ) {
    return this.markets.putProductPrices(userId, productId, dto);
  }

  @Post()
  create(@CurrentUser('id') userId: string, @Body() dto: CreateMarketDto) {
    return this.markets.create(userId, dto);
  }

  @Get(':id')
  get(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.markets.get(userId, id);
  }

  @Put(':id')
  update(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateMarketDto,
  ) {
    return this.markets.update(userId, id, dto);
  }

  @Put(':id/status')
  setStatus(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: SetMarketStatusDto,
  ) {
    return this.markets.setStatus(userId, id, dto.status as MarketStatus);
  }

  @Delete(':id')
  delete(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.markets.delete(userId, id);
  }

  @Post(':id/payment-check')
  paymentCheck(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.markets.runPaymentCheck(userId, id);
  }

  @Post(':id/domains')
  addDomain(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: AddDomainDto,
  ) {
    return this.markets.addDomain(userId, id, dto);
  }

  @Delete(':id/domains/:domainId')
  removeDomain(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('domainId') domainId: string,
  ) {
    return this.markets.removeDomain(userId, id, domainId);
  }

  @Post(':id/domains/:domainId/verify')
  verifyDomain(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('domainId') domainId: string,
  ) {
    return this.markets.verifyDomain(userId, id, domainId);
  }

  @Put(':id/domains/:domainId/primary')
  setPrimaryDomain(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('domainId') domainId: string,
  ) {
    return this.markets.setPrimaryDomain(userId, id, domainId);
  }
}

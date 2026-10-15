import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import { CurrentUser, RequireApp, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequireAppGuard } from '../../common/guards/require-app.guard';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { B2bTaxExemptionService } from './b2b-tax-exemption.service';
import {
  CreateTaxExemptionDto,
  DashboardVatCheckDto,
  ListTaxExemptionsQueryDto,
} from './dto/tax-exemption.dto';

/**
 * Creator routes of the b2b app's customer tax exemptions (M2.5, D4) and
 * the dashboard VAT check. The store is the creator's own. Exemptions only
 * take effect while `reverse_charge_enabled` is on; managing them needs the
 * app only, so a merchant can prepare them before switching it on.
 */
@Controller('b2b/my/tax-exemptions')
@UseGuards(AuthGuard('jwt'), RolesGuard, RequireAppGuard)
@Roles(UserRole.CREATOR)
@RequireApp('b2b')
export class B2bExemptionsController {
  constructor(
    private readonly storeApps: StoreAppsService,
    private readonly exemptions: B2bTaxExemptionService,
  ) {}

  @Get()
  async list(
    @CurrentUser('id') userId: string,
    @Query() query: ListTaxExemptionsQueryDto,
  ) {
    const store = await this.storeApps.storeOfCreator(userId);
    return this.exemptions.list(store.id, query.include_revoked === true);
  }

  @Get('by-customer/:customerId')
  async byCustomer(
    @CurrentUser('id') userId: string,
    @Param('customerId') customerId: string,
  ) {
    const store = await this.storeApps.storeOfCreator(userId);
    return this.exemptions.byCustomer(store.id, customerId);
  }

  @Post('vat-check')
  @HttpCode(200)
  async vatCheck(
    @CurrentUser('id') userId: string,
    @Body() dto: DashboardVatCheckDto,
  ) {
    const store = await this.storeApps.storeOfCreator(userId);
    const e = await this.exemptions.checkVat(
      store.id,
      dto.vat_number,
      'dashboard',
    );
    return {
      vat_number: e.vat_number,
      country_code: e.country_code,
      status: e.status,
      name: e.name,
      address: e.address,
      checked_at: e.checked_at,
      request_identifier: e.request_identifier,
      error_code: e.error_code ?? null,
    };
  }

  @Post()
  async create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateTaxExemptionDto,
  ) {
    const store = await this.storeApps.storeOfCreator(userId);
    return this.exemptions.create(store.id, userId, dto);
  }

  @Delete(':id')
  async revoke(@CurrentUser('id') userId: string, @Param('id') id: string) {
    const store = await this.storeApps.storeOfCreator(userId);
    return this.exemptions.revoke(store.id, userId, id);
  }
}

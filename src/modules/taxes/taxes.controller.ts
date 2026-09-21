import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  CreateTaxClassDto,
  CreateTaxRateDto,
  ListTaxRatesQueryDto,
  TaxReportQueryDto,
  UpdatePlatformTaxSettingsDto,
  UpdateStoreTaxSettingsDto,
  UpdateTaxClassDto,
  UpdateTaxRateDto,
} from './dto/tax.dto';
import { TaxManagementService } from './tax-management.service';

const PLATFORM_SCOPE = { store_id: null };

/**
 * Tax administration (API-CONTRACT-TAX.md §3).
 * - `/taxes/admin/*`: platform classes, rates, seed, settings, report (ADMIN).
 * - `/taxes/my/*`: a creator's own store settings, rates and report.
 * - `/taxes/classes`: classes a product form may pick from (any role).
 */
@Controller('taxes')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class TaxesController {
  constructor(private readonly taxes: TaxManagementService) {}

  // ── Any JWT role ──────────────────────────────────────────────────────────

  @Get('classes')
  @Roles(UserRole.ADMIN, UserRole.CREATOR, UserRole.PROVIDER, UserRole.CUSTOMER)
  classesForProductForm(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.taxes.classesForUser(userId, role);
  }

  // ── Admin: classes ────────────────────────────────────────────────────────

  @Get('admin/classes')
  @Roles(UserRole.ADMIN)
  adminListClasses() {
    return this.taxes.listClasses(PLATFORM_SCOPE);
  }

  @Post('admin/classes')
  @Roles(UserRole.ADMIN)
  adminCreateClass(@Body() dto: CreateTaxClassDto) {
    return this.taxes.createClass(PLATFORM_SCOPE, dto);
  }

  @Put('admin/classes/:id')
  @Roles(UserRole.ADMIN)
  adminUpdateClass(@Param('id') id: string, @Body() dto: UpdateTaxClassDto) {
    return this.taxes.updateClass(PLATFORM_SCOPE, id, dto);
  }

  @Delete('admin/classes/:id')
  @Roles(UserRole.ADMIN)
  adminDeleteClass(@Param('id') id: string) {
    return this.taxes.deleteClass(PLATFORM_SCOPE, id);
  }

  // ── Admin: rates ──────────────────────────────────────────────────────────

  @Get('admin/rates')
  @Roles(UserRole.ADMIN)
  adminListRates(@Query() query: ListTaxRatesQueryDto) {
    return this.taxes.listRates(PLATFORM_SCOPE, query);
  }

  @Post('admin/rates/seed')
  @Roles(UserRole.ADMIN)
  adminSeedRates() {
    return this.taxes.seedPlatformRates();
  }

  @Post('admin/rates')
  @Roles(UserRole.ADMIN)
  adminCreateRate(@Body() dto: CreateTaxRateDto) {
    return this.taxes.createRate(PLATFORM_SCOPE, dto);
  }

  @Put('admin/rates/:id')
  @Roles(UserRole.ADMIN)
  adminUpdateRate(@Param('id') id: string, @Body() dto: UpdateTaxRateDto) {
    return this.taxes.updateRate(PLATFORM_SCOPE, id, dto);
  }

  @Delete('admin/rates/:id')
  @Roles(UserRole.ADMIN)
  adminDeleteRate(@Param('id') id: string) {
    return this.taxes.deleteRate(PLATFORM_SCOPE, id);
  }

  // ── Admin: settings / report ──────────────────────────────────────────────

  @Get('admin/settings')
  @Roles(UserRole.ADMIN)
  adminGetSettings() {
    return this.taxes.getPlatformSettings();
  }

  @Put('admin/settings')
  @Roles(UserRole.ADMIN)
  adminUpdateSettings(@Body() dto: UpdatePlatformTaxSettingsDto) {
    return this.taxes.updatePlatformSettings(dto);
  }

  @Get('admin/report')
  @Roles(UserRole.ADMIN)
  async adminReport(@Query() query: TaxReportQueryDto) {
    const rows = await this.taxes.report(query, {
      store_id: query.store_id ?? null,
    });
    return this.respond(rows, query, 'tax-report');
  }

  // ── Creator: own store ────────────────────────────────────────────────────

  @Get('my/settings')
  @Roles(UserRole.CREATOR)
  mySettings(@CurrentUser('id') userId: string) {
    return this.taxes.getStoreSettings(userId);
  }

  @Put('my/settings')
  @Roles(UserRole.CREATOR)
  updateMySettings(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateStoreTaxSettingsDto,
  ) {
    return this.taxes.updateStoreSettings(userId, dto);
  }

  // Rate rows: a marketplace store's taxes are the platform's, so it may
  // look (and sees nothing) but never write.
  @Get('my/rates')
  @Roles(UserRole.CREATOR)
  async myRates(
    @CurrentUser('id') userId: string,
    @Query() query: ListTaxRatesQueryDto,
  ) {
    const store = await this.taxes.storeOfCreator(userId);
    if (!this.taxes.storeManagesRates(store)) return [];
    return this.taxes.listRates({ store_id: store.id }, query);
  }

  @Post('my/rates')
  @Roles(UserRole.CREATOR)
  async createMyRate(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateTaxRateDto,
  ) {
    const store = await this.taxes.storeOfCreator(userId);
    this.taxes.assertStoreManagesRates(store);
    return this.taxes.createRate({ store_id: store.id }, dto);
  }

  @Put('my/rates/:id')
  @Roles(UserRole.CREATOR)
  async updateMyRate(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateTaxRateDto,
  ) {
    const store = await this.taxes.storeOfCreator(userId);
    this.taxes.assertStoreManagesRates(store);
    return this.taxes.updateRate({ store_id: store.id }, id, dto);
  }

  @Delete('my/rates/:id')
  @Roles(UserRole.CREATOR)
  async deleteMyRate(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    const store = await this.taxes.storeOfCreator(userId);
    this.taxes.assertStoreManagesRates(store);
    return this.taxes.deleteRate({ store_id: store.id }, id);
  }

  @Get('my/report')
  @Roles(UserRole.CREATOR)
  async myReport(
    @CurrentUser('id') userId: string,
    @Query() query: TaxReportQueryDto,
  ) {
    const store = await this.taxes.storeOfCreator(userId);
    const rows = await this.taxes.report(query, { store_id: store.id });
    return this.respond(rows, query, 'tax-report');
  }

  /**
   * JSON rows through the usual response envelope, or a CSV attachment as
   * a StreamableFile — which the envelope interceptor passes through and
   * Nest writes itself (a manual `res.send` next to a returned value would
   * make Nest reply twice).
   */
  private respond(
    rows: Awaited<ReturnType<TaxManagementService['report']>>,
    query: TaxReportQueryDto,
    filename: string,
  ) {
    if (query.format !== 'csv') return rows;
    const name = `${filename}-${query.from}-${query.to ?? query.from}.csv`;
    // UTF-8 BOM so spreadsheet apps read the labels (Moms, KDV, ...) right.
    return new StreamableFile(Buffer.from('\uFEFF' + this.taxes.toCsv(rows)), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${name}"`,
    });
  }
}

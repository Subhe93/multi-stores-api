import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { CommissionsService } from './commissions.service';
import { ProviderEarningsService } from './provider-earnings.service';
import {
  ProviderEarningsLinesQueryDto,
  ProviderEarningsRangeDto,
  ProviderPayoutsQueryDto,
} from './dto/provider-earnings.dto';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CommissionStatus, UserRole } from '@prisma/client';

@Controller('commissions')
@UseGuards(AuthGuard('jwt'))
export class CommissionsController {
  constructor(
    private commissionsService: CommissionsService,
    private providerEarnings: ProviderEarningsService,
  ) {}

  // Provider earnings ledger: server-side aggregates per currency over the
  // provider's own items only (the caller's provider row is resolved from the
  // JWT, never from a parameter).
  @Get('provider/summary')
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER)
  // Folds every matching order (in batches): throttled like an export.
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  getProviderSummary(
    @CurrentUser('id') userId: string,
    @Query() query: ProviderEarningsRangeDto,
  ) {
    return this.providerEarnings.summary(userId, query);
  }

  // Declared before 'provider/lines' so the literal suffix wins.
  @Get('provider/lines.csv')
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async getProviderLinesCsv(
    @CurrentUser('id') userId: string,
    @Query() query: ProviderEarningsLinesQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { csv, truncated } = await this.providerEarnings.linesCsv(
      userId,
      query,
    );
    // The CSV also ends with a marker row; the header lets clients warn.
    if (truncated) res.setHeader('X-Truncated', '1');
    const day = new Date().toISOString().slice(0, 10);
    // UTF-8 BOM so spreadsheet apps detect the encoding of store names.
    return new StreamableFile(Buffer.from('\uFEFF' + csv), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="earnings-${day}.csv"`,
    });
  }

  @Get('provider/lines')
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER)
  getProviderLines(
    @CurrentUser('id') userId: string,
    @Query() query: ProviderEarningsLinesQueryDto,
  ) {
    return this.providerEarnings.lines(userId, query);
  }

  @Get('provider/payouts')
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER)
  getProviderPayouts(
    @CurrentUser('id') userId: string,
    @Query() query: ProviderPayoutsQueryDto,
  ) {
    return this.providerEarnings.payouts(userId, query);
  }

  // Provider/Creator — ملخص أرباحي
  @Get('summary')
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR)
  getSummary(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    const ownerType = role === UserRole.PROVIDER ? 'provider' : 'creator';
    return this.commissionsService.getSummary(userId, ownerType);
  }

  // Admin — ملخص أرباح المنصة
  @Get('platform')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  getPlatformSummary() {
    return this.commissionsService.getPlatformSummary();
  }

  // Admin — قائمة عمولات مفصّلة لجميع الطلبات
  @Get('admin/list')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  getAdminList(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    const statusEnum =
      status && (Object.values(CommissionStatus) as string[]).includes(status)
        ? (status as CommissionStatus)
        : undefined;
    return this.commissionsService.getAdminList({
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
      status: statusEnum,
      search: search || undefined,
    });
  }

  // تفاصيل عمولة طلب محدد
  @Get('order/:orderId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  getByOrder(
    @Param('orderId') orderId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.commissionsService.getByOrder(orderId, userId, role);
  }
}

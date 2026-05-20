import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CommissionsService } from './commissions.service';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CommissionStatus, UserRole } from '@prisma/client';

@Controller('commissions')
@UseGuards(AuthGuard('jwt'))
export class CommissionsController {
  constructor(private commissionsService: CommissionsService) {}

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
  getByOrder(@Param('orderId') orderId: string) {
    return this.commissionsService.getByOrder(orderId);
  }
}

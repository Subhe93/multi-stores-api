import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CommissionsService } from './commissions.service';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

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

  // تفاصيل عمولة طلب محدد
  @Get('order/:orderId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.CREATOR, UserRole.ADMIN)
  getByOrder(@Param('orderId') orderId: string) {
    return this.commissionsService.getByOrder(orderId);
  }
}

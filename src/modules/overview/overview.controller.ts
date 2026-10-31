import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { OverviewService } from './overview.service';

// Creator dashboard home: KPIs, charts, breakdowns, to-dos and the setup
// checklist of the caller's own store (the store always comes from the JWT).
@Controller('stores')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.CREATOR)
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  // GET /stores/my/overview?range=today|7d|30d|90d|12m&tz=Europe/Stockholm
  @Get('my/overview')
  getOverview(
    @CurrentUser('id') userId: string,
    @Query('range') range?: string,
    @Query('tz') tz?: string,
  ) {
    return this.overview.getOverview(userId, range, tz);
  }
}

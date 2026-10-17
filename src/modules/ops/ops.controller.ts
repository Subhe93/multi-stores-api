import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { OpsStatusService } from './ops-status.service';

/** `GET /admin/ops/status` (ADMIN): read-only operability snapshot, cached 15 s. */
@Controller('admin/ops')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class OpsController {
  constructor(private readonly status: OpsStatusService) {}

  @Get('status')
  getStatus() {
    return this.status.status();
  }
}

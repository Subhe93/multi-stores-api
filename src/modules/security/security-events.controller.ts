import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { SecurityAuditService } from './security-audit.service';
import { ReauthService } from './reauth.service';
import { ReauthDto } from './dto/security.dto';
import { ReqMeta, type RequestMeta } from './request-meta';

/** Admin view of the security trail (read-only; rows are append-only). */
@Controller('admin')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class SecurityEventsController {
  constructor(
    private readonly audit: SecurityAuditService,
    private readonly reauth: ReauthService,
  ) {}

  @Get('security-events')
  list(@Query() query: { page?: string; limit?: string; action?: string }) {
    return this.audit.list(query);
  }

  // Sudo mode: one confirmation covers admin user management for 5 min.
  @Post('reauth')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  grant(
    @CurrentUser('id') adminId: string,
    @Body() dto: ReauthDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.reauth.grant(adminId, dto, meta);
  }

  // Lost phone AND recovery codes: an admin turns the account's 2FA off.
  @Post('users/:id/2fa/reset')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  resetTwoFactor(
    @CurrentUser('id') adminId: string,
    @Param('id') targetId: string,
    @Body() dto: ReauthDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.reauth.adminResetTwoFactor(adminId, targetId, dto, meta);
  }
}

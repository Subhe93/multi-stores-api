import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UsersService } from './users.service';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole, UserStatus } from '@prisma/client';
import type { RequestUser } from '../../common/decorators/current-user.decorator';
import { ReauthService, type ReauthInput } from '../security/reauth.service';
import {
  SecurityAuditService,
  type SecurityAction,
} from '../security/security-audit.service';
import { ReqMeta, type RequestMeta } from '../security/request-meta';

@Controller('admin')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class UsersController {
  constructor(
    private usersService: UsersService,
    private reauth: ReauthService,
    private audit: SecurityAuditService,
  ) {}

  /**
   * Privilege-bearing account changes need the acting admin's password +
   * 2FA: a stolen admin token alone must not be able to mint an admin or
   * take over a creator (and through it, the payment keys).
   */
  private stepUp(
    admin: RequestUser,
    input: ReauthInput,
    purpose: string,
    meta: RequestMeta,
  ) {
    return this.reauth.verifyAdmin(admin.id, input, { purpose, meta });
  }

  private record(
    admin: RequestUser,
    action: SecurityAction,
    target: { id: string; email?: string | null },
    meta: RequestMeta,
    fields?: string[],
  ) {
    return this.audit.record({
      actor: { id: admin.id, email: admin.email, role: admin.role },
      action,
      targetType: 'user',
      targetId: target.id,
      targetLabel: target.email ?? null,
      fields,
      meta,
    });
  }

  @Get('users')
  findAll(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('role') role?: UserRole,
    @Query('status') status?: UserStatus,
    @Query('search') search?: string,
    @Query('store_id') store_id?: string,
  ) {
    return this.usersService.findAll(
      page ? +page : undefined,
      limit ? +limit : undefined,
      { role, status, search, store_id },
    );
  }

  @Get('users/stats')
  getDashboardStats() {
    return this.usersService.getDashboardStats();
  }

  @Get('users/recent')
  getRecentUsers() {
    return this.usersService.getRecentUsers();
  }

  @Get('users/:id')
  findById(@Param('id') id: string) {
    return this.usersService.findById(id);
  }

  @Post('users')
  async create(
    @CurrentUser() admin: RequestUser,
    @ReqMeta() meta: RequestMeta,
    @Body()
    body: ReauthInput & {
      email: string;
      password: string;
      role: UserRole;
      status?: UserStatus;
      avatar_url?: string;
      company_name?: string;
      description?: string;
      country?: string;
      phone?: string;
      verified?: boolean;
      display_name?: string;
      bio?: string;
      first_name?: string;
      last_name?: string;
      // Required for role CUSTOMER (400 STORE_REQUIRED / STORE_NOT_FOUND).
      store_id?: string;
      // Email the login details (password + magic link) to the new user.
      send_credentials?: boolean;
      locale?: string;
    },
  ) {
    const { current_password, totp_code, reauth_token, ...data } = body;
    const staff = data.role !== UserRole.CUSTOMER;
    if (staff) {
      await this.stepUp(
        admin,
        { current_password, totp_code, reauth_token },
        'user.create_staff',
        meta,
      );
    }
    const created = await this.usersService.create({
      ...data,
      send_credentials: data.send_credentials === true,
      locale:
        typeof data.locale === 'string' && /^[a-z]{2}$/.test(data.locale)
          ? data.locale
          : undefined,
    });
    if (staff) {
      await this.record(admin, 'user.created_staff', created, meta, [
        `role: ${data.role}`,
      ]);
      if (data.role === UserRole.ADMIN) {
        this.audit.alert(
          await this.audit.adminEmails(),
          'admin_account_created',
          { actorEmail: admin.email, fields: [created.email], meta },
          await this.audit.platformLocale(),
        );
      }
    }
    return created;
  }

  @Put('users/:id')
  async update(
    @CurrentUser() admin: RequestUser,
    @ReqMeta() meta: RequestMeta,
    @Param('id') id: string,
    @Body()
    body: ReauthInput & {
      email?: string;
      status?: UserStatus;
      avatar_url?: string | null;
      company_name?: string;
      description?: string | null;
      country?: string;
      phone?: string | null;
      verified?: boolean;
      logo_url?: string | null;
      display_name?: string;
      bio?: string | null;
      cover_url?: string | null;
      first_name?: string;
      last_name?: string;
    },
  ) {
    const { current_password, totp_code, reauth_token, ...data } = body;
    // Email (account recovery address) and status changes are takeover /
    // privilege levers; profile fields are not.
    const sensitive = [
      ...(data.email !== undefined ? ['email'] : []),
      ...(data.status !== undefined ? [`status: ${data.status}`] : []),
    ];
    if (sensitive.length) {
      await this.stepUp(
        admin,
        { current_password, totp_code, reauth_token },
        'user.update',
        meta,
      );
    }
    const before = sensitive.length
      ? await this.usersService.findById(id)
      : null;
    const updated = await this.usersService.update(id, data);
    if (before && data.email !== undefined && data.email !== before.email) {
      await this.record(
        admin,
        'user.email_changed_by_admin',
        { id, email: before.email },
        meta,
        ['email'],
      );
    }
    if (before && data.status !== undefined && data.status !== before.status) {
      await this.record(
        admin,
        'user.status_changed',
        { id, email: before.email },
        meta,
        [`status: ${data.status}`],
      );
    }
    return updated;
  }

  @Put('users/:id/status')
  async updateStatus(
    @CurrentUser() admin: RequestUser,
    @ReqMeta() meta: RequestMeta,
    @Param('id') id: string,
    @Body() body: ReauthInput & { status: UserStatus },
  ) {
    const target = await this.usersService.findById(id);
    // Moderating customers stays one click; staff accounts need step-up.
    if (target.role !== UserRole.CUSTOMER) {
      await this.stepUp(admin, body, 'user.status', meta);
    }
    const res = await this.usersService.updateStatus(id, body.status);
    await this.record(admin, 'user.status_changed', target, meta, [
      `status: ${body.status}`,
    ]);
    return res;
  }

  @Put('users/:id/password')
  async resetPassword(
    @CurrentUser() admin: RequestUser,
    @ReqMeta() meta: RequestMeta,
    @Param('id') id: string,
    @Body() body: ReauthInput & { password: string },
  ) {
    await this.stepUp(admin, body, 'user.password_reset', meta);
    const target = await this.usersService.findById(id);
    const res = await this.usersService.resetPassword(id, body.password);
    await this.record(admin, 'user.password_reset_by_admin', target, meta, [
      'password',
    ]);
    return res;
  }

  @Delete('users/:id')
  async remove(
    @CurrentUser() admin: RequestUser,
    @ReqMeta() meta: RequestMeta,
    @Param('id') id: string,
    @Body() body: ReauthInput = {},
  ) {
    await this.stepUp(admin, body ?? {}, 'user.delete', meta);
    const target = await this.usersService.findById(id);
    const res = await this.usersService.remove(id, admin.id);
    await this.record(admin, 'user.deleted_by_admin', target, meta, [
      `role: ${target.role}`,
    ]);
    return res;
  }

  @Get('platform-config')
  @Roles(UserRole.ADMIN, UserRole.PROVIDER, UserRole.CREATOR)
  getPlatformConfig() {
    return this.usersService.getPlatformConfig();
  }

  @Put('platform-config')
  updatePlatformConfig(
    @Body()
    body: {
      commission_type?: string;
      commission_value?: number;
      default_currency?: string;
      default_locale?: string;
      supported_locales?: string[];
      platform_name?: string;
      support_email?: string;
      min_order_amount?: number | null;
      require_provider_approval?: boolean;
      require_creator_approval?: boolean;
    },
  ) {
    return this.usersService.updatePlatformConfig(body);
  }
}

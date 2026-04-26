import {
  Controller,
  Get,
  Put,
  Param,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UsersService } from './users.service';
import { Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole, UserStatus } from '@prisma/client';

@Controller('admin')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get('users')
  findAll(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('role') role?: UserRole,
    @Query('status') status?: UserStatus,
    @Query('search') search?: string,
  ) {
    return this.usersService.findAll(page ? +page : undefined, limit ? +limit : undefined, { role, status, search });
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

  @Put('users/:id/status')
  updateStatus(
    @Param('id') id: string,
    @Body('status') status: UserStatus,
  ) {
    return this.usersService.updateStatus(id, status);
  }

  @Get('platform-config')
  @Roles(UserRole.ADMIN, UserRole.PROVIDER, UserRole.CREATOR)
  getPlatformConfig() {
    return this.usersService.getPlatformConfig();
  }

  @Put('platform-config')
  updatePlatformConfig(
    @Body() body: {
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

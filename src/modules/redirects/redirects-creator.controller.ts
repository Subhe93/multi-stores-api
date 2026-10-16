import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import { CurrentUser, RequireApp, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequireAppGuard } from '../../common/guards/require-app.guard';
import { RedirectsService } from './redirects.service';
import {
  CreateRedirectDto,
  RedirectListQueryDto,
  TestRedirectDto,
  UpdateRedirectDto,
} from './dto/redirect.dto';

/**
 * Creator management of the store's redirects (M4.4 §6.3). Listing and
 * deleting stay open when the importer app is off, so a merchant can clean
 * up; creating, editing and testing require the app. Static routes are
 * declared before ':id'.
 */
@Controller('redirects/my')
@UseGuards(AuthGuard('jwt'), RolesGuard, RequireAppGuard)
@Roles(UserRole.CREATOR)
export class RedirectsCreatorController {
  constructor(private readonly redirects: RedirectsService) {}

  @Get()
  async list(
    @CurrentUser('id') userId: string,
    @Query() query: RedirectListQueryDto,
  ) {
    const storeId = await this.redirects.storeIdForCreator(userId);
    return this.redirects.list(storeId, query);
  }

  @Post('test')
  @RequireApp('importer')
  async test(@CurrentUser('id') userId: string, @Body() dto: TestRedirectDto) {
    const storeId = await this.redirects.storeIdForCreator(userId);
    return this.redirects.test(storeId, dto.path);
  }

  @Post()
  @RequireApp('importer')
  async create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateRedirectDto,
  ) {
    const storeId = await this.redirects.storeIdForCreator(userId);
    return this.redirects.create(storeId, dto);
  }

  @Put(':id')
  @RequireApp('importer')
  async update(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRedirectDto,
  ) {
    const storeId = await this.redirects.storeIdForCreator(userId);
    return this.redirects.update(storeId, id, dto);
  }

  @Delete(':id')
  async remove(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const storeId = await this.redirects.storeIdForCreator(userId);
    return this.redirects.remove(storeId, id);
  }
}

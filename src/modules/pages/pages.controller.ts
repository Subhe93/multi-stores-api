import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PagesService } from './pages.service';
import { CreatePageDto, UpdatePageDto } from './dto/page.dto';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller()
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class PagesController {
  constructor(private pagesService: PagesService) {}

  @Get('stores/:storeId/pages')
  @Roles(UserRole.CREATOR, UserRole.ADMIN)
  findByStore(
    @Param('storeId') storeId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.pagesService.findByStore(storeId, userId, role);
  }

  @Post('stores/:storeId/pages')
  @Roles(UserRole.CREATOR)
  create(
    @Param('storeId') storeId: string,
    @Body() dto: CreatePageDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.pagesService.create(storeId, dto, userId, role);
  }

  @Get('pages/:id')
  @Roles(UserRole.CREATOR, UserRole.ADMIN)
  findById(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.pagesService.findById(id, userId, role);
  }

  @Put('pages/:id')
  @Roles(UserRole.CREATOR)
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePageDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.pagesService.update(id, dto, userId, role);
  }

  @Delete('pages/:id')
  @Roles(UserRole.CREATOR)
  delete(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.pagesService.delete(id, userId, role);
  }
}

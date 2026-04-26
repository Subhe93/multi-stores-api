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
import { Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller()
export class PagesController {
  constructor(private pagesService: PagesService) {}

  @Get('stores/:storeId/pages')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR, UserRole.ADMIN)
  findByStore(@Param('storeId') storeId: string) {
    return this.pagesService.findByStore(storeId);
  }

  @Post('stores/:storeId/pages')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  create(@Param('storeId') storeId: string, @Body() dto: CreatePageDto) {
    return this.pagesService.create(storeId, dto);
  }

  @Get('pages/:id')
  @UseGuards(AuthGuard('jwt'))
  findById(@Param('id') id: string) {
    return this.pagesService.findById(id);
  }

  @Put('pages/:id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  update(@Param('id') id: string, @Body() dto: UpdatePageDto) {
    return this.pagesService.update(id, dto);
  }

  @Delete('pages/:id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  delete(@Param('id') id: string) {
    return this.pagesService.delete(id);
  }
}

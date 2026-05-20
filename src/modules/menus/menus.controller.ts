import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { MenusService } from './menus.service';
import { CreateMenuDto, SetMenuItemsDto, UpdateMenuDto } from './dto/menus.dto';

@Controller('menus')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.CREATOR)
export class MenusController {
  constructor(private service: MenusService) {}

  @Get('mine')
  list(@CurrentUser('id') userId: string) {
    return this.service.listByStore(userId);
  }

  @Get(':id')
  getById(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.service.getById(userId, id);
  }

  @Post()
  create(@CurrentUser('id') userId: string, @Body() dto: CreateMenuDto) {
    return this.service.create(userId, dto);
  }

  @Put(':id')
  update(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateMenuDto,
  ) {
    return this.service.update(userId, id, dto);
  }

  @Delete(':id')
  delete(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.service.delete(userId, id);
  }

  @Put(':id/items')
  setItems(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: SetMenuItemsDto,
  ) {
    return this.service.setItems(userId, id, dto);
  }
}

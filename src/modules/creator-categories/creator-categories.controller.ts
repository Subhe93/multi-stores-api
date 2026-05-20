import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CreatorCategoriesService } from './creator-categories.service';
import {
  CreateCreatorCategoryDto,
  UpdateCreatorCategoryDto,
  ReorderCreatorCategoriesDto,
} from './dto/creator-category.dto';
import { Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

@Controller('creator-categories')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.CREATOR)
export class CreatorCategoriesController {
  constructor(private service: CreatorCategoriesService) {}

  @Get()
  findAll(@CurrentUser('id') userId: string) {
    return this.service.findAll(userId);
  }

  @Post()
  create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateCreatorCategoryDto,
  ) {
    return this.service.create(userId, dto);
  }

  @Put('reorder')
  reorder(
    @CurrentUser('id') userId: string,
    @Body() dto: ReorderCreatorCategoriesDto,
  ) {
    return this.service.reorder(userId, dto);
  }

  @Get(':id')
  findById(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.service.findById(id, userId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateCreatorCategoryDto,
  ) {
    return this.service.update(id, userId, dto);
  }

  @Delete(':id')
  delete(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.service.delete(id, userId);
  }

  @Get(':id/products')
  getProducts(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.service.getProducts(id, userId);
  }
}

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
import { CategoriesService } from './categories.service';
import {
  CreateCategoryDto,
  UpdateCategoryDto,
  LinkAttributesDto,
} from './dto/category.dto';
import { Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller('categories')
export class CategoriesController {
  constructor(private categoriesService: CategoriesService) {}

  // عام — للجميع
  @Get()
  findAll() {
    return this.categoriesService.findAll();
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.categoriesService.findById(id);
  }

  @Get('slug/:slug')
  findBySlug(@Param('slug') slug: string) {
    return this.categoriesService.findBySlug(slug);
  }

  @Get(':id/attributes')
  getAttributes(@Param('id') id: string) {
    return this.categoriesService.getAttributeTemplates(id);
  }

  // Admin فقط
  @Post()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  create(@Body() dto: CreateCategoryDto) {
    return this.categoriesService.create(dto);
  }

  @Put(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categoriesService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  delete(@Param('id') id: string) {
    return this.categoriesService.delete(id);
  }

  @Post(':id/attributes')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  linkAttributes(@Param('id') id: string, @Body() dto: LinkAttributesDto) {
    return this.categoriesService.linkAttributes(id, dto);
  }
}

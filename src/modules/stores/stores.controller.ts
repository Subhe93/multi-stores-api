import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { StoresService } from './stores.service';
import { CreateStoreDto, UpdateStoreDto, UpdateThemeDto, UpdateLanguageDto } from './dto/store.dto';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller('stores')
export class StoresController {
  constructor(private storesService: StoresService) {}

  // عام — الحصول على متجر بالـ slug
  @Get(':slug')
  findBySlug(@Param('slug') slug: string) {
    return this.storesService.findBySlug(slug);
  }

  // Creator — إنشاء متجر
  @Post()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  create(@CurrentUser('id') userId: string, @Body() dto: CreateStoreDto) {
    return this.storesService.create(userId, dto);
  }

  // Creator — متجري
  @Get('my/store')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  getMyStore(@CurrentUser('id') userId: string) {
    return this.storesService.findByCreator(userId);
  }

  // Creator — تحديث المتجر
  @Put('my/store')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  update(@CurrentUser('id') userId: string, @Body() dto: UpdateStoreDto) {
    return this.storesService.update(userId, dto);
  }

  // Creator — تحديث الثيم
  @Put('my/theme')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  updateTheme(@CurrentUser('id') userId: string, @Body() dto: UpdateThemeDto) {
    return this.storesService.updateTheme(userId, dto);
  }

  // Creator — تحديث اللغات
  @Put('my/languages')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  updateLanguages(@CurrentUser('id') userId: string, @Body() dto: UpdateLanguageDto) {
    return this.storesService.updateLanguages(userId, dto);
  }
}

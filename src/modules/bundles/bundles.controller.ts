import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { BundlesService } from './bundles.service';
import { CreateBundleDto, UpdateBundleDto } from './dto/bundle.dto';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller('bundles')
export class BundlesController {
  constructor(private bundlesService: BundlesService) {}

  @Get('templates')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  templates() {
    return this.bundlesService.getTemplates();
  }

  @Post()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateBundleDto,
  ) {
    return this.bundlesService.create(userId, dto);
  }

  @Get()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  findMine(
    @CurrentUser('id') userId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('q') q?: string,
  ) {
    return this.bundlesService.findByOwner(
      userId,
      page ? +page : undefined,
      limit ? +limit : undefined,
      q,
    );
  }

  @Get(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  findOne(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.bundlesService.findById(id, userId);
  }

  @Put(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  update(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateBundleDto,
  ) {
    return this.bundlesService.update(id, userId, dto);
  }

  @Delete(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.CREATOR)
  remove(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.bundlesService.delete(id, userId);
  }
}

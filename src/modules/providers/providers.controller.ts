import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ProvidersService } from './providers.service';
import { CreateProviderDto, UpdateProviderDto } from './dto/create-provider.dto';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller('providers')
@UseGuards(AuthGuard('jwt'))
export class ProvidersController {
  constructor(private providersService: ProvidersService) {}

  @Post()
  @Roles(UserRole.PROVIDER)
  @UseGuards(RolesGuard)
  create(@CurrentUser('id') userId: string, @Body() dto: CreateProviderDto) {
    return this.providersService.create(userId, dto);
  }

  @Get('me')
  @Roles(UserRole.PROVIDER)
  @UseGuards(RolesGuard)
  getMyProfile(@CurrentUser('id') userId: string) {
    return this.providersService.findByUserId(userId);
  }

  @Put('me')
  @Roles(UserRole.PROVIDER)
  @UseGuards(RolesGuard)
  updateMyProfile(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateProviderDto,
  ) {
    return this.providersService.update(userId, dto);
  }

  @Get('me/stores')
  @Roles(UserRole.PROVIDER)
  @UseGuards(RolesGuard)
  getMyStores(
    @CurrentUser('id') userId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.providersService.findStoresUsingProvider(userId, page, limit);
  }

  @Get('me/stores/:storeId')
  @Roles(UserRole.PROVIDER)
  @UseGuards(RolesGuard)
  getMyStoreById(
    @CurrentUser('id') userId: string,
    @Param('storeId') storeId: string,
  ) {
    return this.providersService.findStoreForProvider(userId, storeId);
  }

  @Get()
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  findAll(@Query('page') page?: number, @Query('limit') limit?: number) {
    return this.providersService.findAll(page, limit);
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.providersService.findById(id);
  }

  @Put(':id/verify')
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  verify(@Param('id') id: string) {
    return this.providersService.verify(id);
  }
}

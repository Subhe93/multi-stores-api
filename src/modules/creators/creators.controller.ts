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
import { CreatorsService } from './creators.service';
import { CreateCreatorDto, UpdateCreatorDto } from './dto/create-creator.dto';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller('creators')
@UseGuards(AuthGuard('jwt'))
export class CreatorsController {
  constructor(private creatorsService: CreatorsService) {}

  @Post()
  @Roles(UserRole.CREATOR)
  @UseGuards(RolesGuard)
  create(@CurrentUser('id') userId: string, @Body() dto: CreateCreatorDto) {
    return this.creatorsService.create(userId, dto);
  }

  @Get('me')
  @Roles(UserRole.CREATOR)
  @UseGuards(RolesGuard)
  getMyProfile(@CurrentUser('id') userId: string) {
    return this.creatorsService.findByUserId(userId);
  }

  @Put('me')
  @Roles(UserRole.CREATOR)
  @UseGuards(RolesGuard)
  updateMyProfile(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateCreatorDto,
  ) {
    return this.creatorsService.update(userId, dto);
  }

  @Get()
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  findAll(@Query('page') page?: number, @Query('limit') limit?: number) {
    return this.creatorsService.findAll(page, limit);
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.creatorsService.findById(id);
  }

  @Put(':id/verify')
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  verify(@Param('id') id: string) {
    return this.creatorsService.verify(id);
  }
}

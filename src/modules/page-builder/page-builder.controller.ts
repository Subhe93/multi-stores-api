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
import { PageBuilderService } from './page-builder.service';
import { CreateBlockDto, UpdateBlockDto } from './dto/block.dto';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.CREATOR, UserRole.ADMIN)
export class PageBuilderController {
  constructor(private pageBuilderService: PageBuilderService) {}

  @Get('pages/:pageId/blocks')
  getBlocks(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.pageBuilderService.getBlocks(pageId, userId, role);
  }

  @Post('pages/:pageId/blocks')
  addBlock(
    @Param('pageId') pageId: string,
    @Body() dto: CreateBlockDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.pageBuilderService.addBlock(pageId, dto, userId, role);
  }

  @Put('blocks/:id')
  updateBlock(
    @Param('id') id: string,
    @Body() dto: UpdateBlockDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.pageBuilderService.updateBlock(id, dto, userId, role);
  }

  @Delete('blocks/:id')
  deleteBlock(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.pageBuilderService.deleteBlock(id, userId, role);
  }

  @Put('pages/:pageId/blocks/sort')
  reorderBlocks(
    @Param('pageId') pageId: string,
    @Body('block_ids') blockIds: string[],
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.pageBuilderService.reorderBlocks(pageId, blockIds, userId, role);
  }
}

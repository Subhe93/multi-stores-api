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
import { Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.CREATOR)
export class PageBuilderController {
  constructor(private pageBuilderService: PageBuilderService) {}

  @Get('pages/:pageId/blocks')
  getBlocks(@Param('pageId') pageId: string) {
    return this.pageBuilderService.getBlocks(pageId);
  }

  @Post('pages/:pageId/blocks')
  addBlock(@Param('pageId') pageId: string, @Body() dto: CreateBlockDto) {
    return this.pageBuilderService.addBlock(pageId, dto);
  }

  @Put('blocks/:id')
  updateBlock(@Param('id') id: string, @Body() dto: UpdateBlockDto) {
    return this.pageBuilderService.updateBlock(id, dto);
  }

  @Delete('blocks/:id')
  deleteBlock(@Param('id') id: string) {
    return this.pageBuilderService.deleteBlock(id);
  }

  @Put('pages/:pageId/blocks/sort')
  reorderBlocks(
    @Param('pageId') pageId: string,
    @Body('block_ids') blockIds: string[],
  ) {
    return this.pageBuilderService.reorderBlocks(pageId, blockIds);
  }
}

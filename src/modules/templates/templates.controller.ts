import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { TemplatesService } from './templates.service';
import { ImportKitDto } from './dto/import-kit.dto';

@Controller('v2/templates')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.CREATOR)
export class TemplatesController {
  constructor(private service: TemplatesService) {}

  // List the kit catalog (lightweight metadata for the gallery).
  @Get()
  list() {
    return this.service.listKits();
  }

  @Get(':id')
  getKit(@Param('id') id: string) {
    return this.service.getKit(id);
  }

  // Apply a kit to the creator's store. Replaces the matching pages' sections
  // and applies the kit's theme. Pages stay DRAFT for review.
  @Post(':id/import')
  import(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: ImportKitDto,
  ) {
    return this.service.importKit(userId, id, { withDemoData: dto.withDemoData });
  }
}

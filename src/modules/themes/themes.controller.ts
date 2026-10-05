import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ThemesService } from './themes.service';
import { ApplyThemeDto } from './dto/apply-theme.dto';

@Controller('v2/themes')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.CREATOR)
export class ThemesController {
  constructor(private service: ThemesService) {}

  // List the look-only preset catalog (lightweight metadata for the gallery).
  @Get()
  list() {
    return this.service.listPresets();
  }

  @Get(':id')
  getPreset(@Param('id') id: string) {
    return this.service.getPreset(id);
  }

  // Apply a preset to the creator's store: theme tokens + header / footer
  // chrome layout. Never replaces texts, links, images or page content.
  @Post(':id/apply')
  apply(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: ApplyThemeDto,
  ) {
    return this.service.apply(userId, id, dto.publish ?? true);
  }
}

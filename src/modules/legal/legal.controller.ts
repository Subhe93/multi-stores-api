import {
  Controller,
  Get,
  Put,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { LegalService } from './legal.service';
import { UpdateLegalPageDto } from './dto/legal.dto';
import { Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller('legal')
export class LegalController {
  constructor(private legalService: LegalService) {}

  // ── Public reads ────────────────────────────────────────────────────────────

  @Get()
  list(@Query('locale') locale?: string) {
    return this.legalService.list(locale);
  }

  // ── Admin (full JSON for the editor) ────────────────────────────────────────

  @Get('admin')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  listAdmin() {
    return this.legalService.listAdmin();
  }

  @Get('admin/:slug')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  getAdmin(@Param('slug') slug: string) {
    return this.legalService.findBySlugAdmin(slug);
  }

  @Put('admin/:slug')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  update(@Param('slug') slug: string, @Body() dto: UpdateLegalPageDto) {
    return this.legalService.update(slug, dto);
  }

  // ── Public single page — kept LAST so /admin and /admin/:slug match first ──

  @Get(':slug')
  bySlug(@Param('slug') slug: string, @Query('locale') locale?: string) {
    return this.legalService.findBySlug(slug, locale);
  }
}

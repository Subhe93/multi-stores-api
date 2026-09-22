import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { BackupKind, UserRole } from '@prisma/client';
import type { Request } from 'express';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { BackupsService, RESTORE_TIMEOUT_MS } from './backups.service';
import {
  CreateBackupDto,
  DownloadBackupQueryDto,
  RestoreBackupDto,
  UpdateBackupSettingsDto,
} from './dto/backups.dto';

/**
 * Admin backups (plans/backups/API-CONTRACT.md), mounted at
 * `/api/admin/backups`. `settings` routes are declared before `:id` so the
 * literal segment wins.
 */
@Controller('admin/backups')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class BackupsController {
  constructor(private readonly backups: BackupsService) {}

  // ── Settings ──────────────────────────────────────────────────────────────

  @Get('settings')
  getSettings() {
    return this.backups.getSettings();
  }

  @Put('settings')
  updateSettings(@Body() dto: UpdateBackupSettingsDto) {
    return this.backups.updateSettings(dto);
  }

  // ── Backups ───────────────────────────────────────────────────────────────

  @Get()
  list() {
    return this.backups.list();
  }

  @Post()
  create(@CurrentUser('id') userId: string, @Body() dto: CreateBackupDto) {
    return this.backups.create(BackupKind.MANUAL, {
      includeUploads: dto.include_uploads ?? false,
      note: dto.note ?? null,
      createdBy: userId,
    });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.backups.get(id);
  }

  /** Streams the file as an attachment; the envelope interceptor passes it through. */
  @Get(':id/download')
  download(@Param('id') id: string, @Query() query: DownloadBackupQueryDto) {
    return this.backups.download(id, query.file);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.backups.delete(id);
  }

  @Post(':id/restore')
  restore(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: RestoreBackupDto,
    @Req() req: Request,
  ) {
    // pg_restore may take minutes; keep this one socket open long enough.
    req.socket.setTimeout(RESTORE_TIMEOUT_MS + 30_000);
    return this.backups.restore(id, dto, userId);
  }
}

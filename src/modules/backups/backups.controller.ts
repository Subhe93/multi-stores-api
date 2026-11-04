import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
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
import type { RequestUser } from '../../common/decorators';
import { ReauthService } from '../security/reauth.service';
import {
  SecurityAuditService,
  type SecurityAction,
} from '../security/security-audit.service';
import { ReqMeta, type RequestMeta } from '../security/request-meta';
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
  constructor(
    private readonly backups: BackupsService,
    private readonly reauth: ReauthService,
    private readonly audit: SecurityAuditService,
  ) {}

  /**
   * A dump holds every account, password hash and encrypted secret, and a
   * restore overwrites the whole database: download, restore and delete need
   * a fresh admin re-auth grant (POST /admin/reauth, password + 2FA), sent
   * in the `X-Reauth-Token` header. A stolen access token alone is not enough.
   */
  private async stepUp(admin: RequestUser, grant: string | undefined) {
    await this.reauth.verifyGrant(admin.id, grant ?? '');
  }

  private record(
    admin: RequestUser,
    action: SecurityAction,
    backupId: string,
    meta: RequestMeta,
    fields?: string[],
  ) {
    return this.audit.record({
      actor: { id: admin.id, email: admin.email, role: admin.role },
      action,
      targetType: 'platform',
      targetId: backupId,
      targetLabel: `backup ${backupId}`,
      fields,
      meta,
    });
  }

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
  async create(
    @CurrentUser() admin: RequestUser,
    @Body() dto: CreateBackupDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    const backup = await this.backups.create(BackupKind.MANUAL, {
      includeUploads: dto.include_uploads ?? false,
      note: dto.note ?? null,
      createdBy: admin.id,
    });
    const id = (backup as { id?: string } | null)?.id ?? 'new';
    await this.record(admin, 'backup.created', id, meta);
    return backup;
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.backups.get(id);
  }

  /** Streams the file as an attachment; the envelope interceptor passes it through. */
  @Get(':id/download')
  async download(
    @CurrentUser() admin: RequestUser,
    @Param('id') id: string,
    @Query() query: DownloadBackupQueryDto,
    @Headers('x-reauth-token') grant: string | undefined,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.stepUp(admin, grant);
    const file = await this.backups.download(id, query.file);
    await this.record(admin, 'backup.downloaded', id, meta, [query.file]);
    return file;
  }

  @Delete(':id')
  async remove(
    @CurrentUser() admin: RequestUser,
    @Param('id') id: string,
    @Headers('x-reauth-token') grant: string | undefined,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.stepUp(admin, grant);
    const res = await this.backups.delete(id);
    await this.record(admin, 'backup.deleted', id, meta);
    return res;
  }

  @Post(':id/restore')
  async restore(
    @CurrentUser() admin: RequestUser,
    @Param('id') id: string,
    @Body() dto: RestoreBackupDto,
    @Headers('x-reauth-token') grant: string | undefined,
    @ReqMeta() meta: RequestMeta,
    @Req() req: Request,
  ) {
    await this.stepUp(admin, grant);
    const fields = [dto.restore_uploads ? 'db+uploads' : 'db'];
    // Recorded before (kept in the pre-restore safety backup) and after (the
    // restore replaced the audit table with the dump's).
    await this.record(admin, 'backup.restored', id, meta, fields);
    // pg_restore may take minutes; keep this one socket open long enough.
    req.socket.setTimeout(RESTORE_TIMEOUT_MS + 30_000);
    const res = await this.backups.restore(id, dto, admin.id);
    await this.record(admin, 'backup.restored', id, meta, fields);
    return res;
  }
}

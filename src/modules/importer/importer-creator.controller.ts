import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  StreamableFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { promises as fs } from 'fs';
import * as path from 'path';
import { UserRole } from '@prisma/client';
import { CurrentUser, RequireApp, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequireAppGuard } from '../../common/guards/require-app.guard';
import { ImportSourcesService } from './sources/import-sources.service';
import { ImportRunsService } from './runs/import-runs.service';
import {
  BUNDLE_MAX_FILES,
  BUNDLE_UPLOAD_MAX_FILE_BYTES,
  boundedBundleStorage,
} from './runs/bundle-store';
import { CreateImportSourceDto, UpdateImportSourceDto } from './dto/source.dto';
import {
  ConfirmRunDto,
  CreateImportRunDto,
  RunItemsQueryDto,
  RunListQueryDto,
  RunLogsQueryDto,
  RunReportQueryDto,
} from './dto/run.dto';
import { importError } from './importer.errors';

/** WP-F export script (served as a download from the Sources tab). */
export const EXPORT_SCRIPT_PATH = path.join(
  'tools',
  'importer',
  'wp-export.sh',
);

/**
 * Creator routes of the importer app (M4.4 §10). Every write carries
 * @RequireApp('importer') (403 STORE_APP_NOT_ENABLED when off; the app
 * requires an INDEPENDENT store with markets); reads stay open so a merchant
 * can still see past runs. Every lookup is scoped to the caller's store.
 */
@Controller('importer/my')
@UseGuards(AuthGuard('jwt'), RolesGuard, RequireAppGuard)
@Roles(UserRole.CREATOR)
export class ImporterCreatorController {
  constructor(
    private readonly sources: ImportSourcesService,
    private readonly runs: ImportRunsService,
  ) {}

  // ── Sources ───────────────────────────────────────────────────────────────

  @Get('sources')
  async listSources(@CurrentUser('id') userId: string) {
    return this.sources.list(await this.runs.storeIdForCreator(userId));
  }

  @Post('sources')
  @RequireApp('importer')
  async createSource(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateImportSourceDto,
  ) {
    return this.sources.create(await this.runs.storeIdForCreator(userId), dto);
  }

  @Put('sources/:id')
  @RequireApp('importer')
  async updateSource(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateImportSourceDto,
  ) {
    return this.sources.update(
      await this.runs.storeIdForCreator(userId),
      id,
      dto,
    );
  }

  @Delete('sources/:id')
  @RequireApp('importer')
  async deleteSource(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.sources.remove(await this.runs.storeIdForCreator(userId), id);
  }

  @Post('sources/:id/verify')
  @HttpCode(200)
  @RequireApp('importer')
  async verifySource(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.sources.verify(await this.runs.storeIdForCreator(userId), id);
  }

  /** Read-only export script for the source shop (WP-F). 404 IMPORT_EXPORT_SCRIPT_NOT_FOUND until it exists. */
  @Get('export-script')
  async exportScript() {
    const file = path.resolve(process.cwd(), EXPORT_SCRIPT_PATH);
    const buf = await fs.readFile(file).catch(() => null);
    if (!buf) {
      throw new NotFoundException({
        code: 'IMPORT_EXPORT_SCRIPT_NOT_FOUND',
        message: 'The export script is not available on this server',
      });
    }
    return new StreamableFile(buf, {
      type: 'text/x-shellscript; charset=utf-8',
      disposition: 'attachment; filename="wp-export.sh"',
    });
  }

  // ── Runs ──────────────────────────────────────────────────────────────────

  /**
   * Multipart: `source_id`, `options` (JSON string) and the bundle — `file`
   * (one archive: refused with IMPORT_BUNDLE_INVALID_ARCHIVE until `fflate`
   * is approved) and/or `files` (the extracted, allowlisted bundle files).
   */
  @Post('runs')
  @RequireApp('importer')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'file', maxCount: 1 },
        { name: 'files', maxCount: BUNDLE_MAX_FILES },
      ],
      {
        // The 50 MB total is enforced while streaming (nginx: client_max_body_size ~55M).
        storage: boundedBundleStorage(),
        limits: {
          fileSize: BUNDLE_UPLOAD_MAX_FILE_BYTES,
          files: BUNDLE_MAX_FILES + 1,
        },
      },
    ),
  )
  async createRun(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateImportRunDto,
    @UploadedFiles()
    uploaded:
      | { file?: Express.Multer.File[]; files?: Express.Multer.File[] }
      | undefined,
  ) {
    const storeId = await this.runs.storeIdForCreator(userId);
    // Unsupported source kinds (WC_REST) fail before the empty-bundle check.
    await this.sources.assertBundleKind(storeId, dto.source_id);
    const options = ImportRunsService.parseOptionsField(dto.options);
    const files = [...(uploaded?.file ?? []), ...(uploaded?.files ?? [])];
    if (!files.length)
      throw importError(
        'IMPORT_BUNDLE_MISSING_FILE',
        'Upload the export bundle',
      );
    return this.runs.create(storeId, userId, dto.source_id, options, files);
  }

  @Get('runs')
  async listRuns(
    @CurrentUser('id') userId: string,
    @Query() q: RunListQueryDto,
  ) {
    return this.runs.list(await this.runs.storeIdForCreator(userId), q);
  }

  @Get('runs/:id')
  async getRun(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.runs.detail(await this.runs.storeIdForCreator(userId), id);
  }

  @Get('runs/:id/items')
  async runItems(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: RunItemsQueryDto,
  ) {
    return this.runs.items(await this.runs.storeIdForCreator(userId), id, q);
  }

  @Get('runs/:id/logs')
  async runLogs(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: RunLogsQueryDto,
  ) {
    return this.runs.logs(await this.runs.storeIdForCreator(userId), id, q);
  }

  @Get('runs/:id/report.csv')
  async runReport(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: RunReportQueryDto,
  ) {
    const csv = await this.runs.reportCsv(
      await this.runs.storeIdForCreator(userId),
      id,
      q.phase,
    );
    return new StreamableFile(Buffer.from('\uFEFF' + csv), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="import-${id}.csv"`,
    });
  }

  @Put('runs/:id/options')
  @RequireApp('importer')
  async updateOptions(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Record<string, unknown>,
  ) {
    // The body is the options object itself (validated by normalizeRunOptions).
    return this.runs.updateOptions(
      await this.runs.storeIdForCreator(userId),
      id,
      body,
    );
  }

  @Post('runs/:id/confirm')
  @HttpCode(200)
  @RequireApp('importer')
  async confirm(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmRunDto,
  ) {
    return this.runs.confirm(
      await this.runs.storeIdForCreator(userId),
      userId,
      id,
      dto.plan_fingerprint,
    );
  }

  @Post('runs/:id/cancel')
  @HttpCode(200)
  @RequireApp('importer')
  async cancel(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.runs.cancel(await this.runs.storeIdForCreator(userId), id);
  }

  @Post('runs/:id/rollback')
  @HttpCode(200)
  @RequireApp('importer')
  async rollback(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.runs.rollback(
      await this.runs.storeIdForCreator(userId),
      userId,
      id,
    );
  }

  @Delete('runs/:id')
  @RequireApp('importer')
  async deleteRun(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.runs.remove(await this.runs.storeIdForCreator(userId), id);
  }
}

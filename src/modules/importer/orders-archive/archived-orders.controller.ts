import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserRole } from '@prisma/client';
import {
  CurrentUser,
  Roles,
  type RequestUser,
} from '../../../common/decorators';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { ImportRunsService } from '../runs/import-runs.service';
import { boundedBundleStorage } from '../runs/bundle-store';
import { importError } from '../importer.errors';
import {
  ORDERS_ARCHIVE_MAX_BYTES,
  OrdersArchiveService,
} from './orders-archive.service';
import {
  ArchivedOrdersListQueryDto,
  ArchivedOrdersStoreQueryDto,
  OrdersArchiveImportQueryDto,
} from './archived-orders.dto';

/**
 * Store of the archived-orders routes: a CREATOR always acts on their own
 * store (`storeId` must match when given); an ADMIN names it with `storeId`.
 */
async function resolveStore(
  runs: ImportRunsService,
  user: RequestUser,
  storeId: string | undefined,
): Promise<string> {
  if (user.role === UserRole.ADMIN) {
    if (!storeId)
      throw new BadRequestException({
        code: 'STORE_ID_REQUIRED',
        message: 'storeId is required for admins',
      });
    return storeId;
  }
  const own = await runs.storeIdForCreator(user.id);
  if (storeId && storeId !== own)
    throw new BadRequestException({
      code: 'STORE_MISMATCH',
      message: 'storeId does not match your store',
    });
  return own;
}

/**
 * Upload / import of a WooCommerce order archive (plans/wp-order-archive,
 * M70). Multipart `file` = one `.tar.gz` / `.tgz` / `.zip` of the exported
 * order tables (+ optional manifest.txt). `?dryRun=1` returns the summary
 * without writing; without it the orders are upserted and the same summary
 * is returned.
 */
@Controller('importer/orders-archive')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.CREATOR, UserRole.ADMIN)
export class OrdersArchiveImportController {
  constructor(
    private readonly runs: ImportRunsService,
    private readonly archive: OrdersArchiveService,
  ) {}

  @Post()
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: boundedBundleStorage(ORDERS_ARCHIVE_MAX_BYTES),
      limits: { fileSize: ORDERS_ARCHIVE_MAX_BYTES, files: 1 },
    }),
  )
  async importArchive(
    @CurrentUser() user: RequestUser,
    @Query() q: OrdersArchiveImportQueryDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    const storeId = await resolveStore(this.runs, user, q.storeId);
    if (!file?.buffer?.length)
      throw importError(
        'IMPORT_BUNDLE_MISSING_FILE',
        'Upload the orders archive as "file" (.tar.gz / .tgz / .zip)',
      );
    const dryRun = q.dryRun === '1' || q.dryRun === 'true';
    return this.archive.importArchive(
      storeId,
      { originalname: file.originalname, buffer: file.buffer },
      { dryRun },
    );
  }
}

/** Read side of the archive for the dashboard tab (creator own store / admin with storeId). */
@Controller('archived-orders')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.CREATOR, UserRole.ADMIN)
export class ArchivedOrdersController {
  constructor(
    private readonly runs: ImportRunsService,
    private readonly archive: OrdersArchiveService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: RequestUser,
    @Query() q: ArchivedOrdersListQueryDto,
  ) {
    const storeId = await resolveStore(this.runs, user, q.storeId);
    return this.archive.list(storeId, q);
  }

  /** `{ count, min_date, max_date }` — the dashboard shows the tab only when count > 0. */
  @Get('summary')
  async summary(
    @CurrentUser() user: RequestUser,
    @Query() q: ArchivedOrdersStoreQueryDto,
  ) {
    const storeId = await resolveStore(this.runs, user, q.storeId);
    return this.archive.summary(storeId);
  }

  @Get('export.csv')
  async exportCsv(
    @CurrentUser() user: RequestUser,
    @Query() q: ArchivedOrdersListQueryDto,
  ) {
    const storeId = await resolveStore(this.runs, user, q.storeId);
    const csv = this.archive.exportCsvStream(storeId, q);
    return new StreamableFile(csv, {
      type: 'text/csv; charset=utf-8',
      disposition: 'attachment; filename="woocommerce-orders.csv"',
    });
  }

  @Get(':id')
  async detail(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: ArchivedOrdersStoreQueryDto,
  ) {
    const storeId = await resolveStore(this.runs, user, q.storeId);
    return this.archive.detail(storeId, id);
  }
}

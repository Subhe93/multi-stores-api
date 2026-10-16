import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import { CurrentUser, RequireApp, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequireAppGuard } from '../../common/guards/require-app.guard';
import { ImportRunsService } from './runs/import-runs.service';
import { DirectoryRunDto } from './dto/run.dto';

/**
 * Admin-only server-side bundle run (the Namez run without an archive
 * dependency): the bundle is an extracted directory below
 * `IMPORTER_BUNDLE_DIR_ROOT` on the API host. The importer app must be
 * enabled for the store; everything after creation is the normal run flow
 * (the merchant reviews / confirms in the dashboard).
 */
@Controller('admin/importer/stores/:storeId')
@UseGuards(AuthGuard('jwt'), RolesGuard, RequireAppGuard)
@Roles(UserRole.ADMIN)
export class ImporterAdminController {
  constructor(private readonly runs: ImportRunsService) {}

  @Post('runs/from-directory')
  @RequireApp('importer')
  async fromDirectory(
    @CurrentUser('id') userId: string,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: DirectoryRunDto,
  ) {
    return this.runs.createFromDirectory(
      storeId,
      userId,
      dto.source_id,
      dto.directory,
      dto.options,
    );
  }
}

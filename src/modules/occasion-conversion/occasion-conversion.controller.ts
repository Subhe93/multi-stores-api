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
import { Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  ApplyConversionDto,
  ConversionInputDto,
  RollbackConversionDto,
} from './dto/occasion-conversion.dto';
import { OccasionConversionService } from './occasion-conversion.service';

/**
 * Admin-only, run from the server session for a migration (Namez Phase 1):
 * dry run → review the report → apply with its fingerprint → rollback by
 * conversion id if needed. No dashboard UI; the merchant edits the pages
 * afterwards like any other builder page.
 */
@Controller('admin/occasion-conversion/stores/:storeId')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class OccasionConversionController {
  constructor(private readonly service: OccasionConversionService) {}

  @Post('dry-run')
  dryRun(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: ConversionInputDto,
  ) {
    return this.service.dryRun(storeId, dto);
  }

  @Post('apply')
  apply(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: ApplyConversionDto,
  ) {
    return this.service.apply(storeId, dto.input, dto.fingerprint);
  }

  @Post('rollback')
  rollback(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: RollbackConversionDto,
  ) {
    return this.service.rollback(storeId, dto.conversion_id);
  }
}

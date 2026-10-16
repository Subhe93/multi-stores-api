import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { RequireApp, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  RequireAppGuard,
  type RequestWithAppStore,
} from '../../common/guards/require-app.guard';
import { appStoreId } from './designer-assets.controller';
import { PrintQueueQueryDto } from './designer-print-queue.dto';
import { DesignerPrintQueueService } from './designer-print-queue.service';

/**
 * Creator routes of the print queue (M4.2 §4.3, WP5), mounted at
 * `/api/designer/my/…`. Store owner only (JWT creator + the designer app in
 * effect for the creator's store).
 */
@Controller('designer/my')
@UseGuards(AuthGuard('jwt'), RolesGuard, RequireAppGuard)
@Roles(UserRole.CREATOR)
@RequireApp('designer')
export class DesignerPrintQueueController {
  constructor(private readonly files: DesignerPrintQueueService) {}

  /** Print queue rows (status filter, newest first). */
  @Get('print-queue')
  list(@Req() req: RequestWithAppStore, @Query() query: PrintQueueQueryDto) {
    return this.files.list(appStoreId(req), query);
  }

  /** Retry every FAILED row of the store. */
  @Post('print-queue/retry-failed')
  @HttpCode(200)
  @Throttle({ default: { limit: 6, ttl: 60000 } })
  retryFailed(@Req() req: RequestWithAppStore) {
    return this.files.retryAllFailed(appStoreId(req));
  }

  // The print download lives in DesignerOrderDesignsController (readable
  // while the app is off).

  /** Back to PENDING (attempts 0) and nudge the worker. */
  @Post('orders/:orderId/items/:itemId/regenerate')
  @HttpCode(200)
  @Throttle({ default: { limit: 6, ttl: 60000 } })
  regenerate(
    @Req() req: RequestWithAppStore,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.files.regenerateItem(appStoreId(req), orderId, itemId);
  }
}

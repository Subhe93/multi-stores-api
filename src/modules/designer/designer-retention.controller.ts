import {
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
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
import { DesignerRetentionService } from './designer-retention.service';

/**
 * Creator erasure route of the designer app (M4.2 §4.3 / §9 R5), mounted at
 * `/api/designer/my/…`. Store owner only, app in effect.
 */
@Controller('designer/my')
@UseGuards(AuthGuard('jwt'), RolesGuard, RequireAppGuard)
@Roles(UserRole.CREATOR)
@RequireApp('designer')
export class DesignerRetentionController {
  constructor(private readonly retention: DesignerRetentionService) {}

  /**
   * "Erase personal images now": photo originals, previews, print files and
   * the proof of one order item. 409 DESIGNER_PRINT_NOT_READY while a print
   * render is running.
   */
  @Post('orders/:orderId/items/:itemId/purge')
  @HttpCode(200)
  @Throttle({ default: { limit: 6, ttl: 60000 } })
  purge(
    @Req() req: RequestWithAppStore,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.retention.eraseOrderItem(appStoreId(req), orderId, itemId);
  }
}

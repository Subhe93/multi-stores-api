import { Module } from '@nestjs/common';
import { DesignerAssetsModule } from './designer-assets.module';
import { DesignerPrintQueueController } from './designer-print-queue.controller';
import { DesignerPrintQueueService } from './designer-print-queue.service';
import { DesignerRenderService } from './designer-render.service';
import { DesignerTriggersService } from './designer-triggers.service';
import {
  createDesignerRenderer,
  DESIGNER_BROWSER,
} from './render/designer-chromium.host';

/**
 * Render pipeline of the designer app (M4.2 WP5): the isolated Chromium
 * host, proof / print rendering, the DB-backed print queue worker, the
 * order triggers and the creator print-queue routes.
 *
 * Cycle-free (Prisma, PRIVATE_STORAGE and StoreAppsService are global; the
 * assets module imports nothing else), so PaymentsModule imports it for the
 * paid call sites and WP4's DesignerCoreModule can import it to bind
 * `DesignerTriggersService` to its port. Nest keeps one instance per
 * provider, so the worker interval and the browser exist once.
 */
@Module({
  imports: [DesignerAssetsModule],
  controllers: [DesignerPrintQueueController],
  providers: [
    { provide: DESIGNER_BROWSER, useFactory: () => createDesignerRenderer() },
    DesignerRenderService,
    DesignerPrintQueueService,
    DesignerTriggersService,
  ],
  exports: [
    DesignerRenderService,
    DesignerPrintQueueService,
    DesignerTriggersService,
  ],
})
export class DesignerRenderModule {}

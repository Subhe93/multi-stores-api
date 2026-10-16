import { Module } from '@nestjs/common';
import { DESIGNER_TRIGGERS_PORT } from '../../common/ports/designer-triggers.port';
import { DesignerAssetsModule } from './designer-assets.module';
import { DesignerCartService } from './designer-cart.service';
import { DesignerRenderModule } from './designer-render.module';
import {
  DesignerOrderDesignsController,
  DesignerProductsController,
  DesignerTemplatesController,
} from './designer-templates.controller';
import { DesignerTemplatesService } from './designer-templates.service';
import { DesignerTriggersService } from './designer-triggers.service';
import { DesignsController } from './designs.controller';
import { DesignsService } from './designs.service';

/**
 * Designs + commerce of the designer app (M4.2 WP4, C28): the public design
 * draft API, the creator template / product-link API, the cart/order line
 * service (`DesignerCartService`), the storefront payload block and the
 * order triggers port.
 *
 * Cycle-free core module (invoices D5 pattern): it imports only the
 * designer asset and render modules, which import nothing but globals, so
 * CartModule, OrdersModule and StorefrontModule can import it. Nest keeps
 * one instance per provider however often it is imported.
 *
 * `DESIGNER_TRIGGERS_PORT` is bound to WP5's `DesignerTriggersService`
 * (`NoopDesignerTriggers` is the stand-in for tests / a build without WP5).
 */
@Module({
  imports: [DesignerAssetsModule, DesignerRenderModule],
  controllers: [
    DesignsController,
    DesignerTemplatesController,
    DesignerProductsController,
    DesignerOrderDesignsController,
  ],
  providers: [
    DesignsService,
    DesignerCartService,
    DesignerTemplatesService,
    { provide: DESIGNER_TRIGGERS_PORT, useExisting: DesignerTriggersService },
  ],
  exports: [
    DesignsService,
    DesignerCartService,
    DesignerTemplatesService,
    DESIGNER_TRIGGERS_PORT,
  ],
})
export class DesignerCoreModule {}

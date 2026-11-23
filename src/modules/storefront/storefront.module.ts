import { Module } from '@nestjs/common';
import { StorefrontController } from './storefront.controller';
import { StorefrontService } from './storefront.service';
import { MarketsModule } from '../markets/markets.module';
import { TaxesModule } from '../taxes/taxes.module';
import { PersonalizationModule } from '../personalization/personalization.module';
import { DesignerCoreModule } from '../designer/designer-core.module';
import { EditHintTokenModule } from './edit-hint/edit-hint-token.module';
import { StorefrontEditHintController } from './edit-hint/storefront-edit-hint.controller';
import { StorefrontEditTargetService } from './edit-hint/storefront-edit-target.service';
import { StorefrontGateModule } from './storefront-gate.service';
import { ShippingModule } from '../shipping/shipping.module';

// TaxesModule has no imports of its own (no cycle); the b2b app needs the
// engine to estimate each product's rate for the company price display.
// PersonalizationModule (M4.1): product payload shaping and the
// free-shipping threshold; it imports no storefront module (no cycle).
@Module({
  imports: [
    MarketsModule,
    TaxesModule,
    PersonalizationModule,
    // M4.2: the product payload `designer` block (cycle-free core module).
    DesignerCoreModule,
    // Owner edit button: verifies the dashboard-issued edit-hint token.
    EditHintTokenModule,
    // Public gate / owner preview of non-LIVE stores (SPEC §3).
    StorefrontGateModule,
    // M161 B6: product shipping rates for JSON-LD. ShippingModule imports
    // only MarketsModule (no cycle).
    ShippingModule,
  ],
  controllers: [StorefrontController, StorefrontEditHintController],
  providers: [StorefrontService, StorefrontEditTargetService],
})
export class StorefrontModule {}

import { Module } from '@nestjs/common';
import { StorefrontController } from './storefront.controller';
import { StorefrontService } from './storefront.service';
import { MarketsModule } from '../markets/markets.module';
import { TaxesModule } from '../taxes/taxes.module';
import { PersonalizationModule } from '../personalization/personalization.module';
import { DesignerCoreModule } from '../designer/designer-core.module';

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
  ],
  controllers: [StorefrontController],
  providers: [StorefrontService],
})
export class StorefrontModule {}

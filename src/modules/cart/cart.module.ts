import { Module } from '@nestjs/common';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';
import { TaxesModule } from '../taxes/taxes.module';
import { MarketsModule } from '../markets/markets.module';
import { B2bModule } from '../b2b/b2b.module';
import { PersonalizationCoreModule } from '../../common/personalization/personalization-core.module';
import { PersonalizationModule } from '../personalization/personalization.module';
import { DesignerCoreModule } from '../designer/designer-core.module';

// PersonalizationModule (M4.1) imports no cart/order module: no cycle.
@Module({
  imports: [
    TaxesModule,
    MarketsModule,
    B2bModule,
    PersonalizationCoreModule,
    PersonalizationModule,
    // M4.2 (C28): cycle-free designer core (DesignerCartService).
    DesignerCoreModule,
  ],
  controllers: [CartController],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}

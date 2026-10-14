import { Module } from '@nestjs/common';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';
import { TaxesModule } from '../taxes/taxes.module';
import { MarketsModule } from '../markets/markets.module';
import { B2bModule } from '../b2b/b2b.module';

@Module({
  imports: [TaxesModule, MarketsModule, B2bModule],
  controllers: [CartController],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}

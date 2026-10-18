import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MarketsModule } from '../markets/markets.module';
import { TaxesModule } from '../taxes/taxes.module';
import { FeedsController, FeedsPublicController } from './feeds.controller';
import { FeedsService } from './feeds.service';

// Feeds app (M5.6): Google Merchant / Meta catalog feeds. Depends only on
// the global Prisma / StoreApps modules plus Markets (pricing, context) and
// Taxes (gross prices); neither imports anything of this module (no cycle).
@Module({
  imports: [ConfigModule, MarketsModule, TaxesModule],
  controllers: [FeedsPublicController, FeedsController],
  providers: [FeedsService],
  exports: [FeedsService],
})
export class FeedsModule {}

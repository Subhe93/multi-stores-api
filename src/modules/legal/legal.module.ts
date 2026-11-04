import { Module } from '@nestjs/common';
import { LegalService } from './legal.service';
import { LegalController } from './legal.controller';
import { StoreLegalService } from './store-legal.service';
import {
  StoreLegalCreatorController,
  StoreLegalStorefrontController,
} from './store-legal.controller';
import { MarketsModule } from '../markets/markets.module';
import { StorefrontGateModule } from '../storefront/storefront-gate.service';

// MarketsModule: `?market=` of the storefront legal reads. StorefrontGateModule:
// owner preview of a non-LIVE store. Neither imports this module (no cycle).
// PrismaModule, StoreAppsModule and RevalidationModule are @Global.
@Module({
  imports: [MarketsModule, StorefrontGateModule],
  controllers: [
    LegalController,
    StoreLegalStorefrontController,
    StoreLegalCreatorController,
  ],
  providers: [LegalService, StoreLegalService],
  exports: [LegalService, StoreLegalService],
})
export class LegalModule {}

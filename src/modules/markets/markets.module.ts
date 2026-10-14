import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MarketsController } from './markets.controller';
import { MarketsAdminController } from './markets-admin.controller';
import { MarketsPublicController } from './markets-public.controller';
import { MarketsService } from './markets.service';
import { MarketsContextService } from './markets-context.service';
import { MarketPricingService } from './market-pricing.service';
import { DomainsService } from './domains.service';
import { FxService } from './fx.service';
import { PaymentCheckService } from './payment-check.service';

// Regular (non-global) module. It depends only on the global Prisma /
// StoreApps / Revalidation / Crypto modules, so Storefront, Cart, Orders,
// Stores and Payments can import it without a cycle. PaymentCheckService
// builds its own platform Stripe client for the same reason (PaymentsModule
// imports OrdersModule, which imports this module).
@Module({
  imports: [ConfigModule],
  controllers: [
    MarketsAdminController,
    MarketsPublicController,
    MarketsController,
  ],
  providers: [
    MarketsService,
    MarketsContextService,
    MarketPricingService,
    DomainsService,
    FxService,
    PaymentCheckService,
  ],
  exports: [MarketsService, MarketsContextService, MarketPricingService],
})
export class MarketsModule {}

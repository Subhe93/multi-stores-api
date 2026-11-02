import { Module } from '@nestjs/common';
import { StoresController, AdminStoresController } from './stores.controller';
import { StoresService } from './stores.service';
import { StoreLifecycleService } from './store-lifecycle.service';
import { OrdersModule } from '../orders/orders.module';
import { MarketsModule } from '../markets/markets.module';
import { RedirectsModule } from '../redirects/redirects.module';
import { EditHintTokenModule } from '../storefront/edit-hint/edit-hint-token.module';
import { CorsModule } from '../../common/cors/cors.module';
import { StorefrontGateModule } from '../storefront/storefront-gate.service';

@Module({
  // OrdersModule: an admin store-type switch re-derives the commission split of
  // the store's unpaid orders, and that math lives in OrdersService.
  // MarketsModule: the default market is created with the store, mirrored by
  // updateLanguages, and consulted by the by-domain proxy lookup.
  // RedirectsModule: by-domain answers `redirects_version` (M4.4).
  // EditHintTokenModule: signs the storefront owner edit-hint token.
  // CorsModule: removing a custom domain drops its cached CORS answer.
  imports: [
    OrdersModule,
    MarketsModule,
    RedirectsModule,
    EditHintTokenModule,
    CorsModule,
    // GET /stores/:slug honours the owner preview of a non-LIVE store.
    StorefrontGateModule,
  ],
  controllers: [StoresController, AdminStoresController],
  providers: [StoresService, StoreLifecycleService],
  exports: [StoresService, StoreLifecycleService],
})
export class StoresModule {}

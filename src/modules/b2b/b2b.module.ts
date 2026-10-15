import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TaxesModule } from '../taxes/taxes.module';
import { B2bService } from './b2b.service';
import { B2bTaxExemptionService } from './b2b-tax-exemption.service';
import { B2bStorefrontController } from './b2b-storefront.controller';
import { B2bExemptionsController } from './b2b-exemptions.controller';
import { ViesService } from './vies/vies.service';
import { FetchViesHttpClient } from './vies/vies.client';
import { MockViesHttpClient } from './vies/vies.mock';
import { VIES_HTTP_CLIENT } from './vies/vies.types';

// StoreAppsModule and PrismaModule are @Global, so StoreAppsService and
// PrismaService inject here directly. TaxesModule imports nothing, so
// importing it cannot form a cycle. Feature modules (orders, cart,
// storefront, payments) import this module for B2bService and, since M2.5,
// B2bTaxExemptionService / ViesService. The app's settings still go through
// PUT /stores/my/apps/b2b.
@Module({
  imports: [TaxesModule],
  controllers: [B2bStorefrontController, B2bExemptionsController],
  providers: [
    B2bService,
    ViesService,
    B2bTaxExemptionService,
    {
      // VIES_MODE=mock answers locally; live and off use fetch (off never
      // reaches the transport).
      provide: VIES_HTTP_CLIENT,
      useFactory: (config: ConfigService) =>
        String(config.get<string>('VIES_MODE') ?? '')
          .trim()
          .toLowerCase() === 'mock'
          ? new MockViesHttpClient()
          : new FetchViesHttpClient(),
      inject: [ConfigService],
    },
  ],
  exports: [B2bService, ViesService, B2bTaxExemptionService],
})
export class B2bModule {}

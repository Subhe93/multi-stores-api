import { Module } from '@nestjs/common';
import { CustomerUploadsModule } from '../customer-uploads/customer-uploads.module';
import { PersonalizationCoreModule } from '../../common/personalization/personalization-core.module';
import { ShippingModule } from '../shipping/shipping.module';
import { MarketsModule } from '../markets/markets.module';
import { PersonalizationLibraryService } from './personalization-library.service';
import { PersonalizationPresetsService } from './personalization-presets.service';
import { PersonalizationRetentionPolicy } from './personalization-retention.policy';
import { PersonalizationController } from './personalization.controller';
import { PersonalizationStorefrontController } from './personalization-storefront.controller';
import { PersonalizationService } from './personalization.service';

/**
 * Personalization app (M4.1). Prisma and StoreApps are global; the other
 * imports (core, shipping, markets) import no app module, so Cart, Orders
 * and Storefront can import this one without a cycle. Exports the runtime
 * service and the presets service (the M4.4 importer calls `applyInTx`).
 * Registers the customer-upload retention policy (C23) at init.
 */
@Module({
  imports: [
    CustomerUploadsModule,
    PersonalizationCoreModule,
    ShippingModule,
    MarketsModule,
  ],
  controllers: [PersonalizationController, PersonalizationStorefrontController],
  providers: [
    PersonalizationService,
    PersonalizationPresetsService,
    PersonalizationLibraryService,
    PersonalizationRetentionPolicy,
  ],
  exports: [PersonalizationService, PersonalizationPresetsService],
})
export class PersonalizationModule {}

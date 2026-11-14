import { Module } from '@nestjs/common';
import { StoresModule } from '../stores/stores.module';
import { ConsentLogOwnerController } from './consent-log.owner.controller';
import { ConsentLogService } from './consent-log.service';
import { ConsentLogStorefrontController } from './consent-log.storefront.controller';

/**
 * Consent v2 consent log (plans/consent-v2/CONTRACT.md §5): the storefront
 * logging endpoint, the owner list / summary / export and the `consent-log`
 * retention task (RetentionModule and PrismaModule are global).
 * StoresModule: the owner routes resolve the caller's store.
 */
@Module({
  imports: [StoresModule],
  controllers: [ConsentLogStorefrontController, ConsentLogOwnerController],
  providers: [ConsentLogService],
})
export class ConsentLogModule {}

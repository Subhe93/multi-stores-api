import { Module } from '@nestjs/common';
import { ProvidersController } from './providers.controller';
import { ProvidersService } from './providers.service';
import { TraderVatCheckService } from '../stores/trader-vat-check';

@Module({
  controllers: [ProvidersController],
  // TraderVatCheckService: stateless VIES lookup shared with the store
  // trader-details form (provided here to avoid importing StoresModule).
  providers: [ProvidersService, TraderVatCheckService],
  exports: [ProvidersService],
})
export class ProvidersModule {}

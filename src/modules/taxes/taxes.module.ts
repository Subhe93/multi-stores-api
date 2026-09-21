import { Module } from '@nestjs/common';
import { TaxesController } from './taxes.controller';
import { TaxManagementService } from './tax-management.service';
import { TaxService } from './tax.service';

@Module({
  controllers: [TaxesController],
  providers: [TaxService, TaxManagementService],
  exports: [TaxService, TaxManagementService],
})
export class TaxesModule {}

import { Module } from '@nestjs/common';
import { MetaConversionsService } from './meta-conversions.service';

// Meta Conversions API (server-side Purchase). Imports nothing: Prisma and
// Crypto are global, so OrdersModule can import this module without a cycle.
@Module({
  providers: [MetaConversionsService],
  exports: [MetaConversionsService],
})
export class MetaCapiModule {}

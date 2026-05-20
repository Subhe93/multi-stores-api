import { Global, Module } from '@nestjs/common';
import { RevalidationService } from './revalidation.service';

// Global so any feature module can inject RevalidationService without wiring
// imports — mirrors how PrismaModule is exposed.
@Global()
@Module({
  providers: [RevalidationService],
  exports: [RevalidationService],
})
export class RevalidationModule {}

import { Module } from '@nestjs/common';
import { RedirectsService } from './redirects.service';
import { RedirectsPublicController } from './redirects-public.controller';
import { RedirectsCreatorController } from './redirects-creator.controller';

// Platform store redirects (M4.4). Depends only on the global Prisma and
// StoreApps modules, so Stores, Markets and the importer can import it
// without a cycle.
@Module({
  controllers: [RedirectsPublicController, RedirectsCreatorController],
  providers: [RedirectsService],
  exports: [RedirectsService],
})
export class RedirectsModule {}

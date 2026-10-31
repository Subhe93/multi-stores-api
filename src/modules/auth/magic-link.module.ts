import { Module } from '@nestjs/common';
import { MagicLinkService } from './magic-link.service';
import { AccountLinksService } from './account-links.service';
import { AccountCredentialsService } from './account-credentials.service';

// Shared by auth, admin users and the Kustom checkout (each creates accounts
// and mails their credentials). PrismaModule, MailModule and StoreAppsModule
// are @Global, so no imports are needed here.
@Module({
  providers: [MagicLinkService, AccountLinksService, AccountCredentialsService],
  exports: [MagicLinkService, AccountLinksService, AccountCredentialsService],
})
export class MagicLinkModule {}

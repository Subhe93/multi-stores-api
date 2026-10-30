import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  ZohoMailController,
  ZohoMailOAuthController,
  ZohoMailPurgeController,
} from './zoho-mail.controller';
import { ZohoMailService } from './zoho-mail.service';

// Zoho Mail app. Uses the global Prisma / Crypto / StoreApps / Mail modules;
// it registers itself with MailService as a store mail provider, so the mail
// module never imports this one (no cycle).
@Module({
  imports: [ConfigModule],
  controllers: [
    ZohoMailController,
    ZohoMailPurgeController,
    ZohoMailOAuthController,
  ],
  providers: [ZohoMailService],
  exports: [ZohoMailService],
})
export class ZohoMailModule {}

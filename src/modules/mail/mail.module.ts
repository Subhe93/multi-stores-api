import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MailService } from './mail.service';
import { MailController, StoreMailController } from './mail.controller';

// Global so any module can inject MailService without re-importing.
@Global()
@Module({
  imports: [ConfigModule],
  controllers: [MailController, StoreMailController],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}

import { Global, Module } from '@nestjs/common';
import { NotificationTemplatesService } from './notification-templates.service';
import { NotificationTemplatesController } from './notification-templates.controller';

// Global so the MailService can inject NotificationTemplatesService directly
// (and other modules could reuse it for in-app notifications later).
@Global()
@Module({
  controllers: [NotificationTemplatesController],
  providers: [NotificationTemplatesService],
  exports: [NotificationTemplatesService],
})
export class NotificationTemplatesModule {}

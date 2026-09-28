import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '@nestjs/passport';
import { MailService } from './mail.service';
import {
  UpdateSmtpSettingsDto,
  UpdateStoreSmtpSettingsDto,
  UpdateStoreNotificationsDto,
  EmailLogQueryDto,
  SendTestEmailDto,
  TemplateSampleDto,
} from './dto/mail.dto';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller('mail/admin')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class MailController {
  constructor(private mailService: MailService) {}

  @Get('settings')
  getSettings() {
    return this.mailService.getAdminSettings();
  }

  @Put('settings')
  updateSettings(@Body() dto: UpdateSmtpSettingsDto) {
    return this.mailService.updateAdminSettings(dto);
  }

  // Send a test email to the given address, or to the admin's own email.
  @Post('test')
  sendTest(
    @Body() dto: SendTestEmailDto,
    @CurrentUser('email') adminEmail: string,
  ) {
    return this.mailService.sendTest(dto.to || adminEmail);
  }

  // Delivery log of every store and of the platform itself.
  @Get('logs')
  listLogs(@Query() query: EmailLogQueryDto) {
    return this.mailService.listLogs(query);
  }

  // A platform template rendered with sample data (the editor's live preview).
  @Post('templates/:event/preview')
  previewTemplate(
    @Param('event') event: string,
    @Body() dto: TemplateSampleDto,
  ) {
    return this.mailService.renderTemplateSample({ event, ...dto });
  }

  @Post('templates/:event/test')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  testTemplate(
    @Param('event') event: string,
    @Body() dto: TemplateSampleDto,
    @CurrentUser('email') adminEmail: string,
  ) {
    return this.mailService.sendTemplateTest(
      { event, ...dto },
      dto.to || adminEmail,
    );
  }
}

/**
 * The creator's own sender, for independent stores. Every method resolves the
 * caller's store itself — no store id is accepted from the client — and refuses
 * marketplace stores, which always send through the platform.
 */
@Controller('mail/store')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.CREATOR)
export class StoreMailController {
  constructor(private mailService: MailService) {}

  @Get('settings')
  getSettings(@CurrentUser('id') userId: string) {
    return this.mailService.getStoreSettings(userId);
  }

  @Put('settings')
  updateSettings(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateStoreSmtpSettingsDto,
  ) {
    return this.mailService.updateStoreSettings(userId, dto);
  }

  @Post('test')
  sendTest(
    @CurrentUser('id') userId: string,
    @CurrentUser('email') creatorEmail: string,
    @Body() dto: SendTestEmailDto,
  ) {
    return this.mailService.sendStoreTest(userId, dto.to || creatorEmail);
  }

  // The two below serve every store type: a marketplace store has no sender
  // of its own, but it still receives order notifications.

  @Get('logs')
  listLogs(
    @CurrentUser('id') userId: string,
    @Query() query: EmailLogQueryDto,
  ) {
    return this.mailService.listStoreLogs(userId, query);
  }

  @Get('notifications')
  getNotifications(@CurrentUser('id') userId: string) {
    return this.mailService.getStoreNotifications(userId);
  }

  @Put('notifications')
  updateNotifications(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateStoreNotificationsDto,
  ) {
    return this.mailService.updateStoreNotifications(userId, dto);
  }

  // The store's template rendered with its newest order's products.
  @Post('templates/:event/preview')
  previewTemplate(
    @CurrentUser('id') userId: string,
    @Param('event') event: string,
    @Body() dto: TemplateSampleDto,
  ) {
    return this.mailService.renderStoreTemplateSample(userId, {
      event,
      ...dto,
    });
  }

  // Always delivered to the store's own notifications address (or the login
  // email when none is set): the content is free HTML, so it must not be
  // sendable to arbitrary addresses.
  @Post('templates/:event/test')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  testTemplate(
    @CurrentUser('id') userId: string,
    @Param('event') event: string,
    @Body() dto: TemplateSampleDto,
  ) {
    return this.mailService.sendStoreTemplateTest(userId, { event, ...dto });
  }
}

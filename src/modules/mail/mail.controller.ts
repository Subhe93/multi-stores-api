import { Controller, Get, Put, Post, Body, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { MailService } from './mail.service';
import {
  UpdateSmtpSettingsDto,
  UpdateStoreSmtpSettingsDto,
  SendTestEmailDto,
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
}

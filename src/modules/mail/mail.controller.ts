import { Controller, Get, Put, Post, Body, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { MailService } from './mail.service';
import { UpdateSmtpSettingsDto, SendTestEmailDto } from './dto/mail.dto';
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

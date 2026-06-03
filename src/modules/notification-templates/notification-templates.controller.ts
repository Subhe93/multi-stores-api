import { Controller, Get, Put, Param, Body, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { NotificationTemplatesService } from './notification-templates.service';
import { UpdateNotificationTemplateDto } from './dto/notification-template.dto';
import { Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller('notification-templates/admin')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class NotificationTemplatesController {
  constructor(private templates: NotificationTemplatesService) {}

  @Get()
  list() {
    return this.templates.list();
  }

  // Event catalog (event keys + variables) — used by the dashboard to render
  // the available events list and per-event variable hints dynamically.
  @Get('events')
  events() {
    return this.templates.events();
  }

  @Get(':event')
  getByEvent(@Param('event') event: string) {
    return this.templates.getByEvent(event);
  }

  @Put(':event')
  update(
    @Param('event') event: string,
    @Body() dto: UpdateNotificationTemplateDto,
  ) {
    return this.templates.update(event, dto);
  }
}

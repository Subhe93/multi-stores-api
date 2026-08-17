import { Controller, Get, Put, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { NotificationTemplatesService } from './notification-templates.service';
import { UpdateNotificationTemplateDto } from './dto/notification-template.dto';
import { CurrentUser, Roles } from '../../common/decorators';
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

/**
 * A creator's own overrides for their independent store. The store is resolved
 * from the caller, never taken from the request, and marketplace stores are
 * refused since their customers always receive the platform templates.
 */
@Controller('notification-templates/store')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.CREATOR)
export class StoreNotificationTemplatesController {
  constructor(private templates: NotificationTemplatesService) {}

  @Get()
  list(@CurrentUser('id') userId: string) {
    return this.templates.listForStore(userId);
  }

  // Same catalog the admin editor uses, so the variable chips stay in sync.
  @Get('events')
  events() {
    return this.templates.events();
  }

  @Get(':event')
  getByEvent(@CurrentUser('id') userId: string, @Param('event') event: string) {
    return this.templates.getForStore(userId, event);
  }

  @Put(':event')
  update(
    @CurrentUser('id') userId: string,
    @Param('event') event: string,
    @Body() dto: UpdateNotificationTemplateDto,
  ) {
    return this.templates.updateForStore(userId, event, dto);
  }

  /** Revert to the platform template. */
  @Delete(':event')
  reset(@CurrentUser('id') userId: string, @Param('event') event: string) {
    return this.templates.resetForStore(userId, event);
  }
}

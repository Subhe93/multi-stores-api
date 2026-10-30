import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { UserRole } from '@prisma/client';
import { CurrentUser, RequireApp, Roles } from '../../common/decorators';
import type { RequestUser } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequireAppGuard } from '../../common/guards/require-app.guard';
import {
  ZohoClientDto,
  ZohoTestDto,
  ZohoUpdateSenderDto,
} from './dto/zoho-mail.dto';
import { ZohoMailService, type ZohoCallbackQuery } from './zoho-mail.service';

/** Creator routes of the Zoho Mail app (independent store + app enabled). */
@Controller('stores/my/zoho-mail')
@UseGuards(AuthGuard('jwt'), RolesGuard, RequireAppGuard)
@Roles(UserRole.CREATOR)
@RequireApp('zoho_mail')
export class ZohoMailController {
  constructor(private readonly zoho: ZohoMailService) {}

  @Get()
  status(@CurrentUser() user: RequestUser) {
    return this.zoho.status(user.id);
  }

  /** Save the store's own Zoho OAuth client (secret optional on update). */
  @Put('client')
  saveClient(@CurrentUser() user: RequestUser, @Body() dto: ZohoClientDto) {
    return this.zoho.saveClient(user.id, dto);
  }

  /** Authorize URL for the saved client (body {}). */
  @Post('connect')
  connect(@CurrentUser() user: RequestUser) {
    return this.zoho.connect(user.id);
  }

  @Put()
  update(@CurrentUser() user: RequestUser, @Body() dto: ZohoUpdateSenderDto) {
    return this.zoho.updateSender(user.id, dto);
  }

  @Post('refresh-addresses')
  refreshAddresses(@CurrentUser() user: RequestUser) {
    return this.zoho.refreshAddresses(user.id);
  }

  @Post('test')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  test(@CurrentUser() user: RequestUser, @Body() dto: ZohoTestDto) {
    return this.zoho.sendTest(user.id, dto.to);
  }
}

/**
 * Purge route, deliberately WITHOUT RequireAppGuard: a creator must always be
 * able to revoke and remove the stored credentials, even after the app was
 * disabled or made unavailable. The service still requires the caller's own
 * INDEPENDENT store.
 */
@Controller('stores/my/zoho-mail')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.CREATOR)
export class ZohoMailPurgeController {
  constructor(private readonly zoho: ZohoMailService) {}

  /** Drops token + client; `?keep_client=1` keeps the client. */
  @Delete()
  disconnect(
    @CurrentUser() user: RequestUser,
    @Query('keep_client') keepClient?: string,
  ) {
    return this.zoho.disconnect(
      user.id,
      keepClient === '1' || keepClient === 'true',
    );
  }
}

/** Public OAuth redirect target; always answers with a 302 to the dashboard. */
@Controller('zoho-mail/oauth')
export class ZohoMailOAuthController {
  constructor(private readonly zoho: ZohoMailService) {}

  @Get('callback')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async callback(
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ): Promise<void> {
    const pick = (k: string) =>
      typeof query[k] === 'string' ? query[k] : undefined;
    const input: ZohoCallbackQuery = {
      code: pick('code'),
      state: pick('state'),
      error: pick('error'),
      'accounts-server': pick('accounts-server'),
      location: pick('location'),
    };
    const target = await this.zoho.handleCallback(input);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(302, target);
  }
}

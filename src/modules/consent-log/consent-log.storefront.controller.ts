import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { clientIp } from '../../common/security/signup-rate-limit';
import { LogConsentDto } from './dto/consent-log.dto';
import { ConsentLogService } from './consent-log.service';

/**
 * `POST /storefront/:slug/consent`: the storefront logs every cookie
 * decision (consent v2 §5.2). Public (no cookies, `credentials: 'omit'`),
 * throttled per IP by the global ThrottlerGuard at 20/min. Answers 204;
 * 400 validation, 404 unknown store, 429 throttle.
 */
@Controller('storefront')
export class ConsentLogStorefrontController {
  constructor(private readonly consentLog: ConsentLogService) {}

  @Post(':slug/consent')
  @HttpCode(204)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async log(
    @Param('slug') slug: string,
    @Body() dto: LogConsentDto,
    @Req() req: Request,
  ): Promise<void> {
    const ua: string | string[] | undefined = req.headers?.['user-agent'];
    await this.consentLog.record(slug, dto, {
      ip: clientIp(req),
      userAgent: typeof ua === 'string' ? ua : ua?.[0],
    });
  }
}

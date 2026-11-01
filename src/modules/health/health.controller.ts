import { Controller, Get, Header } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

/**
 * Liveness probe: `GET /api/health`. No database access, so it answers as
 * long as the process serves HTTP. Used by deploy checks and by the
 * storefront proxy to tell "API down" (maintenance page, 503) from "store
 * not found" (404). Never throttled: the storefront probes it every few
 * seconds from one IP.
 */
@Controller('health')
@SkipThrottle()
export class HealthController {
  @Get()
  @Header('Cache-Control', 'no-store')
  check() {
    return { status: 'ok' };
  }
}

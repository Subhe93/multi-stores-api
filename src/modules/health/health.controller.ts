import { Controller, Get, Header, Optional } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  StorageHealthService,
  type StorageHealth,
} from '../storage/storage-health.service';

/**
 * Liveness probe: `GET /api/health`. No database access, so it answers as
 * long as the process serves HTTP. Used by deploy checks and by the
 * storefront proxy to tell "API down" (maintenance page, 503) from "store
 * not found" (404). Never throttled: the storefront probes it every few
 * seconds from one IP. `storage` reports the bucket reachability of the
 * media and private roles (HeadBucket, cached 60 s; always `ok` on local
 * disk) without failing the probe.
 */
@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(
    @Optional() private readonly storageHealth?: StorageHealthService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async check(): Promise<{ status: 'ok'; storage?: StorageHealth }> {
    if (!this.storageHealth) return { status: 'ok' };
    try {
      return { status: 'ok', storage: await this.storageHealth.check() };
    } catch {
      return { status: 'ok' };
    }
  }
}

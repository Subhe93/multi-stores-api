import { Module } from '@nestjs/common';
import { applyWorkersEnv } from '../../common/ops/workers-env';
import { OpsController } from './ops.controller';
import { OpsStatusService } from './ops-status.service';
import { OpsService } from './ops.service';

// `WORKERS=...` is expanded into the per-worker flags at module load, i.e.
// before any scheduler's onModuleInit reads its own flag.
applyWorkersEnv(process.env);

/**
 * Operability (M5 W1-C): `GET /admin/ops/status`, the job tick sink, the
 * quota / tick purge tasks and the production env guard.
 */
@Module({
  controllers: [OpsController],
  providers: [OpsService, OpsStatusService],
})
export class OpsModule {}

import { Module } from '@nestjs/common';
import { BackupSchedulerService } from './backup-scheduler.service';
import { BackupsController } from './backups.controller';
import { BackupsService } from './backups.service';

@Module({
  controllers: [BackupsController],
  providers: [BackupsService, BackupSchedulerService],
  exports: [BackupsService],
})
export class BackupsModule {}

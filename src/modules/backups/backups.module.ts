import { Module } from '@nestjs/common';
import { BackupSchedulerService } from './backup-scheduler.service';
import { BackupsController } from './backups.controller';
import { BackupsService } from './backups.service';
import { BackupOffsiteService } from './offsite/backup-offsite.service';
import { backupObjectSinkProvider } from './offsite/backup-sink.provider';

@Module({
  controllers: [BackupsController],
  providers: [
    backupObjectSinkProvider,
    BackupOffsiteService,
    BackupsService,
    BackupSchedulerService,
  ],
  exports: [BackupsService, BackupOffsiteService],
})
export class BackupsModule {}

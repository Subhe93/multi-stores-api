import { Logger, Provider } from '@nestjs/common';
import {
  BACKUP_OBJECT_SINK,
  BackupObjectSink,
  NoopBackupObjectSink,
} from './backup-object-sink';
import {
  S3BackupObjectSink,
  s3BackupSinkConfigFromEnv,
} from './s3-backup-sink';

/**
 * Picks the sink from the environment: the S3 sink whenever
 * `S3_BACKUP_BUCKET` is set (also while `STORAGE_DRIVER=local`: Phase 1
 * ships before the storage switch), the no-op sink otherwise. The env is
 * parsed by the storage core (`parseStorageConfig`), so both read it
 * identically. Booleans only in the log line, never credentials.
 */
export function createBackupObjectSink(
  env: NodeJS.ProcessEnv = process.env,
  logger: Pick<Logger, 'log' | 'warn'> = new Logger('BackupObjectSink'),
): BackupObjectSink {
  const config = s3BackupSinkConfigFromEnv(env);
  if (!config) {
    if ((env.STORAGE_DRIVER ?? 'local').toLowerCase() === 's3') {
      logger.warn(
        'STORAGE_DRIVER=s3 but S3_BACKUP_BUCKET is empty: backups stay local only',
      );
    } else {
      logger.log('Offsite backups off (S3_BACKUP_BUCKET not set)');
    }
    return new NoopBackupObjectSink();
  }
  logger.log(
    `Offsite backups → s3://${config.bucket}/${config.keyPrefix ?? ''} (region=${config.region ?? 'default'}, kms=${!!config.kmsKeyId}, object_lock=${!!config.objectLock}, endpoint=${!!config.endpoint}, backup_credentials=${!!config.credentials})`,
  );
  return new S3BackupObjectSink(config);
}

export const backupObjectSinkProvider: Provider = {
  provide: BACKUP_OBJECT_SINK,
  useFactory: () => createBackupObjectSink(),
};

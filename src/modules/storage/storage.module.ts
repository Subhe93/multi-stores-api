/**
 * Global storage module: resolves the three bucket roles by `STORAGE_DRIVER`
 * (local → `LocalObjectStorage` rooted at `<cwd>/uploads`, `PRIVATE_STORAGE_DIR`
 * and `BACKUP_DIR`; s3 → `S3ObjectStorage` per role (bucket + key prefix:
 * one bucket may hold all three roles under `media/`, `private/`,
 * `backups/`), media wrapped in `DualReadObjectStorage` while
 * `MEDIA_LOCAL_FALLBACK` is on) and exposes `PublicStorage` +
 * `StorageHealthService`. The `PrivateStorage` and `InvoiceStorage` adapters
 * are bound by their own modules over `PRIVATE_OBJECT_STORAGE`.
 */
import { Global, Module, type Provider } from '@nestjs/common';
import { DualReadObjectStorage } from './dual-read-object-storage';
import { LocalObjectStorage } from './local-object-storage';
import type { ObjectStorage } from './object-storage';
import { PublicStorage } from './public-storage';
import { createS3Client, S3ObjectStorage } from './s3-object-storage';
import { StorageHealthService } from './storage-health.service';
import { parseStorageConfig, type StorageConfig } from './storage.config';
import {
  BACKUP_OBJECT_STORAGE,
  MEDIA_STORAGE,
  PRIVATE_OBJECT_STORAGE,
  STORAGE_CONFIG,
} from './storage.tokens';

/** Builds the three stores from a config (also used by scripts and specs). */
export function buildObjectStorages(
  cfg: StorageConfig,
  client?: ReturnType<typeof createS3Client>,
): { media: ObjectStorage; priv: ObjectStorage; backup: ObjectStorage } {
  const localMedia = new LocalObjectStorage({
    root: cfg.local.uploadsDir,
    keyPrefix: 'uploads/',
  });
  const localPrivate = new LocalObjectStorage({
    root: cfg.local.privateDir,
    fileMode: 0o600,
  });
  const localBackup = new LocalObjectStorage({
    root: cfg.local.backupsDir,
    fileMode: 0o600,
  });
  const needsClient = cfg.driver === 's3' || cfg.backupDriver === 's3';
  const s3 =
    needsClient && !client
      ? createS3Client({
          region: cfg.region!,
          endpoint: cfg.endpoint ?? undefined,
          forcePathStyle: cfg.forcePathStyle ?? undefined,
        })
      : client;
  // The backup bucket may be written with its own key (BACKUP_AWS_*) when
  // the API key has no access to it (INFRA.md §5.2); with one shared bucket
  // the API key is used. A client passed in (tests, scripts) serves every
  // role.
  const backupClient =
    cfg.backupDriver === 's3' && !client && cfg.backupCredentials
      ? createS3Client({
          region: cfg.region!,
          endpoint: cfg.endpoint ?? undefined,
          forcePathStyle: cfg.forcePathStyle ?? undefined,
          credentials: cfg.backupCredentials,
        })
      : s3;

  let media: ObjectStorage = localMedia;
  let priv: ObjectStorage = localPrivate;
  if (cfg.driver === 's3') {
    const s3Media = new S3ObjectStorage({
      client: s3!,
      bucket: cfg.mediaBucket!,
      role: 'media',
      keyPrefix: cfg.mediaPrefix,
      deleteMode: cfg.deleteMode,
    });
    media = cfg.mediaLocalFallback
      ? new DualReadObjectStorage(s3Media, localMedia)
      : s3Media;
    priv = new S3ObjectStorage({
      client: s3!,
      bucket: cfg.privateBucket!,
      role: 'private',
      keyPrefix: cfg.privatePrefix,
      kmsKeyId: cfg.kmsKeyId ?? undefined,
      deleteMode: cfg.deleteMode,
    });
  }
  const backup: ObjectStorage =
    cfg.backupDriver === 's3'
      ? new S3ObjectStorage({
          client: backupClient!,
          bucket: cfg.backupBucket!,
          role: 'backup',
          keyPrefix: cfg.backupPrefix,
          kmsKeyId: cfg.kmsKeyId ?? undefined,
          deleteMode: cfg.deleteMode,
        })
      : localBackup;
  return { media, priv, backup };
}

const STORAGES = Symbol('STORAGES');
type Storages = ReturnType<typeof buildObjectStorages>;

const providers: Provider[] = [
  { provide: STORAGE_CONFIG, useFactory: () => parseStorageConfig() },
  {
    provide: STORAGES,
    inject: [STORAGE_CONFIG],
    useFactory: (cfg: StorageConfig) => buildObjectStorages(cfg),
  },
  {
    provide: MEDIA_STORAGE,
    inject: [STORAGES],
    useFactory: (s: Storages) => s.media,
  },
  {
    provide: PRIVATE_OBJECT_STORAGE,
    inject: [STORAGES],
    useFactory: (s: Storages) => s.priv,
  },
  {
    provide: BACKUP_OBJECT_STORAGE,
    inject: [STORAGES],
    useFactory: (s: Storages) => s.backup,
  },
  PublicStorage,
  StorageHealthService,
];

@Global()
@Module({
  providers,
  exports: [
    STORAGE_CONFIG,
    MEDIA_STORAGE,
    PRIVATE_OBJECT_STORAGE,
    BACKUP_OBJECT_STORAGE,
    PublicStorage,
    StorageHealthService,
  ],
})
export class StorageModule {}

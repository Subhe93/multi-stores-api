import { Global, Module } from '@nestjs/common';
import { PRIVATE_STORAGE, PrivateFileStorage } from './private-file-storage';
import type { ObjectStorage } from '../../modules/storage/object-storage';
import { S3PrivateStorage } from '../../modules/storage/s3-private-storage';
import type { StorageConfig } from '../../modules/storage/storage.config';
import {
  PRIVATE_OBJECT_STORAGE,
  STORAGE_CONFIG,
} from '../../modules/storage/storage.tokens';

/**
 * Binds the platform private storage (C10) once for the whole app, so
 * customer uploads (M4.0), the designer (M4.2) and the importer (M4.4) share
 * one root (`PRIVATE_STORAGE_DIR`, default `<cwd>/storage`). With
 * `STORAGE_DRIVER=s3` the same keys live in the private bucket
 * (`S3PrivateStorage` over `PRIVATE_OBJECT_STORAGE`).
 */
@Global()
@Module({
  providers: [
    {
      provide: PRIVATE_STORAGE,
      inject: [STORAGE_CONFIG, PRIVATE_OBJECT_STORAGE],
      useFactory: (cfg: StorageConfig, objects: ObjectStorage) =>
        cfg.driver === 's3'
          ? new S3PrivateStorage(objects)
          : new PrivateFileStorage(),
    },
  ],
  exports: [PRIVATE_STORAGE],
})
export class PrivateStorageModule {}

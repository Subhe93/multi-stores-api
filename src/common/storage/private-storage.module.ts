import { Global, Module } from '@nestjs/common';
import { PRIVATE_STORAGE, PrivateFileStorage } from './private-file-storage';

/**
 * Binds the platform private storage (C10) once for the whole app, so
 * customer uploads (M4.0), the designer (M4.2) and the importer (M4.4) share
 * one root (`PRIVATE_STORAGE_DIR`, default `<cwd>/storage`).
 */
@Global()
@Module({
  providers: [
    { provide: PRIVATE_STORAGE, useFactory: () => new PrivateFileStorage() },
  ],
  exports: [PRIVATE_STORAGE],
})
export class PrivateStorageModule {}

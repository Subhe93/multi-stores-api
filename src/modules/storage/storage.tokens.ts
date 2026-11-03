/** Nest injection tokens of the storage module (no runtime deps, safe to import anywhere). */
export const STORAGE_CONFIG = Symbol('STORAGE_CONFIG');
/** Public media objects (`uploads/<folder>/<file>`). */
export const MEDIA_STORAGE = Symbol('MEDIA_STORAGE');
/** Private objects: customer originals, designer files, importer bundles, invoices. */
export const PRIVATE_OBJECT_STORAGE = Symbol('PRIVATE_OBJECT_STORAGE');
/** Offsite backups (`db/`, `files/`, `manifests/`). */
export const BACKUP_OBJECT_STORAGE = Symbol('BACKUP_OBJECT_STORAGE');

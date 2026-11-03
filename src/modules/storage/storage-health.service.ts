/**
 * Bucket reachability per role, cached 60 s, for `GET /api/health` and the
 * startup check. The probe is `HeadBucket` first and, when the key may not
 * call it (403), `ListObjectsV2 MaxKeys=1` on the role prefix; the answer
 * records which one succeeded (`probe: 'head' | 'list'`). GetBucketLocation
 * is never called. In local mode every role answers `ok` without touching
 * the disk. Logs carry booleans, bucket names and prefixes only.
 */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ObjectStorage } from './object-storage';
import { S3ObjectStorage, type BucketProbe } from './s3-object-storage';
import { DualReadObjectStorage } from './dual-read-object-storage';
import {
  BACKUP_OBJECT_STORAGE,
  MEDIA_STORAGE,
  PRIVATE_OBJECT_STORAGE,
  STORAGE_CONFIG,
} from './storage.tokens';
import { describeStorageConfig, type StorageConfig } from './storage.config';

export const STORAGE_HEALTH_CACHE_MS = 60_000;

export type StorageRoleHealth = 'ok' | 'fail';

export interface StorageHealth {
  driver: 'local' | 's3';
  media: StorageRoleHealth;
  private: StorageRoleHealth;
  backup?: StorageRoleHealth;
  /** Which probe answered per role (absent for a local role or a failure). */
  probe: {
    media?: BucketProbe;
    private?: BucketProbe;
    backup?: BucketProbe;
  };
}

function s3Of(storage: ObjectStorage): S3ObjectStorage | null {
  if (storage instanceof S3ObjectStorage) return storage;
  if (storage instanceof DualReadObjectStorage) return s3Of(storage.primary);
  return null;
}

@Injectable()
export class StorageHealthService implements OnModuleInit {
  private readonly logger = new Logger(StorageHealthService.name);
  private cached: { at: number; value: StorageHealth } | null = null;
  private inflight: Promise<StorageHealth> | null = null;
  /** Clock (specs replace it). */
  now: () => number = Date.now;

  constructor(
    @Inject(STORAGE_CONFIG) private readonly config: StorageConfig,
    @Inject(MEDIA_STORAGE) private readonly media: ObjectStorage,
    @Inject(PRIVATE_OBJECT_STORAGE) private readonly priv: ObjectStorage,
    @Inject(BACKUP_OBJECT_STORAGE) private readonly backup: ObjectStorage,
  ) {}

  /**
   * Startup: in s3 mode (or with an S3 backup bucket) one probe per role;
   * a media/private failure (network, 404, a refused list) is logged and,
   * with STORAGE_STRICT_STARTUP, refuses to start. A refused HeadBucket
   * alone is not a failure: the list probe covers it. The backup bucket is
   * best-effort: its failure only warns (offsite copies record
   * `offsite_error`, the watchdog alerts), because the API key may lack
   * access to it by design and serving must not depend on it.
   */
  async onModuleInit(): Promise<void> {
    this.logger.log(
      `storage ${JSON.stringify(describeStorageConfig(this.config))}`,
    );
    if (this.config.driver !== 's3' && this.config.backupDriver !== 's3') {
      return;
    }
    const health = await this.check(true);
    if (health.backup === 'fail') {
      this.logger.warn(
        'storage: bucket probe failed for backup; offsite backups will record offsite_error until the bucket/credentials (BACKUP_AWS_*) are fixed',
      );
    }
    const failed = (['media', 'private'] as const).filter(
      (r) => health[r] === 'fail',
    );
    if (failed.length === 0) {
      this.logger.log(
        `storage: buckets reachable (probe ${JSON.stringify(health.probe)})`,
      );
      return;
    }
    const line = `storage: bucket probe failed for ${failed.join(', ')} (driver=${this.config.driver})`;
    if (this.config.strictStartup) {
      this.logger.error(`${line}; refusing to start (STORAGE_STRICT_STARTUP)`);
      throw new Error(line);
    }
    this.logger.warn(`${line}; continuing (STORAGE_STRICT_STARTUP=false)`);
  }

  /** Cached health (60 s); `force` bypasses the cache. */
  async check(force = false): Promise<StorageHealth> {
    const now = this.now();
    if (
      !force &&
      this.cached &&
      now - this.cached.at < STORAGE_HEALTH_CACHE_MS
    ) {
      return this.cached.value;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.probe().then(
      (value) => {
        this.cached = { at: this.now(), value };
        this.inflight = null;
        return value;
      },
      (err) => {
        this.inflight = null;
        throw err;
      },
    );
    return this.inflight;
  }

  private async probe(): Promise<StorageHealth> {
    const [media, priv, backup] = await Promise.all([
      this.probeOne(this.media, 'media'),
      this.probeOne(this.priv, 'private'),
      this.probeOne(this.backup, 'backup'),
    ]);
    const out: StorageHealth = {
      driver: this.config.driver,
      media: media.status,
      private: priv.status,
      probe: {},
    };
    if (media.probe) out.probe.media = media.probe;
    if (priv.probe) out.probe.private = priv.probe;
    if (this.config.backupDriver === 's3') {
      out.backup = backup.status;
      if (backup.probe) out.probe.backup = backup.probe;
    }
    return out;
  }

  private async probeOne(
    storage: ObjectStorage,
    role: string,
  ): Promise<{ status: StorageRoleHealth; probe?: BucketProbe }> {
    const s3 = s3Of(storage);
    if (!s3) return { status: 'ok' };
    try {
      const probe = await s3.probe();
      return { status: 'ok', probe };
    } catch (err) {
      this.logger.warn(
        `storage: probe of ${role} (${s3.location}) failed: ${
          err instanceof Error ? err.name : 'error'
        }`,
      );
      return { status: 'fail' };
    }
  }
}

/**
 * Dual-read media storage for the migration window (`MEDIA_LOCAL_FALLBACK`):
 * reads (`get`/`head`/`exists`) try S3 first and fall back to the local tree
 * on a miss; writes go to S3 only; deletes go to both (the local file goes
 * even when S3 refuses the delete); `list` is S3 only.
 */
import type {
  DeleteObjectResult,
  GetObjectOptions,
  ListObjectsOptions,
  ListObjectsResult,
  ObjectBody,
  ObjectHead,
  ObjectStorage,
  PutObjectOptions,
  PutObjectResult,
} from './object-storage';
import type { Readable } from 'stream';

export class DualReadObjectStorage implements ObjectStorage {
  readonly driver = 's3' as const;

  constructor(
    readonly primary: ObjectStorage,
    readonly fallback: ObjectStorage,
  ) {}

  get location(): string {
    return this.primary.location;
  }

  put(
    key: string,
    body: Buffer | Readable,
    opts: PutObjectOptions,
  ): Promise<PutObjectResult> {
    return this.primary.put(key, body, opts);
  }

  /** A range the primary cannot satisfy throws there (the object exists in S3). */
  async get(key: string, opts?: GetObjectOptions): Promise<ObjectBody | null> {
    return (await this.primary.get(key, opts)) ?? this.fallback.get(key, opts);
  }

  async head(key: string): Promise<ObjectHead | null> {
    return (await this.primary.head(key)) ?? this.fallback.head(key);
  }

  /**
   * Both sides are asked; the local delete happens even when S3 refuses
   * (`denied`/`skipped`). Deleted when either side removed something; else
   * the primary's reason wins over a plain `missing`.
   */
  async delete(key: string): Promise<DeleteObjectResult> {
    const [a, b] = await Promise.all([
      this.primary.delete(key),
      this.fallback.delete(key),
    ]);
    if (a.deleted || b.deleted) return { deleted: true };
    return a.reason && a.reason !== 'missing' ? a : b;
  }

  async exists(key: string): Promise<boolean> {
    return (await this.primary.exists(key)) || this.fallback.exists(key);
  }

  list(prefix: string, opts?: ListObjectsOptions): Promise<ListObjectsResult> {
    return this.primary.list(prefix, opts);
  }
}

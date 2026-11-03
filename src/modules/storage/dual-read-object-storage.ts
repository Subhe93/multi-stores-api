/**
 * Dual-read media storage for the migration window (`MEDIA_LOCAL_FALLBACK`):
 * reads (`get`/`head`/`exists`) try S3 first and fall back to the local tree
 * on a miss; writes go to S3 only; deletes go to both; `list` is S3 only.
 */
import type {
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

  async get(key: string): Promise<ObjectBody | null> {
    return (await this.primary.get(key)) ?? this.fallback.get(key);
  }

  async head(key: string): Promise<ObjectHead | null> {
    return (await this.primary.head(key)) ?? this.fallback.head(key);
  }

  async delete(key: string): Promise<boolean> {
    const [a, b] = await Promise.all([
      this.primary.delete(key),
      this.fallback.delete(key),
    ]);
    return a || b;
  }

  async exists(key: string): Promise<boolean> {
    return (await this.primary.exists(key)) || this.fallback.exists(key);
  }

  list(prefix: string, opts?: ListObjectsOptions): Promise<ListObjectsResult> {
    return this.primary.list(prefix, opts);
  }
}

import { Readable } from 'stream';
import type {
  BackupObjectSink,
  BackupSinkGet,
  BackupSinkHead,
  BackupSinkObject,
  BackupSinkPutOptions,
  BackupSinkPutResult,
} from './backup-object-sink';
import { SHA256_METADATA_KEY } from './backup-object-sink';

interface StoredObject {
  body: Buffer;
  contentType: string;
  metadata: Record<string, string>;
  lastModified: Date;
  etag: string;
}

/**
 * In-memory sink for unit tests: keeps every object, exposes what was
 * put with which options, and can be told to fail or to lie about sizes.
 */
export class MemoryBackupObjectSink implements BackupObjectSink {
  readonly enabled: boolean;
  readonly target = 'memory://backups';
  readonly objects = new Map<string, StoredObject>();
  readonly puts: { key: string; options: BackupSinkPutOptions }[] = [];
  /** When set, the next put rejects with this error. */
  failNextPut: Error | null = null;
  /** When set, `sizeOf`/`head` report this size for every object (verification tests). */
  headSizeOverride: number | null = null;
  /** `lastModified` reported by `list` (null = date from the key only). */
  listLastModified: 'real' | 'none' = 'real';
  private clock: () => Date;

  constructor(opts: { enabled?: boolean; now?: () => Date } = {}) {
    this.enabled = opts.enabled ?? true;
    this.clock = opts.now ?? (() => new Date());
  }

  async put(
    key: string,
    body: Readable | Buffer,
    options: BackupSinkPutOptions,
  ): Promise<BackupSinkPutResult> {
    if (this.failNextPut) {
      const err = this.failNextPut;
      this.failNextPut = null;
      throw err;
    }
    const buf = Buffer.isBuffer(body) ? body : await collect(body);
    const metadata = { ...(options.metadata ?? {}) };
    if (options.sha256) metadata[SHA256_METADATA_KEY] = options.sha256;
    const etag = `etag-${this.objects.size + 1}`;
    this.objects.set(key, {
      body: buf,
      contentType: options.contentType,
      metadata,
      lastModified: this.clock(),
      etag,
    });
    this.puts.push({ key, options });
    return { etag, size: buf.length };
  }

  async sizeOf(key: string): Promise<number | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    return this.headSizeOverride ?? o.body.length;
  }

  async head(key: string): Promise<BackupSinkHead | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    return {
      size: this.headSizeOverride ?? o.body.length,
      etag: o.etag,
      lastModified: o.lastModified,
      metadata: { ...o.metadata },
    };
  }

  async list(prefix: string): Promise<BackupSinkObject[]> {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, o]) => ({
        key,
        size: o.body.length,
        lastModified: this.listLastModified === 'real' ? o.lastModified : null,
      }));
  }

  async get(key: string): Promise<BackupSinkGet | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    return {
      stream: Readable.from([o.body]),
      size: o.body.length,
      metadata: { ...o.metadata },
    };
  }

  /** Seeds a success marker as the cron script would write it. */
  seedManifest(key: string, at: Date): void {
    this.objects.set(key, {
      body: Buffer.from('{}'),
      contentType: 'application/json',
      metadata: {},
      lastModified: at,
      etag: `etag-${key}`,
    });
  }
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * `PrivateStorage` (C10) over `PRIVATE_OBJECT_STORAGE`: the same namespaced
 * keys and the same key validation as `PrivateFileStorage`, stored as
 * objects in the private bucket (SSE-KMS when `S3_KMS_KEY_ID` is set).
 * `openRead` streams the object (large originals are never buffered).
 */
import type { Readable } from 'stream';
import {
  InvalidPrivateStorageKeyError,
  isValidPrivateStorageKey,
  type PrivateFileRead,
  type PrivateFileStat,
  type PrivateStorage,
} from '../../common/storage/private-file-storage';
import { contentTypeFor } from './local-object-storage';
import type { ObjectStorage } from './object-storage';

export class S3PrivateStorage implements PrivateStorage {
  /** Not a directory: `s3://<bucket>` (disk guards skip it in s3 mode). */
  readonly root: string;

  constructor(private readonly objects: ObjectStorage) {
    this.root = `s3://${objects.location}`;
  }

  private key(key: string): string {
    if (!isValidPrivateStorageKey(key)) {
      throw new InvalidPrivateStorageKeyError(String(key));
    }
    return key;
  }

  async exists(key: string): Promise<boolean> {
    const head = await this.objects.head(this.key(key));
    return head !== null && head.size > 0;
  }

  async read(key: string): Promise<Buffer | null> {
    const obj = await this.objects.get(this.key(key));
    if (!obj) return null;
    return collect(obj.stream);
  }

  async write(key: string, data: Buffer): Promise<void> {
    const k = this.key(key);
    await this.objects.put(k, data, {
      contentType: contentTypeFor(k),
      cacheControl: 'private, no-store',
      sse: 'kms',
    });
  }

  /** False when the key did not exist or S3 refused the delete (logged, not thrown). */
  async delete(key: string): Promise<boolean> {
    return (await this.objects.delete(this.key(key))).deleted;
  }

  async stat(key: string): Promise<PrivateFileStat | null> {
    const head = await this.objects.head(this.key(key));
    if (!head) return null;
    return { bytes: head.size, modified_at: head.lastModified ?? new Date(0) };
  }

  async openRead(key: string): Promise<PrivateFileRead | null> {
    const obj = await this.objects.get(this.key(key));
    if (!obj) return null;
    return { bytes: obj.size, stream: obj.stream };
  }
}

export async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
    );
  }
  return Buffer.concat(chunks);
}

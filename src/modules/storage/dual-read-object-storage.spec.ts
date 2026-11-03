import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DualReadObjectStorage } from './dual-read-object-storage';
import { LocalObjectStorage } from './local-object-storage';
import { S3ObjectStorage } from './s3-object-storage';
import { collect } from './s3-private-storage';
import { mockS3, type MockS3 } from './__fixtures__/s3-mock';

describe('DualReadObjectStorage (MEDIA_LOCAL_FALLBACK)', () => {
  let root: string;
  let s3: MockS3;
  let local: LocalObjectStorage;
  let remote: S3ObjectStorage;
  let dual: DualReadObjectStorage;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-'));
    s3 = mockS3(['media']);
    local = new LocalObjectStorage({ root, keyPrefix: 'uploads/' });
    remote = new S3ObjectStorage({
      client: s3.client,
      bucket: 'media',
      role: 'media',
    });
    dual = new DualReadObjectStorage(remote, local);
  });
  afterEach(async () => {
    s3.stub.restore();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reads S3 first and falls back to the local file on a miss', async () => {
    await local.put('uploads/p/local-only.webp', Buffer.from('L'), {
      contentType: 'image/webp',
    });
    await remote.put('uploads/p/both.webp', Buffer.from('S'), {
      contentType: 'image/webp',
    });
    await local.put('uploads/p/both.webp', Buffer.from('L2'), {
      contentType: 'image/webp',
    });

    expect(
      (
        await collect((await dual.get('uploads/p/both.webp'))!.stream)
      ).toString(),
    ).toBe('S');
    expect(
      (
        await collect((await dual.get('uploads/p/local-only.webp'))!.stream)
      ).toString(),
    ).toBe('L');
    expect(await dual.get('uploads/p/none.webp')).toBeNull();
    expect(await dual.exists('uploads/p/local-only.webp')).toBe(true);
    expect(await dual.exists('uploads/p/none.webp')).toBe(false);
    expect((await dual.head('uploads/p/local-only.webp'))!.size).toBe(1);
    expect(dual.driver).toBe('s3');
  });

  it('writes go to S3 only; deletes go to both', async () => {
    await dual.put('uploads/p/new.webp', Buffer.from('N'), {
      contentType: 'image/webp',
    });
    expect(s3.objects.has('media/uploads/p/new.webp')).toBe(true);
    expect(await local.exists('uploads/p/new.webp')).toBe(false);

    await local.put('uploads/p/old.webp', Buffer.from('O'), {
      contentType: 'image/webp',
    });
    await remote.put('uploads/p/old.webp', Buffer.from('O'), {
      contentType: 'image/webp',
    });
    expect(await dual.delete('uploads/p/old.webp')).toBe(true);
    expect(await local.exists('uploads/p/old.webp')).toBe(false);
    expect(s3.objects.has('media/uploads/p/old.webp')).toBe(false);
    expect(await dual.delete('uploads/p/old.webp')).toBe(false);
  });

  it('lists S3 only', async () => {
    await local.put('uploads/p/l.webp', Buffer.from('L'), {
      contentType: 'image/webp',
    });
    await remote.put('uploads/p/s.webp', Buffer.from('S'), {
      contentType: 'image/webp',
    });
    expect((await dual.list('uploads/')).objects.map((o) => o.key)).toEqual([
      'uploads/p/s.webp',
    ]);
  });
});

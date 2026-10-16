import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  InvalidPrivateStorageKeyError,
  PrivateFileStorage,
  defaultPrivateStorageDir,
  isValidPrivateStorageKey,
} from './private-file-storage';

describe('PrivateFileStorage', () => {
  let root: string;
  let storage: PrivateFileStorage;
  const ID = 'a1b2c3d4-0000-4000-8000-000000000001';
  const KEY = `customer-uploads/2026/10/${ID}.jpg`;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'private-storage-'));
    storage = new PrivateFileStorage(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('defaults to <cwd>/storage (or PRIVATE_STORAGE_DIR), never uploads/', () => {
    const prev = process.env.PRIVATE_STORAGE_DIR;
    delete process.env.PRIVATE_STORAGE_DIR;
    try {
      const def = new PrivateFileStorage();
      expect(def.root).toBe(path.resolve(process.cwd(), 'storage'));
      expect(def.root.split(path.sep)).not.toContain('uploads');
      process.env.PRIVATE_STORAGE_DIR = root;
      expect(defaultPrivateStorageDir()).toBe(path.resolve(root));
      expect(new PrivateFileStorage().root).toBe(path.resolve(root));
    } finally {
      if (prev === undefined) delete process.env.PRIVATE_STORAGE_DIR;
      else process.env.PRIVATE_STORAGE_DIR = prev;
    }
  });

  it('writes atomically, reads, stats and deletes', async () => {
    expect(await storage.exists(KEY)).toBe(false);
    expect(await storage.read(KEY)).toBeNull();
    expect(await storage.stat(KEY)).toBeNull();

    await storage.write(KEY, Buffer.from('first'));
    expect(await storage.exists(KEY)).toBe(true);
    expect((await storage.read(KEY))!.toString()).toBe('first');

    await storage.write(KEY, Buffer.from('second!'));
    expect((await storage.read(KEY))!.toString()).toBe('second!');
    const st = await storage.stat(KEY);
    expect(st!.bytes).toBe(7);
    expect(typeof st!.modified_at.getTime()).toBe('number');

    // No temp files are left behind.
    const dir = path.join(root, 'customer-uploads', '2026', '10');
    expect(await fs.readdir(dir)).toEqual([`${ID}.jpg`]);

    expect(await storage.delete(KEY)).toBe(true);
    expect(await storage.delete(KEY)).toBe(false); // ENOENT is not an error
    expect(await storage.exists(KEY)).toBe(false);
  });

  it('never exposes a partial file under concurrent writes', async () => {
    const payloads = Array.from({ length: 8 }, (_, i) =>
      Buffer.alloc(64 * 1024, String(i)),
    );
    await Promise.all(
      payloads.map((p) =>
        storage.write(KEY, p).catch((e: NodeJS.ErrnoException) => {
          // Windows may refuse a rename while another rename holds the target.
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(String(e.code))) throw e;
        }),
      ),
    );
    const got = (await storage.read(KEY))!;
    expect(got.length).toBe(64 * 1024);
    expect(new Set(got.toString()).size).toBe(1);
    const dir = path.join(root, 'customer-uploads', '2026', '10');
    expect((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual(
      [],
    );
  });

  it.each([
    '../etc/passwd',
    `customer-uploads/2026/10/../../../../x/${ID}.jpg`,
    `customer-uploads/2026/10/${ID}.svg`,
    `customer-uploads/2026/10/${ID}.jpg/..`,
    `customer-uploads\\2026\\10\\${ID}.jpg`,
    `/customer-uploads/2026/10/${ID}.jpg`,
    `customer-uploads/26/10/${ID}.jpg`,
    `customer-uploads/2026/10/not-a-uuid.jpg`,
    `invoices/2026/${ID}.pdf`,
    `designer/x/${ID}.png`,
    '',
    `customer-uploads/2026/10/${ID}.jpg\u0000`,
  ])('rejects the unsafe key %j on every operation', async (key) => {
    expect(isValidPrivateStorageKey(key)).toBe(false);
    await expect(storage.write(key, Buffer.from('x'))).rejects.toBeInstanceOf(
      InvalidPrivateStorageKeyError,
    );
    await expect(storage.read(key)).rejects.toBeInstanceOf(
      InvalidPrivateStorageKeyError,
    );
    await expect(storage.exists(key)).rejects.toBeInstanceOf(
      InvalidPrivateStorageKeyError,
    );
    await expect(storage.delete(key)).rejects.toBeInstanceOf(
      InvalidPrivateStorageKeyError,
    );
    await expect(storage.stat(key)).rejects.toBeInstanceOf(
      InvalidPrivateStorageKeyError,
    );
  });

  it('removes the temp file when the write fails (ENOSPC)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- bind() of an overloaded fn
    const realOpen: typeof fs.open = fs.open.bind(fs);
    const spy = jest
      .spyOn(fs, 'open')
      .mockImplementationOnce(async (file, flags, mode) => {
        const handle = await realOpen(file, flags, mode);
        jest
          .spyOn(handle, 'writeFile')
          .mockRejectedValueOnce(
            Object.assign(new Error('no space'), { code: 'ENOSPC' }),
          );
        return handle;
      });
    await expect(storage.write(KEY, Buffer.from('x'))).rejects.toThrow(
      'no space',
    );
    spy.mockRestore();
    const dir = path.join(root, 'customer-uploads', '2026', '10');
    expect(await fs.readdir(dir)).toEqual([]);
    expect(await storage.exists(KEY)).toBe(false);
  });

  it('rejects non-string keys', () => {
    expect(isValidPrivateStorageKey(undefined)).toBe(false);
    expect(() => storage.resolve(42 as unknown as string)).toThrow(
      InvalidPrivateStorageKeyError,
    );
  });

  it('accepts every allowed customer-upload extension', () => {
    for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'pdf', 'ai']) {
      expect(
        isValidPrivateStorageKey(`customer-uploads/2026/01/${ID}.${ext}`),
      ).toBe(true);
    }
    expect(storage.resolve(KEY)).toBe(
      path.join(root, 'customer-uploads', '2026', '10', `${ID}.jpg`),
    );
  });
});

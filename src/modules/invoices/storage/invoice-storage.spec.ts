import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  InvalidInvoiceStorageKeyError,
  LocalDiskInvoiceStorage,
  defaultInvoiceStorageDir,
} from './invoice-storage';

describe('LocalDiskInvoiceStorage', () => {
  let root: string;
  let storage: LocalDiskInvoiceStorage;
  const STORE = '7d0b6c1e-1f1a-4c39-9a52-2b1d2f3c4d5e';
  const INV = 'a1b2c3d4-0000-4000-8000-000000000001';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'inv-storage-'));
    storage = new LocalDiskInvoiceStorage(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('defaults to <cwd>/storage/invoices, never uploads/', () => {
    const def = new LocalDiskInvoiceStorage(undefined);
    expect(def.root).toBe(path.resolve(defaultInvoiceStorageDir()));
    expect(def.root).toBe(path.resolve(process.cwd(), 'storage', 'invoices'));
    expect(def.root.split(path.sep)).not.toContain('uploads');
  });

  it('builds <store>/<yyyy>/<invoice>.pdf keys', () => {
    expect(storage.keyFor(STORE, new Date('2026-10-14T00:00:00Z'), INV)).toBe(
      `${STORE}/2026/${INV}.pdf`,
    );
    expect(storage.keyFor(STORE, '2025-01-01', INV)).toBe(
      `${STORE}/2025/${INV}.pdf`,
    );
  });

  it('writes atomically and reads back', async () => {
    const key = storage.keyFor(STORE, '2026-10-14', INV);
    expect(await storage.exists(key)).toBe(false);
    expect(await storage.read(key)).toBeNull();

    await storage.write(key, Buffer.from('%PDF-1.7 first'));
    expect(await storage.exists(key)).toBe(true);
    expect((await storage.read(key))!.toString()).toBe('%PDF-1.7 first');

    // Overwrite replaces the whole file; no temp files are left behind.
    await storage.write(key, Buffer.from('%PDF-1.7 second'));
    expect((await storage.read(key))!.toString()).toBe('%PDF-1.7 second');
    const dir = path.join(root, STORE, '2026');
    expect(await fs.readdir(dir)).toEqual([`${INV}.pdf`]);
  });

  it('never exposes a partial file under concurrent writes', async () => {
    const key = storage.keyFor(STORE, '2026-10-14', INV);
    const payloads = Array.from({ length: 8 }, (_, i) =>
      Buffer.alloc(64 * 1024, String(i)),
    );
    await Promise.all(
      payloads.map((p) =>
        storage.write(key, p).catch((e: NodeJS.ErrnoException) => {
          // Windows may refuse a rename while another rename holds the
          // target; the file stays whole either way.
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(String(e.code))) throw e;
        }),
      ),
    );
    const got = (await storage.read(key))!;
    expect(got.length).toBe(64 * 1024);
    expect(new Set(got.toString()).size).toBe(1);
    const dir = path.join(root, STORE, '2026');
    expect((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual(
      [],
    );
  });

  it.each([
    '../escape.pdf',
    `${STORE}/2026/../../../etc/passwd.pdf`,
    `${STORE}/2026/..\\..\\x.pdf`,
    `/etc/2026/${INV}.pdf`,
    `C:\\Windows\\2026\\${INV}.pdf`,
    `${STORE}/2026/${INV}.txt`,
    `${STORE}/26/${INV}.pdf`,
    `${STORE}/2026/sub/${INV}.pdf`,
    `.hidden/2026/${INV}.pdf`,
    '',
  ])('rejects unsafe key %j', async (key) => {
    expect(() => storage.resolve(key)).toThrow(InvalidInvoiceStorageKeyError);
    await expect(storage.read(key)).rejects.toThrow(
      InvalidInvoiceStorageKeyError,
    );
    await expect(storage.write(key, Buffer.from('x'))).rejects.toThrow(
      InvalidInvoiceStorageKeyError,
    );
  });

  it('rejects unsafe ids when building a key', () => {
    expect(() => storage.keyFor('../x', '2026-01-01', INV)).toThrow(
      InvalidInvoiceStorageKeyError,
    );
    expect(() => storage.keyFor(STORE, '2026-01-01', 'a/b')).toThrow(
      InvalidInvoiceStorageKeyError,
    );
    expect(() => storage.keyFor(STORE, 'not-a-date', INV)).toThrow(
      InvalidInvoiceStorageKeyError,
    );
  });
});

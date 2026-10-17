import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { OrderStatus, UserRole } from '@prisma/client';
import { PrivateFileStorage } from '../../common/storage/private-file-storage';
import { UploadsService } from '../uploads/uploads.service';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  CustomerUploadsService,
  sanitizeFileName,
} from './customer-uploads.service';
import { parseCustomerPreviewId } from './customer-uploads.types';
import type { Readable } from 'stream';

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}
import type { RetentionService } from '../retention/retention.service';
import * as rasterInspect from '../../common/uploads/raster-inspect';

// ── In-memory CustomerUpload table (only the query shapes the service uses) ──

type Row = {
  id: string;
  store_id: string | null;
  original_key: string;
  original_name: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
  preview_url: string;
  created_at: Date;
  attached_at: Date | null;
  purged_at: Date | null;
  values: {
    field_name: string | null;
    order_item: {
      fulfiller_id?: string | null;
      order: {
        status: OrderStatus;
        order_number: string;
        store_id: string | null;
        customer: { user_id: string } | null;
        items: { fulfiller_id: string | null }[];
      };
    };
  }[];
};

type Where = Record<string, unknown>;

const PURGEABLE_STATUSES = [
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'REFUNDED',
  'RETURNED',
];
const isOpen = (v: Row['values'][number]) =>
  !PURGEABLE_STATUSES.includes(v.order_item.order.status);

function matches(row: Row, where: Where = {}): boolean {
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(cond as Where[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (k === 'values') {
      // Only the "open order" filter of runRetention is modelled.
      const c = cond as { some?: unknown; none?: unknown };
      if (c.some && !row.values.some(isOpen)) return false;
      if (c.none && row.values.some(isOpen)) return false;
      continue;
    }
    const v = (row as unknown as Record<string, unknown>)[k];
    if (cond === null) {
      if (v !== null) return false;
    } else if (typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; not?: unknown; lt?: Date };
      if (c.in && !c.in.includes(v)) return false;
      if ('not' in c && c.not === null && v === null) return false;
      if (c.lt && !(v instanceof Date && v < c.lt)) return false;
    } else if (v !== cond) {
      return false;
    }
  }
  return true;
}

function fakePrisma(rows: Row[], extra: Record<string, unknown> = {}) {
  const customerUpload = {
    create: jest.fn(({ data }: { data: Partial<Row> }) => {
      const row = {
        store_id: null,
        attached_at: null,
        purged_at: null,
        values: [],
        ...data,
      } as Row;
      rows.push(row);
      return Promise.resolve(row);
    }),
    findMany: jest.fn(
      (args: {
        where?: Where;
        take?: number;
        cursor?: { id: string };
        skip?: number;
        orderBy?: Record<string, 'asc'>;
      }) => {
        let list = rows.filter((r) => matches(r, args.where));
        const key = Object.keys(args.orderBy ?? { id: 'asc' })[0] as keyof Row;
        const sortKey = (r: Row): string => {
          const v = r[key];
          return v instanceof Date ? v.toISOString() : String(v as string);
        };
        list = [...list].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
        if (args.cursor) {
          const i = list.findIndex((r) => r.id === args.cursor!.id);
          list = list.slice(i + (args.skip ?? 0));
        }
        return Promise.resolve(args.take ? list.slice(0, args.take) : list);
      },
    ),
    findUnique: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(rows.find((r) => r.id === where.id) ?? null),
    ),
    groupBy: jest.fn(({ where }: { where: Where }) => {
      const ids = new Set(
        rows.filter((r) => matches(r, where)).map((r) => r.store_id),
      );
      return Promise.resolve([...ids].map((store_id) => ({ store_id })));
    }),
    updateMany: jest.fn(
      ({ where, data }: { where: Where; data: Partial<Row> }) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return Promise.resolve({ count: hit.length });
      },
    ),
    update: jest.fn(
      ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const r = rows.find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return Promise.resolve(r);
      },
    ),
    count: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(rows.filter((r) => matches(r, where)).length),
    ),
  };
  // claimAttached's UPDATE ... WHERE NOT EXISTS (open order), one row.
  const $executeRaw = jest.fn(
    (
      _sql: TemplateStringsArray,
      nowIso: string,
      id: string,
      cutoff: string,
    ) => {
      const r = rows.find((x) => x.id === id);
      if (
        !r ||
        r.purged_at !== null ||
        r.attached_at === null ||
        !(r.attached_at < new Date(cutoff)) ||
        r.values.some(isOpen)
      ) {
        return Promise.resolve(0);
      }
      r.purged_at = new Date(nowIso);
      return Promise.resolve(1);
    },
  );
  return {
    customerUpload,
    $executeRaw,
    provider: { findUnique: jest.fn().mockResolvedValue(null) },
    creator: { findUnique: jest.fn().mockResolvedValue(null) },
    ...extra,
  };
}

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('CustomerUploadsService', () => {
  let cwd: string;
  let storageRoot: string;
  let storage: PrivateFileStorage;
  let rows: Row[];
  let prisma: ReturnType<typeof fakePrisma>;
  let service: CustomerUploadsService;

  const build = (extra: Record<string, unknown> = {}) => {
    prisma = fakePrisma(rows, extra);
    service = new CustomerUploadsService(
      prisma as unknown as PrismaService,
      new UploadsService(),
      storage,
    );
  };

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cu-cwd-'));
    storageRoot = path.join(cwd, 'storage');
    jest.spyOn(process, 'cwd').mockReturnValue(cwd);
    storage = new PrivateFileStorage(storageRoot);
    rows = [];
    build();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    delete process.env.CUSTOMER_UPLOAD_RETENTION_DAYS;
    delete process.env.CUSTOMER_UPLOAD_ORPHAN_DAYS;
    delete process.env.CUSTOMER_UPLOAD_DAILY_BYTES_PER_IP;
    delete process.env.CUSTOMER_UPLOAD_MIN_FREE_MB;
    await fs.rm(cwd, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });

  const file = (originalname: string, buffer: Buffer) => ({
    originalname,
    buffer,
    size: buffer.length,
  });

  // ── Upload ──

  describe('upload', () => {
    it('keeps the exact original privately and writes an EXIF-free WebP preview', async () => {
      const jpg = await sharp({
        create: {
          width: 3000,
          height: 1000,
          channels: 3,
          background: { r: 1, g: 2, b: 3 },
        },
      })
        .withExif({ IFD0: { Copyright: 'secret-gps-owner' } })
        .jpeg()
        .toBuffer();
      expect((await sharp(jpg).metadata()).exif).toBeDefined();

      const res = await service.upload(file('My "photo".JPG', jpg));
      expect(res).toMatchObject({
        file_type: 'jpg',
        file_size: jpg.length,
        width: 3000,
        height: 1000,
        original_name: 'My photo.JPG',
        mime: 'image/jpeg',
      });
      expect(res.url).toBe(`/uploads/customer-previews/${res.upload_id}.webp`);

      // Original: byte-identical (sha256) in private storage, not under uploads/.
      const row = rows[0];
      expect(row.original_key).toMatch(
        new RegExp(`^customer-uploads/\\d{4}/\\d{2}/${res.upload_id}\\.jpg$`),
      );
      const stored = await storage.read(row.original_key);
      const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
      expect(sha(stored!)).toBe(sha(jpg));
      expect(row.sha256).toBe(sha(jpg));
      expect(row.attached_at).toBeNull();
      expect(row.store_id).toBeNull();

      // Preview: public WebP ≤ 2000px without metadata.
      const preview = await fs.readFile(path.join(cwd, res.url));
      const meta = await sharp(preview).metadata();
      expect(meta.format).toBe('webp');
      expect(Math.max(meta.width, meta.height)).toBe(2000);
      expect(meta.exif).toBeUndefined();
    });

    it('stores PDF/AI as-is with a placeholder preview', async () => {
      const pdf = Buffer.from('%PDF-1.4\n% artwork\n');
      const res = await service.upload(file('logo.ai', pdf));
      expect(res).toMatchObject({
        file_type: 'ai',
        width: null,
        height: null,
        mime: 'application/postscript',
      });
      expect(await storage.read(rows[0].original_key)).toEqual(pdf);
      const preview = await fs.readFile(path.join(cwd, res.url));
      const meta = await sharp(preview).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual([
        'webp',
        256,
        256,
      ]);
    });

    it('accepts %PDF- within the first 1024 bytes and PostScript .ai files', async () => {
      const preamble = Buffer.concat([
        Buffer.alloc(600, 0x20),
        Buffer.from('%PDF-1.7\n'),
      ]);
      await expect(
        service.upload(file('print.pdf', preamble)),
      ).resolves.toMatchObject({ file_type: 'pdf', mime: 'application/pdf' });
      const ps = Buffer.from('%!PS-Adobe-3.0\n%%Creator: Adobe Illustrator\n');
      await expect(service.upload(file('logo.ai', ps))).resolves.toMatchObject({
        file_type: 'ai',
        mime: 'application/postscript',
      });
      // PostScript is not a PDF, and %PDF- after 1024 bytes does not count.
      await expect(service.upload(file('x.pdf', ps))).rejects.toMatchObject({
        response: { code: 'CUSTOMER_UPLOAD_TYPE_NOT_ALLOWED' },
      });
      const late = Buffer.concat([
        Buffer.alloc(1100, 0x20),
        Buffer.from('%PDF-1.7'),
      ]);
      await expect(service.upload(file('x.pdf', late))).rejects.toMatchObject({
        response: { code: 'CUSTOMER_UPLOAD_TYPE_NOT_ALLOWED' },
      });
    });

    it('bounds animations by width × height × frames (decode bomb)', async () => {
      const png = await sharp({
        create: { width: 4, height: 4, channels: 3, background: '#fff' },
      })
        .png()
        .toBuffer();
      jest.spyOn(rasterInspect, 'inspectRaster').mockResolvedValueOnce({
        format: 'webp',
        width: 10_000,
        height: 1_000,
        pages: 11,
      });
      await expect(service.upload(file('a.webp', png))).rejects.toMatchObject({
        response: { code: 'UPLOAD_FILE_TOO_LARGE' },
      });
      expect(rows).toHaveLength(0);
    });

    it('enforces the per-IP daily byte budget (429 CUSTOMER_UPLOAD_QUOTA)', async () => {
      process.env.CUSTOMER_UPLOAD_DAILY_BYTES_PER_IP = '30';
      const pdf = Buffer.from('%PDF-1.4 twenty bytes'); // 21 bytes
      await service.upload(file('a.pdf', pdf), { ip: '198.51.100.1' });
      await expect(
        service.upload(file('b.pdf', pdf), { ip: '198.51.100.1' }),
      ).rejects.toMatchObject({
        status: 429,
        response: { code: 'CUSTOMER_UPLOAD_QUOTA' },
      });
      // Another client is not affected; a used-up budget fails admission.
      await service.upload(file('c.pdf', pdf), { ip: '198.51.100.2' });
      await service.upload(file('d.pdf', Buffer.from('%PDF-1.4 ')), {
        ip: '198.51.100.1',
      });
      await expect(service.admit({ ip: '198.51.100.1' })).rejects.toMatchObject(
        { status: 429 },
      );
      expect(rows).toHaveLength(3);
    });

    it('refuses uploads when the disk is low (503 CUSTOMER_UPLOAD_STORAGE_FULL)', async () => {
      jest.spyOn(fs, 'statfs').mockResolvedValue({
        bavail: 10,
        bsize: 4096,
      } as Awaited<ReturnType<typeof fs.statfs>>);
      await expect(service.admit({ ip: '1.2.3.4' })).rejects.toMatchObject({
        status: 503,
        response: { code: 'CUSTOMER_UPLOAD_STORAGE_FULL' },
      });
      await expect(
        service.upload(file('a.pdf', Buffer.from('%PDF-1.4'))),
      ).rejects.toMatchObject({ status: 503 });
      process.env.CUSTOMER_UPLOAD_MIN_FREE_MB = '0';
      await expect(service.admit({ ip: '1.2.3.4' })).resolves.toBeUndefined();
    });

    it.each([
      ['image.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
      ['fake.pdf', Buffer.from('<html>not a pdf</html>')],
      ['noext', Buffer.from('%PDF-1.4')],
    ])(
      'rejects %s with CUSTOMER_UPLOAD_TYPE_NOT_ALLOWED',
      async (name, buf) => {
        await expect(service.upload(file(name, buf))).rejects.toMatchObject({
          response: { code: 'CUSTOMER_UPLOAD_TYPE_NOT_ALLOWED' },
        });
        expect(rows).toHaveLength(0);
      },
    );

    it('rejects a GIF renamed to .png, and undecodable rasters', async () => {
      const gif = await sharp({
        create: { width: 4, height: 4, channels: 3, background: '#000' },
      })
        .gif()
        .toBuffer();
      await expect(service.upload(file('x.png', gif))).rejects.toMatchObject({
        response: { code: 'CUSTOMER_UPLOAD_TYPE_NOT_ALLOWED' },
      });
      await expect(
        service.upload(file('x.jpg', Buffer.from('garbage'))),
      ).rejects.toMatchObject({
        response: { code: 'UPLOAD_IMAGE_PROCESS_FAILED' },
      });
    });

    it('rejects missing files', async () => {
      await expect(service.upload(undefined)).rejects.toMatchObject({
        response: { code: 'UPLOAD_NO_FILE' },
      });
    });

    it('removes the original when the row cannot be written', async () => {
      prisma.customerUpload.create.mockRejectedValueOnce(new Error('db down'));
      const png = await sharp({
        create: { width: 4, height: 4, channels: 3, background: '#fff' },
      })
        .png()
        .toBuffer();
      await expect(service.upload(file('a.png', png))).rejects.toThrow(
        'db down',
      );
      const dirFiles = await fs
        .readdir(path.join(cwd, 'uploads', 'customer-previews'))
        .catch(() => []);
      expect(dirFiles).toEqual([]);
    });
  });

  // ── Order write path ──

  describe('resolveForOrder / markAttached', () => {
    beforeEach(() => {
      rows.push(
        baseRow(uuid(1), { purged_at: null }),
        baseRow(uuid(2), { purged_at: new Date('2026-01-01') }),
      );
    });

    it('maps preview URLs by exact URL; legacy and unknown URLs are absent', async () => {
      const rel = `/uploads/customer-previews/${uuid(1)}.webp`;
      const abs = `https://api.example.com/uploads/customer-previews/${uuid(1)}.webp`;
      const purged = `/uploads/customer-previews/${uuid(2)}.webp`;
      const unknown = `/uploads/customer-previews/${uuid(3)}.webp`;
      const legacy = `/uploads/custom-fields/${uuid(1)}.webp`;
      const map = await service.resolveForOrder([
        rel,
        abs,
        purged,
        unknown,
        legacy,
        'hello',
      ]);
      expect([...map.keys()].sort()).toEqual([abs, purged, rel].sort());
      expect(map.get(rel)).toEqual({ id: uuid(1), purged: false });
      expect(map.get(abs)).toEqual({ id: uuid(1), purged: false });
      expect(map.get(purged)).toEqual({ id: uuid(2), purged: true });
      // One batched query.
      expect(prisma.customerUpload.findMany).toHaveBeenCalledTimes(1);
    });

    it('leaves out uploads attached to another store (IDOR guard)', async () => {
      rows[0].store_id = 'store-a';
      rows[0].attached_at = new Date();
      const rel = `/uploads/customer-previews/${uuid(1)}.webp`;
      expect((await service.resolveForOrder([rel], 'store-b')).size).toBe(0);
      expect(
        (await service.resolveForOrder([rel], 'store-a')).get(rel),
      ).toEqual({ id: uuid(1), purged: false });
    });

    it('does not query when no URL is a preview', async () => {
      const map = await service.resolveForOrder([
        '/uploads/custom-fields/a.webp',
      ]);
      expect(map.size).toBe(0);
      expect(prisma.customerUpload.findMany).not.toHaveBeenCalled();
    });

    it('attaches orphans and own-store uploads; another store or a purge throws (rollback)', async () => {
      const tx = { customerUpload: prisma.customerUpload };
      expect(
        await service.markAttached([uuid(1), uuid(1)], 'store-a', tx as never),
      ).toBe(1);
      const first = rows[0].attached_at;
      expect(first).toBeInstanceOf(Date);
      expect(rows[0].store_id).toBe('store-a');
      // Same store again (a second order): allowed, the clock restarts.
      expect(
        await service.markAttached([uuid(1)], 'store-a', tx as never),
      ).toBe(1);
      // Another store: refused, nothing changes.
      await expect(
        service.markAttached([uuid(1)], 'store-b', tx as never),
      ).rejects.toMatchObject({
        response: { code: 'CUSTOMER_UPLOAD_EXPIRED' },
      });
      expect(rows[0].store_id).toBe('store-a');
      // Purged (uuid 2) or unknown ids: count mismatch → throws.
      await expect(
        service.markAttached([uuid(1), uuid(2)], 'store-a', tx as never),
      ).rejects.toMatchObject({
        response: {
          code: 'CUSTOMER_UPLOAD_EXPIRED',
          params: { upload_ids: [uuid(2)] },
        },
      });
      await expect(
        service.markAttached([uuid(3)], 'store-a', tx as never),
      ).rejects.toMatchObject({
        response: { code: 'CUSTOMER_UPLOAD_EXPIRED' },
      });
      // M5 A3: the non-throwing variant names exactly the unattachable ids.
      expect(
        await service.tryMarkAttached(
          [uuid(1), uuid(2), uuid(3)],
          'store-a',
          tx as never,
        ),
      ).toEqual({ attached: 1, unattachable: [uuid(2), uuid(3)] });
      expect(await service.markAttached([], 'store-a', tx as never)).toBe(0);
      const where = (
        prisma.customerUpload.updateMany.mock.calls[0] as [
          { where: Record<string, unknown> },
        ]
      )[0].where;
      expect(where).toEqual({
        id: { in: [uuid(1)] },
        purged_at: null,
        OR: [{ attached_at: null }, { store_id: 'store-a' }],
      });
    });
  });

  // ── Download authorization ──

  describe('downloadOriginal', () => {
    const ORIGINAL = Buffer.from('%PDF-1.4 original bytes');

    beforeEach(async () => {
      const row = baseRow(uuid(5), {
        mime: 'application/pdf',
        original_key: `customer-uploads/2026/10/${uuid(5)}.pdf`,
        attached_at: new Date(),
        store_id: 'store-1',
        values: [
          {
            field_name: 'Logo file',
            order_item: {
              fulfiller_id: 'provider-1',
              order: {
                status: 'PROCESSING',
                order_number: 'ORD-1001',
                store_id: 'store-1',
                customer: { user_id: 'buyer-user' },
                // provider-2 fulfils another item of the same order.
                items: [
                  { fulfiller_id: 'provider-1' },
                  { fulfiller_id: 'provider-2' },
                ],
              },
            },
          },
        ],
      });
      rows.push(row, baseRow(uuid(6)));
      await storage.write(row.original_key, ORIGINAL);
      build({
        provider: {
          findUnique: jest.fn(({ where }: { where: { user_id: string } }) =>
            Promise.resolve(
              where.user_id === 'provider-user'
                ? { id: 'provider-1' }
                : where.user_id === 'provider2-user'
                  ? { id: 'provider-2' }
                  : null,
            ),
          ),
        },
        creator: {
          findUnique: jest.fn(({ where }: { where: { user_id: string } }) =>
            Promise.resolve(
              where.user_id === 'owner-user'
                ? { id: 'creator-1', store: { id: 'store-1' } }
                : where.user_id === 'other-user'
                  ? { id: 'creator-2', store: { id: 'store-2' } }
                  : null,
            ),
          ),
        },
      });
    });

    it.each([
      ['admin', 'admin-user', UserRole.ADMIN],
      ['store owner creator', 'owner-user', UserRole.CREATOR],
      ['provider fulfilling that item', 'provider-user', UserRole.PROVIDER],
    ])('lets the %s download the exact original', async (_l, id, role) => {
      const res = await service.downloadOriginal(uuid(5), { id, role });
      expect(await collect(res.stream)).toEqual(ORIGINAL);
      expect(res.length).toBe(ORIGINAL.length);
      expect(res.mime).toBe('application/pdf');
      expect(res.filename).toBe(
        `ORD-1001-Logo_file-${uuid(5).slice(0, 8)}.pdf`,
      );
    });

    it.each([
      ['other creator', 'other-user', UserRole.CREATOR],
      ['other customer', 'someone', UserRole.CUSTOMER],
      ['other provider', 'nobody', UserRole.PROVIDER],
      // The buyer already has the file; only staff download originals.
      ['buyer', 'buyer-user', UserRole.CUSTOMER],
      // Same order, but not the item that carries this upload.
      ['provider of another item', 'provider2-user', UserRole.PROVIDER],
    ])('answers 404 to the %s', async (_l, id, role) => {
      await expect(
        service.downloadOriginal(uuid(5), { id, role }),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: 'CUSTOMER_UPLOAD_NOT_FOUND' },
      });
    });

    it('M5 A5: streams the original from disk (stat + createReadStream, no readFile)', async () => {
      const readFile = jest.spyOn(storage, 'read');
      const openRead = jest.spyOn(storage, 'openRead');
      const res = await service.downloadOriginal(uuid(5), {
        id: 'admin-user',
        role: UserRole.ADMIN,
      });
      expect(openRead).toHaveBeenCalledTimes(1);
      expect(readFile).not.toHaveBeenCalled();
      expect(res.length).toBe(ORIGINAL.length);
      expect(await collect(res.stream)).toEqual(ORIGINAL);
      readFile.mockRestore();
      openRead.mockRestore();
    });

    it('answers 404 for unattached, unknown and malformed ids (even to admin)', async () => {
      const admin = { id: 'a', role: UserRole.ADMIN };
      for (const id of [uuid(6), uuid(9), '../../etc/passwd']) {
        await expect(service.downloadOriginal(id, admin)).rejects.toMatchObject(
          { status: 404 },
        );
      }
    });

    it('answers 410 when purged (after authorization)', async () => {
      rows[0].purged_at = new Date();
      await expect(
        service.downloadOriginal(uuid(5), {
          id: 'owner-user',
          role: UserRole.CREATOR,
        }),
      ).rejects.toMatchObject({
        status: 410,
        response: { code: 'CUSTOMER_UPLOAD_PURGED' },
      });
      await expect(
        service.downloadOriginal(uuid(5), {
          id: 'other-user',
          role: UserRole.CREATOR,
        }),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  // ── Retention ──

  describe('runRetention', () => {
    const NOW = new Date('2026-10-16T12:00:00Z');
    const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400000);

    async function seed(
      n: number,
      over: Partial<Row>,
      statuses: OrderStatus[] = [],
      { files = true }: { files?: boolean } = {},
    ): Promise<Row> {
      const id = uuid(n);
      const row = baseRow(id, {
        original_key: `customer-uploads/2026/01/${id}.png`,
        ...over,
        values: statuses.map((status) => ({
          field_name: 'Photo',
          order_item: {
            order: {
              status,
              order_number: `O-${n}`,
              store_id: over.store_id ?? null,
              customer: null,
              items: [],
            },
          },
        })),
      });
      rows.push(row);
      // Rows retention never touches (open orders) can skip the disk writes.
      if (!files) return row;
      await storage.write(row.original_key, Buffer.from('orig'));
      const preview = path.join(cwd, 'uploads', 'customer-previews');
      await fs.mkdir(preview, { recursive: true });
      await fs.writeFile(path.join(preview, `${id}.webp`), 'p');
      return row;
    }

    const previewExists = (id: string) =>
      fs
        .stat(path.join(cwd, 'uploads', 'customer-previews', `${id}.webp`))
        .then(
          () => true,
          () => false,
        );

    it('keeps attached files forever without a policy (K1) but purges orphans after 30 days', async () => {
      const attached = await seed(
        1,
        { store_id: 's1', attached_at: daysAgo(400), created_at: daysAgo(400) },
        ['DELIVERED'],
      );
      const oldOrphan = await seed(2, { created_at: daysAgo(31) });
      const freshOrphan = await seed(3, { created_at: daysAgo(29) });

      const r = await service.runRetention(NOW);
      expect(r).toEqual({
        purgedAttached: 0,
        purgedOrphans: 1,
        skippedOpenOrders: 0,
        errors: 0,
      });
      expect(attached.purged_at).toBeNull();
      expect(oldOrphan.purged_at).toEqual(NOW);
      expect(await storage.exists(oldOrphan.original_key)).toBe(false);
      expect(await previewExists(oldOrphan.id)).toBe(false);
      expect(freshOrphan.purged_at).toBeNull();
      expect(await storage.exists(freshOrphan.original_key)).toBe(true);
    });

    it('honours CUSTOMER_UPLOAD_ORPHAN_DAYS', async () => {
      process.env.CUSTOMER_UPLOAD_ORPHAN_DAYS = '5';
      const orphan = await seed(2, { created_at: daysAgo(6) });
      await service.runRetention(NOW);
      expect(orphan.purged_at).toEqual(NOW);
    });

    it('resolves policies: minimum number wins, null = forever, undefined = no opinion', async () => {
      process.env.CUSTOMER_UPLOAD_RETENTION_DAYS = '90';
      expect(await service.retentionDaysFor('s1')).toBe(90);
      expect(await service.retentionDaysFor(null)).toBe(90);
      service.registerRetentionPolicy({
        retentionDays: () => Promise.resolve(undefined),
      });
      expect(await service.retentionDaysFor('s1')).toBe(90);
      service.registerRetentionPolicy({
        retentionDays: () => Promise.resolve(null),
      });
      expect(await service.retentionDaysFor('s1')).toBeNull();
      service.registerRetentionPolicy({
        retentionDays: (s) => Promise.resolve(s === 's1' ? 60 : undefined),
      });
      service.registerRetentionPolicy({
        retentionDays: () => Promise.resolve(45),
      });
      expect(await service.retentionDaysFor('s1')).toBe(45);
      expect(await service.retentionDaysFor('s2')).toBe(45);
      delete process.env.CUSTOMER_UPLOAD_RETENTION_DAYS;
      expect(await service.retentionDaysFor(null)).toBeNull();
    });

    it('a failing policy never shortens retention', async () => {
      service.registerRetentionPolicy({
        retentionDays: () => Promise.reject(new Error('boom')),
      });
      process.env.CUSTOMER_UPLOAD_RETENTION_DAYS = '1';
      expect(await service.retentionDaysFor('s1')).toBeNull();
    });

    it('purges expired attached uploads only when every order is closed', async () => {
      service.registerRetentionPolicy({
        retentionDays: (s) => Promise.resolve(s === 's1' ? 60 : undefined),
      });
      const closed = await seed(
        1,
        { store_id: 's1', attached_at: daysAgo(61) },
        ['DELIVERED', 'REFUNDED'],
      );
      const open = await seed(2, { store_id: 's1', attached_at: daysAgo(61) }, [
        'DELIVERED',
        'PROCESSING',
      ]);
      const young = await seed(
        3,
        { store_id: 's1', attached_at: daysAgo(59) },
        ['SHIPPED'],
      );
      const otherStore = await seed(
        4,
        { store_id: 's2', attached_at: daysAgo(500) },
        ['DELIVERED'],
      );

      const dry = await service.runRetention(NOW, { dryRun: true });
      expect(dry).toEqual({
        purgedAttached: 1,
        purgedOrphans: 0,
        skippedOpenOrders: 1,
        errors: 0,
      });
      expect(closed.purged_at).toBeNull();
      expect(await storage.exists(closed.original_key)).toBe(true);

      const r = await service.runRetention(NOW);
      expect(r).toEqual(dry);
      expect(closed.purged_at).toEqual(NOW);
      expect(await storage.exists(closed.original_key)).toBe(false);
      expect(await previewExists(closed.id)).toBe(false);
      for (const kept of [open, young, otherStore]) {
        expect(kept.purged_at).toBeNull();
        expect(await storage.exists(kept.original_key)).toBe(true);
      }

      // Idempotent: nothing left to purge.
      expect((await service.runRetention(NOW)).purgedAttached).toBe(0);
    });

    it('more open-order rows than a page never hide purgeable ones', async () => {
      process.env.CUSTOMER_UPLOAD_RETENTION_DAYS = '0';
      // No files for the 250 open-order rows: 500 disk writes made this test
      // exceed the timeout under a loaded full run, and the still-running body
      // then raced the next test's temp-dir cleanup (ENOTEMPTY).
      for (let i = 1; i <= 250; i++) {
        await seed(
          i,
          { store_id: 's1', attached_at: daysAgo(1) },
          ['PROCESSING'],
          { files: false },
        );
      }
      const last = await seed(
        999,
        { store_id: 's1', attached_at: daysAgo(1) },
        ['DELIVERED'],
      );
      const r = await service.runRetention(NOW);
      expect(r).toMatchObject({ purgedAttached: 1, skippedOpenOrders: 250 });
      expect(last.purged_at).toEqual(NOW);
    });

    it('stops at the deadline', async () => {
      await seed(2, { created_at: daysAgo(40) });
      const r = await service.runRetention(NOW, { deadline: Date.now() });
      expect(r.purgedOrphans).toBe(0);
      expect(prisma.customerUpload.findMany).not.toHaveBeenCalled();
    });

    it('the attached claim is atomic: an order opened after the scan wins', async () => {
      process.env.CUSTOMER_UPLOAD_RETENTION_DAYS = '0';
      const row = await seed(1, { store_id: 's1', attached_at: daysAgo(1) }, [
        'DELIVERED',
      ]);
      // A new open order references the file between the scan and the claim.
      const realFindMany =
        prisma.customerUpload.findMany.getMockImplementation()!;
      prisma.customerUpload.findMany.mockImplementationOnce((args) => {
        const out = realFindMany(args);
        row.values.push({
          field_name: 'Photo',
          order_item: {
            order: {
              status: 'PENDING',
              order_number: 'O-new',
              store_id: 's1',
              customer: null,
              items: [],
            },
          },
        });
        return out;
      });
      const r = await service.runRetention(NOW);
      expect(r.purgedAttached).toBe(0);
      expect(row.purged_at).toBeNull();
      expect(await storage.exists(row.original_key)).toBe(true);
    });

    it('respects the limit', async () => {
      process.env.CUSTOMER_UPLOAD_RETENTION_DAYS = '0';
      for (let i = 1; i <= 5; i++) {
        await seed(i, { store_id: 's1', attached_at: daysAgo(1) }, [
          'DELIVERED',
        ]);
      }
      const r = await service.runRetention(NOW, { limit: 2 });
      expect(r.purgedAttached).toBe(2);
      expect(rows.filter((x) => x.purged_at).length).toBe(2);
    });

    it('reverts the claim and counts an error when the original cannot be deleted', async () => {
      const orphan = await seed(2, { created_at: daysAgo(40) });
      jest
        .spyOn(storage, 'delete')
        .mockRejectedValueOnce(
          Object.assign(new Error('EACCES'), { code: 'EACCES' }),
        );
      const r = await service.runRetention(NOW);
      expect(r).toMatchObject({ purgedOrphans: 0, errors: 1 });
      expect(orphan.purged_at).toBeNull();
      expect(await storage.exists(orphan.original_key)).toBe(true);
      // The next run finishes the job (the preview is already gone: fine).
      expect((await service.runRetention(NOW)).purgedOrphans).toBe(1);
      expect(await storage.exists(orphan.original_key)).toBe(false);
    });

    it('never reverts once the original is deleted', async () => {
      const orphan = await seed(2, { created_at: daysAgo(40) });
      const del = jest.spyOn(storage, 'delete');
      const r = await service.runRetention(NOW);
      expect(r.purgedOrphans).toBe(1);
      expect(del).toHaveBeenCalledTimes(1);
      expect(orphan.purged_at).toEqual(NOW);
      expect(prisma.customerUpload.update).not.toHaveBeenCalled();
    });

    it('registers itself as the customer-uploads retention task', async () => {
      const registerTask = jest.fn<void, [unknown]>();
      const svc = new CustomerUploadsService(
        prisma as unknown as PrismaService,
        new UploadsService(),
        storage,
        { registerTask } as unknown as RetentionService,
      );
      svc.onModuleInit();
      expect(registerTask).toHaveBeenCalledTimes(1);
      const task = registerTask.mock.calls[0][0] as {
        key: string;
        run: (
          now: Date,
          o: { dryRun: boolean; limit: number },
        ) => Promise<unknown>;
      };
      expect(task.key).toBe('customer-uploads');
      await seed(2, { created_at: daysAgo(40) });
      await expect(task.run(NOW, { dryRun: true, limit: 10 })).resolves.toEqual(
        {
          purged: 1,
          skipped: 0,
          errors: 0,
          details: {
            purgedAttached: 0,
            purgedOrphans: 1,
            skippedOpenOrders: 0,
            errors: 0,
          },
        },
      );
    });
  });
});

describe('customer upload helpers', () => {
  it('parseCustomerPreviewId accepts only the exact preview path', () => {
    const previewIdOf = parseCustomerPreviewId;
    const id = uuid(7);
    expect(previewIdOf(`/uploads/customer-previews/${id}.webp`)).toBe(id);
    expect(
      previewIdOf(`http://localhost:3001/uploads/customer-previews/${id}.webp`),
    ).toBe(id);
    expect(previewIdOf(`x/uploads/customer-previews/${id}.webp`)).toBeNull();
    expect(previewIdOf(`/uploads/customer-previews/${id}.png`)).toBeNull();
    expect(previewIdOf(`/uploads/custom-fields/${id}.webp`)).toBeNull();
    expect(
      previewIdOf(`javascript:/uploads/customer-previews/${id}.webp`),
    ).toBeNull();
    expect(previewIdOf(42)).toBeNull();
    // Query strings and fragments are refused everywhere (one parser).
    expect(previewIdOf(`/uploads/customer-previews/${id}.webp?v=1`)).toBeNull();
    expect(
      previewIdOf(`https://a.example/uploads/customer-previews/${id}.webp#x`),
    ).toBeNull();
  });

  it('sanitizeFileName strips paths and unsafe characters', () => {
    expect(sanitizeFileName('C:\\fakepath\\a"b<c>.png')).toBe('abc.png');
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('..')).toBe('file');
    expect(sanitizeFileName(undefined)).toBe('file');
    expect(sanitizeFileName(`${'x'.repeat(300)}.jpeg`)).toHaveLength(255);
  });

  it('sanitizeFileName strips bidi/format characters and decodes multer latin1 names', () => {
    // RIGHT-TO-LEFT OVERRIDE would show "photo<U+202E>gnp.exe" as "photoexe.png".
    expect(sanitizeFileName('photo\u202Egnp.exe')).toBe('photognp.exe');
    expect(sanitizeFileName('a\u200Bb\u2066c\uFEFF.png')).toBe('abc.png');
    // multer hands UTF-8 names over as latin1.
    const latin1 = Buffer.from('bröllop åäö.png', 'utf8').toString('latin1');
    expect(sanitizeFileName(latin1)).toBe('bröllop åäö.png');
    // A genuine latin1 name that is not valid UTF-8 is kept.
    expect(sanitizeFileName('caf\u00e9.png')).toBe('café.png');
  });
});

function baseRow(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    store_id: null,
    original_key: `customer-uploads/2026/01/${id}.png`,
    original_name: 'a.png',
    mime: 'image/png',
    bytes: 4,
    width: 1,
    height: 1,
    sha256: '0'.repeat(64),
    preview_url: `/uploads/customer-previews/${id}.webp`,
    created_at: new Date('2026-10-01T00:00:00Z'),
    attached_at: null,
    purged_at: null,
    values: [],
    ...over,
  };
}

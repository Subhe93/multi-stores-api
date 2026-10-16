jest.mock('../../../common/uploads/raster-inspect', () => ({
  inspectRaster: jest.fn(),
}));

import type { Prisma } from '@prisma/client';
import { inspectRaster } from '../../../common/uploads/raster-inspect';
import type { PrivateStorage } from '../../../common/storage/private-file-storage';
import {
  IMPORT_DECODE_OPTS,
  MEDIA_MAX_PIXELS,
  MEDIA_QUOTA_DEFAULT_BYTES,
  MediaImporter,
  mediaQuotaBytes,
  type MediaNeed,
} from './media-importer';

// M4.4 fixer B: imported rasters are decoded first-frame-only with a pixel
// cap, animated bombs (frames x w x h) are refused, and a per-store media
// byte quota over a rolling 24 h window applies (IMPORT_MEDIA_QUOTA).

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(92),
]);
const inspect = inspectRaster as jest.MockedFunction<typeof inspectRaster>;

function setup(opts: { usedBytes?: number; quotaBytes?: number } = {}) {
  const db = {
    importMedia: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      findMany: jest.fn(() => Promise.resolve([])),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...data }),
      ),
      update: jest.fn(),
      aggregate: jest.fn(() =>
        Promise.resolve({ _sum: { bytes: opts.usedBytes ?? 0 } }),
      ),
    },
  };
  const fetcher = {
    get: jest.fn((url: string) =>
      Promise.resolve({ status: 200, body: PNG, url, headers: {} }),
    ),
  };
  const uploads = {
    storeBuffer: jest.fn(() =>
      Promise.resolve({ url: '/uploads/imports/x.webp' }),
    ),
  };
  const mi = new MediaImporter({
    db: db as unknown as Prisma.TransactionClient,
    fetcher: fetcher as never,
    uploads,
    storage: { write: jest.fn() } as unknown as PrivateStorage,
    storeId: 's1',
    runId: 'r1',
    quotaBytes: opts.quotaBytes,
  });
  return { mi, db, fetcher, uploads };
}

const need = (n: number): MediaNeed => ({
  source_url: `https://shop.example/wp-content/uploads/${n}.png`,
  candidates: [`https://shop.example/wp-content/uploads/${n}.png`],
  target: 'public',
});

beforeEach(() => {
  inspect.mockReset();
  inspect.mockResolvedValue({
    format: 'png',
    width: 100,
    height: 100,
    pages: 1,
  });
});

describe('MediaImporter decode options', () => {
  it('stores public images first-frame-only with the pixel cap', async () => {
    const { mi, uploads } = setup();
    const res = await mi.ensure(need(1));
    expect(res.ok).toBe(true);
    expect(uploads.storeBuffer).toHaveBeenCalledWith(
      PNG,
      '.png',
      'imports',
      IMPORT_DECODE_OPTS,
    );
    expect(IMPORT_DECODE_OPTS).toEqual({
      animated: false,
      limitInputPixels: MEDIA_MAX_PIXELS,
    });
  });

  it('refuses an animated image whose frames together exceed the pixel cap', async () => {
    inspect.mockResolvedValue({
      format: 'gif',
      width: 2000,
      height: 2000,
      pages: 11, // 11 x 4 MP = 44 MP > 40 MP
    });
    const { mi, uploads } = setup();
    const res = await mi.ensure(need(2));
    expect(res).toMatchObject({ ok: false, code: 'IMPORT_MEDIA_TOO_LARGE' });
    expect(uploads.storeBuffer).not.toHaveBeenCalled();
  });

  it('accepts an animated image under the cap', async () => {
    inspect.mockResolvedValue({
      format: 'gif',
      width: 500,
      height: 500,
      pages: 10,
    });
    const { mi } = setup();
    expect((await mi.ensure(need(3))).ok).toBe(true);
  });
});

describe('MediaImporter store quota', () => {
  it('reads IMPORT_MEDIA_QUOTA_BYTES (default 2 GB)', () => {
    expect(mediaQuotaBytes({})).toBe(MEDIA_QUOTA_DEFAULT_BYTES);
    expect(MEDIA_QUOTA_DEFAULT_BYTES).toBe(2 * 1024 * 1024 * 1024);
    expect(mediaQuotaBytes({ IMPORT_MEDIA_QUOTA_BYTES: '1000' })).toBe(1000);
    expect(mediaQuotaBytes({ IMPORT_MEDIA_QUOTA_BYTES: 'x' })).toBe(
      MEDIA_QUOTA_DEFAULT_BYTES,
    );
    expect(mediaQuotaBytes({ IMPORT_MEDIA_QUOTA_BYTES: '0' })).toBe(
      MEDIA_QUOTA_DEFAULT_BYTES,
    );
  });

  it('refuses without downloading when the last 24 h already used the quota', async () => {
    const { mi, fetcher, db } = setup({ usedBytes: 500, quotaBytes: 400 });
    const res = await mi.ensure(need(4));
    expect(res).toMatchObject({ ok: false, code: 'IMPORT_MEDIA_QUOTA' });
    expect(fetcher.get).not.toHaveBeenCalled();
    const arg = (db.importMedia.aggregate.mock.calls[0] as unknown[])[0] as {
      where: { store_id: string; created_at: { gte: Date } };
    };
    expect(arg.where.store_id).toBe('s1');
    expect(Date.now() - arg.where.created_at.gte.getTime()).toBeGreaterThan(
      23 * 3600 * 1000,
    );
  });

  it('counts this run on top of the window and stops at the quota', async () => {
    // 100-byte images, 250 bytes quota with 0 used: two fit, the third not.
    const { mi, db } = setup({ usedBytes: 0, quotaBytes: 250 });
    const results = await mi.ensureAll([need(5), need(6), need(7)], 1);
    expect(results.map((r) => r.ok)).toEqual([true, true, false]);
    expect(results[2]).toMatchObject({ code: 'IMPORT_MEDIA_QUOTA' });
    // The window is read once per importer.
    expect(db.importMedia.aggregate).toHaveBeenCalledTimes(1);
  });

  it('a reused image (ledger hit) does not count', async () => {
    const { mi, db, fetcher } = setup({ usedBytes: 1000, quotaBytes: 10 });
    db.importMedia.findUnique.mockResolvedValueOnce({
      source_url: need(8).source_url,
      public_url: '/uploads/imports/old.webp',
      private_key: null,
      sha256: 'x',
      mime: 'image/png',
      width: 1,
      height: 1,
    } as never);
    expect((await mi.ensure(need(8))).ok).toBe(true);
    expect(fetcher.get).not.toHaveBeenCalled();
  });
});

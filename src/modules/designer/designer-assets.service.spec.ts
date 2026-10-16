import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { DesignAssetKind } from '@prisma/client';
import {
  isValidPrivateStorageKey,
  PrivateFileStorage,
} from '../../common/storage/private-file-storage';
import { RasterInspectError } from '../../common/uploads/raster-inspect';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import {
  DesignerAssetsService,
  rasterError,
  Semaphore,
  templateAssetChecks,
} from './designer-assets.service';
import { designerErrorCode } from './designer-errors';
import {
  fakeDesignerPrisma,
  type FakeDesignerDb,
} from './designer-fake-prisma.mockspec';
import { DESIGNER_FILES_PATH, DesignerUrlsService } from './designer-urls';

const STORE = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const TPL = '44444444-4444-4444-8444-444444444444';

function png(w: number, h: number, alpha = false): Promise<Buffer> {
  return sharp({
    create: {
      width: w,
      height: h,
      channels: alpha ? 4 : 3,
      background: alpha
        ? { r: 10, g: 20, b: 30, alpha: 0.5 }
        : { r: 10, g: 20, b: 30 },
    },
  })
    .png()
    .toBuffer();
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return designerErrorCode(e) ?? `THROWN:${String(e)}`;
  }
}

describe('DesignerAssetsService', () => {
  let root: string;
  let db: FakeDesignerDb;
  let storage: PrivateFileStorage;
  let enabled: Set<string>;
  let svc: DesignerAssetsService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'designer-assets-'));
    storage = new PrivateFileStorage(root);
    db = {
      assets: [],
      templates: [],
      designs: [],
      orderItemDesigns: [],
      refCounts: [],
    };
    enabled = new Set([STORE]);
    process.env.DESIGNER_URL_SECRET = 'spec-secret-0123456789abcdef';
    const storeApps = {
      isEnabled: jest.fn((id: string) => Promise.resolve(enabled.has(id))),
    } as unknown as StoreAppsService;
    svc = new DesignerAssetsService(
      fakeDesignerPrisma(db) as unknown as PrismaService,
      storage,
      storeApps,
      new DesignerUrlsService(),
    );
  });

  afterEach(async () => {
    delete process.env.DESIGNER_URL_SECRET;
    await fs.rm(root, { recursive: true, force: true });
  });

  describe('template assets', () => {
    it('stores a print background privately under designer/ with exact bytes', async () => {
      const buf = await png(3000, 4200);
      const r = await svc.storeTemplateAsset(STORE, {
        buffer: buf,
        kind: DesignAssetKind.TEMPLATE_BG_PRINT,
      });
      expect(r.deduped).toBe(false);
      expect(r.warnings).toEqual([]);
      expect(r.resolution).toEqual({
        template_mm: { width: 500, height: 700 },
        template_size_source: 'default',
        target_px: { width: 3000, height: 4200 },
        effective_dpi: 152.4,
      });
      const row = db.assets[0];
      expect(row.private_key).toMatch(
        new RegExp(`^designer/${STORE}/\\d{4}/bg-print/${row.id}\\.png$`),
      );
      expect(isValidPrivateStorageKey(row.private_key)).toBe(true);
      expect(row.public_url).toBeNull();
      expect(row).toMatchObject({
        width: 3000,
        height: 4200,
        mime: 'image/png',
      });
      expect((await storage.read(row.private_key!))!.equals(buf)).toBe(true);
      // Private kind → signed, short-lived URL.
      expect(r.asset.public).toBe(false);
      expect(r.asset.url!.startsWith(DESIGNER_FILES_PATH)).toBe(true);
    });

    it('warns (never blocks) on a low-resolution print background and aspect mismatch', async () => {
      const r = await svc.storeTemplateAsset(STORE, {
        buffer: await png(1000, 1000),
        kind: DesignAssetKind.TEMPLATE_BG_PRINT,
      });
      expect(r.warnings.map((w) => w.code)).toEqual([
        'PRINT_BG_LOW_RES',
        'ASPECT_MISMATCH',
      ]);
      expect(r.warnings[0].params).toMatchObject({
        target_width: 3000,
        target_height: 4200,
        effective_dpi: 36.3, // min(1000 px over 500 mm, 1000 px over 700 mm)
      });
      expect(db.assets).toHaveLength(1);
    });

    it('checks against the template trim size when template_id is given', async () => {
      db.templates.push({
        id: TPL,
        store_id: STORE,
        current_version_id: 'v2',
        versions: [
          { id: 'v2', spec: { width: 300, height: 400 } },
          { id: 'v1', spec: { width: 500, height: 700 } },
        ],
      });
      const r = await svc.storeTemplateAsset(STORE, {
        buffer: await png(600, 800),
        kind: DesignAssetKind.TEMPLATE_BG_WEB,
        template_id: TPL,
      });
      expect(r.resolution).toMatchObject({
        template_mm: { width: 300, height: 400 },
        template_size_source: 'template',
        target_px: { width: 600, height: 800 },
      });
      expect(r.warnings).toEqual([]);
      expect(db.assets[0].meta).toEqual({ template_id: TPL });
      // Web backgrounds are public at a stable path.
      expect(r.asset.public).toBe(true);
      expect(r.asset.url).toBe(`/api/designer/assets/${db.assets[0].id}.png`);
      expect(db.assets[0].public_url).toBe(r.asset.url);
    });

    it("404s another store's template", async () => {
      db.templates.push({ id: TPL, store_id: OTHER, versions: [] });
      expect(
        await codeOf(
          svc.storeTemplateAsset(STORE, {
            buffer: await png(10, 10),
            kind: DesignAssetKind.TEMPLATE_DECO,
            template_id: TPL,
          }),
        ),
      ).toBe('DESIGNER_TEMPLATE_NOT_FOUND');
    });

    it('dedupes identical bytes of the same kind', async () => {
      const buf = await png(100, 100, true);
      const a = await svc.storeTemplateAsset(STORE, {
        buffer: buf,
        kind: DesignAssetKind.TEMPLATE_DECO,
      });
      const b = await svc.storeTemplateAsset(STORE, {
        buffer: buf,
        kind: DesignAssetKind.TEMPLATE_DECO,
        source_url: 'https://namez.se/x.png',
      });
      expect(b.deduped).toBe(true);
      expect(b.asset.id).toBe(a.asset.id);
      expect(db.assets).toHaveLength(1);
    });

    it('replace flow: a new asset row that records what it supersedes', async () => {
      const old = await svc.storeTemplateAsset(STORE, {
        buffer: await png(1500, 2100),
        kind: DesignAssetKind.TEMPLATE_BG_PRINT,
      });
      const r = await svc.storeTemplateAsset(STORE, {
        buffer: await png(3000, 4200),
        kind: DesignAssetKind.TEMPLATE_BG_PRINT,
        replaces_asset_id: old.asset.id,
      });
      expect(r.replaces).toBe(old.asset.id);
      expect(r.asset.id).not.toBe(old.asset.id);
      expect(db.assets).toHaveLength(2);
      expect(db.assets[1].meta).toEqual({ replaces: old.asset.id });
      // The old bytes stay (published versions / orders may use them).
      expect(await storage.exists(db.assets[0].private_key!)).toBe(true);

      expect(
        await codeOf(
          svc.storeTemplateAsset(STORE, {
            buffer: await png(500, 700),
            kind: DesignAssetKind.TEMPLATE_BG_WEB,
            replaces_asset_id: old.asset.id,
          }),
        ),
      ).toBe('DESIGNER_ASSET_KIND');
    });

    it('rejects photos, GIF, corrupt and oversized files', async () => {
      expect(
        await codeOf(
          svc.storeTemplateAsset(STORE, {
            buffer: await png(10, 10),
            kind: DesignAssetKind.CUSTOMER_PHOTO,
          }),
        ),
      ).toBe('DESIGNER_ASSET_KIND');
      const gif = await sharp(await png(20, 20))
        .gif()
        .toBuffer();
      expect(
        await codeOf(
          svc.storeTemplateAsset(STORE, {
            buffer: gif,
            kind: DesignAssetKind.TEMPLATE_DECO,
          }),
        ),
      ).toBe('DESIGNER_UPLOAD_TYPE');
      const truncated = (await png(400, 400)).subarray(0, 120);
      expect(
        await codeOf(
          svc.storeTemplateAsset(STORE, {
            buffer: truncated,
            kind: DesignAssetKind.TEMPLATE_DECO,
          }),
        ),
      ).toBe('DESIGNER_UPLOAD_CORRUPT');
      expect(
        await codeOf(
          svc.storeTemplateAsset(STORE, {
            buffer: Buffer.alloc(40 * 1024 * 1024 + 1),
            kind: DesignAssetKind.TEMPLATE_DECO,
          }),
        ),
      ).toBe('DESIGNER_UPLOAD_TOO_LARGE');
      expect(db.assets).toHaveLength(0);
    });

    it('normalizes EXIF-rotated input (dimensions after rotation)', async () => {
      const jpg = await sharp({
        create: { width: 400, height: 300, channels: 3, background: '#0a0' },
      })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toBuffer();
      const r = await svc.storeTemplateAsset(STORE, {
        buffer: jpg,
        kind: DesignAssetKind.TEMPLATE_DECO,
      });
      expect(r.warnings.map((w) => w.code)).toEqual(['COLOR_CONVERTED']);
      expect([r.asset.width, r.asset.height]).toEqual([300, 400]);
      const meta = await sharp(
        (await storage.read(db.assets[0].private_key!))!,
      ).metadata();
      expect(meta.orientation ?? 1).toBe(1);
    });
  });

  describe('customer photos (§6.2)', () => {
    it('EXIF-orients, strips metadata and writes a private WebP preview', async () => {
      const jpg = await sharp({
        create: { width: 2400, height: 1800, channels: 3, background: '#357' },
      })
        .jpeg()
        .withMetadata({
          orientation: 6,
          exif: { IFD0: { Make: 'Phone' }, IFD3: { GPSLatitudeRef: 'N' } },
        })
        .toBuffer();
      const row = await svc.storePhoto(STORE, jpg, { design_id: null });
      expect(row.kind).toBe(DesignAssetKind.CUSTOMER_PHOTO);
      expect([row.width, row.height]).toEqual([1800, 2400]);
      expect(row.private_key).toMatch(/\/photo\/[0-9a-f-]{36}\.jpg$/);
      expect(row.preview_key).toMatch(/\/photo-preview\/[0-9a-f-]{36}\.webp$/);
      const orig = await sharp(
        (await storage.read(row.private_key!))!,
      ).metadata();
      expect(orig.exif).toBeUndefined();
      expect(orig.orientation ?? 1).toBe(1);
      const prev = await sharp(
        (await storage.read(row.preview_key!))!,
      ).metadata();
      expect(prev.format).toBe('webp');
      expect(Math.max(prev.width, prev.height)).toBe(1600);
      const view = svc.assetView(row);
      expect(view.url!.startsWith(DESIGNER_FILES_PATH)).toBe(true);
      expect(view.preview_url!.startsWith(DESIGNER_FILES_PATH)).toBe(true);
    });

    it('enforces the short side ≥ 300 px and the size cap', async () => {
      expect(await codeOf(svc.storePhoto(STORE, await png(299, 800)))).toBe(
        'DESIGNER_UPLOAD_DIMENSIONS',
      );
      expect(
        await codeOf(
          svc.storePhoto(STORE, await png(400, 400), { max_bytes: 100 }),
        ),
      ).toBe('DESIGNER_UPLOAD_TOO_LARGE');
    });
  });

  describe('fixer B hardening', () => {
    it('re-encodes a display-ready image that carries EXIF/XMP (no metadata served)', async () => {
      const jpg = await sharp({
        create: { width: 400, height: 300, channels: 3, background: '#0a0' },
      })
        .jpeg()
        .withExif({ IFD0: { Copyright: 'secret-owner', Artist: 'gps-person' } })
        .toBuffer();
      expect((await sharp(jpg).metadata()).exif).toBeDefined();
      await svc.storeTemplateAsset(STORE, {
        buffer: jpg,
        kind: DesignAssetKind.TEMPLATE_DECO,
      });
      const stored = (await storage.read(db.assets[0].private_key!))!;
      const meta = await sharp(stored).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(stored.includes(Buffer.from('secret-owner'))).toBe(false);
    });

    it('serves public bytes from the in-process cache; purge evicts', async () => {
      const r = await svc.storeTemplateAsset(STORE, {
        buffer: await png(1000, 1400),
        kind: DesignAssetKind.TEMPLATE_BG_WEB,
      });
      const read = jest.spyOn(storage, 'read');
      await svc.readPublicAsset(r.asset.id, 'png');
      await svc.readPublicAsset(r.asset.id, 'png');
      expect(read).toHaveBeenCalledTimes(1);
      expect(svc.publicCache.size).toBe(1);
      await svc.purgeAssetFiles(db.assets[0] as never);
      expect(svc.publicCache.size).toBe(0);
    });

    it('a saturated image pipeline fails fast with 503 DESIGNER_UPLOAD_BUSY', async () => {
      const sem = new Semaphore(1, 1);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const a = sem.run(() => gate);
      const b = sem.run(() => Promise.resolve(2));
      expect(await codeOf(sem.run(() => Promise.resolve(3)))).toBe(
        'DESIGNER_UPLOAD_BUSY',
      );
      release();
      await a;
      await expect(b).resolves.toBe(2);
    });
  });

  describe('serving', () => {
    it('public asset: served while the app is on, 404 when off or wrong ext/kind', async () => {
      const r = await svc.storeTemplateAsset(STORE, {
        buffer: await png(1000, 1400),
        kind: DesignAssetKind.TEMPLATE_BG_WEB,
      });
      const body = await svc.readPublicAsset(r.asset.id, 'png');
      expect(body.mime).toBe('image/png');
      expect(body.sha256).toBe(r.asset.sha256);
      expect(await codeOf(svc.readPublicAsset(r.asset.id, 'jpg'))).toBe(
        'DESIGNER_FILE_NOT_FOUND',
      );
      enabled.clear();
      expect(await codeOf(svc.readPublicAsset(r.asset.id, 'png'))).toBe(
        'DESIGNER_NOT_ENABLED',
      );
      // A print background is never public.
      enabled.add(STORE);
      const p = await svc.storeTemplateAsset(STORE, {
        buffer: await png(3000, 4200),
        kind: DesignAssetKind.TEMPLATE_BG_PRINT,
      });
      expect(await codeOf(svc.readPublicAsset(p.asset.id, 'png'))).toBe(
        'DESIGNER_FILE_NOT_FOUND',
      );
    });

    it('signed asset link: valid, tampered, other store, app off, purged', async () => {
      const p = await svc.storeTemplateAsset(STORE, {
        buffer: await png(3000, 4200),
        kind: DesignAssetKind.TEMPLATE_BG_PRINT,
      });
      const token = p.asset.url!.slice(DESIGNER_FILES_PATH.length);
      const ok = await svc.readSignedFile(token);
      expect(ok.mime).toBe('image/png');
      expect(ok.buffer.length).toBe(p.asset.bytes);

      expect(await codeOf(svc.readSignedFile(token.slice(0, -2) + 'xx'))).toBe(
        'DESIGNER_FILE_NOT_FOUND',
      );
      // A token for the same id but another store does not open the row.
      const urls = new DesignerUrlsService();
      enabled.add(OTHER);
      const foreign = urls
        .signedPath('asset', p.asset.id, OTHER)
        .slice(DESIGNER_FILES_PATH.length);
      expect(await codeOf(svc.readSignedFile(foreign))).toBe(
        'DESIGNER_FILE_NOT_FOUND',
      );
      // Expired.
      const expired = urls
        .signedPath('asset', p.asset.id, STORE, { ttlSec: -10 })
        .slice(DESIGNER_FILES_PATH.length);
      expect(await codeOf(svc.readSignedFile(expired))).toBe(
        'DESIGNER_LINK_EXPIRED',
      );
      enabled.delete(STORE);
      expect(await codeOf(svc.readSignedFile(token))).toBe(
        'DESIGNER_NOT_ENABLED',
      );
      enabled.add(STORE);
      await svc.purgeAssetFiles(db.assets[0]);
      expect(
        await storage.exists(p.asset.url ? db.assets[0].private_key! : ''),
      ).toBe(false);
      expect(await codeOf(svc.readSignedFile(token))).toBe(
        'DESIGNER_FILES_PURGED',
      );
    });

    it('photo_preview links only open customer photos', async () => {
      const deco = await svc.storeTemplateAsset(STORE, {
        buffer: await png(50, 50),
        kind: DesignAssetKind.TEMPLATE_DECO,
      });
      const t = new DesignerUrlsService()
        .signedPath('photo_preview', deco.asset.id, STORE)
        .slice(DESIGNER_FILES_PATH.length);
      expect(await codeOf(svc.readSignedFile(t))).toBe(
        'DESIGNER_FILE_NOT_FOUND',
      );
    });

    it('oid_proof: works with the app off, 410 after the files purge', async () => {
      const oid = '55555555-5555-4555-8555-555555555555';
      const key = `designer/${STORE}/2026/proof/${oid}.webp`;
      const webp = await sharp(await png(20, 20))
        .webp()
        .toBuffer();
      await storage.write(key, webp);
      db.orderItemDesigns.push({
        id: oid,
        store_id: STORE,
        proof_key: key,
        files_purged_at: null,
      });
      const t = new DesignerUrlsService()
        .signedPath('oid_proof', oid, STORE)
        .slice(DESIGNER_FILES_PATH.length);
      enabled.clear();
      const body = await svc.readSignedFile(t);
      expect(body.mime).toBe('image/webp');
      db.orderItemDesigns[0].files_purged_at = new Date();
      expect(await codeOf(svc.readSignedFile(t))).toBe('DESIGNER_FILES_PURGED');
    });
  });

  describe('delete', () => {
    it('refuses an asset referenced by a template version or an order', async () => {
      const r = await svc.storeTemplateAsset(STORE, {
        buffer: await png(50, 50),
        kind: DesignAssetKind.TEMPLATE_DECO,
      });
      db.refCounts = [1, 0];
      expect(await codeOf(svc.deleteAsset(STORE, r.asset.id))).toBe(
        'DESIGNER_ASSET_IN_USE',
      );
      db.refCounts = [0, 0];
      const key = db.assets[0].private_key!;
      await expect(svc.deleteAsset(STORE, r.asset.id)).resolves.toEqual({
        deleted: true,
      });
      expect(db.assets).toHaveLength(0);
      expect(await storage.exists(key)).toBe(false);
    });

    it("404s another store's asset and refuses customer photos", async () => {
      const r = await svc.storeTemplateAsset(STORE, {
        buffer: await png(50, 50),
        kind: DesignAssetKind.TEMPLATE_DECO,
      });
      expect(await codeOf(svc.deleteAsset(OTHER, r.asset.id))).toBe(
        'DESIGNER_ASSET_NOT_FOUND',
      );
      const photo = await svc.storePhoto(STORE, await png(400, 400));
      expect(await codeOf(svc.deleteAsset(STORE, photo.id))).toBe(
        'DESIGNER_ASSET_KIND',
      );
    });
  });

  it('lists template assets only (never customer photos)', async () => {
    await svc.storeTemplateAsset(STORE, {
      buffer: await png(50, 50),
      kind: DesignAssetKind.TEMPLATE_DECO,
    });
    await svc.storePhoto(STORE, await png(400, 400));
    const list = await svc.listTemplateAssets(STORE);
    expect(list.total).toBe(1);
    expect(list.items[0].kind).toBe(DesignAssetKind.TEMPLATE_DECO);
    const owned = await svc.findOwnedAssets(STORE, [
      list.items[0].id,
      'not-a-uuid',
    ]);
    expect([...owned.keys()]).toEqual([list.items[0].id]);
    expect((await svc.findOwnedAssets(OTHER, [list.items[0].id])).size).toBe(0);
  });
});

describe('templateAssetChecks / rasterError (pure)', () => {
  it('flags an oversized web background', () => {
    const r = templateAssetChecks(
      DesignAssetKind.TEMPLATE_BG_WEB,
      3000,
      4200,
      { width: 500, height: 700 },
      'default',
    );
    expect(r.warnings.map((w) => w.code)).toEqual(['WEB_BG_LARGE']);
  });

  it('has no resolution check for decorations and thumbnails', () => {
    expect(
      templateAssetChecks(
        DesignAssetKind.TEMPLATE_DECO,
        1,
        1,
        { width: 500, height: 700 },
        'default',
      ),
    ).toEqual({ warnings: [], resolution: null });
  });

  it('maps raster inspection codes to designer codes', () => {
    expect(
      designerErrorCode(rasterError(new RasterInspectError('RASTER_ANIMATED'))),
    ).toBe('DESIGNER_UPLOAD_TYPE');
    expect(
      designerErrorCode(
        rasterError(new RasterInspectError('RASTER_TOO_MANY_PIXELS')),
      ),
    ).toBe('DESIGNER_UPLOAD_DIMENSIONS');
    expect(designerErrorCode(rasterError(new Error('x')))).toBe(
      'DESIGNER_UPLOAD_CORRUPT',
    );
  });
});

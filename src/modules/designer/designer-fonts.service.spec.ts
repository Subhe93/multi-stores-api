import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DesignAssetKind } from '@prisma/client';
import { PrivateFileStorage } from '../../common/storage/private-file-storage';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import { DesignerAssetsService } from './designer-assets.service';
import { designerErrorCode } from './designer-errors';
import {
  fakeDesignerPrisma,
  type FakeDesignerDb,
} from './designer-fake-prisma.mockspec';
import {
  detectFontFormat,
  DesignerFontsService,
  guessFaceFromFilename,
  normalizeFace,
} from './designer-fonts.service';
import { DesignerUrlsService } from './designer-urls';

const STORE = '22222222-2222-4222-8222-222222222222';

/** Minimal sfnt: header + table directory whose tables lie inside the file. */
function fakeSfnt(
  tags: string[] = ['cmap', 'glyf', 'head', 'name'],
  version = 0x00010000,
  seed = 0,
): Buffer {
  const size = 512;
  const buf = Buffer.alloc(size, seed);
  buf.writeUInt32BE(version, 0);
  buf.writeUInt16BE(tags.length, 4);
  tags.forEach((t, i) => {
    const rec = 12 + i * 16;
    buf.write(t.padEnd(4, ' '), rec, 'latin1');
    buf.writeUInt32BE(0, rec + 4);
    buf.writeUInt32BE(200 + i * 40, rec + 8);
    buf.writeUInt32BE(40, rec + 12);
  });
  return buf;
}

function fakeWoff2(seed = 0): Buffer {
  const buf = Buffer.alloc(400, seed);
  buf.writeUInt32BE(0x774f4632, 0); // wOF2
  buf.writeUInt32BE(0x00010000, 4);
  buf.writeUInt32BE(buf.length, 8);
  buf.writeUInt16BE(4, 12);
  return buf;
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return designerErrorCode(e) ?? `THROWN:${String(e)}`;
  }
}

describe('detectFontFormat (magic bytes + table directory)', () => {
  it('detects ttf, otf and woff2', () => {
    expect(detectFontFormat(fakeSfnt())).toBe('ttf');
    expect(detectFontFormat(fakeSfnt(undefined, 0x74727565))).toBe('ttf'); // 'true'
    expect(
      detectFontFormat(fakeSfnt(['CFF ', 'cmap', 'head', 'name'], 0x4f54544f)),
    ).toBe('otf');
    expect(detectFontFormat(fakeWoff2())).toBe('woff2');
  });

  it('rejects other files and broken directories', () => {
    expect(
      detectFontFormat(Buffer.from('\x89PNG\r\n\x1a\n0000', 'latin1')),
    ).toBeNull();
    expect(detectFontFormat(Buffer.from('wOFF' + '0'.repeat(60)))).toBeNull();
    // Missing glyf in a TrueType font.
    expect(detectFontFormat(fakeSfnt(['cmap', 'head', 'name']))).toBeNull();
    // A table pointing past the end.
    const bad = fakeSfnt();
    bad.writeUInt32BE(10_000, 12 + 8);
    expect(detectFontFormat(bad)).toBeNull();
    // woff2 whose declared length is not the file size.
    const w = fakeWoff2();
    w.writeUInt32BE(9999, 8);
    expect(detectFontFormat(w)).toBeNull();
    expect(detectFontFormat(Buffer.alloc(4))).toBeNull();
  });
});

describe('guessFaceFromFilename', () => {
  it.each([
    ['Montserrat-SemiBold.ttf', 'Montserrat', 600, 'normal'],
    ['Montserrat-SemiBoldItalic.ttf', 'Montserrat', 600, 'italic'],
    ['Montserrat-Italic.ttf', 'Montserrat', 400, 'italic'],
    ['Anton-Regular.ttf', 'Anton', 400, 'normal'],
    ['OpenSans-ExtraBold.ttf', 'Open Sans', 800, 'normal'],
    ['static/Righteous-Regular.ttf', 'Righteous', 400, 'normal'],
    ['montserrat-v26-latin_latin-ext-600.woff2', 'Montserrat', 600, 'normal'],
    ['montserrat-v26-latin-regular.woff2', 'Montserrat', 400, 'normal'],
    ['montserrat-v26-latin-700italic.woff2', 'Montserrat', 700, 'italic'],
  ])('%s → %s %d %s', (name, family, weight, style) => {
    expect(guessFaceFromFilename(name)).toEqual({ family, weight, style });
  });

  it('leaves unknown parts null', () => {
    expect(guessFaceFromFilename('Righteous.ttf')).toEqual({
      family: 'Righteous',
      weight: null,
      style: null,
    });
    expect(guessFaceFromFilename('')).toEqual({
      family: null,
      weight: null,
      style: null,
    });
  });
});

describe('normalizeFace', () => {
  it('trims and defaults the style', () => {
    expect(normalizeFace({ family: '  Open   Sans ', weight: '700' })).toEqual({
      family: 'Open Sans',
      weight: 700,
      style: 'normal',
    });
  });
  it('rejects bad family / weight / style', () => {
    for (const bad of [
      { family: 'x"; }', weight: 400 },
      { family: '', weight: 400 },
      { family: 'Anton', weight: 0 },
      { family: 'Anton', weight: 450.5 },
      { family: 'Anton', weight: 400, style: 'oblique' },
    ]) {
      expect(() => normalizeFace(bad)).toThrow();
    }
  });
});

describe('DesignerFontsService', () => {
  let root: string;
  let db: FakeDesignerDb;
  let enabled: boolean;
  let fonts: DesignerFontsService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'designer-fonts-'));
    db = {
      assets: [],
      templates: [],
      designs: [],
      orderItemDesigns: [],
      refCounts: [],
    };
    enabled = true;
    process.env.DESIGNER_URL_SECRET = 'spec-secret-0123456789abcdef';
    const prisma = fakeDesignerPrisma(db) as unknown as PrismaService;
    const storeApps = {
      isEnabled: jest.fn(() => Promise.resolve(enabled)),
    } as unknown as StoreAppsService;
    const assets = new DesignerAssetsService(
      prisma,
      new PrivateFileStorage(root),
      storeApps,
      new DesignerUrlsService(),
    );
    fonts = new DesignerFontsService(prisma, assets);
  });

  afterEach(async () => {
    delete process.env.DESIGNER_URL_SECRET;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('registers a face from explicit fields and stores it under designer/…/font/', async () => {
    const r = await fonts.registerFont(STORE, fakeWoff2(), {
      family: 'Montserrat',
      weight: 600,
      style: 'normal',
    });
    expect(r.deduped).toBe(false);
    expect(r.font).toMatchObject({
      family: 'Montserrat',
      weight: 600,
      style: 'normal',
      format: 'woff2',
      url: `/api/designer/fonts/${db.assets[0].id}.woff2`,
      superseded: false,
    });
    expect(db.assets[0]).toMatchObject({
      kind: DesignAssetKind.FONT,
      mime: 'font/woff2',
      width: 0,
      height: 0,
    });
    expect(db.assets[0].private_key).toMatch(
      new RegExp(`^designer/${STORE}/\\d{4}/font/[0-9a-f-]{36}\\.woff2$`),
    );
  });

  it('reads the face from a Google file name when fields are missing', async () => {
    const r = await fonts.registerFont(STORE, fakeSfnt(), {
      filename: 'Anton-Regular.ttf',
    });
    expect(r.font).toMatchObject({
      family: 'Anton',
      weight: 400,
      style: 'normal',
      format: 'ttf',
    });
  });

  it('dedupes identical bytes; a new file for the same face supersedes the old one', async () => {
    const a = await fonts.registerFont(STORE, fakeSfnt(), {
      family: 'Anton',
      weight: 400,
    });
    const again = await fonts.registerFont(STORE, fakeSfnt(), {
      family: 'anton',
      weight: 400,
    });
    expect(again.deduped).toBe(true);
    expect(again.font.id).toBe(a.font.id);

    const b = await fonts.registerFont(
      STORE,
      fakeSfnt(undefined, 0x00010000, 7),
      {
        family: 'Anton',
        weight: 400,
      },
    );
    expect(b.replaced).toEqual([a.font.id]);
    const list = await fonts.listFonts(STORE);
    expect(list.map((f) => [f.id, f.superseded])).toEqual([
      [b.font.id, false],
      [a.font.id, true],
    ]);
    const { found, missing } = await fonts.resolveFaces(STORE, [
      { family: 'Anton', weight: 400, style: 'normal' },
      { family: 'Righteous', weight: 400, style: 'normal' },
    ]);
    expect(found.get('anton|400|normal')?.asset_id).toBe(b.font.id);
    expect(missing).toEqual([
      { family: 'Righteous', weight: 400, style: 'normal' },
    ]);
  });

  it('rejects non-font bytes and invalid faces', async () => {
    expect(
      await codeOf(
        fonts.registerFont(STORE, Buffer.alloc(1000, 1), {
          family: 'Anton',
          weight: 400,
        }),
      ),
    ).toBe('DESIGNER_UPLOAD_TYPE');
    expect(
      await codeOf(
        fonts.registerFont(STORE, fakeSfnt(), { filename: 'x.ttf' }),
      ),
    ).toBe('DESIGNER_FONT_INVALID');
    expect(
      await codeOf(
        fonts.registerFont(STORE, Buffer.alloc(11 * 1024 * 1024), {
          family: 'Anton',
          weight: 400,
        }),
      ),
    ).toBe('DESIGNER_UPLOAD_TOO_LARGE');
    expect(db.assets).toHaveLength(0);
  });

  it('serves fonts publicly while the app is on (404 off), and gives renderer bytes', async () => {
    const r = await fonts.registerFont(STORE, fakeWoff2(), {
      family: 'Righteous',
      weight: 400,
    });
    const body = await fonts.readPublicFont(r.font.id, 'woff2');
    expect(body.mime).toBe('font/woff2');
    expect(body.buffer.equals(fakeWoff2())).toBe(true);
    expect(await codeOf(fonts.readPublicFont(r.font.id, 'ttf'))).toBe(
      'DESIGNER_FILE_NOT_FOUND',
    );

    const files = await fonts.fontFiles(STORE, [r.font.id]);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      asset_id: r.font.id,
      family: 'Righteous',
      weight: 400,
      format: 'woff2',
    });

    const forSpec = await fonts.fontsForSpec(STORE, {
      fonts: [{ asset_id: r.font.id }, { asset_id: 'pending:font:x' }],
    });
    expect(forSpec).toEqual([
      {
        asset_id: r.font.id,
        family: 'Righteous',
        weight: 400,
        style: 'normal',
        url: `/api/designer/fonts/${r.font.id}.woff2`,
      },
    ]);

    enabled = false;
    expect(await codeOf(fonts.readPublicFont(r.font.id, 'woff2'))).toBe(
      'DESIGNER_NOT_ENABLED',
    );
  });
});

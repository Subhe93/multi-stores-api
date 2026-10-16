/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- in-memory Prisma fake rows are untyped in tests */
/*
 * NPP import (M4.2 WP7) end to end on the 10 real templates: converter →
 * importer's SafeFetcher (DNS + transport mocked, nothing leaves the
 * process) → designer assets → template + version → product links →
 * rollback. Images are generated with sharp at the dimensions each role
 * needs (print 3000×4200, web 1000×1400, the 4355/4410 big/small swap).
 */
import { createHash } from 'crypto';
import { promises as fs, readdirSync, readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import sharp from 'sharp';
import { DesignAssetKind } from '@prisma/client';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { StoreAppsService } from '../../store-apps/store-apps.service';
import { PrivateFileStorage } from '../../../common/storage/private-file-storage';
import type {
  DesignerTemplateResult,
  DesignerTemplateRollback,
} from '../../../common/ports/designer-import.port';
import type { NTemplate } from '../../importer/model/normalized';
import { SafeFetcher, type Transport } from '../../importer/media/safe-fetch';
import { createFakePrisma } from '../../importer/__fixtures__/fake-prisma';
import { rollbackRun } from '../../importer/apply/rollback';
import type { TemplateSpecV1 } from '../render/design-renderer';
import { DesignerAssetsService } from '../designer-assets.service';
import { DesignerFontsService } from '../designer-fonts.service';
import { DesignerUrlsService } from '../designer-urls';
import { convertNpp } from './npp-converter';
import { NppDesignerImportPort } from './npp-designer-import.port';
import {
  googleFontFileName,
  normalizeNppAddons,
  NPP_IMPORT_WARNING_CODES,
  NppImportService,
} from './npp-import.service';

jest.setTimeout(120_000);

const STORE = '11111111-1111-4111-8111-111111111111';
const OTHER_STORE = '55555555-5555-4555-8555-555555555555';
const CREATOR = '22222222-2222-4222-8222-222222222222';
const OTHER_CREATOR = '66666666-6666-4666-8666-666666666666';
const HOST = 'namez.se';
const PUBLIC_IP = '93.184.216.34';
const FIX = path.join(__dirname, '__fixtures__');

const readFix = (f: string): unknown =>
  JSON.parse(readFileSync(path.join(FIX, f), 'utf8'));
const NTEMPLATES = readFix('ntemplates_postmeta.json') as NTemplate[];
const A_INPUT: unknown[] = [
  ...readdirSync(FIX)
    .filter((f) => /^se_\d+\.json$/.test(f))
    .sort()
    .map(readFix),
  readFix('template_4410.json'),
  readFix('templates.json'),
];
const LINKED = [
  '4273',
  '4281',
  '4308',
  '4315',
  '4350',
  '4355',
  '4359',
  '4364',
  '4368',
];
const ref = (id: string) => `woo:${HOST}:npp_template:${id}`;
const ALL_FACES: [string, number][] = [
  ['Anton', 400],
  ['Montserrat', 400],
  ['Montserrat', 500],
  ['Montserrat', 600],
  ['Montserrat', 700],
  ['Righteous', 400],
];

/* ------------------------------------------------------------------ */
/* Generated images served by the mocked transport                      */
/* ------------------------------------------------------------------ */

const fileOf = (url: string) => path.basename(new URL(url).pathname);
const DIMS_OVERRIDE: Record<string, [number, number] | null> = {
  // 4355 / 4410: NPP stored the big file as web and the small one as print.
  'Studentskylt-pris-big.jpg': [3000, 4200],
  'Studentskylt-pris-small.png': [1000, 1400],
  // 4273: no hi-res file; the web original (too small for print) is used.
  'Stilren-studentskylt-med-foto.jpg': [1000, 1400],
  // 4364: print = web, a full-size file.
  'Studentskylt-med-snabb-leverans.png': [3000, 4200],
  // 4368: the original is gone, only WordPress' -scaled copy exists.
  'Student-2026-12.jpg': null,
  'Student-2026-12-scaled.jpg': [1000, 1400],
};

async function image(url: string, w: number, h: number): Promise<Buffer> {
  const d = createHash('sha256').update(url).digest();
  const img = sharp({
    create: {
      width: w,
      height: h,
      channels: 3,
      background: { r: d[0], g: d[1], b: d[2] },
    },
  });
  return /\.png$/i.test(url)
    ? img.png({ compressionLevel: 1 }).toBuffer()
    : img.jpeg({ quality: 70 }).toBuffer();
}

const IMAGES = new Map<string, Buffer>();
const WOFF2 = (seed: number) => {
  const buf = Buffer.alloc(400, seed);
  buf.writeUInt32BE(0x774f4632, 0);
  buf.writeUInt32BE(0x00010000, 4);
  buf.writeUInt32BE(buf.length, 8);
  buf.writeUInt16BE(4, 12);
  return buf;
};

beforeAll(async () => {
  const conv = convertNpp(NTEMPLATES, {
    siteHost: HOST,
    includeUnlinked: true,
  });
  const want = new Map<string, [number, number]>();
  for (const t of conv.templates)
    for (const f of t.fetch) {
      const base: [number, number] =
        f.role === 'bg_print'
          ? [3000, 4200]
          : f.role === 'bg_web'
            ? [1000, 1400]
            : f.role === 'deco'
              ? [400, 400]
              : [300, 420];
      for (const u of [f.url, f.fallback_url]) {
        if (!u) continue;
        const o = DIMS_OVERRIDE[fileOf(u)];
        if (o === null) continue;
        if (o) want.set(u, o);
        else if (u === f.url && !want.has(u)) want.set(u, base);
      }
    }
  for (const [u, [w, h]] of want) IMAGES.set(u, await image(u, w, h));
});

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

async function makeHarness() {
  const db: any = createFakePrisma();
  // assetReferences: a LIKE over versions / order snapshots, as in SQL.
  db.$queryRaw = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    const needle = String(values[values.length - 1]).replace(/%/g, '');
    const n = sql.includes('"DesignTemplateVersion"')
      ? db.designTemplateVersion.rows.filter((v: any) =>
          JSON.stringify(v.spec).includes(needle),
        ).length
      : db.orderItemDesign.rows.filter(
          (o: any) =>
            JSON.stringify(o.template_spec).includes(needle) ||
            JSON.stringify(o.assets).includes(needle),
        ).length;
    return Promise.resolve([{ n: BigInt(n) }]);
  };
  // DesignerAssetsService.templateSize selects the versions relation.
  const findTemplate = db.designTemplate.findFirst.bind(db.designTemplate);
  db.designTemplate.findFirst = async (args: any) => {
    if (!args?.select?.versions) return findTemplate(args);
    const row = await findTemplate({ where: args.where });
    if (!row) return null;
    const versions = db.designTemplateVersion.rows
      .filter((v: any) => v.template_id === row.id)
      .sort((a: any, b: any) => b.version - a.version);
    return { current_version_id: row.current_version_id ?? null, versions };
  };
  db.store.rows.push(
    { id: STORE, creator_id: CREATOR },
    { id: OTHER_STORE, creator_id: OTHER_CREATOR },
  );
  db.importSource.rows.push({
    id: 'src-1',
    store_id: STORE,
    kind: 'WP_BUNDLE',
    site_host: HOST,
    host_aliases: ['3dnamez.se'],
    settings: {},
  });
  // Every imported product except 4326 (U4).
  const links = convertNpp(A_INPUT, { siteHost: HOST }).product_links;
  const productIdByRef = new Map<string, string>();
  for (const l of links) {
    if (l.product_source_id === '4326') continue;
    const id = `00000000-0000-4000-8000-00000000${l.product_source_id}`;
    productIdByRef.set(l.product_external_ref, id);
    db.product.rows.push({
      id,
      creator_id: CREATOR,
      external_ref: l.product_external_ref,
    });
  }
  db.product.rows.push({
    id: '00000000-0000-4000-8000-000000009999',
    creator_id: OTHER_CREATOR,
    external_ref: null,
  });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'npp-import-'));
  const storage = new PrivateFileStorage(root);
  const enabled = new Set([STORE]);
  const storeApps = {
    isEnabled: jest.fn((id: string) => Promise.resolve(enabled.has(id))),
  } as unknown as StoreAppsService;
  const assets = new DesignerAssetsService(
    db as PrismaService,
    storage,
    storeApps,
    new DesignerUrlsService(),
  );
  const fonts = new DesignerFontsService(db as PrismaService, assets);
  const npp = new NppImportService(db as PrismaService, storage, assets, fonts);
  const port = new NppDesignerImportPort(
    db as PrismaService,
    storeApps,
    npp,
    assets,
  );

  // The importer's SafeFetcher with DNS and the socket mocked.
  const requests: { url: string; address: string }[] = [];
  const transport: Transport = (req) => {
    requests.push({ url: req.url.toString(), address: req.address });
    const body = IMAGES.get(req.url.toString());
    return Promise.resolve({
      status: body ? 200 : 404,
      headers: body ? { 'content-length': String(body.length) } : {},
      body: Readable.from(body ? [body] : []),
      destroy: () => undefined,
    });
  };
  const fetcherFor = jest
    .spyOn(npp, 'fetcherFor')
    .mockImplementation(async (storeId, siteHost) => {
      const policy = await npp.sourcePolicy(storeId, siteHost);
      return new SafeFetcher(
        { siteHost, aliases: policy.aliases },
        {
          lookup: () => Promise.resolve([{ address: PUBLIC_IP, family: 4 }]),
          transport,
          allowPrivate: false,
        },
      );
    });

  const addFonts = async (faces = ALL_FACES) => {
    let seed = 1;
    for (const [family, weight] of faces)
      await fonts.registerFont(STORE, WOFF2(seed++), {
        family,
        weight,
        style: 'normal',
      });
  };
  const runPort = async (
    templates: NTemplate[] = NTEMPLATES,
    opts: { fetch_media?: boolean; media?: Map<string, any> } = {},
  ) => {
    const results: DesignerTemplateResult[] = [];
    const ids = await port.upsertTemplates(
      STORE,
      templates,
      opts.media ?? new Map(),
      {
        fetch_media: opts.fetch_media ?? true,
        site_host: HOST,
        onResult: (r) => {
          results.push(r);
        },
      },
    );
    return { ids, results };
  };
  const templateByRef = (id: string) =>
    db.designTemplate.rows.find((t: any) => t.external_ref === ref(id));
  const versionsOf = (id: string) =>
    db.designTemplateVersion.rows
      .filter((v: any) => v.template_id === templateByRef(id)?.id)
      .sort((a: any, b: any) => a.version - b.version);
  const specOf = (id: string): TemplateSpecV1 => versionsOf(id).at(-1).spec;
  const asset = (id: string) =>
    db.designAsset.rows.find((a: any) => a.id === id);
  const result = (rs: DesignerTemplateResult[], id: string) =>
    rs.find((r) => r.ext_id === ref(id))!;
  const codes = (rs: DesignerTemplateResult[], id: string) =>
    result(rs, id).warnings.map((w) => w.code);

  return {
    db,
    root,
    storage,
    enabled,
    assets,
    fonts,
    npp,
    port,
    requests,
    fetcherFor,
    productIdByRef,
    addFonts,
    runPort,
    templateByRef,
    versionsOf,
    specOf,
    asset,
    result,
    codes,
  };
}

type Harness = Awaited<ReturnType<typeof makeHarness>>;

describe('NPP import (M4.2 WP7)', () => {
  let h: Harness;

  beforeEach(async () => {
    process.env.DESIGNER_URL_SECRET = 'spec-secret-0123456789abcdef';
    h = await makeHarness();
  });

  afterEach(async () => {
    delete process.env.DESIGNER_URL_SECRET;
    await fs.rm(h.root, { recursive: true, force: true });
  });

  describe('importer port: create', () => {
    it('creates the 9 linked templates as DRAFT v1 with real assets; 4410 is excluded', async () => {
      await h.addFonts();
      const { ids, results } = await h.runPort();

      expect([...ids.keys()].sort()).toEqual(LINKED.map(ref).sort());
      expect(h.result(results, '4410').action).toBe('SKIP');
      expect(h.codes(results, '4410')).toContain('TEMPLATE_UNLINKED');
      expect(h.templateByRef('4410')).toBeUndefined();
      for (const id of LINKED) {
        expect(h.result(results, id)).toMatchObject({
          action: 'CREATE',
          pending_assets: [],
        });
        const t = h.templateByRef(id);
        expect(t).toMatchObject({
          store_id: STORE,
          status: 'DRAFT',
          source: 'npp',
          external_ref: ref(id),
        });
        expect(ids.get(ref(id))).toBe(t.id);
        const [v] = h.versionsOf(id);
        expect(v).toMatchObject({ version: 1, created_by: null });
        expect(v.spec_sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(v.thumbnail_url).toMatch(
          /^\/api\/designer\/assets\/[0-9a-f-]{36}\.jpg$/,
        );
        const bg = (v.spec as TemplateSpecV1).surfaces[0].background;
        expect(h.asset(bg.web!.asset_id).kind).toBe(
          DesignAssetKind.TEMPLATE_BG_WEB,
        );
        expect(h.asset(bg.print!.asset_id).kind).toBe(
          DesignAssetKind.TEMPLATE_BG_PRINT,
        );
        // Fonts point at the uploaded faces.
        for (const f of (v.spec as TemplateSpecV1).fonts)
          expect(h.asset(f.asset_id).kind).toBe(DesignAssetKind.FONT);
      }
      // Every warning code is a documented i18n key.
      for (const r of results)
        for (const w of r.warnings)
          expect(NPP_IMPORT_WARNING_CODES).toContain(w.code);
    });

    it('fetches only through the host-locked SafeFetcher, originals first (U9)', async () => {
      await h.addFonts();
      await h.runPort();
      expect(h.requests.length).toBeGreaterThan(0);
      for (const r of h.requests) {
        expect(r.address).toBe(PUBLIC_IP);
        expect(new URL(r.url).hostname).toBe(HOST);
        expect(new URL(r.url).pathname).toMatch(/^\/wp-content\/uploads\//);
      }
      const urls = h.requests.map((r) => r.url);
      // -scaled is requested only where the original failed (4368).
      expect(urls.filter((u) => /-scaled\./.test(u))).toEqual([
        'https://namez.se/wp-content/uploads/2026/04/Student-2026-12-scaled.jpg',
      ]);
      // Shared files are fetched once per run; 4410's own thumbnail never.
      expect(new Set(urls).size).toBe(urls.length);
      expect(urls.some((u) => u.includes('poster-9Nyj8L3k8B4e'))).toBe(false);
    });

    it('applies the background rules with the real dimensions', async () => {
      await h.addFonts();
      const { results } = await h.runPort();

      // 4355: web (3000×4200) > print (1000×1400) → swapped; the swapped
      // files are stored with the kind of their final role (web = public).
      expect(h.codes(results, '4355')).toContain('BG_SWAPPED');
      const bg55 = h.specOf('4355').surfaces[0].background;
      expect(bg55.web).toMatchObject({ width: 1000, height: 1400 });
      expect(bg55.print).toMatchObject({ width: 3000, height: 4200 });
      const web55 = h.asset(bg55.web!.asset_id);
      const print55 = h.asset(bg55.print!.asset_id);
      expect(web55.kind).toBe(DesignAssetKind.TEMPLATE_BG_WEB);
      expect(web55.public_url).toMatch(/^\/api\/designer\/assets\//);
      expect(web55.meta.source_url).toMatch(/Studentskylt-pris-small\.png$/);
      expect(print55.kind).toBe(DesignAssetKind.TEMPLATE_BG_PRINT);
      expect(print55.public_url).toBeNull();
      expect(print55.meta.source_url).toMatch(/Studentskylt-pris-big\.jpg$/);

      // 4273: print from the web original, too small for print.
      expect(h.codes(results, '4273')).toEqual(
        expect.arrayContaining(['PRINT_BG_FROM_WEB', 'PRINT_BG_LOW_RES']),
      );
      const bg73 = h.specOf('4273').surfaces[0].background;
      expect(bg73.print).toMatchObject({ width: 1000, height: 1400 });
      // Same bytes, two kinds → two rows.
      expect(bg73.web!.asset_id).not.toBe(bg73.print!.asset_id);

      // 4364: print = web file.
      expect(h.codes(results, '4364')).toContain('PRINT_BG_SAME_AS_WEB');
      expect(h.codes(results, '4364')).not.toContain('PRINT_BG_LOW_RES');

      // 4368: original missing → -scaled fallback.
      expect(h.codes(results, '4368')).toContain('BG_SCALED_FALLBACK');

      // 4308: three decorations resolved.
      const decos = h
        .specOf('4308')
        .surfaces[0].elements.filter((e) => e.type === 'image');
      expect(decos).toHaveLength(3);
      for (const d of decos) {
        if (d.type !== 'image') continue;
        expect(d.asset).toMatchObject({ width: 400, height: 400 });
        expect(h.asset(d.asset.asset_id).kind).toBe(
          DesignAssetKind.TEMPLATE_DECO,
        );
      }
      // The 4308 / 4355 shared decoration is stored once (sha256 dedupe).
      const decoIds = (id: string) =>
        h
          .specOf(id)
          .surfaces[0].elements.flatMap((e) =>
            e.type === 'image' ? [e.asset.asset_id] : [],
          );
      expect(
        decoIds('4308').filter((x) => decoIds('4355').includes(x)),
      ).toHaveLength(1);

      // Bytes are copied into designer/… keys.
      for (const a of h.db.designAsset.rows)
        expect(a.private_key).toMatch(new RegExp(`^designer/${STORE}/`));
    });

    it('re-run is idempotent: UNCHANGED, no new versions, no new assets', async () => {
      await h.addFonts();
      await h.runPort();
      const versions = h.db.designTemplateVersion.rows.length;
      const assets = h.db.designAsset.rows.length;
      const templates = h.db.designTemplate.rows.length;
      const { ids, results } = await h.runPort();
      expect(
        results.filter((r) => r.action !== 'SKIP').map((r) => r.action),
      ).toEqual(LINKED.map(() => 'UNCHANGED'));
      expect(ids.size).toBe(9);
      expect(h.db.designTemplateVersion.rows).toHaveLength(versions);
      expect(h.db.designAsset.rows).toHaveLength(assets);
      expect(h.db.designTemplate.rows).toHaveLength(templates);
    });

    it('a re-import never appends over a merchant-edited version nor resets a rename', async () => {
      await h.addFonts();
      await h.runPort();
      const t = h.templateByRef('4273');
      const imported = h.versionsOf('4273').at(-1);
      h.db.designTemplateVersion.rows.push({
        ...imported,
        id: '00000000-0000-4000-8000-0000000000e1',
        version: imported.version + 1,
        spec_sha256: 'merchant-edit',
        created_by: 'user-1',
      });
      t.name = 'Min egen skylt';
      // Same source as the last import: plain UNCHANGED (no warning).
      let run = await h.runPort();
      expect(h.result(run.results, '4273').action).toBe('UNCHANGED');
      expect(h.codes(run.results, '4273')).not.toContain('MERCHANT_EDITED');
      expect(h.codes(run.results, '4273')).toContain('NAME_KEPT');
      // The source changed since the last import: still no new version.
      imported.spec_sha256 = 'older-import';
      const before = h.versionsOf('4273').length;
      run = await h.runPort();
      expect(h.result(run.results, '4273').action).toBe('UNCHANGED');
      expect(h.codes(run.results, '4273')).toContain('MERCHANT_EDITED');
      expect(h.versionsOf('4273')).toHaveLength(before);
      expect(h.templateByRef('4273').name).toBe('Min egen skylt');
    });

    it('partial results: a failing template is reported, the others are returned', async () => {
      await h.addFonts();
      const real = (h.npp as any).importTemplate.bind(h.npp);
      jest
        .spyOn(h.npp as any, 'importTemplate')
        .mockImplementation((ctx: any, t: any) =>
          t.source_id === '4281'
            ? Promise.reject(new Error('disk full'))
            : real(ctx, t),
        );
      const { ids, results } = await h.runPort();
      expect(ids.size).toBe(8);
      expect(ids.has(ref('4281'))).toBe(false);
      expect(h.result(results, '4281')).toMatchObject({
        action: 'ERROR',
        error: 'disk full',
      });
    });

    it('a host outside the source is never contacted (SSRF host lock)', async () => {
      await h.addFonts();
      const evil = JSON.parse(
        JSON.stringify(NTEMPLATES.find((t) => t.ext_id === ref('4364'))),
      );
      const bgEl = evil.elements.find((e: any) => e.type === 'background');
      bgEl.imageData = 'https://evil.example/wp-content/uploads/x.png';
      bgEl.imageDataHiRes = 'http://169.254.169.254/latest/meta-data.png';
      const { results } = await h.runPort([evil]);
      const r = h.result(results, '4364');
      expect(
        r.warnings.filter((w) => w.code === 'ASSET_FETCH_FAILED'),
      ).toHaveLength(2);
      expect(r.pending_assets).toEqual(['pending:bg_web', 'pending:bg_print']);
      expect(h.requests.map((x) => new URL(x.url).hostname)).toEqual([HOST]);
    });
  });

  describe('importer port: media scope off', () => {
    it('creates templates with pending assets and a warning, never fetching', async () => {
      await h.addFonts();
      const { results } = await h.runPort(NTEMPLATES, { fetch_media: false });
      expect(h.requests).toHaveLength(0);
      expect(h.fetcherFor).not.toHaveBeenCalled();
      for (const id of LINKED) {
        const r = h.result(results, id);
        expect(r.action).toBe('CREATE');
        expect(r.warnings.map((w) => w.code)).toContain('MEDIA_SKIPPED');
        expect(r.pending_assets).toEqual(
          expect.arrayContaining(['pending:bg_web', 'pending:bg_print']),
        );
      }
      const bg = h.specOf('4308').surfaces[0].background;
      expect(bg.web).toEqual({
        asset_id: 'pending:bg_web',
        width: 0,
        height: 0,
      });
      expect(
        h
          .specOf('4308')
          .surfaces[0].elements.filter(
            (e) =>
              e.type === 'image' &&
              e.asset.asset_id.startsWith('pending:deco:'),
          ),
      ).toHaveLength(3);
      expect(
        h.db.designAsset.rows.filter((a: any) => a.kind !== 'FONT'),
      ).toHaveLength(0);

      // Media scope on again: the same templates get v2 with the files.
      const again = await h.runPort();
      for (const id of LINKED) {
        expect(h.result(again.results, id)).toMatchObject({
          action: 'UPDATE',
          pending_assets: [],
        });
        expect(h.versionsOf(id).map((v: any) => v.version)).toEqual([1, 2]);
      }
    });

    it('copies the importer private copy without fetching (C26)', async () => {
      await h.addFonts();
      const url =
        'https://namez.se/wp-content/uploads/2026/04/Studentskylt-med-snabb-leverans.png';
      const buf = IMAGES.get(url)!;
      const sha = createHash('sha256').update(buf).digest('hex');
      const key = `importer/${STORE}/media/${sha}.png`;
      await h.storage.write(key, buf);
      h.db.importMedia.rows.push({
        store_id: STORE,
        source_url: url,
        fetched_url: url,
        private_key: key,
        sha256: sha,
      });
      const media = new Map([
        [
          url,
          {
            private_key: key,
            sha256: sha,
            mime: 'image/png',
            width: 3000,
            height: 4200,
          },
        ],
      ]);
      const tpl = NTEMPLATES.filter((t) => t.ext_id === ref('4364'));
      const { results } = await h.runPort(tpl, { fetch_media: false, media });
      const r = h.result(results, '4364');
      // The thumbnail is not in the importer map and stays unfetched.
      expect(r.pending_assets).toEqual([]);
      expect(h.requests).toHaveLength(0);
      const bg = h.specOf('4364').surfaces[0].background;
      const web = h.asset(bg.web!.asset_id);
      expect(web).toMatchObject({ sha256: sha, width: 3000, height: 4200 });
      expect(web.private_key).toMatch(/^designer\//);
      expect(web.private_key).not.toBe(key);
      // The importer's file is untouched (its rollback owns it).
      expect(await h.storage.read(key)).toEqual(buf);
    });
  });

  describe('fonts', () => {
    it('missing fonts → FONTS_MISSING listing the files to upload; filled on re-run', async () => {
      const report = await h.npp.importNpp(STORE, NTEMPLATES, {
        siteHost: HOST,
        fetchMedia: true,
        linkProducts: false,
      });
      expect(report.missing_fonts.map((f) => f.file)).toEqual([
        'Anton-Regular.ttf',
        'Montserrat-Regular.ttf',
        'Montserrat-Medium.ttf',
        'Montserrat-SemiBold.ttf',
        'Montserrat-Bold.ttf',
        'Righteous-Regular.ttf',
      ]);
      const t50 = report.templates.find((t) => t.source_id === '4350')!;
      const w = t50.warnings.find((x) => x.code === 'FONTS_MISSING')!;
      expect(w.data).toEqual({
        faces: ['Anton 400 normal', 'Montserrat 600 normal'],
        files: ['Anton-Regular.ttf', 'Montserrat-SemiBold.ttf'],
      });
      expect(t50.pending_assets).toEqual([
        'pending:font:Anton:400:normal',
        'pending:font:Montserrat:600:normal',
      ]);
      expect(h.specOf('4350').fonts.map((f) => f.asset_id)).toEqual(
        t50.pending_assets,
      );

      // Only Montserrat uploaded: 4364 (Righteous) still misses its face.
      await h.addFonts(ALL_FACES.filter(([f]) => f === 'Montserrat'));
      const second = await h.npp.importNpp(STORE, NTEMPLATES, {
        siteHost: HOST,
        fetchMedia: true,
        linkProducts: false,
      });
      expect(second.missing_fonts.map((f) => f.file)).toEqual([
        'Anton-Regular.ttf',
        'Righteous-Regular.ttf',
      ]);
      const t81 = second.templates.find((t) => t.source_id === '4281')!;
      expect(t81).toMatchObject({
        action: 'UPDATE',
        version: 2,
        pending_assets: [],
      });
    });

    it('googleFontFileName follows the Google static file names', () => {
      expect(
        googleFontFileName({
          family: 'Montserrat',
          weight: 600,
          style: 'italic',
        }),
      ).toBe('Montserrat-SemiBoldItalic.ttf');
      expect(
        googleFontFileName({
          family: 'M PLUS 1p',
          weight: 400,
          style: 'italic',
        }),
      ).toBe('MPLUS1p-Italic.ttf');
    });
  });

  describe('direct import with product links (nppProduct pages)', () => {
    it('links 4273 → 16 products after skipping 4326; 4410 unlinked and excluded', async () => {
      await h.addFonts();
      const report = await h.npp.importNpp(STORE, A_INPUT, {
        siteHost: HOST,
        fetchMedia: true,
        skipProductIds: ['4326'],
      });
      expect(
        report.templates.filter((t) => t.action === 'CREATE'),
      ).toHaveLength(9);
      expect(
        report.templates.find((t) => t.source_id === '4410'),
      ).toMatchObject({
        action: 'SKIP',
        template_id: null,
      });
      const t73 = h.templateByRef('4273');
      expect(
        h.db.productDesigner.rows.filter((l: any) => l.template_id === t73.id),
      ).toHaveLength(16);
      expect(h.db.productDesigner.rows).toHaveLength(24);
      for (const l of h.db.productDesigner.rows)
        expect(l).toMatchObject({ store_id: STORE, enabled: false });
      // 4326 is dropped by the converter (U4) and reported once.
      expect(report.links.some((l) => l.product_source_id === '4326')).toBe(
        false,
      );
      expect(report.links.filter((l) => l.action === 'CREATE')).toHaveLength(
        24,
      );
      expect(report.warnings).toEqual([
        expect.objectContaining({
          code: 'PRODUCT_SKIPPED',
          data: { product_id: '4326' },
        }),
      ]);
      // 4275 → 4315 with its own prices; add-ons always disabled (D9).
      const l75 = h.db.productDesigner.rows.find(
        (l: any) =>
          l.product_id === h.productIdByRef.get('woo:namez.se:product:4275'),
      );
      expect(l75.template_id).toBe(h.templateByRef('4315').id);
      expect(l75.addons).toEqual({
        double: { enabled: false, source_enabled: false, price: 199 },
        raincover: { enabled: false, source_enabled: false, price: 29 },
        poster: { enabled: false, source_enabled: false, price: 0 },
        welcome: {
          enabled: false,
          source_enabled: false,
          price: 249,
          regular: 349,
        },
      });

      // Re-run: everything UNCHANGED.
      const again = await h.npp.importNpp(STORE, A_INPUT, {
        siteHost: HOST,
        fetchMedia: true,
        skipProductIds: ['4326'],
      });
      expect(
        new Set(
          again.templates
            .filter((t) => t.action !== 'SKIP')
            .map((t) => t.action),
        ),
      ).toEqual(new Set(['UNCHANGED']));
      expect(
        new Set(
          again.links.filter((l) => l.action !== 'SKIP').map((l) => l.action),
        ),
      ).toEqual(new Set(['UNCHANGED']));
    });

    it('without the skip, the missing 4326 product is reported; includeUnlinked imports 4410', async () => {
      await h.addFonts();
      const report = await h.npp.importNpp(STORE, A_INPUT, {
        siteHost: HOST,
        fetchMedia: true,
        includeUnlinked: true,
      });
      expect(report.warnings.map((w) => w.code)).toEqual(['PRODUCT_NOT_FOUND']);
      expect(report.templates.find((t) => t.source_id === '4410')!.action).toBe(
        'CREATE',
      );
      expect(
        h.codes(
          report.templates.map((t) => ({
            ext_id: t.external_ref,
            template_id: t.template_id,
            action: t.action,
            pending_assets: t.pending_assets,
            warnings: t.warnings.map((w) => ({
              code: w.code,
              message: w.message,
            })),
          })),
          '4410',
        ),
      ).toEqual(expect.arrayContaining(['BG_SWAPPED', 'NAME_REVIEW']));
    });

    it('normalizeNppAddons keeps NPP prices, never enables an add-on', () => {
      expect(normalizeNppAddons(null, null)).toEqual({});
      expect(
        normalizeNppAddons({ double: true }, { double_extra: '149' }).double,
      ).toEqual({ enabled: false, source_enabled: true, price: 149 });
    });
  });

  describe('importer port: links and availability', () => {
    it('linkProduct writes ProductDesigner{enabled:false} in the importer transaction', async () => {
      await h.addFonts();
      const { ids } = await h.runPort(
        NTEMPLATES.filter((t) => t.ext_id === ref('4273')),
      );
      const pid = h.productIdByRef.get('woo:namez.se:product:4347')!;
      await h.db.$transaction((tx: any) =>
        h.port.linkProduct(tx, pid, ids.get(ref('4273'))!, {
          addons: { double: false },
          pricing: { double_extra: 149 },
        }),
      );
      expect(h.db.productDesigner.rows).toEqual([
        expect.objectContaining({
          product_id: pid,
          store_id: STORE,
          template_id: ids.get(ref('4273')),
          enabled: false,
        }),
      ]);
      // A product of another store is refused.
      await expect(
        h.db.$transaction((tx: any) =>
          h.port.linkProduct(
            tx,
            '00000000-0000-4000-8000-000000009999',
            ids.get(ref('4273'))!,
            {},
          ),
        ),
      ).rejects.toThrow(/does not belong/);
    });

    it('acts as the Null port for a store whose designer app is off', async () => {
      h.enabled.clear();
      expect(await h.port.isAvailable(STORE)).toBe(false);
      await expect(h.runPort()).rejects.toThrow(/not available/);
      expect(h.db.designTemplate.rows).toHaveLength(0);
      expect(h.requests).toHaveLength(0);
    });
  });

  describe('rollback', () => {
    const linkAll = async (ids: Map<string, string>) => {
      const links = convertNpp(A_INPUT, {
        siteHost: HOST,
        skipProductIds: ['4326'],
      }).product_links;
      for (const l of links) {
        const pid = h.productIdByRef.get(l.product_external_ref);
        const tid = ids.get(l.template_external_ref);
        if (pid && tid)
          await h.db.$transaction((tx: any) =>
            h.port.linkProduct(tx, pid, tid, l),
          );
      }
    };

    it('deletes created templates, links and files unless orders/designs use them or they were edited', async () => {
      await h.addFonts();
      const since = new Date(Date.now() - 1000);
      const { ids } = await h.runPort();
      await linkAll(ids);
      expect(h.db.productDesigner.rows).toHaveLength(24);
      // 4364 has an order, 4359 a customer design, 4281 was published.
      h.db.orderItemDesign.rows.push({
        id: 'oid-1',
        store_id: STORE,
        template_id: ids.get(ref('4364')),
        template_spec: h.specOf('4364'),
        assets: [],
      });
      h.db.design.rows.push({
        id: 'd-1',
        store_id: STORE,
        template_version_id: h.versionsOf('4359')[0].id,
      });
      h.templateByRef('4281').status = 'PUBLISHED';
      const keep64 = h.specOf('4364').surfaces[0].background.print!.asset_id;
      const gone73 = h.asset(
        h.specOf('4273').surfaces[0].background.print!.asset_id,
      );
      const fontCount = h.db.designAsset.rows.filter(
        (a: any) => a.kind === 'FONT',
      ).length;

      const res = await h.port.rollbackTemplates(STORE, [...ids.values()], {
        created_since: since,
      });
      const by = (id: string) =>
        res.find((r) => r.template_id === ids.get(ref(id)))!;
      expect(by('4364')).toMatchObject({ action: 'KEEP', reason: 'orders' });
      expect(by('4359')).toMatchObject({ action: 'KEEP', reason: 'designs' });
      expect(by('4281')).toMatchObject({ action: 'KEEP', reason: 'edited' });
      expect(by('4273')).toMatchObject({ action: 'DELETE', links_deleted: 16 });
      expect(by('4273').assets_deleted).toBeGreaterThanOrEqual(3);
      expect(
        h.db.designTemplate.rows.map((t: any) => t.external_ref).sort(),
      ).toEqual([ref('4281'), ref('4359'), ref('4364')]);
      expect(h.db.productDesigner.rows).toHaveLength(3);
      // Files of deleted templates are gone, kept templates keep theirs, fonts stay.
      expect(h.asset(gone73.id)).toBeUndefined();
      expect(await h.storage.read(gone73.private_key)).toBeNull();
      expect(h.asset(keep64)).toBeDefined();
      expect(
        h.db.designAsset.rows.filter((a: any) => a.kind === 'FONT'),
      ).toHaveLength(fontCount);
    });

    it('keeps templates that existed before the run', async () => {
      await h.addFonts();
      const { ids } = await h.runPort();
      const res = await h.port.rollbackTemplates(STORE, [...ids.values()], {
        created_since: new Date(Date.now() + 60_000),
      });
      expect(
        new Set(res.map((r: DesignerTemplateRollback) => r.reason)),
      ).toEqual(new Set(['preexisting']));
      expect(h.db.designTemplate.rows).toHaveLength(9);
    });

    it('the importer rollback asks the designer to delete the handed-off templates', async () => {
      await h.addFonts();
      const runId = '77777777-7777-4777-8777-777777777777';
      h.db.importRun.rows.push({
        id: runId,
        store_id: STORE,
        status: 'SUCCEEDED',
        created_at: new Date(Date.now() - 1000),
      });
      const { ids } = await h.runPort();
      for (const [ext, id] of ids)
        h.db.importEntity.rows.push({
          id: `e-${id}`,
          store_id: STORE,
          entity_type: 'DESIGN_TEMPLATE',
          external_ref: ext,
          target_id: id,
          status: 'ACTIVE',
          created_by_import: true,
          first_run_id: runId,
          last_run_id: runId,
        });
      const out = await rollbackRun({
        prisma: h.db,
        storage: h.storage,
        uploads: { deleteFile: () => Promise.resolve() },
        redirects: { invalidate: () => undefined },
        storeId: STORE,
        creatorId: CREATOR,
        runId,
        designer: h.port,
      });
      expect(out.templates).toBe(9);
      expect(out.errors).toBe(0);
      expect(h.db.designTemplate.rows).toHaveLength(0);
      expect(
        h.db.importEntity.rows.every((e: any) => e.status === 'ROLLED_BACK'),
      ).toBe(true);
    });
  });
});

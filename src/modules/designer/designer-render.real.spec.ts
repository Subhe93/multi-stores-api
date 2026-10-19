/**
 * REAL render (M4.2 WP5): launches the local Chromium (DESIGNER_CHROMIUM_PATH /
 * DESIGNER_BROWSER_CHANNEL, the INVOICE_PDF_* fallbacks, else Edge / Chrome on
 * Windows, else Playwright's managed browser) and renders the converted NPP
 * template 4273 (`npp/__fixtures__/expected/`) at 6 px/mm with solid-colour
 * placeholder assets and a local font (Noto Sans from @fontsource, loaded
 * under the template's family name).
 *
 * Skipped automatically when no browser can be launched, or with
 * DESIGNER_RENDER_REAL=0. DESIGNER_RENDER_DUMP=<dir> keeps the print PNG.
 */
import { createHash, randomUUID } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import type { DesignAsset } from '@prisma/client';
import { DesignerRenderService } from './designer-render.service';
import {
  DesignerChromiumHost,
  DesignerRenderUnavailableError,
} from './render/designer-chromium.host';
import type { DesignStateV1, TemplateSpecV1 } from '@multi-stores/core/designer';

jest.setTimeout(120_000);

const STORE = '11111111-1111-4111-8111-111111111111';
const OID = '22222222-2222-4222-8222-222222222222';

const fontFile = (w: number) =>
  readFileSync(
    path.join(
      path.dirname(require.resolve('@fontsource/noto-sans/package.json')),
      'files',
      `noto-sans-latin-${w}-normal.woff2`,
    ),
  );

/** Replaces every `pending:…` id with a stable uuid; returns the mapping. */
function materialize(spec: TemplateSpecV1): {
  spec: TemplateSpecV1;
  ids: Map<string, string>;
} {
  const ids = new Map<string, string>();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string' && v.startsWith('pending:')) {
      if (!ids.has(v)) ids.set(v, randomUUID());
      return ids.get(v);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [
          k,
          walk(x),
        ]),
      );
    }
    return v;
  };
  return { spec: walk(spec) as TemplateSpecV1, ids };
}

const solid = (w: number, h: number, color: string) =>
  sharp({ create: { width: w, height: h, channels: 3, background: color } })
    .png()
    .toBuffer();

const disabled = process.env.DESIGNER_RENDER_REAL === '0';

describe('DesignerRenderService (REAL Chromium render)', () => {
  const host = new DesignerChromiumHost({
    executablePath:
      process.env.DESIGNER_CHROMIUM_PATH?.trim() ||
      process.env.INVOICE_PDF_CHROMIUM_PATH?.trim() ||
      undefined,
    channel:
      process.env.DESIGNER_BROWSER_CHANNEL?.trim() ||
      process.env.INVOICE_PDF_BROWSER_CHANNEL?.trim() ||
      undefined,
  });
  let available = !disabled;
  let service: DesignerRenderService;
  let spec: TemplateSpecV1;
  let state: DesignStateV1;
  const written = new Map<string, Buffer>();

  beforeAll(async () => {
    if (!available) return;
    const fixture = JSON.parse(
      readFileSync(
        path.join(__dirname, 'npp/__fixtures__/expected/template_4273.json'),
        'utf8',
      ),
    ) as { spec: TemplateSpecV1 };
    const m = materialize(fixture.spec);
    spec = m.spec;
    const front = spec.surfaces[0];
    // Placeholder backgrounds: web 1000×1400, print 3000×4200.
    const bgWebId = m.ids.get('pending:bg_web')!;
    const bgPrintId = m.ids.get('pending:bg_print')!;
    front.background.web = { asset_id: bgWebId, width: 1000, height: 1400 };
    front.background.print = {
      asset_id: bgPrintId,
      width: 3000,
      height: 4200,
    };
    const photoId = randomUUID();
    const slot = front.elements.find((e) => e.type === 'image_slot')!;
    const texts = front.elements.filter((e) => e.type === 'text');
    state = {
      v: 1,
      texts: Object.fromEntries(
        texts.map((t, i) => [t.id, i === 0 ? 'Anna Andersson' : 'NA22B']),
      ),
      photos: {
        [slot.id]: {
          asset_id: photoId,
          width: 4000,
          height: 3000,
          adj: { zoom: 1.4, rot: 7, panX: 0.3, panY: 0.6 },
        },
      },
    };

    const bytes = new Map<string, Buffer>([
      [bgWebId, await solid(1000, 1400, '#1d3557')],
      [bgPrintId, await solid(3000, 4200, '#1d3557')],
      [photoId, await solid(4000, 3000, '#e63946')],
    ]);
    const row = (id: string, w: number, h: number): DesignAsset =>
      ({
        id,
        store_id: STORE,
        kind: id === photoId ? 'CUSTOMER_PHOTO' : 'TEMPLATE_BG_WEB',
        private_key: `k/${id}`,
        preview_key: null,
        mime: 'image/png',
        width: w,
        height: h,
        purged_at: null,
      }) as unknown as DesignAsset;
    const rows = [
      row(bgWebId, 1000, 1400),
      row(bgPrintId, 3000, 4200),
      row(photoId, 4000, 3000),
    ];
    const prisma = {
      designAsset: {
        findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
          Promise.resolve(rows.filter((r) => where.id.in.includes(r.id))),
        ),
      },
      // No app settings row: PNG only (the default print formats).
      storeApp: { findUnique: jest.fn(() => Promise.resolve(null)) },
    };
    const assets = {
      readAssetBytes: jest.fn((a: DesignAsset) =>
        Promise.resolve(bytes.get(a.id)!),
      ),
    };
    const fonts = {
      fontFiles: jest.fn((_s: string, ids: string[]) =>
        Promise.resolve(
          spec.fonts
            .filter((f) => ids.includes(f.asset_id))
            .map((f) => ({
              asset_id: f.asset_id,
              family: f.family,
              weight: f.weight,
              style: f.style,
              format: 'woff2',
              mime: 'font/woff2',
              data: fontFile(f.weight),
            })),
        ),
      ),
    };
    const storage = {
      write: jest.fn((k: string, b: Buffer) => {
        written.set(k, b);
        return Promise.resolve();
      }),
    };
    service = new DesignerRenderService(
      prisma as never,
      storage as never,
      assets as never,
      fonts as never,
      {} as never,
      host,
    );
    // Probe: skip the suite when no browser can be launched here.
    try {
      await host.host.withBrowser(() => Promise.resolve());
    } catch (e) {
      if (!(e instanceof DesignerRenderUnavailableError)) throw e;
      available = false;
      console.warn(`Skipping the real render spec: ${e.message}`);
    }
  });

  afterAll(() => host.close());

  const oidRow = () => ({
    id: OID,
    store_id: STORE,
    order_id: randomUUID(),
    template_spec: spec as never,
    state: state as never,
    proof_key: null,
    files_purged_at: null,
    originals_purged_at: null,
  });

  it('renders 3000×4200 PNG at 152.4 DPI with sRGB, deterministically', async () => {
    if (!available) return;
    const first = await service.renderPrint(oidRow(), new Date('2026-10-16'));
    expect(first.report.missing).toEqual([]);
    expect(Object.keys(first.report.fitted).sort()).toEqual(
      Object.keys(state.texts).sort(),
    );
    const [file] = first.files;
    expect(file).toMatchObject({
      surface: 'front',
      format: 'png',
      width_px: 3000,
      height_px: 4200,
      dpi: 152.4,
    });
    expect(file.key).toBe(`designer/${STORE}/2026/print/${OID}-front.png`);
    const png = written.get(file.key)!;
    // DESIGNER_RENDER_DUMP=<dir> keeps the PNG for a visual check.
    if (process.env.DESIGNER_RENDER_DUMP) {
      writeFileSync(
        path.join(process.env.DESIGNER_RENDER_DUMP, 'template_4273-print.png'),
        png,
      );
    }
    const meta = await sharp(png).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(3000);
    expect(meta.height).toBe(4200);
    expect(Math.round(meta.density ?? 0)).toBe(152);
    expect(meta.icc).toBeDefined();
    expect(file.sha256).toBe(createHash('sha256').update(png).digest('hex'));

    // Pixels: the background colour in a corner, the photo colour in the slot.
    const { data, info } = await sharp(png)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => {
      const i = (y * info.width + x) * 3;
      return [data[i], data[i + 1], data[i + 2]];
    };
    expect(px(5, 4195)).toEqual([0x1d, 0x35, 0x57]);
    const slot = spec.surfaces[0].elements.find(
      (e) => e.type === 'image_slot',
    )!;
    expect(
      px(
        Math.round((slot.x + slot.w / 2) * 6),
        Math.round((slot.y + slot.h / 2) * 6),
      ),
    ).toEqual([0xe6, 0x39, 0x46]);

    // The order proof is derived from the print (no proof_key on the row).
    expect(first.proof_key).toBe(`designer/${STORE}/2026/proof/${OID}.webp`);
    const proofMeta = await sharp(written.get(first.proof_key!)).metadata();
    expect([proofMeta.width, proofMeta.height]).toEqual([1000, 1400]);

    // Same input ⇒ same bytes.
    const second = await service.renderPrint(oidRow(), new Date('2026-10-16'));
    expect(second.files[0].sha256).toBe(file.sha256);
    expect(host.launchCount).toBe(1);
  });

  it('fails without retry when a used font is missing', async () => {
    if (!available) return;
    const broken = {
      ...oidRow(),
      template_spec: { ...spec, fonts: [] } as never,
    };
    await expect(service.renderPrint(broken)).rejects.toMatchObject({
      retryable: false,
      code: 'RENDER_MISSING',
    });
  });
});

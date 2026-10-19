/**
 * REAL print PDF: launches the local Chromium (same selection as the real
 * PNG spec) and renders a tiny 100×50 mm template with 3 mm bleed: a cover
 * background, a text in a local font (Noto Sans, loaded under the
 * template's family) and a JPEG customer photo. Checks the PDF geometry
 * (MediaBox = (trim + 2 × bleed) mm in points, TrimBox / BleedBox), the
 * embedded font, and that the photo is embedded as its untouched original.
 *
 * Skipped automatically when no browser can be launched, or with
 * DESIGNER_RENDER_REAL=0. DESIGNER_RENDER_DUMP=<dir> keeps the PDFs.
 */
import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { inflateSync } from 'zlib';
import sharp from 'sharp';
import type { DesignAsset } from '@prisma/client';
import { DesignerRenderService } from './designer-render.service';
import {
  DesignerChromiumHost,
  DesignerRenderUnavailableError,
} from './render/designer-chromium.host';
import type { DesignStateV1, TemplateSpecV1 } from '@multi-stores/core/designer';
import { MM_TO_PT, printPdfGeometry, readPdfBoxes } from './render/print-pdf';

jest.setTimeout(120_000);

const STORE = '11111111-1111-4111-8111-111111111111';
const BG = 'bbbbbbbb-0000-4000-8000-000000000001';
const PHOTO = 'bbbbbbbb-0000-4000-8000-000000000002';
const FONT = 'bbbbbbbb-0000-4000-8000-000000000003';

const fontFile = () =>
  readFileSync(
    path.join(
      path.dirname(require.resolve('@fontsource/noto-sans/package.json')),
      'files',
      'noto-sans-latin-700-normal.woff2',
    ),
  );

function tinySpec(bleed: number): TemplateSpecV1 {
  return {
    schema: 'designer.template/1',
    unit: 'mm',
    width: 100,
    height: 50,
    bleed_mm: bleed,
    render: { preview_px_per_mm: 2, print_px_per_mm: 6, fit_ref_px_per_mm: 6 },
    fonts: [
      { family: 'Sign Sans', weight: 700, style: 'normal', asset_id: FONT },
    ],
    surfaces: [
      {
        key: 'front',
        background: {
          color: '#ffffff',
          fit: 'cover',
          print: { asset_id: BG, width: 600, height: 300 },
        },
        elements: [
          {
            id: 'slot',
            type: 'image_slot',
            x: 5,
            y: 5,
            w: 40,
            h: 40,
            rot: 0,
            z: 1,
            locked: false,
            label: { en: 'Photo' },
            placeholder: { en: 'Upload' },
            shape: 'rect',
            radius: 0,
            border_color: '#ccc',
            required: true,
            adj_limits: { zoom: [1, 3], rot: [-180, 180] },
            default_adj: { zoom: 1, rot: 0, panX: 0.5, panY: 0.5 },
          },
          {
            id: 'name',
            type: 'text',
            x: 50,
            y: 15,
            w: 45,
            h: 20,
            rot: 0,
            z: 2,
            locked: false,
            label: { en: 'Name' },
            placeholder: { en: 'Name' },
            default_text: 'Anna',
            font: { family: 'Sign Sans', weight: 700, style: 'normal' },
            size: 12,
            color: '#111111',
            align: 'center',
            transform: 'none',
            fit: { mode: 'shrink', step: 0.5, min: 6, pad_ref_px: 8 },
            inset: 4,
            editable: true,
            required: true,
            max_length: 20,
            direction: 'auto',
          },
        ],
      },
    ],
  } as TemplateSpecV1;
}

const state: DesignStateV1 = {
  v: 1,
  texts: { name: 'Anna Andersson' },
  photos: {
    slot: {
      asset_id: PHOTO,
      width: 1600,
      height: 1200,
      adj: { zoom: 1.2, rot: 5, panX: 0.4, panY: 0.5 },
    },
  },
};

const disabled = process.env.DESIGNER_RENDER_REAL === '0';

/**
 * The background image's placement in pt, read from Chromium's page content
 * stream (`<base> 0 0 -<base> 0 H cm`, then the image's `w 0 0 -h x y cm`).
 * The cut's own translate only moves y, so x and the sizes are exact.
 */
function backgroundImagePt(pdf: Buffer): { x: number; w: number; h: number } {
  const s = pdf.toString('latin1');
  const re = /<<([^]*?)>>\s*stream\r?\n/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (!/\/FlateDecode/.test(m[1]) || /\/Subtype/.test(m[1])) continue;
    const len = Number(/\/Length (\d+)/.exec(m[1])?.[1]);
    const start = m.index + m[0].length;
    let text: string;
    try {
      text = inflateSync(pdf.subarray(start, start + len)).toString('latin1');
    } catch {
      continue;
    }
    const base = /^([\d.]+) 0 0 -[\d.]+ 0 [\d.]+ cm/.exec(text);
    const img =
      /\n([\d.]+) 0 0 -([\d.]+) (-?[\d.]+) -?[\d.]+ cm\n[^\n]*\n\/G\d+ gs\n\/X\d+ Do/.exec(
        text,
      );
    if (!base || !img) continue;
    const k = Number(base[1]);
    return {
      w: Number(img[1]) * k,
      h: Number(img[2]) * k,
      x: Number(img[3]) * k,
    };
  }
  throw new Error('no background image in the page content');
}

describe('DesignerRenderService.renderPrintPdf (REAL Chromium)', () => {
  const host = new DesignerChromiumHost({
    executablePath:
      process.env.DESIGNER_CHROMIUM_PATH?.trim() ||
      process.env.INVOICE_PDF_CHROMIUM_PATH?.trim() ||
      process.env.CHROMIUM_PATH?.trim() ||
      undefined,
    channel:
      process.env.DESIGNER_BROWSER_CHANNEL?.trim() ||
      process.env.INVOICE_PDF_BROWSER_CHANNEL?.trim() ||
      process.env.CHROMIUM_CHANNEL?.trim() ||
      undefined,
  });
  let available = !disabled;
  let service: DesignerRenderService;
  let photoJpeg: Buffer;

  beforeAll(async () => {
    if (!available) return;
    photoJpeg = await sharp({
      create: { width: 1600, height: 1200, channels: 3, background: '#e63946' },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
    const bgPng = await sharp({
      create: { width: 600, height: 300, channels: 3, background: '#1d3557' },
    })
      .png()
      .toBuffer();
    const bytes = new Map<string, Buffer>([
      [BG, bgPng],
      [PHOTO, photoJpeg],
    ]);
    const rows = [
      {
        id: BG,
        kind: 'TEMPLATE_BG_PRINT',
        mime: 'image/png',
        width: 600,
        height: 300,
      },
      {
        id: PHOTO,
        kind: 'CUSTOMER_PHOTO',
        mime: 'image/jpeg',
        width: 1600,
        height: 1200,
      },
    ].map(
      (r) =>
        ({
          ...r,
          store_id: STORE,
          private_key: `k/${r.id}`,
          preview_key: null,
          purged_at: null,
        }) as unknown as DesignAsset,
    );
    const prisma = {
      designAsset: {
        findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
          Promise.resolve(rows.filter((r) => where.id.in.includes(r.id))),
        ),
      },
    };
    const assets = {
      readAssetBytes: jest.fn((a: DesignAsset) =>
        Promise.resolve(bytes.get(a.id)!),
      ),
    };
    const fonts = {
      fontFiles: jest.fn(() =>
        Promise.resolve([
          {
            asset_id: FONT,
            family: 'Sign Sans',
            weight: 700,
            style: 'normal',
            format: 'woff2',
            mime: 'font/woff2',
            data: fontFile(),
          },
        ]),
      ),
    };
    service = new DesignerRenderService(
      prisma as never,
      {} as never,
      assets as never,
      fonts as never,
      {} as never,
      host,
    );
    try {
      await host.host.withBrowser(() => Promise.resolve());
    } catch (e) {
      if (!(e instanceof DesignerRenderUnavailableError)) throw e;
      available = false;
      console.warn(`Skipping the real PDF spec: ${e.message}`);
    }
  });

  afterAll(() => host.close());

  const render = async (bleed: number, cropMarks = false) => {
    const spec = tinySpec(bleed);
    const geometry = printPdfGeometry(spec, { cropMarks });
    const pdf = await service.renderPrintPdf(STORE, spec, state, {
      scale: 6,
      locale: 'en',
      geometry,
      title: 'Print file test',
    });
    const dump = process.env.DESIGNER_RENDER_DUMP;
    if (dump) {
      writeFileSync(
        path.join(dump, `tiny-bleed${bleed}${cropMarks ? '-marks' : ''}.pdf`),
        pdf,
      );
    }
    return { pdf, geometry };
  };

  it('MediaBox = (trim + 2 × bleed) mm in points; fonts and the photo original embedded', async () => {
    if (!available) return;
    const { pdf } = await render(3);
    const s = pdf.toString('latin1');
    const boxes = readPdfBoxes(pdf);
    const pt = (mm: number) => mm * MM_TO_PT;
    const [x0, y0, x1, y1] = boxes.MediaBox!;
    expect(x0).toBe(0);
    expect(y0).toBe(0);
    expect(x1).toBeCloseTo(pt(106), 2);
    expect(y1).toBeCloseTo(pt(56), 2);
    expect(boxes.TrimBox![0]).toBeCloseTo(pt(3), 2);
    expect(boxes.TrimBox![2]).toBeCloseTo(pt(103), 2);
    expect(boxes.TrimBox![3]).toBeCloseTo(pt(53), 2);
    expect(boxes.BleedBox).toEqual(boxes.MediaBox);
    expect(s.match(/\/Type \/Page\b(?!s)/g)).toHaveLength(1);
    // Text stays text: the template's face is embedded (subset).
    expect(s).toMatch(/\/FontFile[23]?\s/);
    expect(s).toMatch(/\/FontName \/[A-Z]{6}\+NotoSans/);
    // The JPEG photo is embedded as-is at its own resolution.
    expect(s).toMatch(
      /\/Width 1600\s*\/Height 1200[\s\S]{0,200}?\/Filter \/DCTDecode/,
    );
    expect(pdf.includes(photoJpeg.subarray(0, 4096))).toBe(true);
    expect(s).toContain('/Title (Print file test)');
    // The layers composite plainly: a vector clearRect would turn into an
    // alpha soft mask that hides the background layer inside the trim.
    expect(s).not.toMatch(/\/SMask\s*<<\s*\/Type\s*\/Mask/);
    // Placement at full size: the 2:1 cover background over the 106×56 mm
    // bleed box is 112×56 mm, starting 3 mm left of the page. (Chromium
    // floors a beforeprint canvas's CSS/pixel ratio to 1/64; a canvas sized
    // from mm printed everything ~0.8 % too small.)
    const bg = backgroundImagePt(pdf);
    expect(bg.w / MM_TO_PT).toBeCloseTo(112, 1);
    expect(bg.h / MM_TO_PT).toBeCloseTo(56, 1);
    expect(bg.x / MM_TO_PT).toBeCloseTo(-3, 1);
  });

  it('bleed 0 → the trim size; crop marks add the slug', async () => {
    if (!available) return;
    const flat = readPdfBoxes((await render(0)).pdf);
    expect(flat.MediaBox![2]).toBeCloseTo(100 * MM_TO_PT, 2);
    expect(flat.MediaBox![3]).toBeCloseTo(50 * MM_TO_PT, 2);
    const flatBg = backgroundImagePt((await render(0)).pdf);
    expect(flatBg.w / MM_TO_PT).toBeCloseTo(100, 1);
    expect(flatBg.x).toBeCloseTo(0, 1);
    const { pdf, geometry } = await render(3, true);
    const marked = readPdfBoxes(pdf);
    expect(marked.MediaBox![2]).toBeCloseTo(
      geometry.page_mm.width * MM_TO_PT,
      2,
    );
    expect(geometry.page_mm.width).toBe(100 + 2 * (3 + 5));
    expect(marked.BleedBox![2] - marked.BleedBox![0]).toBeCloseTo(
      106 * MM_TO_PT,
      2,
    );
  });
});

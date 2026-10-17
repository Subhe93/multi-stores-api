/*
 * REAL Chromium golden (M4.2 WP11, §12.3 G3): renders three representative
 * converted NPP templates through DesignerRenderService.renderPrint at
 * 6 px/mm in the local browser (same launch logic as
 * designer-render.real.spec.ts):
 *   - template_4273: photo slot with pan / zoom / rotate;
 *   - template_4355: "swapped" backgrounds (web and print differ; print wins)
 *     with two decoration images;
 *   - template_4359: text-heavy (long names hit the shrink loop);
 *   - template_4364: the Anton and Righteous faces.
 *
 * Inputs are generated locally: gradient / checkerboard placeholder images
 * (sharp) and the REAL template faces from the OFL @fontsource packages
 * (montserrat, anton, righteous: dev dependencies). No network.
 *
 * Asserts 3000×4200, the fitted sizes (exact), a 16×16 average hash
 * (Hamming ≤ HASH_TOLERANCE), per-region / per-element mean colours
 * (|Δ| ≤ MEAN_TOLERANCE per channel) against small JSON goldens in
 * `__fixtures__/golden/chromium/`, a per-pixel diff of the decoded output
 * (downscaled 1:5 to 600×840) against the reference PNG next to them (at
 * most PIXEL_DIFF_MAX_RATIO of the pixels may differ by more than
 * PIXEL_DIFF_DELTA in any channel), plus byte-identical output across two
 * runs.
 *
 * Skipped when no browser can be launched, when a fontsource face is not
 * installed, or with DESIGNER_RENDER_REAL=0. UPDATE_GOLDEN=1 rewrites the
 * goldens (JSON + reference PNGs); DESIGNER_RENDER_DUMP=<dir> keeps the
 * full PNGs.
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import type { DesignAsset } from '@prisma/client';
import { DesignerRenderService } from './designer-render.service';
import {
  DesignerChromiumHost,
  DesignerRenderUnavailableError,
} from './render/designer-chromium.host';
import type { DesignStateV1, TemplateSpecV1 } from './render/design-renderer';
import {
  GOLDEN_DIR,
  golden,
  loadTemplate,
  UPDATE_GOLDEN,
} from './__fixtures__/golden/golden-kit.mockspec';

jest.setTimeout(240_000);

const STORE = '11111111-1111-4111-8111-111111111111';
const OID = '22222222-2222-4222-8222-222222222222';
const MEAN_TOLERANCE = 6;
const HASH_TOLERANCE = 16;
const GRID = { cols: 5, rows: 7 }; // 600×600 px cells at 3000×4200
/** Per-pixel diff: a pixel "differs" past this channel delta ... */
const PIXEL_DIFF_DELTA = 16;
/** ... and at most this share of the reference pixels may differ. */
const PIXEL_DIFF_MAX_RATIO = 0.001;
/** Reference PNG size (1:5 of the print). */
const REF = { width: 600, height: 840 };

type RGB = [number, number, number];

/** `Montserrat` → `@fontsource/montserrat/files/montserrat-latin-<w>-normal.woff2`. */
function fontsourcePath(family: string, weight: number, style: string): string {
  const slug = family.toLowerCase().replace(/\s+/g, '-');
  return path.join(
    path.dirname(require.resolve(`@fontsource/${slug}/package.json`)),
    'files',
    `${slug}-latin-${weight}-${style === 'italic' ? 'italic' : 'normal'}.woff2`,
  );
}

const fontFile = (family: string, weight: number, style: string) =>
  readFileSync(fontsourcePath(family, weight, style));

/** The faces of a spec that are not installed (empty = all available). */
function missingFaces(spec: TemplateSpecV1): string[] {
  const out: string[] = [];
  for (const f of spec.fonts) {
    try {
      readFileSync(fontsourcePath(f.family, f.weight, f.style));
    } catch {
      out.push(`${f.family} ${f.weight} ${f.style}`);
    }
  }
  return out;
}

/** `pending:deco:abc` → `g-pending-deco-abc` (stable, URL-safe ids). */
function materialize(spec: TemplateSpecV1): TemplateSpecV1 {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string' && v.startsWith('pending:'))
      return 'g-' + v.replace(/[^a-zA-Z0-9]+/g, '-');
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
  return walk(spec) as TemplateSpecV1;
}

/** Vertical gradient (optionally checkered) as PNG. */
function gradient(
  w: number,
  h: number,
  from: RGB,
  to: RGB,
  checker = 0,
): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const t = h > 1 ? y / (h - 1) : 0;
    for (let x = 0; x < w; x++) {
      const dark =
        checker > 0 &&
        (Math.floor(x / checker) + Math.floor(y / checker)) % 2 === 1;
      for (let c = 0; c < 3; c++) {
        const v = Math.round(from[c] + (to[c] - from[c]) * t);
        raw[(y * w + x) * 3 + c] = dark ? Math.round(v * 0.6) : v;
      }
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toBuffer();
}

interface Fixture {
  stem: string;
  spec: TemplateSpecV1;
  state: DesignStateV1;
  /** asset id → [bytes, width, height] */
  images: Map<string, [Buffer, number, number]>;
}

const PHOTO = 'g-photo';
const WEB_BG: [RGB, RGB] = [
  [200, 30, 30],
  [255, 200, 0],
];
const PRINT_BG: [RGB, RGB] = [
  [20, 40, 110],
  [40, 160, 120],
];

async function buildFixture(
  stem: string,
  texts: string[],
  photoAdj: DesignStateV1['photos'][string]['adj'],
): Promise<Fixture> {
  const spec = materialize(loadTemplate(stem));
  const front = spec.surfaces[0];
  const images = new Map<string, [Buffer, number, number]>();
  const bgWeb = front.background.web!;
  const bgPrint = front.background.print!;
  Object.assign(bgWeb, { width: 300, height: 420 });
  Object.assign(bgPrint, { width: 600, height: 840 });
  images.set(bgWeb.asset_id, [
    await gradient(300, 420, WEB_BG[0], WEB_BG[1]),
    300,
    420,
  ]);
  images.set(bgPrint.asset_id, [
    await gradient(600, 840, PRINT_BG[0], PRINT_BG[1]),
    600,
    840,
  ]);
  let deco = 0;
  for (const el of front.elements) {
    if (el.type !== 'image') continue;
    const colours: [RGB, RGB][] = [
      [
        [250, 250, 250],
        [180, 180, 180],
      ],
      [
        [0, 0, 0],
        [90, 60, 30],
      ],
    ];
    const [a, b] = colours[deco++ % colours.length];
    Object.assign(el.asset, { width: 160, height: 120 });
    images.set(el.asset.asset_id, [await gradient(160, 120, a, b), 160, 120]);
  }
  images.set(PHOTO, [
    await gradient(800, 600, [230, 57, 70], [69, 123, 157], 50),
    800,
    600,
  ]);
  const state: DesignStateV1 = { v: 1, texts: {}, photos: {} };
  front.elements
    .filter((e) => e.type === 'text' && e.editable)
    .forEach((e, i) => {
      state.texts[e.id] = texts[i % texts.length];
    });
  for (const el of front.elements) {
    if (el.type === 'image_slot') {
      state.photos[el.id] = {
        asset_id: PHOTO,
        width: 800,
        height: 600,
        adj: photoAdj,
      };
    }
  }
  return { stem, spec, state, images };
}

function serviceFor(
  fx: Fixture,
  host: DesignerChromiumHost,
  written: Map<string, Buffer>,
) {
  const rows = [...fx.images.entries()].map(
    ([id, [, w, h]]) =>
      ({
        id,
        store_id: STORE,
        kind: id === PHOTO ? 'CUSTOMER_PHOTO' : 'TEMPLATE_BG_WEB',
        private_key: `k/${id}`,
        preview_key: null,
        mime: 'image/png',
        width: w,
        height: h,
        purged_at: null,
      }) as unknown as DesignAsset,
  );
  const prisma = {
    designAsset: {
      findMany: ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(rows.filter((r) => where.id.in.includes(r.id))),
    },
  };
  const assets = {
    readAssetBytes: (a: DesignAsset) =>
      Promise.resolve(fx.images.get(a.id)![0]),
  };
  const fonts = {
    fontFiles: (_s: string, ids: string[]) =>
      Promise.resolve(
        fx.spec.fonts
          .filter((f) => ids.includes(f.asset_id))
          .map((f) => ({
            asset_id: f.asset_id,
            family: f.family,
            weight: f.weight,
            style: f.style,
            format: 'woff2',
            mime: 'font/woff2',
            data: fontFile(f.family, f.weight, f.style),
          })),
      ),
  };
  const storage = {
    write: (k: string, b: Buffer) => {
      written.set(k, b);
      return Promise.resolve();
    },
  };
  return new DesignerRenderService(
    prisma as never,
    storage as never,
    assets as never,
    fonts as never,
    {} as never,
    host,
  );
}

/* ------------------------------------------------------------------ */
/* Perceptual fingerprint                                              */
/* ------------------------------------------------------------------ */

interface Fingerprint {
  width: number;
  height: number;
  fitted: Record<string, number>;
  ahash: string;
  grid: RGB[];
  elements: Record<string, RGB>;
}

async function fingerprint(
  png: Buffer,
  spec: TemplateSpecV1,
  fitted: Record<string, number>,
): Promise<Fingerprint> {
  const { data, info } = await sharp(png)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const mean = (x0: number, y0: number, x1: number, y1: number): RGB => {
    x0 = Math.max(0, Math.floor(x0));
    y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(W, Math.ceil(x1));
    y1 = Math.min(H, Math.ceil(y1));
    const sum = [0, 0, 0];
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * 3;
        sum[0] += data[i];
        sum[1] += data[i + 1];
        sum[2] += data[i + 2];
        n++;
      }
    }
    return sum.map((s) => (n ? Math.round(s / n) : 0)) as RGB;
  };
  const grid: RGB[] = [];
  const cw = W / GRID.cols;
  const ch = H / GRID.rows;
  for (let r = 0; r < GRID.rows; r++) {
    for (let c = 0; c < GRID.cols; c++) {
      grid.push(mean(c * cw, r * ch, (c + 1) * cw, (r + 1) * ch));
    }
  }
  const elements: Record<string, RGB> = {};
  for (const el of spec.surfaces[0].elements) {
    elements[el.id] = mean(
      el.x * 6,
      el.y * 6,
      (el.x + el.w) * 6,
      (el.y + el.h) * 6,
    );
  }
  // Average hash over a 16×16 greyscale thumbnail.
  const small = await sharp(png)
    .removeAlpha()
    .greyscale()
    .resize(16, 16, { fit: 'fill', kernel: 'cubic' })
    .raw()
    .toBuffer();
  const avg = small.reduce((a, b) => a + b, 0) / small.length;
  let bits = '';
  for (const v of small) bits += v > avg ? '1' : '0';
  let ahash = '';
  for (let i = 0; i < bits.length; i += 4)
    ahash += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return { width: W, height: H, fitted, ahash, grid, elements };
}

function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    let x = parseInt(a[i] ?? '0', 16) ^ parseInt(b[i] ?? '0', 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

function maxDelta(a: RGB[], b: RGB[]): number {
  let d = 0;
  a.forEach((p, i) => {
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(p[c] - b[i][c]));
  });
  return d;
}

/** The print downscaled 1:5 as raw RGB (the per-pixel comparison unit). */
async function referenceRaw(png: Buffer): Promise<Buffer> {
  return sharp(png)
    .removeAlpha()
    .resize(REF.width, REF.height, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer();
}

/**
 * Loads (or with UPDATE_GOLDEN=1 writes) the reference PNG of a case and
 * returns its raw RGB. A missing reference without UPDATE_GOLDEN=1 throws.
 */
async function referenceGolden(stem: string, actual: Buffer): Promise<Buffer> {
  const file = path.join(GOLDEN_DIR, 'chromium', `${stem}.png`);
  if (UPDATE_GOLDEN) {
    await sharp(actual, { raw: { ...REF, channels: 3 } })
      .png({ compressionLevel: 9 })
      .toFile(file);
    return actual;
  }
  if (!existsSync(file)) {
    throw new Error(
      `Missing golden chromium/${stem}.png; run the spec with UPDATE_GOLDEN=1 to create it.`,
    );
  }
  return sharp(readFileSync(file)).removeAlpha().raw().toBuffer();
}

/** Share of pixels whose any channel differs by more than PIXEL_DIFF_DELTA. */
function pixelDiffRatio(a: Buffer, b: Buffer): number {
  expect(a.length).toBe(b.length);
  let differing = 0;
  for (let i = 0; i < a.length; i += 3) {
    if (
      Math.abs(a[i] - b[i]) > PIXEL_DIFF_DELTA ||
      Math.abs(a[i + 1] - b[i + 1]) > PIXEL_DIFF_DELTA ||
      Math.abs(a[i + 2] - b[i + 2]) > PIXEL_DIFF_DELTA
    ) {
      differing++;
    }
  }
  return differing / (a.length / 3);
}

/* ------------------------------------------------------------------ */
/* Spec                                                                */
/* ------------------------------------------------------------------ */

const disabled = process.env.DESIGNER_RENDER_REAL === '0';
const CASE_STEMS = [
  'template_4273',
  'template_4355',
  'template_4359',
  'template_4364',
];

describe('designer print golden (REAL Chromium, 6 px/mm)', () => {
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

  beforeAll(async () => {
    if (!available) return;
    const missing = CASE_STEMS.flatMap((stem) =>
      missingFaces(loadTemplate(stem)),
    );
    if (missing.length) {
      available = false;
      console.warn(
        `Skipping the Chromium golden spec: fontsource face(s) not installed: ${[...new Set(missing)].join(', ')}`,
      );
      return;
    }
    try {
      await host.host.withBrowser(() => Promise.resolve());
    } catch (e) {
      if (!(e instanceof DesignerRenderUnavailableError)) throw e;
      available = false;
      console.warn(`Skipping the Chromium golden spec: ${e.message}`);
    }
  });

  afterAll(() => host.close());

  const cases: [string, () => Promise<Fixture>][] = [
    [
      'template_4273 (photo slot, pan/zoom/rotate)',
      () =>
        buildFixture('template_4273', ['Åsa Öberg-Ängström', 'NA3b'], {
          zoom: 1.6,
          rot: 17,
          panX: 0.2,
          panY: 0.75,
        }),
    ],
    [
      'template_4355 (swapped backgrounds, decorations)',
      () =>
        buildFixture('template_4355', ['Björn Ågren', 'SA3a'], {
          zoom: 2.3,
          rot: -12,
          panX: 0.1,
          panY: 0.9,
        }),
    ],
    [
      'template_4359 (text-heavy)',
      () =>
        buildFixture(
          'template_4359',
          [
            'Maximiliana Charlotta Åkesson-Lindqvist',
            'Teknikprogrammet Göteborgs Högre Allmänna Läroverk 2026',
          ],
          { zoom: 1, rot: 0, panX: 0.5, panY: 0.5 },
        ),
    ],
    [
      'template_4364 (Anton + Righteous faces)',
      () =>
        buildFixture('template_4364', ['Vilma Lindqvist', 'EK3c'], {
          zoom: 1.2,
          rot: 5,
          panX: 0.4,
          panY: 0.3,
        }),
    ],
  ];

  it.each(cases)('%s', async (_name, build) => {
    if (!available) return;
    const fx = await build();
    const written = new Map<string, Buffer>();
    const service = serviceFor(fx, host, written);
    const row = () => ({
      id: OID,
      store_id: STORE,
      order_id: '33333333-3333-4333-8333-333333333333',
      template_spec: fx.spec as never,
      state: fx.state as never,
      proof_key: 'existing', // skip the derived order proof
      files_purged_at: null,
      originals_purged_at: null,
    });
    const now = new Date('2026-10-16T00:00:00Z');
    const first = await service.renderPrint(row(), now);
    const png1 = written.get(first.files[0].key)!;
    const second = await service.renderPrint(row(), now);
    const png2 = written.get(second.files[0].key)!;

    // Determinism: byte-identical PNGs.
    expect(createHash('sha256').update(png2).digest('hex')).toBe(
      createHash('sha256').update(png1).digest('hex'),
    );
    expect(first.files[0]).toMatchObject({ width_px: 3000, height_px: 4200 });
    const meta = await sharp(png1).metadata();
    expect([meta.width, meta.height]).toEqual([3000, 4200]);

    if (process.env.DESIGNER_RENDER_DUMP) {
      writeFileSync(
        path.join(process.env.DESIGNER_RENDER_DUMP, `${fx.stem}-golden.png`),
        png1,
      );
    }

    const actual = await fingerprint(png1, fx.spec, first.report.fitted);
    const expected = golden<Fingerprint>(`chromium/${fx.stem}.json`, actual);
    expect([actual.width, actual.height]).toEqual([
      expected.width,
      expected.height,
    ]);
    expect(actual.fitted).toEqual(expected.fitted);
    expect(hamming(actual.ahash, expected.ahash)).toBeLessThanOrEqual(
      HASH_TOLERANCE,
    );
    expect(maxDelta(actual.grid, expected.grid)).toBeLessThanOrEqual(
      MEAN_TOLERANCE,
    );
    const ids = Object.keys(expected.elements);
    expect(Object.keys(actual.elements).sort()).toEqual([...ids].sort());
    expect(
      maxDelta(
        ids.map((k) => actual.elements[k]),
        ids.map((k) => expected.elements[k]),
      ),
    ).toBeLessThanOrEqual(MEAN_TOLERANCE);

    // Per-pixel diff of the decoded output against the reference PNG.
    const raw = await referenceRaw(png1);
    const ref = await referenceGolden(fx.stem, raw);
    expect(pixelDiffRatio(raw, ref)).toBeLessThanOrEqual(PIXEL_DIFF_MAX_RATIO);

    // Print uses the print background (bottom-left cell = print gradient end,
    // never the web gradient) — the 4355 "swapped" case in particular.
    const bottomLeft = actual.grid[(GRID.rows - 1) * GRID.cols];
    const dist = (a: RGB, b: RGB) =>
      Math.max(...a.map((v, i) => Math.abs(v - b[i])));
    expect(dist(bottomLeft, PRINT_BG[1])).toBeLessThan(
      dist(bottomLeft, WEB_BG[1]),
    );
  });
});

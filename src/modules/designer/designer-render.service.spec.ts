import sharp from 'sharp';
import type { DesignAsset } from '@prisma/client';
import {
  canonicalJson,
  classifyRenderError,
  designProofSha,
  DesignerRenderJobError,
  DesignerRenderService,
  designProofKey,
  imageNeeds,
  pdfImageNeeds,
  photoVisibleCrop,
  printScale,
  proofScale,
} from './designer-render.service';
import {
  DESIGNER_MAX_CANVAS_SIDE,
  DesignerRenderUnavailableError,
  DisabledDesignerRenderer,
  type CanvasJob,
  type DesignerBrowserRenderer,
  type PdfJob,
  type RenderFile,
} from './render/designer-chromium.host';
import { mmToPt, readPdfBoxes } from './render/print-pdf';
import {
  DEFAULT_ADJ,
  type DesignStateV1,
  type ImageSlotElement,
  type PhotoAdj,
  type TemplateSpecV1,
} from '@multi-stores/core/designer';
import { designerErrors } from './designer-errors';

const STORE = '11111111-1111-4111-8111-111111111111';
const OID = '22222222-2222-4222-8222-222222222222';
const DESIGN = '33333333-3333-4333-8333-333333333333';
const BG_WEB = 'aaaaaaaa-0000-4000-8000-000000000001';
const BG_PRINT = 'aaaaaaaa-0000-4000-8000-000000000002';
const DECO = 'aaaaaaaa-0000-4000-8000-000000000003';
const PHOTO = 'aaaaaaaa-0000-4000-8000-000000000004';
const FONT = 'aaaaaaaa-0000-4000-8000-000000000005';

function spec(): TemplateSpecV1 {
  return {
    schema: 'designer.template/1',
    unit: 'mm',
    width: 500,
    height: 700,
    bleed_mm: 0,
    render: { preview_px_per_mm: 2, print_px_per_mm: 6, fit_ref_px_per_mm: 6 },
    fonts: [
      { family: 'Montserrat', weight: 600, style: 'normal', asset_id: FONT },
    ],
    surfaces: [
      {
        key: 'front',
        background: {
          color: '#fff',
          fit: 'stretch',
          web: { asset_id: BG_WEB, width: 1000, height: 1400 },
          print: { asset_id: BG_PRINT, width: 3000, height: 4200 },
        },
        elements: [
          {
            id: 'slot',
            type: 'image_slot',
            x: 100,
            y: 100,
            w: 300,
            h: 300,
            rot: 0,
            z: 1,
            locked: false,
            label: { sv: 'Foto' },
            placeholder: { sv: 'Ladda upp bild' },
            shape: 'rect',
            radius: 0,
            border_color: '#ccc',
            required: true,
            adj_limits: { zoom: [1, 3], rot: [-180, 180] },
            default_adj: { zoom: 1, rot: 0, panX: 0.5, panY: 0.5 },
          },
          {
            id: 'deco',
            type: 'image',
            x: 0,
            y: 0,
            w: 50,
            h: 50,
            rot: 0,
            z: 2,
            locked: true,
            asset: { asset_id: DECO, width: 300, height: 300 },
          },
        ],
      },
    ],
  };
}

const state = (): DesignStateV1 => ({
  v: 1,
  texts: {},
  photos: {
    slot: {
      asset_id: PHOTO,
      width: 4000,
      height: 3000,
      adj: { zoom: 1, rot: 0, panX: 0.5, panY: 0.5 },
    },
  },
});

async function png(w: number, h: number) {
  return sharp({
    create: { width: w, height: h, channels: 3, background: '#336699' },
  })
    .png()
    .toBuffer();
}

let bigPhotoBytes: Promise<Buffer> | null = null;
const bigPhoto = () => (bigPhotoBytes ??= png(4000, 3000));

/** A one-page PDF shaped like Chromium's (classic xref), page in pt. */
function fakeChromiumPdf(w: number, h: number): Buffer {
  const content = 'q Q\n';
  const objs = [
    '',
    '<</Producer (test)>>',
    `<</Type /Page\n/MediaBox [0 0 ${w} ${h}]\n/Contents 3 0 R\n/Parent 4 0 R>>`,
    `<</Length ${content.length}>> stream\n${content}endstream`,
    '<</Type /Pages\n/Count 1\n/Kids [2 0 R]>>',
    '<</Type /Catalog\n/Pages 4 0 R>>',
  ];
  let out = '%PDF-1.4\n';
  const at: number[] = [];
  for (let id = 1; id < objs.length; id++) {
    at[id] = out.length;
    out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objs.length; id++) {
    out += `${String(at[id]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<</Size ${objs.length}\n/Root 5 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

function build(
  opts: {
    browser?: DesignerBrowserRenderer;
    settings?: Record<string, unknown>;
  } = {},
) {
  const rows: DesignAsset[] = [
    [BG_WEB, 1000, 1400, 'TEMPLATE_BG_WEB'],
    [BG_PRINT, 3000, 4200, 'TEMPLATE_BG_PRINT'],
    [DECO, 300, 300, 'TEMPLATE_DECO'],
    [PHOTO, 4000, 3000, 'CUSTOMER_PHOTO'],
  ].map(
    ([id, width, height, kind]) =>
      ({
        id,
        store_id: STORE,
        kind,
        width,
        height,
        mime: 'image/png',
        private_key: `k/${id as string}`,
        preview_key: kind === 'CUSTOMER_PHOTO' ? `p/${id as string}` : null,
        purged_at: null,
      }) as unknown as DesignAsset,
  );
  const prisma = {
    designAsset: {
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(rows.filter((r) => where.id.in.includes(r.id))),
      ),
    },
    design: {
      findUnique: jest.fn(),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      count: jest.fn(() => Promise.resolve(0)),
    },
    orderItemDesign: { count: jest.fn(() => Promise.resolve(0)) },
    storeLanguageConfig: {
      findUnique: jest.fn(() => Promise.resolve({ primary_locale: 'sv' })),
    },
    order: {
      findUnique: jest.fn(() => Promise.resolve({ locale: 'en' })),
    },
    storeApp: {
      findUnique: jest.fn(() =>
        Promise.resolve(opts.settings ? { settings: opts.settings } : null),
      ),
    },
  };
  const readAssetBytes = jest.fn(
    async (a: DesignAsset, variant: 'original' | 'preview') =>
      variant === 'preview'
        ? sharp(await png(160, 120))
            .webp()
            .toBuffer()
        : png(Math.min(a.width, 64), Math.min(a.height, 64)),
  );
  // The photo original is stored at full size to exercise the prescale.
  const assets = {
    readAssetBytes: jest.fn((a: DesignAsset, v: 'original' | 'preview') =>
      a.id === PHOTO && v === 'original' ? bigPhoto() : readAssetBytes(a, v),
    ),
  };
  const fonts = {
    fontFiles: jest.fn(() =>
      Promise.resolve([
        {
          asset_id: FONT,
          family: 'Montserrat',
          weight: 600,
          style: 'normal',
          format: 'woff2',
          mime: 'font/woff2',
          data: Buffer.from('font'),
        },
      ]),
    ),
  };
  const written = new Map<string, Buffer>();
  const storage = {
    write: jest.fn((k: string, b: Buffer) => {
      written.set(k, b);
      return Promise.resolve();
    }),
    exists: jest.fn((k: string) => Promise.resolve(written.has(k))),
    delete: jest.fn((k: string) => {
      written.delete(k);
      return Promise.resolve();
    }),
  };
  const urls = {
    signedPath: jest.fn(
      (k: string, id: string) => `/api/designer/files/${k}.${id}`,
    ),
  };
  const calls: { job: CanvasJob; files: Map<string, RenderFile>; t: number }[] =
    [];
  const pdfCalls: {
    job: PdfJob;
    files: Map<string, RenderFile>;
    t: number;
  }[] = [];
  const browser: DesignerBrowserRenderer = opts.browser ?? {
    enabled: true,
    close: jest.fn(() => Promise.resolve()),
    probe: jest.fn(() => Promise.resolve()),
    renderCanvas: jest.fn(async (job: CanvasJob, files, t) => {
      calls.push({ job, files, t });
      const w = Math.round(500 * job.scale);
      const h = Math.round(700 * job.scale);
      const img = sharp({
        create: { width: w, height: h, channels: 4, background: '#fff' },
      });
      return {
        data:
          job.type === 'image/png'
            ? await img.png().toBuffer()
            : await img.webp().toBuffer(),
        width: w,
        height: h,
        report: { fitted: {}, missing: [], elements: 2 },
      };
    }),
    renderPdf: jest.fn(
      (job: PdfJob, files: Map<string, RenderFile>, t: number) => {
        pdfCalls.push({ job, files, t });
        // Chromium rounds the (padded) paper up a little.
        return Promise.resolve({
          data: fakeChromiumPdf(
            job.geometry.page_pt.width + 4,
            job.geometry.page_pt.height + 4,
          ),
          report: { fitted: {}, missing: [], elements: 2 },
        });
      },
    ),
  };
  const service = new DesignerRenderService(
    prisma as never,
    storage as never,
    assets as never,
    fonts as never,
    urls as never,
    browser,
  );
  return {
    service,
    prisma,
    assets,
    storage,
    written,
    calls,
    pdfCalls,
    browser,
    urls,
  };
}

const oid = (over: Record<string, unknown> = {}) => ({
  id: OID,
  store_id: STORE,
  order_id: 'o1',
  template_spec: spec() as never,
  state: state() as never,
  proof_key: null,
  files_purged_at: null,
  originals_purged_at: null,
  ...over,
});

describe('imageNeeds', () => {
  it('print: print background, decoration, photo original fitted to its drawn size', () => {
    const needs = imageNeeds(spec(), state(), 'print', 6);
    expect(needs.map((n) => [n.asset_id, n.variant])).toEqual([
      [BG_PRINT, 'original'],
      [PHOTO, 'original'],
      [DECO, 'original'],
    ]);
    // 4:3 photo in a 300×300 mm slot at 6 px/mm: drawn 2400×1800, of which
    // the slot shows the centre 1800 px = original columns 500..3500.
    expect(needs[1].fit).toEqual({ width: 2400, height: 1800 });
    expect(needs[1].crop).toEqual({
      left: 500,
      top: 0,
      width: 3000,
      height: 3000,
    });
  });

  it('photoVisibleCrop: the rotated slot clip intersected with the drawn image, whole pixels; null when all is visible', () => {
    const slot = { x: 100, y: 100, w: 300, h: 300 };
    const photo = { width: 4000, height: 3000 };
    const adj = (over: Partial<PhotoAdj>) => ({ ...DEFAULT_ADJ, ...over });
    // Portrait slot fully covered by a landscape photo: whole height visible.
    expect(photoVisibleCrop(slot, { ...photo, adj: adj({}) }, 6).crop).toEqual({
      left: 500,
      top: 0,
      width: 3000,
      height: 3000,
    });
    // Zoom 2, pan to the top-left corner: a quarter of the image.
    const z = photoVisibleCrop(
      slot,
      { ...photo, adj: adj({ zoom: 2, panX: 0, panY: 0 }) },
      6,
    );
    expect(z.fit).toEqual({ width: 4800, height: 3600 });
    expect(z.crop).toEqual({ left: 0, top: 0, width: 1500, height: 1500 });
    // Rotation widens the visible box (the clip corners turn into the photo's frame).
    const r = photoVisibleCrop(
      slot,
      { ...photo, adj: adj({ rot: 15 }) },
      6,
    ).crop!;
    expect(r.width).toBeGreaterThan(3000);
    expect(r.left + r.width).toBeLessThanOrEqual(4000);
    expect(r.top).toBe(0);
    expect(r.height).toBe(3000);
    // At 45° the clip's diagonal exceeds the drawn width: everything is visible.
    expect(
      photoVisibleCrop(slot, { ...photo, adj: adj({ rot: 45 }) }, 6).crop,
    ).toBeNull();
    // A square photo in a square slot shows everything: nothing to cut.
    expect(
      photoVisibleCrop(slot, { width: 2000, height: 2000, adj: adj({}) }, 6)
        .crop,
    ).toBeNull();
    // Two slots sharing one asset never get a crop (each shows a different part).
    const s = spec();
    const front = s.surfaces[0];
    const second = {
      ...(front.elements.find(
        (e) => e.type === 'image_slot',
      ) as ImageSlotElement),
      id: 'foto2',
      x: 10,
    };
    front.elements.push(second);
    const st = state();
    st.photos.foto2 = { ...st.photos[Object.keys(st.photos)[0]] };
    const shared = imageNeeds(s, st, 'print', 6).find(
      (n) => n.asset_id === PHOTO,
    )!;
    expect(shared.crop).toBeUndefined();
    expect(shared.fit).toEqual({ width: 2400, height: 1800 });
  });

  it('proof: web background and the photo preview', () => {
    const needs = imageNeeds(spec(), state(), 'proof', 2);
    expect(needs.map((n) => [n.asset_id, n.variant])).toEqual([
      [BG_WEB, 'original'],
      [PHOTO, 'preview'],
      [DECO, 'original'],
    ]);
  });

  it('print falls back to the web background', () => {
    const s = spec();
    delete s.surfaces[0].background.print;
    expect(imageNeeds(s, state(), 'print', 6)[0].asset_id).toBe(BG_WEB);
  });
});

describe('DesignerRenderService.renderPrint (mock browser)', () => {
  it('renders at 6 px/mm, downscales the photo original, stores PNG + derived proof', async () => {
    const b = build();
    const res = await b.service.renderPrint(oid(), new Date('2026-10-16'));
    expect(b.calls).toHaveLength(1);
    const { job, files, t } = b.calls[0];
    expect(job).toMatchObject({
      mode: 'print',
      scale: 6,
      type: 'image/png',
      locale: 'en', // the order's locale
    });
    expect(t).toBe(60_000);
    expect(job.fonts).toEqual([
      { family: 'Montserrat', weight: 600, style: 'normal', asset_id: FONT },
    ]);
    expect([...files.keys()].sort()).toEqual(
      [`a/${BG_PRINT}`, `a/${PHOTO}`, `a/${DECO}`, `f/${FONT}`].sort(),
    );
    // The served photo is the visible crop (original 500..3500 × 0..3000)
    // scaled to its drawn size, and the job tells the page where it goes.
    const photo = await sharp(files.get(`a/${PHOTO}`)!.body).metadata();
    expect([photo.width, photo.height]).toEqual([1800, 1800]);
    expect(job.assets).toEqual([
      { id: BG_PRINT },
      { id: PHOTO, crop: { fx: 0.125, fy: 0, fw: 0.75, fh: 1 } },
      { id: DECO },
    ]);

    expect(res.files).toEqual([
      expect.objectContaining({
        surface: 'front',
        format: 'png',
        key: `designer/${STORE}/2026/print/${OID}-front.png`,
        width_px: 3000,
        height_px: 4200,
        dpi: 152.4,
      }),
    ]);
    const meta = await sharp(b.written.get(res.files[0].key)).metadata();
    expect(meta.icc).toBeDefined();
    expect(Math.round(meta.density!)).toBe(152);
    expect(res.proof_key).toBe(`designer/${STORE}/2026/proof/${OID}.webp`);
    const proof = await sharp(b.written.get(res.proof_key!)).metadata();
    expect([proof.format, proof.width, proof.height]).toEqual([
      'webp',
      1000,
      1400,
    ]);
  });

  it('PNG only by default: no PDF render, one print file', async () => {
    const b = build();
    const res = await b.service.renderPrint(oid(), new Date('2026-10-16'));
    expect(b.pdfCalls).toHaveLength(0);
    expect(res.files.map((f) => f.format)).toEqual(['png']);
    expect(b.prisma.storeApp.findUnique).toHaveBeenCalledWith({
      where: { store_id_app_key: { store_id: STORE, app_key: 'designer' } },
      select: { settings: true },
    });
  });

  it('PDF on: second print file with bleed geometry, photo originals, crop marks', async () => {
    const b = build({
      settings: { print_formats: ['png', 'pdf'], print_crop_marks: true },
    });
    const s = spec();
    s.bleed_mm = 3;
    const res = await b.service.renderPrint(
      oid({ template_spec: s as never }),
      new Date('2026-10-16'),
    );
    expect(b.pdfCalls).toHaveLength(1);
    const { job, files, t } = b.pdfCalls[0];
    expect(t).toBe(90_000);
    expect(job.scale).toBe(6);
    expect(job.locale).toBe('en');
    // 500×700 + 3 mm bleed + 8 mm crop-mark slug (offset 3 + length 5).
    expect(job.geometry.page_mm).toEqual({ width: 516, height: 716 });
    expect(job.geometry.bleed_box_mm).toEqual({
      x: 5,
      y: 5,
      width: 506,
      height: 706,
    });
    expect(job.geometry.crop_mark_lines_mm).toHaveLength(8);
    // Originals: the photo is served whole (no crop, no downscale).
    expect(job.assets).toEqual([{ id: BG_PRINT }, { id: PHOTO }, { id: DECO }]);
    expect(files.get(`a/${PHOTO}`)!.body).toBe(await bigPhoto());
    expect(files.has(`f/${FONT}`)).toBe(true);
    expect(res.files.map((f) => f.format)).toEqual(['png', 'pdf']);
    const pdf = res.files[1];
    expect(pdf).toMatchObject({
      surface: 'front',
      format: 'pdf',
      key: `designer/${STORE}/2026/print/${OID}-front.pdf`,
      page_mm: { width: 516, height: 716 },
      trim_mm: { width: 500, height: 700 },
      bleed_mm: 3,
      crop_marks: true,
      width_px: 3096,
      height_px: 4296,
    });
    const stored = b.written.get(pdf.key)!;
    expect(pdf.bytes).toBe(stored.length);
    // The PDF step wrote the exact page boxes.
    const boxes = readPdfBoxes(stored);
    expect(boxes.MediaBox).toEqual([0, 0, mmToPt(516), mmToPt(716)]);
    expect(boxes.TrimBox).toEqual([
      mmToPt(8),
      mmToPt(8),
      mmToPt(508),
      mmToPt(708),
    ]);
  });

  it('PDF of a huge template: the coordinate scale drops so the page layer fits the canvas limits', async () => {
    const b = build({
      settings: { print_formats: ['png', 'pdf'], print_crop_marks: true },
    });
    (b.browser.renderCanvas as jest.Mock).mockImplementationOnce(
      async (job: CanvasJob) => {
        const w = Math.round(job.spec.width * job.scale);
        const h = Math.round(job.spec.height * job.scale);
        return {
          data: await sharp({
            create: { width: 8, height: 8, channels: 4, background: '#fff' },
          })
            .png()
            .toBuffer(),
          width: w,
          height: h,
          report: { fitted: {}, missing: [], elements: 0 },
        };
      },
    );
    const s = spec();
    s.width = 2725;
    s.height = 400;
    s.bleed_mm = 3;
    s.surfaces[0].elements = [];
    const res = await b.service.renderPrint(
      oid({ template_spec: s as never }),
      new Date('2026-10-16'),
    );
    const { job } = b.pdfCalls[0];
    // The PNG keeps 6 px/mm (16 350 px wide, within the limits).
    expect(res.files[0].width_px).toBe(16_350);
    expect(job.scale).toBeLessThan(6);
    expect(
      Math.ceil(job.geometry.page_mm.width * job.scale),
    ).toBeLessThanOrEqual(DESIGNER_MAX_CANVAS_SIDE);
  });

  it('pdfImageNeeds: originals, except photos over the per-photo / per-job pixel budget', () => {
    const fit = { width: 600, height: 400 };
    const assets = new Map([
      ['bg', { width: 11000, height: 9000 }],
      ['small', { width: 4000, height: 3000 }],
      ['huge', { width: 12000, height: 8000 }],
    ]);
    const needs = pdfImageNeeds(
      [
        { asset_id: 'bg', variant: 'original' },
        { asset_id: 'small', variant: 'original', fit, crop: undefined },
        {
          asset_id: 'huge',
          variant: 'original',
          fit,
          crop: { left: 1, top: 1, width: 10, height: 10 },
        },
      ],
      assets,
    );
    // Template images stay whole originals (the PNG decodes them too).
    expect(needs[0]).toEqual({ asset_id: 'bg', variant: 'original' });
    expect(needs[1]).toEqual({ asset_id: 'small', variant: 'original' });
    // 96 MP photo: downscaled to 2 × its drawn size, never cropped.
    expect(needs[2]).toEqual({
      asset_id: 'huge',
      variant: 'original',
      fit: { width: 1200, height: 800 },
    });
    // The per-job budget: four 36 MP photos → the fourth is downscaled.
    const many = new Map(
      ['a', 'b', 'c', 'd'].map((id) => [id, { width: 6000, height: 6000 }]),
    );
    const out = pdfImageNeeds(
      ['a', 'b', 'c', 'd'].map((id) => ({
        asset_id: id,
        variant: 'original' as const,
        fit,
      })),
      many,
    );
    expect(out.map((n) => !!n.fit)).toEqual([false, false, false, true]);
  });

  it('PDF on but the engine has no PDF support: retryable unavailable', async () => {
    const b = build({ settings: { print_formats: ['png', 'pdf'] } });
    delete (b.browser as { renderPdf?: unknown }).renderPdf;
    await expect(b.service.renderPrint(oid())).rejects.toMatchObject({
      retryable: true,
      code: 'DESIGNER_RENDER_UNAVAILABLE',
    });
  });

  it('keeps an existing order proof', async () => {
    const b = build();
    const res = await b.service.renderPrint(
      oid({ proof_key: 'designer/x/proof.webp' }),
    );
    expect(res.proof_key).toBeNull();
    expect(b.storage.write).toHaveBeenCalledTimes(1);
  });

  it('purged files: non-retryable, no browser call', async () => {
    const b = build();
    await expect(
      b.service.renderPrint(oid({ originals_purged_at: new Date() })),
    ).rejects.toMatchObject({
      retryable: false,
      code: 'DESIGNER_FILES_PURGED',
    });
    expect(b.calls).toHaveLength(0);
  });

  it('a missing asset row: non-retryable', async () => {
    const b = build();
    b.prisma.designAsset.findMany.mockResolvedValueOnce([]);
    await expect(b.service.renderPrint(oid())).rejects.toMatchObject({
      retryable: false,
      code: 'DESIGNER_ASSET_NOT_FOUND',
    });
  });

  it('a missing element in the report: non-retryable', async () => {
    const browser: DesignerBrowserRenderer = {
      enabled: true,
      close: () => Promise.resolve(),
      probe: () => Promise.resolve(),
      renderCanvas: () =>
        Promise.resolve({
          data: Buffer.alloc(0),
          width: 3000,
          height: 4200,
          report: { fitted: {}, missing: ['slot'], elements: 1 },
        }),
    };
    const b = build({ browser });
    await expect(b.service.renderPrint(oid())).rejects.toMatchObject({
      retryable: false,
      code: 'RENDER_MISSING',
    });
  });

  it('engine off: retryable unavailable error, no file reads', async () => {
    const b = build({ browser: new DisabledDesignerRenderer() });
    await expect(b.service.renderPrint(oid())).rejects.toMatchObject({
      retryable: true,
      code: 'DESIGNER_RENDER_UNAVAILABLE',
    });
    expect(b.assets.readAssetBytes).not.toHaveBeenCalled();
  });
});

describe('DesignerRenderService.renderDesignProof', () => {
  const design = (over: Record<string, unknown> = {}) => ({
    id: DESIGN,
    store_id: STORE,
    state: state(),
    state_version: 4,
    proof_key: null,
    proof_state_sha: null,
    template_version_id: 'v1',
    template_version: { spec: spec() },
    ...over,
  });

  it('renders a WebP proof at scale 2 from previews and records the state sha', async () => {
    const b = build();
    b.prisma.design.findUnique.mockResolvedValue(design());
    const res = await b.service.renderDesignProof(DESIGN, {
      now: new Date('2026-10-16'),
    });
    expect(res.reused).toBe(false);
    const sha = designProofSha(state(), 'v1');
    expect(res.proof_key).toBe(
      designProofKey(STORE, DESIGN, sha, new Date('2026-10-16')),
    );
    expect(res.proof_key).toMatch(
      new RegExp(`^designer/${STORE}/2026/proof/${DESIGN}-[a-p]{16}\\.webp$`),
    );
    expect(b.calls[0].job).toMatchObject({
      mode: 'proof',
      scale: 2,
      type: 'image/webp',
      quality: 0.85,
    });
    expect(b.calls[0].t).toBe(10_000);
    expect(b.calls[0].files.get(`a/${PHOTO}`)!.contentType).toBe('image/webp');
    expect(b.calls[0].job.locale).toBe('sv'); // store primary locale
    // Recorded through replaceDesignProofKey: fenced by state_version only.
    expect(b.prisma.design.updateMany).toHaveBeenCalledWith({
      where: { id: DESIGN, state_version: 4 },
      data: {
        proof_key: res.proof_key,
        proof_state_sha: sha,
      },
    });
    expect(b.urls.signedPath).toHaveBeenCalledWith('proof', DESIGN, STORE, {
      ttlSec: 3600,
    });
  });

  it('reuses the proof when the state sha matches', async () => {
    const b = build();
    b.written.set('designer/p.webp', Buffer.from('x'));
    b.prisma.design.findUnique.mockResolvedValue(
      design({
        proof_key: 'designer/p.webp',
        proof_state_sha: designProofSha(state(), 'v1'),
      }),
    );
    const res = await b.service.renderDesignProof(DESIGN);
    expect(res).toMatchObject({ reused: true, proof_key: 'designer/p.webp' });
    expect(b.calls).toHaveLength(0);
  });

  it('engine unavailable → 503 DESIGNER_RENDER_UNAVAILABLE', async () => {
    const b = build({ browser: new DisabledDesignerRenderer() });
    b.prisma.design.findUnique.mockResolvedValue(design());
    await expect(b.service.renderDesignProof(DESIGN)).rejects.toBeInstanceOf(
      DesignerRenderUnavailableError,
    );
  });

  it('a recorded proof releases the superseded file unless an order uses it', async () => {
    const b = build();
    b.written.set('designer/old.webp', Buffer.from('x'));
    b.prisma.design.findUnique.mockResolvedValue(
      design({ proof_key: 'designer/old.webp', proof_state_sha: 'stale' }),
    );
    const res = await b.service.renderDesignProof(DESIGN);
    const casCall = (
      b.prisma.design.updateMany.mock.calls[0] as unknown as [
        { where: Record<string, unknown> },
      ]
    )[0];
    expect(casCall.where).toEqual({ id: DESIGN, state_version: 4 });
    expect(b.storage.delete).toHaveBeenCalledWith('designer/old.webp');
    expect(b.written.has(res.proof_key)).toBe(true);

    const shared = build();
    shared.prisma.orderItemDesign.count.mockResolvedValue(1);
    shared.prisma.design.findUnique.mockResolvedValue(
      design({ proof_key: 'designer/old.webp', proof_state_sha: 'stale' }),
    );
    await shared.service.renderDesignProof(DESIGN);
    expect(shared.storage.delete).not.toHaveBeenCalled();
  });

  it('a lost race keeps the winner and releases its own file', async () => {
    const b = build();
    b.prisma.design.updateMany.mockResolvedValueOnce({ count: 0 });
    b.prisma.design.findUnique
      .mockResolvedValueOnce(design())
      .mockResolvedValue({ proof_key: 'designer/winner.webp' });
    const res = await b.service.renderDesignProof(DESIGN);
    expect(res.proof_key).toBe('designer/winner.webp');
    expect(b.storage.delete).toHaveBeenCalledTimes(1);
    const own = (b.storage.delete.mock.calls[0] as unknown[])[0] as string;
    expect(own).toMatch(/-[a-p]{16}\.webp$/);
    expect(b.written.has(own)).toBe(false);
  });

  it('identical concurrent requests share one render', async () => {
    const b = build();
    b.prisma.design.findUnique.mockResolvedValue(design());
    const [r1, r2] = await Promise.all([
      b.service.renderDesignProof(DESIGN),
      b.service.renderDesignProof(DESIGN),
    ]);
    expect(b.calls).toHaveLength(1);
    expect(r1.proof_key).toBe(r2.proof_key);
  });

  it('one proof per store at a time; a long queue gets 503', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let running = 0;
    let peak = 0;
    const base = build();
    const slow: DesignerBrowserRenderer = {
      enabled: true,
      close: () => Promise.resolve(),
      probe: () => Promise.resolve(),
      renderCanvas: async (job, files, t) => {
        running++;
        peak = Math.max(peak, running);
        await gate;
        running--;
        return base.browser.renderCanvas(job, files, t);
      },
    };
    const b = build({ browser: slow });
    // Every request is a different state of a different design of the store.
    let n = 0;
    b.prisma.design.findUnique.mockImplementation(() =>
      Promise.resolve(
        design({
          id: `33333333-3333-4333-8333-33333333333${n}`,
          state: { ...state(), texts: { t: String(n++) } },
        }),
      ),
    );
    const jobs = Array.from({ length: 6 }, () =>
      b.service.renderDesignProof(DESIGN).then(
        () => 'ok',
        (e: unknown) => e,
      ),
    );
    await new Promise((r) => setTimeout(r, 20));
    release();
    const out = await Promise.all(jobs);
    expect(peak).toBe(1);
    expect(out.filter((o) => o === 'ok')).toHaveLength(5);
    expect(
      out.filter((o) => o instanceof DesignerRenderUnavailableError),
    ).toHaveLength(1);
  });

  it('purgeDesignProof clears the row (CAS) and deletes the file', async () => {
    const b = build();
    b.prisma.design.findUnique.mockResolvedValue({
      proof_key: 'designer/p.webp',
    });
    await expect(b.service.purgeDesignProof(DESIGN)).resolves.toEqual({
      deleted: true,
    });
    expect(b.prisma.design.updateMany).toHaveBeenCalledWith({
      where: { id: DESIGN, proof_key: 'designer/p.webp' },
      data: { proof_key: null, proof_state_sha: null },
    });
    expect(b.storage.delete).toHaveBeenCalledWith('designer/p.webp');
    b.prisma.design.findUnique.mockResolvedValue({ proof_key: null });
    await expect(b.service.purgeDesignProof(DESIGN)).resolves.toEqual({
      deleted: false,
    });
  });

  it('unknown design → 404', async () => {
    const b = build();
    b.prisma.design.findUnique.mockResolvedValue(null);
    await expect(b.service.renderDesignProof(DESIGN)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('scale clamps', () => {
  it('a normal template keeps its scales (golden parity)', () => {
    expect(proofScale(spec())).toBe(2);
    expect(printScale(spec())).toBe(6);
  });
  it('the proof is clamped to ~4 MP whatever preview_px_per_mm says', () => {
    const s = {
      ...spec(),
      render: { ...spec().render, preview_px_per_mm: 50 },
    };
    const k = proofScale(s);
    expect(500 * k * 700 * k).toBeLessThanOrEqual(4_000_000);
    expect(k).toBeGreaterThan(3.3);
  });
  it('the print is clamped for an oversized trim size', () => {
    const s = { ...spec(), width: 5000, height: 5000 };
    const k = printScale(s);
    expect(5000 * k).toBeLessThanOrEqual(16_384);
    expect(5000 * k * 5000 * k).toBeLessThanOrEqual(64_000_000);
  });
});

describe('helpers', () => {
  it('canonicalJson sorts keys at every level (stable proof sha)', () => {
    expect(
      canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: null } }),
    ).toBe('{"a":{"c":null,"d":[2,{"x":2,"y":1}]},"b":1}');
    expect(designProofSha({ v: 1, a: 2 }, 'x')).toBe(
      designProofSha({ a: 2, v: 1 }, 'x'),
    );
    expect(designProofSha({ v: 1 }, 'x')).not.toBe(
      designProofSha({ v: 1 }, 'y'),
    );
  });

  it('classifyRenderError', () => {
    expect(
      classifyRenderError(new Error('Designer render timed out')),
    ).toMatchObject({ retryable: true });
    expect(
      classifyRenderError(
        new Error('page.evaluate: Error: FONT_LOAD_FAILED:X'),
      ),
    ).toMatchObject({ retryable: false, code: 'FONT_LOAD_FAILED' });
    expect(
      classifyRenderError(designerErrors.gone('DESIGNER_FILES_PURGED', 'gone')),
    ).toMatchObject({ retryable: false, code: 'DESIGNER_FILES_PURGED' });
    expect(
      classifyRenderError(new DesignerRenderUnavailableError()),
    ).toMatchObject({ retryable: true, code: 'DESIGNER_RENDER_UNAVAILABLE' });
    const own = new DesignerRenderJobError('x', false, 'C');
    expect(classifyRenderError(own)).toBe(own);
  });
});

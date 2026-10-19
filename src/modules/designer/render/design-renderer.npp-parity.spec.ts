/*
 * NPP parity (M4.2 launch fix, §3.4): the shared renderer must draw an
 * imported template exactly as the client's plugin printed it.
 *
 * Oracle: `npp/__fixtures__/npp-render.js`, a verbatim port of
 * order-viewer.js:56-171 (the NPP 1.9.1 print export). For each of the 10
 * converted templates the raw NPP elements (from the fixtures the converter
 * reads) are rendered by the oracle at sf = 6 with the print background
 * override, a customer value in every editable text (Swedish name with
 * å/ä/ö, a class) and a photo with pan / zoom / rotation in every slot; the
 * converted spec is rendered by `renderDesign` in `print` mode at 6 px/mm
 * with the same state. Both draw into a RecordingCtx; the normalized draw
 * logs must be identical.
 *
 * Two normalizations, neither of which changes a pixel: `=direction`
 * entries are dropped from our log (NPP never set `ctx.direction`;
 * imported templates use `ltr`, the canvas default), and the weight in the
 * oracle's `=font` strings is snapped with the converter's `nearestWeight`
 * to a weight the Google family ships (NPP asked Anton for 500; CSS font
 * matching gives it the only face, 400, which is what the converter
 * records and warns about as FONT_WEIGHT_SUBSTITUTED). The three intended
 * deviations (smoothing quality,
 * cover background, empty optional slot in print) are not exercised here
 * by construction: imported templates use `fit: 'stretch'`, every slot has
 * a photo, and smoothing is a page setting, not a draw call. They are
 * listed in the renderer header and in M4.2-DESIGN §3.4.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  fakeImage,
  loadTemplate,
  RecordingCtx,
  stateFor,
  TEMPLATE_IDS,
  type LogEntry,
} from '../__fixtures__/golden/golden-kit.mockspec';
import { renderDesign, type TemplateSpecV1 } from '@multi-stores/core/designer';
import {
  convertNpp,
  KNOWN_GOOGLE_WEIGHTS,
  nearestWeight,
  type NppConvertedTemplate,
} from '../npp/npp-converter';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const createNppRenderer = require('../npp/__fixtures__/npp-render.js') as (
  data: {
    elements: NppElement[];
    imgAdj: Record<string, unknown>;
    sizeMode?: string;
  },
  imageCache: Record<string, unknown>,
) => {
  renderToCanvas: (
    canvas: { width: number; height: number; getContext: () => RecordingCtx },
    sf: number,
    bgOverride?: string,
  ) => void;
};

type NppElement = Record<string, unknown> & { id: string; type: string };

const FIX = path.join(__dirname, '..', 'npp', '__fixtures__');
const read = (f: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));

/** Raw NPP templates by id, first occurrence wins (as the converter does). */
function rawTemplates(): Map<string, NppElement[]> {
  const out = new Map<string, NppElement[]>();
  const files = fs
    .readdirSync(FIX)
    .filter((f) => /^se_\d+\.json$/.test(f))
    .sort();
  for (const f of files) {
    const d = read(f) as {
      templateData?: { id: string; elements: NppElement[] };
    };
    const td = d.templateData;
    if (td && !out.has(String(td.id))) out.set(String(td.id), td.elements);
  }
  const rest = read('template_4410.json') as {
    id: string | number;
    elements: NppElement[];
  };
  if (!out.has(String(rest.id))) out.set(String(rest.id), rest.elements);
  return out;
}

const ALL_INPUT = [
  ...fs
    .readdirSync(FIX)
    .filter((f) => /^se_\d+\.json$/.test(f))
    .sort()
    .map(read),
  read('template_4410.json'),
  read('templates.json'),
];
const converted = convertNpp(ALL_INPUT, { siteHost: 'namez.se' });
const RAW = rawTemplates();

/** The NPP element types the converter turns into spec elements. */
const CONVERTED_TYPES = new Set([
  'text',
  'image-slot',
  'deco-image',
  'overlay',
]);

/** Image handle with the natural size NPP's cover math reads. */
function nppImage(id: string, w = 0, h = 0) {
  return { ...fakeImage(id), naturalWidth: w, naturalHeight: h };
}

function nppLog(
  t: NppConvertedTemplate,
  raw: NppElement[],
  spec: TemplateSpecV1,
) {
  const state = stateFor(spec, 'sv');
  // Pair raw elements with spec elements in order (the converter keeps the
  // array order and skips background / unsupported / image-less elements).
  const specEls = spec.surfaces[0].elements;
  const rawEls = raw.filter(
    (e) =>
      CONVERTED_TYPES.has(e.type) &&
      !((e.type === 'deco-image' || e.type === 'overlay') && !e.imageData),
  );
  expect(rawEls.map((e) => e.id)).toEqual(specEls.map((e) => e.id));

  const imageCache: Record<string, unknown> = {};
  for (const f of t.fetch) {
    if (f.role === 'thumb') continue;
    imageCache[f.url] = fakeImage(f.key);
    if (f.fallback_url) imageCache[f.fallback_url] = fakeImage(f.key);
  }
  const elements: NppElement[] = raw.map((e) => ({ ...e }));
  const imgAdj: Record<string, unknown> = {};
  for (const e of elements) {
    if (e.type === 'text' && e.editable !== false) {
      e.customerValue = state.texts[e.id];
    } else if (e.type === 'image-slot') {
      const p = state.photos[e.id];
      const src = 'photo://' + e.id;
      e.customerImage = src;
      imageCache[src] = nppImage(p.asset_id, p.width, p.height);
      imgAdj[e.id] = { ...p.adj };
    }
  }
  const bg = raw.find((e) => e.type === 'background');
  const bgOverride =
    (bg && (bg.imageDataHiRes as string)) ||
    (bg && (bg.imageData as string)) ||
    undefined;
  const ctx = new RecordingCtx();
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  createNppRenderer({ elements, imgAdj }, imageCache).renderToCanvas(
    canvas,
    6,
    bgOverride,
  );
  return { log: ctx.normalizedLog().map(snapFontWeight), canvas, state };
}

/** `=font` of the oracle with the weight a Google family can supply. */
function snapFontWeight(e: LogEntry): LogEntry {
  if (e[0] !== '=font') return e;
  const m = /^(\d+) (.+px) "(.+)"$/.exec(String(e[1]));
  if (!m) return e;
  const available = KNOWN_GOOGLE_WEIGHTS[m[3]];
  if (!available) return e;
  return [
    '=font',
    `${nearestWeight(Number(m[1]), available)} ${m[2]} "${m[3]}"`,
  ];
}

function ourLog(
  spec: TemplateSpecV1,
  state: ReturnType<typeof stateFor>,
): LogEntry[] {
  const ctx = new RecordingCtx();
  const report = renderDesign(ctx, {
    spec,
    surface: 'front',
    state,
    mode: 'print',
    scale: 6,
    locale: 'sv',
    images: { get: (id: string) => fakeImage(id) },
  });
  expect(report.missing).toEqual([]);
  return ctx.normalizedLog().filter((e) => e[0] !== '=direction');
}

describe('NPP parity: renderDesign(print, 6 px/mm) = order-viewer.js renderToCanvas(sf 6)', () => {
  it('covers the 10 converted templates', () => {
    expect(TEMPLATE_IDS).toHaveLength(10);
    for (const stem of TEMPLATE_IDS)
      expect(RAW.has(stem.replace('template_', ''))).toBe(true);
  });

  it.each(TEMPLATE_IDS)(
    '%s: identical draw logs (photo pan/zoom/rotate, Swedish texts)',
    (stem) => {
      const id = stem.replace('template_', '');
      const t = converted.templates.find((x) => x.source_id === id)!;
      const spec = loadTemplate(stem);
      expect(t.spec).toEqual(spec); // the committed expected fixture is the converter's output
      const npp = nppLog(t, RAW.get(id)!, spec);
      expect([npp.canvas.width, npp.canvas.height]).toEqual([3000, 4200]);
      const ours = ourLog(spec, npp.state);
      expect(ours).toEqual(npp.log);
      // Sanity: real work happened (background, every text and every photo drawn).
      const draws = ours.filter((e) => e[0] === 'drawImage').length;
      const slots = spec.surfaces[0].elements.filter(
        (e) => e.type === 'image_slot',
      ).length;
      const decos = spec.surfaces[0].elements.filter(
        (e) => e.type === 'image',
      ).length;
      expect(draws).toBe(1 + slots + decos);
      expect(ours.filter((e) => e[0] === 'fillText').length).toBe(
        spec.surfaces[0].elements.filter((e) => e.type === 'text').length,
      );
    },
  );

  it('deviation 3 is real: an empty optional slot draws nothing in print (NPP filled it #e8e8e8)', () => {
    const spec = loadTemplate('template_4273');
    const slot = spec.surfaces[0].elements.find(
      (e) => e.type === 'image_slot',
    )!;
    const state = stateFor(spec, 'sv');
    delete state.photos[slot.id];
    const ours = ourLog(spec, state);
    expect(ours.some((e) => e[0] === '=fillStyle' && e[1] === '#e8e8e8')).toBe(
      false,
    );
    const raw = RAW.get('4273')!.map((e) => ({ ...e }));
    const ctx = new RecordingCtx();
    createNppRenderer({ elements: raw, imgAdj: {} }, {}).renderToCanvas(
      { width: 0, height: 0, getContext: () => ctx },
      6,
    );
    expect(
      ctx.log.some((e) => e[0] === '=fillStyle' && e[1] === '#e8e8e8'),
    ).toBe(true);
  });
});

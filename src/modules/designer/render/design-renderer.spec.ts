/*
 * Deterministic geometry tests for the designer renderer (M4.2 §12.1).
 * A fake Ctx2D records every call together with the current transform matrix;
 * measureText is linear in the font's pixel size, so text-fit results are exact.
 * Pixel golden tests (Chromium) come later (§12.3).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  canvasSize,
  designTextLength,
  coverLayout,
  Ctx2D,
  DesignStateV1,
  effectiveDpi,
  fitTextSize,
  fontString,
  ImageSlotElement,
  renderDesign,
  RenderInput,
  resolveText,
  sortElements,
  TemplateSpecV1,
  TextElement,
  validateSpec,
  validateState,
} from './design-renderer';
import {
  convertNpp,
  finalizeTemplateAssets,
  NppConvertedTemplate,
} from '../npp/npp-converter';

/* ------------------------------------------------------------------ */
/* Fake context with an affine matrix                                  */
/* ------------------------------------------------------------------ */

type M = [number, number, number, number, number, number]; // a b c d e f
const I: M = [1, 0, 0, 1, 0, 0];
function mul(m: M, n: M): M {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
const apply = (m: M, x: number, y: number) => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

interface Call {
  op: string;
  args: unknown[];
  m: M;
  font: string;
  fillStyle: unknown;
  textAlign: string;
  textBaseline: string;
}

/** Width = text.length × px × factor (px parsed from the font shorthand). */
const linearMeasure = (factor: number) => (text: string, font: string) => {
  const px = Number(/([\d.]+)px/.exec(font)?.[1] ?? 0);
  return text.length * px * factor;
};

class FakeCtx implements Ctx2D {
  calls: Call[] = [];
  measures = 0;
  m: M = I;
  private stack: {
    m: M;
    font: string;
    fillStyle: unknown;
    strokeStyle: unknown;
  }[] = [];
  font = '10px sans-serif';
  fillStyle: unknown = '#000';
  strokeStyle: unknown = '#000';
  lineWidth = 1;
  textAlign = 'start';
  textBaseline = 'alphabetic';
  direction = 'inherit';
  constructor(
    private measure: (text: string, font: string) => number = linearMeasure(
      0.6,
    ),
  ) {}
  private rec(op: string, args: unknown[]) {
    this.calls.push({
      op,
      args,
      m: this.m,
      font: this.font,
      fillStyle: this.fillStyle,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
    });
  }
  save() {
    this.stack.push({
      m: this.m,
      font: this.font,
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
    });
    this.rec('save', []);
  }
  restore() {
    const s = this.stack.pop();
    if (s) Object.assign(this, s);
    this.rec('restore', []);
  }
  translate(x: number, y: number) {
    this.m = mul(this.m, [1, 0, 0, 1, x, y]);
  }
  rotate(a: number) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    this.m = mul(this.m, [c, s, -s, c, 0, 0]);
  }
  beginPath() {
    this.rec('beginPath', []);
  }
  rect(...a: number[]) {
    this.rec('rect', a);
  }
  ellipse(...a: number[]) {
    this.rec('ellipse', a);
  }
  moveTo(...a: number[]) {
    this.rec('moveTo', a);
  }
  lineTo(...a: number[]) {
    this.rec('lineTo', a);
  }
  quadraticCurveTo(...a: number[]) {
    this.rec('quadraticCurveTo', a);
  }
  closePath() {
    this.rec('closePath', []);
  }
  clip() {
    this.rec('clip', []);
  }
  fill() {
    this.rec('fill', []);
  }
  stroke() {
    this.rec('stroke', []);
  }
  fillRect(...a: number[]) {
    this.rec('fillRect', a);
  }
  strokeRect(...a: number[]) {
    this.rec('strokeRect', a);
  }
  clearRect(...a: number[]) {
    this.rec('clearRect', a);
  }
  setLineDash(seg: number[]) {
    this.rec('setLineDash', [seg]);
  }
  drawImage(img: unknown, ...a: number[]) {
    this.rec('drawImage', [img, ...a]);
  }
  fillText(t: string, x: number, y: number) {
    this.rec('fillText', [t, x, y]);
  }
  measureText(text: string) {
    this.measures++;
    return { width: this.measure(text, this.font) };
  }
  ops(op: string) {
    return this.calls.filter((c) => c.op === op);
  }
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const FIX = path.join(__dirname, '..', 'npp', '__fixtures__');
function loadAll(): unknown[] {
  return fs
    .readdirSync(FIX)
    .filter((f) => /^(se_\d+|template_\d+|templates)\.json$/.test(f))
    .sort()
    .map(
      (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8')) as unknown,
    );
}
const converted = convertNpp(loadAll(), { siteHost: 'namez.se' });
const tpl = (id: string): NppConvertedTemplate => {
  const t = converted.templates.find((x) => x.source_id === id);
  if (!t) throw new Error('missing template ' + id);
  return t;
};
/** Finalized spec with deterministic fake assets (id = pending key without prefix). */
function finalSpec(
  id: string,
  dims: Record<string, [number, number]> = {},
): TemplateSpecV1 {
  const t = tpl(id);
  const media: Record<
    string,
    { asset_id: string; width: number; height: number }
  > = {};
  for (const f of t.fetch) {
    const [w, h] = dims[f.key] || [3000, 4200];
    media[f.key] = {
      asset_id: f.key.replace('pending:', 'a:'),
      width: w,
      height: h,
    };
  }
  for (const f of t.fonts)
    media[f.key] = {
      asset_id: f.key.replace('pending:', 'a:'),
      width: 0,
      height: 0,
    };
  return finalizeTemplateAssets(t, media).spec;
}
const textEl = (spec: TemplateSpecV1, label: string) =>
  spec.surfaces[0].elements.find(
    (e) => e.type === 'text' && e.label.sv === label,
  ) as TextElement;
const slotEl = (spec: TemplateSpecV1) =>
  spec.surfaces[0].elements.find(
    (e) => e.type === 'image_slot',
  ) as ImageSlotElement;

/** Image lookup that returns a tagged object for every asset id. */
const tagImages = () => ({ get: (id: string) => ({ tag: id }) });
const emptyState = (): DesignStateV1 => ({ v: 1, texts: {}, photos: {} });

function input(
  spec: TemplateSpecV1,
  over: Partial<RenderInput> = {},
): RenderInput {
  return {
    spec,
    state: emptyState(),
    mode: 'proof',
    scale: 2,
    images: tagImages(),
    locale: 'sv',
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('design-renderer', () => {
  describe('canvasSize', () => {
    it('500×700 mm → 3000×4200 at 6 px/mm and 1000×1400 at 2 px/mm', () => {
      const spec = finalSpec('4273');
      expect(canvasSize(spec, 6)).toEqual({ width: 3000, height: 4200 });
      expect(canvasSize(spec, 2)).toEqual({ width: 1000, height: 1400 });
      expect(canvasSize({ ...spec, bleed_mm: 3 }, 1, true)).toEqual({
        width: 506,
        height: 706,
      });
    });
  });

  describe('sortElements', () => {
    it('sorts by z and keeps array order on ties (stable)', () => {
      const els = [
        { id: 'a', z: 3 },
        { id: 'b', z: 1 },
        { id: 'c', z: 3 },
        { id: 'd', z: 1 },
        { id: 'e', z: 2 },
        { id: 'f', z: 3 },
      ];
      expect(sortElements(els).map((e) => e.id)).toEqual([
        'b',
        'd',
        'e',
        'a',
        'c',
        'f',
      ]);
      // Input untouched.
      expect(els.map((e) => e.id).join('')).toBe('abcdef');
    });
    it('treats missing / non-finite z as 0', () => {
      const els = [
        { id: 'a', z: 1 },
        { id: 'b', z: NaN },
        { id: 'c', z: -1 },
      ];
      expect(sortElements(els).map((e) => e.id)).toEqual(['c', 'b', 'a']);
    });
    it('is stable across many ties (20 equal z values)', () => {
      const els = Array.from({ length: 20 }, (_, i) => ({
        id: 'e' + i,
        z: i % 2,
      }));
      const ids = sortElements(els).map((e) => e.id);
      expect(ids.slice(0, 10)).toEqual(
        Array.from({ length: 10 }, (_, i) => 'e' + i * 2),
      );
      expect(ids.slice(10)).toEqual(
        Array.from({ length: 10 }, (_, i) => 'e' + (i * 2 + 1)),
      );
    });
  });

  describe('resolveText', () => {
    const spec = finalSpec('4273');
    const namn = textEl(spec, 'Namn');
    const st = (v?: string): DesignStateV1 => ({
      v: 1,
      texts: v === undefined ? {} : { [namn.id]: v },
      photos: {},
    });
    it('uses the customer value, else the default text', () => {
      expect(resolveText(namn, st('Anna'), 'sv')).toBe('Anna');
      expect(resolveText(namn, st(''), 'sv')).toBe('Namn');
      expect(resolveText(namn, st(), 'sv')).toBe('Namn');
    });
    it('falls back to the placeholder when the default text is empty', () => {
      const el = { ...namn, default_text: '' };
      expect(resolveText(el, st(), 'sv')).toBe('Namn'); // placeholder (normalized from "Enter Namn")
      expect(
        resolveText({ ...el, placeholder: { sv: 'Skriv' } }, st(), 'sv'),
      ).toBe('Skriv');
    });
    it('uppercase: value/default uppercased, never the placeholder (NPP product.js:150)', () => {
      const el: TextElement = { ...namn, transform: 'uppercase' };
      expect(resolveText(el, st('anna'), 'sv')).toBe('ANNA');
      expect(resolveText(el, st(), 'sv')).toBe('NAMN');
      expect(resolveText({ ...el, default_text: '' }, st(), 'sv')).toBe('');
    });
    it('non-editable elements ignore the state', () => {
      expect(resolveText({ ...namn, editable: false }, st('Anna'), 'sv')).toBe(
        'Namn',
      );
    });
  });

  describe('fitTextSize (NPP shrink loop)', () => {
    const spec = finalSpec('4273');
    const namn = textEl(spec, 'Namn'); // w 300, size 73, Montserrat 600
    const fs6 = (s: number, sc: number) => fontString(namn.font, s, sc);

    it('keeps the template size when the text fits (one measure)', () => {
      const ctx = new FakeCtx();
      expect(fitTextSize(ctx, 'Namn', namn, fs6, 6)).toBe(73);
      expect(ctx.measures).toBe(1);
      expect(ctx.font).toBe('600 438px "Montserrat"');
    });

    it('shrinks in 0.5 steps to the first size with width <= w*6 - 8', () => {
      // 29 chars × s × 6 × 0.6 <= 1792 → s <= 17.16 → 17
      const ctx = new FakeCtx();
      const text = 'Alexandra Johansson-Lindqvist';
      expect(text.length).toBe(29);
      expect(fitTextSize(ctx, text, namn, fs6, 6)).toBe(17);
      expect(ctx.measures).toBe((73 - 17) / 0.5 + 1);
    });

    it('accepts width exactly equal to the limit (<=)', () => {
      // 1 char, factor chosen so that width at s=50 is exactly 1792.
      const ctx = new FakeCtx(linearMeasure(1792 / (50 * 6)));
      expect(fitTextSize(ctx, 'X', namn, fs6, 6)).toBe(50);
    });

    it('stops at min 6 and returns 6 when nothing fits', () => {
      const ctx = new FakeCtx(linearMeasure(100));
      expect(fitTextSize(ctx, 'WWWWWWWW', namn, fs6, 6)).toBe(6);
      expect(ctx.measures).toBe((73 - 6) / 0.5 + 1);
    });

    it('returns min without measuring when the template size is already below min (NPP)', () => {
      const ctx = new FakeCtx();
      expect(fitTextSize(ctx, 'abc', { ...namn, size: 5 }, fs6, 6)).toBe(6);
      expect(ctx.measures).toBe(0);
    });

    it('does not drift with fractional sizes (size - i*step)', () => {
      const ctx = new FakeCtx(linearMeasure(100));
      fitTextSize(ctx, 'W', { ...namn, size: 7.3 }, fs6, 6);
      // 7.3, 6.8, 6.3 — three exact steps.
      expect(ctx.measures).toBe(3);
    });

    it('D5: pad is unscaled, so NPP at sf=2 and sf=6 can disagree; we always fit at ref 6', () => {
      // width = 9.9 × px. ref 6: s ≤ 1792/(9.9×6)=30.17 → 30.  NPP sf=2: s ≤ 592/(9.9×2)=29.9 → 29.5
      const m = linearMeasure(9.9);
      expect(fitTextSize(new FakeCtx(m), 'X', namn, fs6, 6)).toBe(30);
      expect(fitTextSize(new FakeCtx(m), 'X', namn, fs6, 2)).toBe(29.5);
      const fitted = [2, 6, 1].map((scale) => {
        const ctx = new FakeCtx(m);
        const r = renderDesign(
          ctx,
          input(spec, {
            scale,
            state: { v: 1, texts: { [namn.id]: 'X' }, photos: {} },
          }),
        );
        return r.fitted[namn.id];
      });
      expect(fitted).toEqual([30, 30, 30]);
    });
  });

  describe('text drawing', () => {
    const spec = finalSpec('4273');
    const namn = textEl(spec, 'Namn');
    it('draws at the output scale with NPP alignment and baseline', () => {
      const ctx = new FakeCtx();
      renderDesign(
        ctx,
        input(spec, {
          scale: 2,
          state: { v: 1, texts: { [namn.id]: 'Anna' }, photos: {} },
        }),
      );
      const t = ctx.ops('fillText').find((c) => c.args[0] === 'Anna')!;
      expect(t.font).toBe('600 146px "Montserrat"');
      expect(t.fillStyle).toBe('#ffffff');
      expect(t.textAlign).toBe('center');
      expect(t.textBaseline).toBe('middle');
      expect(t.args[1]).toBe((90 + 150) * 2);
      expect(t.args[2]).toBe((40 + 26) * 2);
    });
    it('left/right use the 4 mm inset scaled (NPP x*sf + 4*sf)', () => {
      for (const [align, x] of [
        ['left', (90 + 4) * 6],
        ['right', (90 + 300 - 4) * 6],
      ] as const) {
        const el: TextElement = { ...namn, align };
        const s: TemplateSpecV1 = {
          ...spec,
          surfaces: [{ ...spec.surfaces[0], elements: [el] }],
        };
        const ctx = new FakeCtx();
        renderDesign(ctx, input(s, { scale: 6 }));
        const t = ctx.ops('fillText')[0];
        expect(t.textAlign).toBe(align);
        expect(t.args[1]).toBe(x);
      }
    });
    it('skips a text element whose font is not loaded and reports it', () => {
      const ctx = new FakeCtx();
      const r = renderDesign(
        ctx,
        input(spec, {
          fonts: { has: (f, w) => !(f === 'Montserrat' && w === 600) },
        }),
      );
      expect(r.missing).toEqual([namn.id]);
      expect(ctx.ops('fillText').map((c) => c.args[0])).toEqual(['Klass']);
    });
  });

  describe('coverLayout / effectiveDpi', () => {
    const slot = { x: 113, y: 171, w: 271, h: 359 }; // 4273 slot
    it('landscape photo, zoom 1: fills the height, pans across the width', () => {
      // iA 4/3 > sA → bh = 359×6 = 2154, bw = 2872; overflow x = 2872 − 1626 = 1246
      const at = (panX: number) =>
        coverLayout(slot, 4000, 3000, { zoom: 1, rot: 0, panX, panY: 0.5 }, 6);
      expect(at(0.5)).toEqual({
        dx: 55,
        dy: 1026,
        dw: 2872,
        dh: 2154,
        rot: 0,
        cx: 55 + 1436,
        cy: 1026 + 1077,
      });
      expect(at(0).dx).toBe(678);
      expect(at(1).dx).toBe(678 - 1246);
      expect(at(0.5).dy).toBe(171 * 6); // no vertical overflow
    });
    it('portrait photo, zoom 3, pan (0.1, 0.9), rot 17', () => {
      // iA 2/3 < sA → bw = 1626, bh = 2439; ×3 → 4878 × 7317
      const l = coverLayout(
        slot,
        2400,
        3600,
        { zoom: 3, rot: 17, panX: 0.1, panY: 0.9 },
        6,
      );
      expect(l.dw).toBeCloseTo(4878, 9);
      expect(l.dh).toBeCloseTo(7317, 9);
      expect(l.dx).toBeCloseTo(678 - (4878 - 1626) * 0.1, 9);
      expect(l.dy).toBeCloseTo(1026 - (7317 - 2154) * 0.9, 9);
      expect(l.rot).toBe(17);
      expect(l.cx).toBeCloseTo(l.dx + 4878 / 2, 9);
      expect(l.cy).toBeCloseTo(l.dy + 7317 / 2, 9);
    });
    it('rot ±180 passes through unchanged', () => {
      expect(
        coverLayout(
          slot,
          1000,
          1000,
          { zoom: 1, rot: 180, panX: 0.5, panY: 0.5 },
          2,
        ).rot,
      ).toBe(180);
      expect(
        coverLayout(
          slot,
          1000,
          1000,
          { zoom: 1, rot: -180, panX: 0.5, panY: 0.5 },
          2,
        ).rot,
      ).toBe(-180);
    });
    it('is scale-linear', () => {
      const a = coverLayout(
        slot,
        4000,
        3000,
        { zoom: 2.3, rot: 0, panX: 0.3, panY: 0.7 },
        1,
      );
      const b = coverLayout(
        slot,
        4000,
        3000,
        { zoom: 2.3, rot: 0, panX: 0.3, panY: 0.7 },
        6,
      );
      for (const k of ['dx', 'dy', 'dw', 'dh', 'cx', 'cy'] as const)
        expect(b[k]).toBeCloseTo(a[k] * 6, 9);
    });
    it('effectiveDpi = original px per inch of printed width', () => {
      // zoom 1: printed width 2872/6 mm = 478.67 mm → 4000 / (478.67/25.4) = 212.26 dpi
      expect(
        effectiveDpi(slot, 4000, 3000, {
          zoom: 1,
          rot: 0,
          panX: 0.5,
          panY: 0.5,
        }),
      ).toBeCloseTo((4000 * 25.4) / (2872 / 6), 9);
      expect(
        effectiveDpi(slot, 4000, 3000, {
          zoom: 2,
          rot: 0,
          panX: 0.5,
          panY: 0.5,
        }),
      ).toBeCloseTo((4000 * 25.4) / (2872 / 3), 9);
    });
  });

  describe('photo transform (matrix)', () => {
    // 4368: slot x63 y221 w312 h371 rot 5
    const spec = finalSpec('4368');
    const slot = slotEl(spec);
    const adj = { zoom: 2.3, rot: 17, panX: 0.1, panY: 0.9 };
    const state: DesignStateV1 = {
      v: 1,
      texts: {},
      photos: {
        [slot.id]: { asset_id: 'photo1', width: 2400, height: 3600, adj },
      },
    };
    const rotAround = (
      x: number,
      y: number,
      cx: number,
      cy: number,
      deg: number,
    ) => {
      const a = (deg * Math.PI) / 180;
      return [
        cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a),
        cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a),
      ];
    };

    it('maps the photo rect through photo rotation, then slot rotation', () => {
      const ctx = new FakeCtx();
      const r = renderDesign(
        ctx,
        input(spec, { scale: 6, mode: 'print', state }),
      );
      expect(r.missing).toEqual([]);
      const d = ctx
        .ops('drawImage')
        .find((c) => (c.args[0] as { tag: string }).tag === 'photo1')!;
      const [, dx, dy, dw, dh] = d.args as number[];
      const l = coverLayout(slot, 2400, 3600, adj, 6);
      expect([dx, dy, dw, dh]).toEqual([l.dx, l.dy, l.dw, l.dh]);
      const scx = (slot.x + slot.w / 2) * 6;
      const scy = (slot.y + slot.h / 2) * 6;
      for (const [px, py] of [
        [dx, dy],
        [dx + dw, dy],
        [dx, dy + dh],
        [dx + dw, dy + dh],
      ]) {
        const inner = rotAround(px, py, l.cx, l.cy, 17);
        const expected = rotAround(inner[0], inner[1], scx, scy, 5);
        const got = apply(d.m, px, py);
        expect(got[0]).toBeCloseTo(expected[0], 6);
        expect(got[1]).toBeCloseTo(expected[1], 6);
      }
    });

    it('clips to the slot rect under the slot rotation only', () => {
      const ctx = new FakeCtx();
      renderDesign(ctx, input(spec, { scale: 6, mode: 'print', state }));
      const clipIdx = ctx.calls.findIndex((c) => c.op === 'clip');
      const rect = ctx.calls
        .slice(0, clipIdx)
        .filter((c) => c.op === 'rect')
        .pop()!;
      expect(rect.args).toEqual([
        slot.x * 6,
        slot.y * 6,
        slot.w * 6,
        slot.h * 6,
      ]);
      const scx = (slot.x + slot.w / 2) * 6;
      const scy = (slot.y + slot.h / 2) * 6;
      const exp = rotAround(slot.x * 6, slot.y * 6, scx, scy, 5);
      const got = apply(rect.m, slot.x * 6, slot.y * 6);
      expect(got[0]).toBeCloseTo(exp[0], 6);
      expect(got[1]).toBeCloseTo(exp[1], 6);
    });

    it('D6: geometry uses the stored original size, not the decoded preview', () => {
      // The preview bitmap is 1600×1067 (aspect 1.4996); the state says 4000×3000 (1.3333).
      const preview = {
        tag: 'preview',
        naturalWidth: 1600,
        naturalHeight: 1067,
        width: 1600,
        height: 1067,
      };
      const st: DesignStateV1 = {
        v: 1,
        texts: {},
        photos: {
          [slot.id]: {
            asset_id: 'p',
            width: 4000,
            height: 3000,
            adj: { zoom: 1, rot: 0, panX: 0.5, panY: 0.5 },
          },
        },
      };
      const ctx = new FakeCtx();
      renderDesign(
        ctx,
        input(spec, {
          scale: 2,
          state: st,
          images: { get: (id) => (id === 'p' ? preview : { tag: id }) },
        }),
      );
      const d = ctx.ops('drawImage').find((c) => c.args[0] === preview)!;
      const l = coverLayout(
        slot,
        4000,
        3000,
        { zoom: 1, rot: 0, panX: 0.5, panY: 0.5 },
        2,
      );
      expect(d.args.slice(1)).toEqual([l.dx, l.dy, l.dw, l.dh]);
    });

    it('ellipse and round-rect clips', () => {
      const base = { ...slot, rot: 0 };
      for (const [el, op, count] of [
        [{ ...base, shape: 'ellipse' as const }, 'ellipse', 1],
        [{ ...base, radius: 20 }, 'quadraticCurveTo', 4],
      ] as const) {
        const s: TemplateSpecV1 = {
          ...spec,
          surfaces: [
            { ...spec.surfaces[0], elements: [el as ImageSlotElement] },
          ],
        };
        const ctx = new FakeCtx();
        renderDesign(ctx, input(s, { scale: 2, state }));
        const clipIdx = ctx.calls.findIndex((c) => c.op === 'clip');
        expect(
          ctx.calls.slice(0, clipIdx).filter((c) => c.op === op),
        ).toHaveLength(count);
      }
      // Ellipse radii = w/2, h/2 around the box centre (NPP :163-167).
      const s: TemplateSpecV1 = {
        ...spec,
        surfaces: [
          {
            ...spec.surfaces[0],
            elements: [{ ...base, shape: 'ellipse' } as ImageSlotElement],
          },
        ],
      };
      const ctx = new FakeCtx();
      renderDesign(ctx, input(s, { scale: 2, state }));
      expect(ctx.ops('ellipse')[0].args).toEqual([
        (63 + 156) * 2,
        (221 + 185.5) * 2,
        312,
        371,
        0,
        0,
        Math.PI * 2,
      ]);
    });
  });

  describe('z-order with real templates', () => {
    /** Sequence of drawn things: image tags, text strings and empty-slot fills. */
    function sequence(
      spec: TemplateSpecV1,
      state: DesignStateV1 = emptyState(),
    ) {
      const ctx = new FakeCtx();
      renderDesign(ctx, input(spec, { scale: 1, state }));
      return ctx.calls
        .filter(
          (c) =>
            c.op === 'drawImage' ||
            c.op === 'fillText' ||
            (c.op === 'fill' && c.fillStyle === '#e8e8e8'),
        )
        .map((c) =>
          c.op === 'drawImage'
            ? (c.args[0] as { tag: string }).tag
            : c.op === 'fillText'
              ? 'text:' + String(c.args[0])
              : 'slot',
        );
    }
    it('4308: [bg, slot, deco0, deco2, deco1, text, text]', () => {
      expect(sequence(finalSpec('4308'))).toEqual([
        'a:bg_web',
        'slot',
        'a:deco:3kfdpwple',
        'a:deco:63x4rv4qi',
        'a:deco:excetwi1x',
        'text:Namn',
        'text:Klass',
      ]);
    });
    it('4355: Namn and slot share z3 — Namn (earlier in the array) is drawn first', () => {
      const seq = sequence(finalSpec('4355'));
      expect(seq.indexOf('text:Namn')).toBeLessThan(seq.indexOf('slot'));
      expect(seq).toEqual([
        'a:bg_web',
        'text:Namn',
        'slot',
        'a:deco:xgv7p6c5g',
        'text:Klass',
        'a:deco:hzagncqgf',
      ]);
    });
    it('4281: two texts with z3 keep array order', () => {
      expect(sequence(finalSpec('4281'))).toEqual([
        'a:bg_web',
        'text:Namn',
        'text:Klass',
        'slot',
      ]);
    });
    it('4359: slot (z1) is drawn under the texts (z2)', () => {
      expect(sequence(finalSpec('4359'))).toEqual([
        'a:bg_web',
        'slot',
        'text:Namn',
        'text:Text',
      ]);
    });
    it('rendering twice gives identical call logs (determinism)', () => {
      const spec = finalSpec('4308');
      const a = new FakeCtx();
      const b = new FakeCtx();
      renderDesign(a, input(spec, { scale: 6 }));
      renderDesign(b, input(spec, { scale: 6 }));
      expect(JSON.stringify(a.calls)).toBe(JSON.stringify(b.calls));
    });
  });

  describe('background and modes', () => {
    const spec = finalSpec('4281');
    const firstImage = (ctx: FakeCtx) =>
      (ctx.ops('drawImage')[0].args[0] as { tag: string }).tag;
    it('print uses the print asset, proof/edit use the web asset; stretched to the canvas', () => {
      const p = new FakeCtx();
      renderDesign(p, input(spec, { mode: 'print', scale: 6 }));
      expect(firstImage(p)).toBe('a:bg_print');
      expect(p.ops('drawImage')[0].args.slice(1)).toEqual([0, 0, 3000, 4200]);
      for (const mode of ['proof', 'edit'] as const) {
        const c = new FakeCtx();
        renderDesign(c, input(spec, { mode }));
        expect(firstImage(c)).toBe('a:bg_web');
      }
    });
    it('print falls back to web when there is no print asset', () => {
      const s = JSON.parse(JSON.stringify(spec)) as TemplateSpecV1;
      delete s.surfaces[0].background.print;
      const c = new FakeCtx();
      renderDesign(c, input(s, { mode: 'print' }));
      expect(firstImage(c)).toBe('a:bg_web');
    });
    it('fills the colour without an image; reports a missing image', () => {
      const s = JSON.parse(JSON.stringify(spec)) as TemplateSpecV1;
      delete s.surfaces[0].background.web;
      delete s.surfaces[0].background.print;
      const c = new FakeCtx();
      const r = renderDesign(c, input(s));
      expect(c.ops('fillRect')[0].args).toEqual([0, 0, 1000, 1400]);
      expect(c.ops('fillRect')[0].fillStyle).toBe('#ffffff');
      expect(r.missing).toEqual([]);
      const c2 = new FakeCtx();
      const r2 = renderDesign(
        c2,
        input(spec, { images: { get: () => undefined } }),
      );
      expect(r2.missing).toContain('background');
    });
    it('empty slot: edit draws NPP dashed placeholder; proof/print fill only', () => {
      const e = new FakeCtx();
      renderDesign(e, input(spec, { mode: 'edit' }));
      expect(e.ops('setLineDash')[0].args[0]).toEqual([12, 8]);
      expect(e.ops('strokeRect')).toHaveLength(1);
      expect(e.ops('fillText').map((c) => c.args[0])).toContain(
        'Ladda upp bild',
      );
      expect(
        e.ops('fillText').find((c) => c.args[0] === 'Ladda upp bild')!.font,
      ).toBe('28px "Montserrat"');
      for (const mode of ['proof', 'print'] as const) {
        const c = new FakeCtx();
        renderDesign(c, input(spec, { mode }));
        expect(c.ops('setLineDash')).toHaveLength(0);
        expect(c.ops('fillText').map((x) => x.args[0])).not.toContain(
          'Ladda upp bild',
        );
        // Proof keeps the shaped #e8e8e8 fill; print draws nothing for an
        // empty (optional) slot (deviation 3 from NPP).
        expect(
          c.calls.some((x) => x.op === 'fill' && x.fillStyle === '#e8e8e8'),
        ).toBe(mode === 'proof');
      }
    });
    it('missing photo / decoration images are skipped and reported', () => {
      const s = finalSpec('4308');
      const slot = slotEl(s);
      const st: DesignStateV1 = {
        v: 1,
        texts: {},
        photos: {
          [slot.id]: {
            asset_id: 'gone',
            width: 10,
            height: 10,
            adj: { zoom: 1, rot: 0, panX: 0.5, panY: 0.5 },
          },
        },
      };
      const c = new FakeCtx();
      const r = renderDesign(
        c,
        input(s, {
          state: st,
          images: {
            get: (id) =>
              id === 'gone' || id === 'a:deco:excetwi1x'
                ? undefined
                : { tag: id },
          },
        }),
      );
      expect(r.missing).toEqual([slot.id, 'excetwi1x']);
      expect(r.elements).toBe(4); // 6 elements − 2 missing
    });
    it('active-slot overlay only in edit mode', () => {
      const slot = slotEl(spec);
      const e = new FakeCtx();
      renderDesign(
        e,
        input(spec, {
          mode: 'edit',
          ui: { activeSlotId: slot.id, accentColor: '#f00' },
        }),
      );
      expect(e.calls.filter((c) => c.op === 'strokeRect')).toHaveLength(2);
      const p = new FakeCtx();
      renderDesign(
        p,
        input(spec, { mode: 'proof', ui: { activeSlotId: slot.id } }),
      );
      expect(p.ops('strokeRect')).toHaveLength(0);
    });
  });

  describe('validateState', () => {
    // Code-point helper keeps invisible characters out of the source.
    const cp = (...c: number[]) => String.fromCodePoint(...c);
    const spec = finalSpec('4273');
    const namn = textEl(spec, 'Namn');
    const klass = textEl(spec, 'Klass');
    const slot = slotEl(spec);
    const photo = {
      asset_id: 'p1',
      width: 4000,
      height: 3000,
      adj: { zoom: 1, rot: 0, panX: 0.5, panY: 0.5 },
    };

    it('complete design passes and is normalized', () => {
      const r = validateState(
        spec,
        {
          v: 1,
          texts: {
            [namn.id]: cp(0xc5) + 'nna' + cp(0x07, 0x202e),
            [klass.id]: '3B',
            junk: 'x',
          },
          photos: { [slot.id]: photo, other: photo },
        },
        { requireComplete: true },
      );
      expect(r.ok).toBe(true);
      expect(r.normalized.texts).toEqual({
        [namn.id]: cp(0xc5) + 'nna',
        [klass.id]: '3B',
      });
      expect(Object.keys(r.normalized.photos)).toEqual([slot.id]);
    });
    it('NFC normalization', () => {
      const decomposed = 'A' + cp(0x30a) + 'ngstr' + 'o' + cp(0x308) + 'm';
      const r = validateState(spec, { texts: { [namn.id]: decomposed } });
      expect(r.normalized.texts[namn.id]).toBe(
        cp(0xc5) + 'ngstr' + cp(0xf6) + 'm',
      );
    });
    it('required / photo_required only with requireComplete', () => {
      expect(validateState(spec, { texts: {}, photos: {} }).ok).toBe(true);
      const r = validateState(
        spec,
        { texts: { [namn.id]: '   ' }, photos: {} },
        { requireComplete: true },
      );
      expect(r.errors).toEqual([
        { element_id: namn.id, rule: 'required' },
        { element_id: klass.id, rule: 'required' },
        { element_id: slot.id, rule: 'photo_required' },
      ]);
    });
    it('max_length counts code points without VS15/VS16', () => {
      const family = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
      const heart = cp(0x2764, 0xfe0f);
      expect(designTextLength(family)).toBe(5);
      expect(designTextLength(heart)).toBe(1);
      const el = { ...namn, max_length: 3 };
      const s: TemplateSpecV1 = {
        ...spec,
        surfaces: [{ ...spec.surfaces[0], elements: [el] }],
      };
      expect(
        validateState(s, { texts: { [el.id]: heart + heart + heart } }).ok,
      ).toBe(true);
      expect(validateState(s, { texts: { [el.id]: 'abcd' } }).errors).toEqual([
        { element_id: el.id, rule: 'max_length' },
      ]);
    });
    it('allowed_chars is a class body compiled with the u flag; invalid bodies fail closed', () => {
      const el = { ...namn, allowed_chars: 'A-Za-zÅÄÖåäö \\-' };
      const s: TemplateSpecV1 = {
        ...spec,
        surfaces: [{ ...spec.surfaces[0], elements: [el] }],
      };
      expect(validateState(s, { texts: { [el.id]: 'Åsa-Li' } }).ok).toBe(true);
      expect(
        validateState(s, { texts: { [el.id]: 'Åsa1' } }).errors[0].rule,
      ).toBe('chars');
      const bad = { ...namn, allowed_chars: 'z-a' };
      const s2: TemplateSpecV1 = {
        ...spec,
        surfaces: [{ ...spec.surfaces[0], elements: [bad] }],
      };
      expect(
        validateState(s2, { texts: { [bad.id]: 'x' } }).errors[0].rule,
      ).toBe('chars');
    });
    it('photo asset and adjustment ranges', () => {
      const bad = (p: unknown) =>
        validateState(spec, { photos: { [slot.id]: p } }).errors.map(
          (e) => e.rule,
        );
      expect(bad({ ...photo, asset_id: '' })).toEqual(['asset']);
      expect(bad({ ...photo, width: 0 })).toEqual(['asset']);
      expect(
        bad({ ...photo, adj: { zoom: 3.01, rot: 0, panX: 0.5, panY: 0.5 } }),
      ).toEqual(['adj_range']);
      expect(
        bad({ ...photo, adj: { zoom: 1, rot: -181, panX: 0.5, panY: 0.5 } }),
      ).toEqual(['adj_range']);
      expect(
        bad({ ...photo, adj: { zoom: 1, rot: 0, panX: 1.2, panY: 0.5 } }),
      ).toEqual(['adj_range']);
      expect(
        bad({ ...photo, adj: { zoom: 3, rot: 180, panX: 0, panY: 1 } }),
      ).toEqual([]);
      // Missing adj → template default.
      const r = validateState(spec, {
        photos: { [slot.id]: { asset_id: 'p', width: 10, height: 10 } },
      });
      expect(r.normalized.photos[slot.id].adj).toEqual({
        zoom: 1,
        rot: 0,
        panX: 0.5,
        panY: 0.5,
      });
    });
    it('garbage input never throws', () => {
      for (const g of [null, 1, 'x', [], { texts: 5, photos: 'x' }])
        expect(validateState(spec, g).ok).toBe(true);
    });
  });

  describe('validateSpec', () => {
    it('every converted + finalized real template is valid', () => {
      for (const t of converted.templates) {
        const r = validateSpec(finalSpec(t.source_id));
        expect({ id: t.source_id, errors: r.errors }).toEqual({
          id: t.source_id,
          errors: [],
        });
      }
    });
    it('rejects duplicate ids, undeclared fonts and invalid allowed_chars', () => {
      const spec = finalSpec('4273');
      const [a, b] = spec.surfaces[0].elements;
      const s: TemplateSpecV1 = {
        ...spec,
        surfaces: [
          {
            ...spec.surfaces[0],
            elements: [
              a,
              { ...b, id: a.id },
              {
                ...(a as TextElement),
                id: 'x1',
                font: { family: 'Comic', weight: 400, style: 'normal' },
              },
              { ...(a as TextElement), id: 'x2', allowed_chars: 'z-a' },
              { ...(a as TextElement), id: 'BAD ID' },
            ],
          },
        ],
      };
      const rules = validateSpec(s).errors.map((e) => e.rule);
      expect(rules).toEqual(
        expect.arrayContaining(['duplicate', 'undeclared', 'regex', 'format']),
      );
    });
  });
});

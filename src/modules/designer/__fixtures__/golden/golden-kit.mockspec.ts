/*
 * Golden-test kit of the designer renderer (M4.2 WP11, §12.3).
 *
 * Shared by the `*.golden.spec.ts` files (the `.mockspec.ts` suffix keeps it
 * out of the jest test match and out of `nest build`):
 *   - RecordingCtx: a fake Ctx2D that logs every call and every property set;
 *   - fakeMeasure: deterministic per-code-point text metrics (emoji wide,
 *     variation selectors / ZWJ zero-width), linear in the font px size;
 *   - the converted NPP templates (`npp/__fixtures__/expected/`) and the
 *     deterministic design states the goldens are built from;
 *   - log compaction + hashing and the UPDATE_GOLDEN=1 read/write helper.
 *
 * The same recorder exists (byte-for-byte equivalent logic) in the web repo
 * (`src/lib/designer/design-renderer.golden.spec.ts`), which replays these
 * goldens through the web mirror of the renderer.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type {
  Ctx2D,
  DesignStateV1,
  Mode,
  RenderInput,
  RenderReport,
  TemplateSpecV1,
} from '@multi-stores/core/designer';

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

export const GOLDEN_DIR = __dirname;
export const EXPECTED_DIR = path.join(
  __dirname,
  '..',
  '..',
  'npp',
  '__fixtures__',
  'expected',
);

/** The 10 converted NPP templates (file stem, e.g. `template_4273`). */
export const TEMPLATE_IDS = fs
  .readdirSync(EXPECTED_DIR)
  .filter((f) => /^template_\d+\.json$/.test(f))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();

export const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === '1';

/* ------------------------------------------------------------------ */
/* Numbers                                                             */
/* ------------------------------------------------------------------ */

/** Rounds to 1e-6 and folds -0 into 0 so goldens stay readable and stable. */
export function r6(n: number): number {
  const v = Math.round(n * 1e6) / 1e6;
  return Object.is(v, -0) ? 0 : v;
}

function norm(v: unknown): unknown {
  if (typeof v === 'number') return r6(v);
  if (Array.isArray(v)) return v.map(norm);
  return v;
}

/* ------------------------------------------------------------------ */
/* Fake metrics                                                        */
/* ------------------------------------------------------------------ */

/** Advance of one code point in em (deterministic, roughly Montserrat-like). */
export function advance(cp: number): number {
  if (cp === 0xfe0e || cp === 0xfe0f || cp === 0x200d) return 0;
  if (cp >= 0x1f000 || (cp >= 0x2600 && cp <= 0x27bf)) return 1.2;
  if (cp === 0x20) return 0.28;
  if (cp >= 0x0590 && cp <= 0x08ff) return 0.5; // Hebrew / Arabic
  const ch = String.fromCodePoint(cp);
  if ('il.,:;\'!|Ij-'.includes(ch)) return 0.3;
  if (ch !== ch.toLowerCase()) return 0.68; // upper case, incl. Å Ä Ö
  return 0.56;
}

/** Font px size from a CSS font shorthand (`600 438px "Montserrat"`). */
export function fontPx(font: string): number {
  const m = /([\d.]+)px/.exec(font);
  return m ? Number(m[1]) : 0;
}

/** Width = Σ advance(code point) × px. */
export function fakeMeasure(text: string, font: string): number {
  let em = 0;
  for (const ch of text) em += advance(ch.codePointAt(0)!);
  return em * fontPx(font);
}

/* ------------------------------------------------------------------ */
/* Recording context                                                   */
/* ------------------------------------------------------------------ */

export type LogEntry = unknown[];

/** Image handles carry their asset id; the log records only that id. */
export interface FakeImage {
  __asset: string;
}
export const fakeImage = (id: string): FakeImage => ({ __asset: id });

function imageId(img: unknown): string {
  const id = (img as FakeImage | null)?.__asset;
  return typeof id === 'string' ? id : '?';
}

/**
 * Fake Ctx2D. Every method call is logged as `[op, ...args]` and every
 * property set as `['=prop', value]`, in call order. Numbers are logged raw;
 * `normalizedLog()` rounds them for goldens.
 */
export class RecordingCtx implements Ctx2D {
  readonly log: LogEntry[] = [];
  private _font = '10px sans-serif';
  private _fillStyle: unknown = '#000000';
  private _strokeStyle: unknown = '#000000';
  private _lineWidth = 1;
  private _textAlign = 'start';
  private _textBaseline = 'alphabetic';
  private _direction = 'inherit';
  private readonly stack: unknown[][] = [];

  constructor(
    private readonly measure: (
      text: string,
      font: string,
    ) => number = fakeMeasure,
  ) {}

  private rec(...e: unknown[]) {
    this.log.push(e);
  }

  get font() {
    return this._font;
  }
  set font(v: string) {
    this._font = v;
    this.rec('=font', v);
  }
  get fillStyle() {
    return this._fillStyle;
  }
  set fillStyle(v: unknown) {
    this._fillStyle = v;
    this.rec('=fillStyle', v);
  }
  get strokeStyle() {
    return this._strokeStyle;
  }
  set strokeStyle(v: unknown) {
    this._strokeStyle = v;
    this.rec('=strokeStyle', v);
  }
  get lineWidth() {
    return this._lineWidth;
  }
  set lineWidth(v: number) {
    this._lineWidth = v;
    this.rec('=lineWidth', v);
  }
  get textAlign() {
    return this._textAlign;
  }
  set textAlign(v: string) {
    this._textAlign = v;
    this.rec('=textAlign', v);
  }
  get textBaseline() {
    return this._textBaseline;
  }
  set textBaseline(v: string) {
    this._textBaseline = v;
    this.rec('=textBaseline', v);
  }
  get direction() {
    return this._direction;
  }
  set direction(v: string) {
    this._direction = v;
    this.rec('=direction', v);
  }

  save() {
    this.stack.push([
      this._font,
      this._fillStyle,
      this._strokeStyle,
      this._lineWidth,
      this._textAlign,
      this._textBaseline,
      this._direction,
    ]);
    this.rec('save');
  }
  restore() {
    const s = this.stack.pop();
    if (s) {
      [
        this._font,
        this._fillStyle,
        this._strokeStyle,
        this._lineWidth,
        this._textAlign,
        this._textBaseline,
        this._direction,
      ] = s as [string, unknown, unknown, number, string, string, string];
    }
    this.rec('restore');
  }
  translate(x: number, y: number) {
    this.rec('translate', x, y);
  }
  rotate(a: number) {
    this.rec('rotate', a);
  }
  beginPath() {
    this.rec('beginPath');
  }
  rect(x: number, y: number, w: number, h: number) {
    this.rec('rect', x, y, w, h);
  }
  ellipse(
    x: number,
    y: number,
    rx: number,
    ry: number,
    rot: number,
    a0: number,
    a1: number,
  ) {
    this.rec('ellipse', x, y, rx, ry, rot, a0, a1);
  }
  moveTo(x: number, y: number) {
    this.rec('moveTo', x, y);
  }
  lineTo(x: number, y: number) {
    this.rec('lineTo', x, y);
  }
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number) {
    this.rec('quadraticCurveTo', cpx, cpy, x, y);
  }
  closePath() {
    this.rec('closePath');
  }
  clip() {
    this.rec('clip');
  }
  fill() {
    this.rec('fill');
  }
  stroke() {
    this.rec('stroke');
  }
  fillRect(x: number, y: number, w: number, h: number) {
    this.rec('fillRect', x, y, w, h);
  }
  strokeRect(x: number, y: number, w: number, h: number) {
    this.rec('strokeRect', x, y, w, h);
  }
  clearRect(x: number, y: number, w: number, h: number) {
    this.rec('clearRect', x, y, w, h);
  }
  setLineDash(seg: number[]) {
    this.rec('setLineDash', [...seg]);
  }
  drawImage(img: unknown, dx: number, dy: number, dw: number, dh: number) {
    this.rec('drawImage', imageId(img), dx, dy, dw, dh);
  }
  fillText(text: string, x: number, y: number) {
    this.rec('fillText', text, x, y);
  }
  measureText(text: string) {
    const width = this.measure(text, this._font);
    this.rec('measureText', text, width);
    return { width };
  }

  /** The log with numbers rounded to 1e-6 (nested arrays included). */
  normalizedLog(): LogEntry[] {
    return this.log.map((e) => e.map(norm));
  }
}

/** sha256 of the normalized log (JSON). */
export function logHash(log: LogEntry[]): string {
  return createHash('sha256').update(JSON.stringify(log)).digest('hex');
}

/**
 * Collapses each text-fit scan (`=font`, `measureText` pairs) into one
 * `['fitScan', text, firstFont, lastFont, steps, lastWidth]` entry so the
 * golden stays readable; the full log is covered by `logHash`.
 */
export function compactLog(log: LogEntry[]): LogEntry[] {
  const out: LogEntry[] = [];
  for (let i = 0; i < log.length; ) {
    const isPair = (k: number) =>
      log[k]?.[0] === '=font' && log[k + 1]?.[0] === 'measureText';
    if (!isPair(i)) {
      out.push(log[i]);
      i++;
      continue;
    }
    const text = log[i + 1][1];
    const first = log[i][1];
    let last = first;
    let width = log[i + 1][2];
    let steps = 0;
    while (isPair(i) && log[i + 1][1] === text) {
      last = log[i][1];
      width = log[i + 1][2];
      steps++;
      i += 2;
    }
    out.push(['fitScan', text, first, last, steps, width]);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Templates and states                                                */
/* ------------------------------------------------------------------ */

export function loadTemplate(stem: string): TemplateSpecV1 {
  const raw = JSON.parse(
    fs.readFileSync(path.join(EXPECTED_DIR, stem + '.json'), 'utf8'),
  ) as { spec: TemplateSpecV1 };
  return raw.spec;
}

/** Every asset id referenced by a spec (backgrounds, decorations). */
export function specAssetIds(spec: TemplateSpecV1): string[] {
  const ids = new Set<string>();
  for (const sf of spec.surfaces) {
    if (sf.background.web) ids.add(sf.background.web.asset_id);
    if (sf.background.print) ids.add(sf.background.print.asset_id);
    for (const el of sf.elements) if (el.type === 'image') ids.add(el.asset.asset_id);
  }
  return [...ids];
}

export const PHOTO_LANDSCAPE = 'photo-landscape';
export const PHOTO_PORTRAIT = 'photo-portrait';

/** ❤️ = U+2764 U+FE0F (with the emoji variation selector). */
export const HEART = String.fromCodePoint(0x2764, 0xfe0f);

export type StateKey = 'sv' | 'long' | 'defaults';

/**
 * Deterministic design states for a template:
 *   - sv: Swedish name with å/ä/ö, a short class, landscape photo with pan/zoom/rotate;
 *   - long: long names (forces the shrink loop; the second one reaches the 6 minimum
 *     on narrow fields) incl. ❤️ with VS16, portrait photo zoom 2.3 pan (0.1, 0.9) rot -45;
 *   - defaults: no values (default texts), empty photo slot.
 */
export function stateFor(spec: TemplateSpecV1, key: StateKey): DesignStateV1 {
  const els = spec.surfaces[0].elements;
  const texts = els.filter((e) => e.type === 'text' && e.editable);
  const slots = els.filter((e) => e.type === 'image_slot');
  const state: DesignStateV1 = { v: 1, texts: {}, photos: {} };
  if (key === 'defaults') return state;
  const values =
    key === 'sv'
      ? ['Åsa Öberg-Ängström', 'NA3b']
      : [
          'Maximiliana Charlotta Åkesson-Lindqvist ' + HEART,
          'Teknikprogrammet ' +
            HEART +
            ' Göteborgs Högre Allmänna Läroverk för Flickor 2026',
        ];
  texts.forEach((t, i) => {
    state.texts[t.id] = values[i % values.length];
  });
  for (const s of slots) {
    state.photos[s.id] =
      key === 'sv'
        ? {
            asset_id: PHOTO_LANDSCAPE,
            width: 4000,
            height: 3000,
            adj: { zoom: 1.6, rot: 17, panX: 0.2, panY: 0.75 },
          }
        : {
            asset_id: PHOTO_PORTRAIT,
            width: 2400,
            height: 3600,
            adj: { zoom: 2.3, rot: -45, panX: 0.1, panY: 0.9 },
          };
  }
  return state;
}

export interface GoldenCase {
  key: string;
  state: StateKey;
  mode: Mode;
  scale: number;
  /** Edit mode only: select the first photo slot (overlay). */
  activeSlot?: boolean;
}

/** proof @2 (web scale) and print @6 for every state, plus one edit case. */
export const GOLDEN_CASES: GoldenCase[] = [
  ...(['sv', 'long', 'defaults'] as StateKey[]).flatMap((state) => [
    { key: `${state}@proof:2`, state, mode: 'proof' as Mode, scale: 2 },
    { key: `${state}@print:6`, state, mode: 'print' as Mode, scale: 6 },
  ]),
  {
    key: 'sv@edit:2',
    state: 'sv',
    mode: 'edit',
    scale: 2,
    activeSlot: true,
  },
  { key: 'defaults@edit:2', state: 'defaults', mode: 'edit', scale: 2 },
];

/** All font faces declared by the spec count as loaded. */
export function fontsOf(spec: TemplateSpecV1): RenderInput['fonts'] {
  const keys = new Set(
    spec.fonts.map((f) => `${f.family}|${f.weight}|${f.style}`),
  );
  return { has: (f, w, s) => keys.has(`${f}|${w}|${s}`) };
}

/** The RenderInput of a golden case (images resolve to tagged fake handles). */
export function caseInput(
  spec: TemplateSpecV1,
  c: GoldenCase,
): RenderInput {
  const state = stateFor(spec, c.state);
  const slot = spec.surfaces[0].elements.find((e) => e.type === 'image_slot');
  return {
    spec,
    surface: 'front',
    state,
    mode: c.mode,
    scale: c.scale,
    locale: 'sv',
    images: { get: (id: string) => fakeImage(id) },
    fonts: fontsOf(spec),
    ui:
      c.mode === 'edit'
        ? {
            activeSlotId: c.activeSlot && slot ? slot.id : undefined,
            uiFontFamily: 'system-ui',
          }
        : undefined,
  };
}

export interface GoldenRecord {
  canvas: { width: number; height: number };
  report: RenderReport;
  calls: number;
  sha256: string;
  log: LogEntry[];
}

/** Renders a case with a recorder and builds its golden record. */
export function recordCase(
  render: (ctx: Ctx2D, input: RenderInput) => RenderReport,
  canvasSize: (
    spec: TemplateSpecV1,
    scale: number,
  ) => { width: number; height: number },
  spec: TemplateSpecV1,
  c: GoldenCase,
): GoldenRecord {
  const ctx = new RecordingCtx();
  const report = render(ctx, caseInput(spec, c));
  const log = ctx.normalizedLog();
  const size = canvasSize(spec, c.scale);
  return {
    canvas: { width: size.width, height: size.height },
    report: JSON.parse(JSON.stringify(report)) as RenderReport,
    calls: log.length,
    sha256: logHash(log),
    log: compactLog(log),
  };
}

/* ------------------------------------------------------------------ */
/* Golden files                                                        */
/* ------------------------------------------------------------------ */

const isPrim = (x: unknown) => x === null || typeof x !== 'object';

/**
 * One-line values: primitives, and arrays with at least one primitive whose
 * other items are arrays of primitives (a log entry such as
 * `['setLineDash', [12, 8]]`). A list of entries is not flat.
 */
function isFlat(v: unknown): boolean {
  if (isPrim(v)) return true;
  if (!Array.isArray(v)) return false;
  return (
    v.some(isPrim) &&
    v.every((x) => isPrim(x) || (Array.isArray(x) && x.every(isPrim)))
  );
}

/** Pretty JSON with flat arrays (log entries) on a single line. */
export function prettyJson(v: unknown, indent = ''): string {
  if (isFlat(v)) return JSON.stringify(v);
  const inner = indent + ' ';
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return (
      '[\n' +
      v.map((x) => inner + prettyJson(x, inner)).join(',\n') +
      '\n' +
      indent +
      ']'
    );
  }
  const entries = Object.entries(v as Record<string, unknown>).filter(
    ([, x]) => x !== undefined,
  );
  if (entries.length === 0) return '{}';
  return (
    '{\n' +
    entries
      .map(([k, x]) => inner + JSON.stringify(k) + ': ' + prettyJson(x, inner))
      .join(',\n') +
    '\n' +
    indent +
    '}'
  );
}

/**
 * Returns the stored golden, or writes `actual` and returns it when
 * UPDATE_GOLDEN=1. A missing golden without UPDATE_GOLDEN=1 throws.
 */
export function golden<T>(relPath: string, actual: T): T {
  const file = path.join(GOLDEN_DIR, relPath);
  if (UPDATE_GOLDEN) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, prettyJson(actual) + '\n', 'utf8');
    return actual;
  }
  if (!fs.existsSync(file)) {
    throw new Error(
      `Missing golden ${relPath}; run the spec with UPDATE_GOLDEN=1 to create it.`,
    );
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

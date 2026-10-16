/*
 * Designer renderer (M4.2 WP1) — RENDERER_VERSION 1.0.0.
 *
 * SOURCE OF TRUTH: multi-stores-shared/src/designer/design-renderer.ts
 * Mirrors (byte-identical, never edit them by hand):
 *   - multi-stores-api/src/modules/designer/render/design-renderer.ts
 *   - multi-stores-web/src/lib/designer/design-renderer.ts
 *   - multi-stores-dashboard/src/lib/designer/design-renderer.ts
 * Run `node multi-stores-shared/scripts/sync-designer-renderer.mjs` after an edit
 * (it copies the file and rewrites each repo's RENDERER_SHA256 constant).
 *
 * Rules for this file:
 *   - zero imports, no DOM globals at import time (runs in Node, browsers,
 *     workers and the server-side Chromium render page);
 *   - pure functions over a structural Canvas2D subset (Ctx2D) and an image
 *     lookup supplied by the caller;
 *   - units are millimetres (template space); `scale` is px per mm;
 *   - the drawing algorithm follows NPP 1.9.1 (product.js:117-195,
 *     order-viewer.js:56-171). Deliberate deviations are marked [dev].
 */

export const RENDERER_VERSION = '1.0.0';

/* ------------------------------------------------------------------ */
/* Types: TemplateSpecV1 / DesignStateV1                               */
/* ------------------------------------------------------------------ */

/** Locale map, e.g. { sv: 'Namn', en: 'Name' }. */
export type I18n = Record<string, string>;

/** Reference to a stored asset; width/height are pixels of the ORIGINAL file. */
export interface AssetRef {
  asset_id: string;
  width: number;
  height: number;
}

export type FontStyle = 'normal' | 'italic';

export interface FontRef {
  family: string;
  weight: number;
  style: FontStyle;
  asset_id: string;
}

export interface Background {
  color: string;
  web?: AssetRef;
  print?: AssetRef;
  fit: 'stretch' | 'cover';
}

export interface ElementBase {
  /** ^[a-z0-9_-]{1,32}$ */
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees, clockwise, around the box centre. */
  rot: number;
  z: number;
  locked: boolean;
}

export interface TextFit {
  mode: 'shrink';
  /** NPP: 0.5 */
  step: number;
  /** NPP: 6 */
  min: number;
  /** NPP: 8 px, NOT scaled (evaluated at fit_ref_px_per_mm). */
  pad_ref_px: number;
}

export interface TextElement extends ElementBase {
  type: 'text';
  label: I18n;
  placeholder: I18n;
  default_text: string;
  font: { family: string; weight: number; style: FontStyle };
  /** NPP fontSize, in px at 1 px/mm (= mm units). */
  size: number;
  color: string;
  align: 'left' | 'center' | 'right';
  transform: 'none' | 'uppercase';
  fit: TextFit;
  /** Horizontal inset for left/right alignment, mm (NPP: 4). */
  inset: number;
  editable: boolean;
  required: boolean;
  /** Code points (NFC, U+FE0E/U+FE0F not counted). */
  max_length: number;
  /** Character-class body parsed as data by compileDesignAllowedChars (`^[…]*$`, `u` flag). */
  allowed_chars?: string;
  direction: 'auto' | 'ltr' | 'rtl';
  source_label?: string;
}

export interface PhotoAdj {
  zoom: number;
  rot: number;
  panX: number;
  panY: number;
}

export interface ImageSlotElement extends ElementBase {
  type: 'image_slot';
  label: I18n;
  placeholder: I18n;
  shape: 'rect' | 'ellipse';
  /** Corner radius in mm (rect only). */
  radius: number;
  /** Edit mode only. */
  border_color: string;
  required: boolean;
  adj_limits: { zoom: [number, number]; rot: [number, number] };
  default_adj: PhotoAdj;
}

/** Decoration / overlay image (NPP deco-image, overlay), drawn stretched. */
export interface ImageElement extends ElementBase {
  type: 'image';
  asset: AssetRef;
}

export type DesignElement = TextElement | ImageSlotElement | ImageElement;

export interface Surface {
  key: 'front';
  background: Background;
  elements: DesignElement[];
}

export interface TemplateSpecV1 {
  schema: 'designer.template/1';
  unit: 'mm';
  /** Trim size in mm. */
  width: number;
  height: number;
  bleed_mm: number;
  render: {
    preview_px_per_mm: number;
    print_px_per_mm: number;
    fit_ref_px_per_mm: number;
  };
  fonts: FontRef[];
  surfaces: Surface[];
  flags?: Record<string, boolean>;
}

export interface DesignPhoto {
  asset_id: string;
  /** Pixels of the ORIGINAL (EXIF-oriented) file — geometry never uses the decoded preview size. */
  width: number;
  height: number;
  adj: PhotoAdj;
}

export interface DesignStateV1 {
  v: 1;
  texts: Record<string, string>;
  photos: Record<string, DesignPhoto>;
  /** Reserved (choice_image). */
  choices?: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* Canvas contract                                                     */
/* ------------------------------------------------------------------ */

/**
 * Structural subset of CanvasRenderingContext2D / OffscreenCanvasRenderingContext2D.
 * Kept free of DOM types so the file compiles without lib.dom.
 */
export interface Ctx2D {
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  beginPath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
  ): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  closePath(): void;
  clip(): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  setLineDash(segments: number[]): void;
  drawImage(
    image: unknown,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  font: string;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  textAlign: string;
  textBaseline: string;
  direction: string;
}

export type Mode = 'edit' | 'proof' | 'print';

/** Image lookup keyed by asset_id. Values are whatever the host's drawImage accepts. */
export interface ImageLookup {
  get(assetId: string): unknown;
}

/** Optional font availability check (host knows which FontFaces loaded). */
export interface FontLookup {
  has(family: string, weight: number, style: FontStyle): boolean;
}

export interface RenderInput {
  spec: TemplateSpecV1;
  surface?: 'front';
  state: DesignStateV1;
  mode: Mode;
  /** Output px per mm (2 = preview/proof, 6 = print). */
  scale: number;
  images: ImageLookup;
  fonts?: FontLookup;
  /** Locale used for placeholders (falls back to the first available value). */
  locale?: string;
  ui?: {
    activeSlotId?: string;
    emptySlotText?: (el: ImageSlotElement) => string;
    /** Family for the empty-slot placeholder text (NPP: Montserrat). */
    uiFontFamily?: string;
    accentColor?: string;
  };
}

export interface RenderReport {
  /** Chosen font size (mm units) per text element id. */
  fitted: Record<string, number>;
  /** Element ids (or 'background') whose image/font was unavailable; such elements are skipped. */
  missing: string[];
  /** Number of elements actually drawn (background excluded). */
  elements: number;
}

export interface CoverLayout {
  /** Destination rect of the image, px, before the photo rotation. */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  /** Photo rotation in degrees (around cx, cy). */
  rot: number;
  /** Image centre, px. */
  cx: number;
  cy: number;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const DEG = Math.PI / 180;
const EMPTY_SLOT_FILL = '#e8e8e8';
const EMPTY_SLOT_TEXT = '#aaa';
const DEFAULT_ACCENT = '#2563eb';
const DEFAULT_UI_FONT = 'Montserrat';

export const DEFAULT_ADJ: PhotoAdj = { zoom: 1, rot: 0, panX: 0.5, panY: 0.5 };

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function finiteOr(v: unknown, d: number): number {
  return typeof v === 'number' && isFinite(v) ? v : d;
}

/** Picks a locale value; falls back to the first non-empty value. */
export function pickI18n(map: I18n | undefined, locale?: string): string {
  if (!map) return '';
  if (locale && typeof map[locale] === 'string' && map[locale] !== '')
    return map[locale];
  for (const k of Object.keys(map)) {
    if (typeof map[k] === 'string' && map[k] !== '') return map[k];
  }
  return '';
}

/** CSS font shorthand, NPP format: `600 438px "Montserrat"` (italic prefixed when needed). */
export function fontString(
  font: { family: string; weight: number; style: FontStyle },
  sizeMm: number,
  scale: number,
): string {
  const style = font.style === 'italic' ? 'italic ' : '';
  return (
    style + font.weight + ' ' + sizeMm * scale + 'px "' + font.family + '"'
  );
}

/** Canvas pixel size for a scale. */
export function canvasSize(
  spec: TemplateSpecV1,
  scale: number,
  withBleed = false,
): { width: number; height: number } {
  const b = withBleed ? 2 * (spec.bleed_mm || 0) : 0;
  return {
    width: Math.round((spec.width + b) * scale),
    height: Math.round((spec.height + b) * scale),
  };
}

/** Stable sort by (z, original index). Ties keep array order (V8 stable sort in NPP). */
export function sortElements<T extends { z: number }>(els: T[]): T[] {
  return els
    .map((el, i) => ({ el, i, z: finiteOr(el.z, 0) }))
    .sort((a, b) => a.z - b.z || a.i - b.i)
    .map((x) => x.el);
}

/**
 * Text to draw (NPP product.js:149-150):
 *   text0 = customer value unless empty, else default text;
 *   uppercase ? text0.toUpperCase() : (text0 || placeholder).
 * Non-editable elements ignore the state.
 */
export function resolveText(
  el: TextElement,
  state: DesignStateV1 | undefined,
  locale?: string,
): string {
  const v =
    el.editable && state && state.texts ? state.texts[el.id] : undefined;
  const text0 = v !== undefined && v !== '' ? v : el.default_text;
  if (el.transform === 'uppercase') return (text0 || '').toUpperCase();
  return text0 || pickI18n(el.placeholder, locale) || '';
}

/**
 * NPP fitTextSize: from `size` down to `fit.min` in `fit.step` decrements, the first
 * size whose width fits `el.w * refScale - fit.pad_ref_px`; `fit.min` otherwise.
 * Always called with refScale = spec.render.fit_ref_px_per_mm (D5) so every output
 * scale picks the same size. Sizes are computed as size - i*step (no float drift).
 */
export function fitTextSize(
  ctx: Pick<Ctx2D, 'font' | 'measureText'>,
  text: string,
  el: TextElement,
  fontStr: (sizeMm: number, scale: number) => string,
  refScale: number,
): number {
  const step = el.fit && el.fit.step > 0 ? el.fit.step : 0.5;
  const min = el.fit ? finiteOr(el.fit.min, 6) : 6;
  const pad = el.fit ? finiteOr(el.fit.pad_ref_px, 8) : 8;
  const start = finiteOr(el.size, 28);
  const maxW = el.w * refScale - pad;
  for (let i = 0; ; i++) {
    const s = start - i * step;
    if (s < min) break;
    ctx.font = fontStr(s, refScale);
    if (ctx.measureText(text).width <= maxW) return s;
  }
  return min;
}

/**
 * NPP cover math (product.js:168-175) in px for `scale`, using the ORIGINAL image
 * dimensions (D6). Pan 0..1 moves across the overflow; rotation is around the image centre.
 */
export function coverLayout(
  slot: Pick<ElementBase, 'x' | 'y' | 'w' | 'h'>,
  imgW: number,
  imgH: number,
  adj: PhotoAdj,
  scale: number,
): CoverLayout {
  const iA = imgW > 0 && imgH > 0 ? imgW / imgH : 1;
  const sA = slot.w / slot.h;
  let bw: number;
  let bh: number;
  if (iA > sA) {
    bh = slot.h * scale;
    bw = bh * iA;
  } else {
    bw = slot.w * scale;
    bh = bw / iA;
  }
  const zoom = finiteOr(adj.zoom, 1);
  const zw = bw * zoom;
  const zh = bh * zoom;
  const dx =
    slot.x * scale - Math.max(0, zw - slot.w * scale) * finiteOr(adj.panX, 0.5);
  const dy =
    slot.y * scale - Math.max(0, zh - slot.h * scale) * finiteOr(adj.panY, 0.5);
  return {
    dx,
    dy,
    dw: zw,
    dh: zh,
    rot: finiteOr(adj.rot, 0),
    cx: dx + zw / 2,
    cy: dy + zh / 2,
  };
}

/** Effective print resolution of a photo in a slot (original pixels per inch). */
export function effectiveDpi(
  slot: Pick<ElementBase, 'x' | 'y' | 'w' | 'h'>,
  imgW: number,
  imgH: number,
  adj: PhotoAdj,
): number {
  const l = coverLayout(slot, imgW, imgH, adj, 1); // mm
  if (!(l.dw > 0)) return 0;
  return (imgW * 25.4) / l.dw;
}

/** NPP roundRect path (product.js:118). */
function roundRectPath(
  ctx: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** Builds the slot outline path (ellipse / round-rect / rect) in px. */
function slotPath(ctx: Ctx2D, el: ImageSlotElement, s: number): void {
  if (el.shape === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(
      (el.x + el.w / 2) * s,
      (el.y + el.h / 2) * s,
      (el.w * s) / 2,
      (el.h * s) / 2,
      0,
      0,
      Math.PI * 2,
    );
  } else if (el.radius > 0) {
    roundRectPath(ctx, el.x * s, el.y * s, el.w * s, el.h * s, el.radius * s);
  } else {
    ctx.beginPath();
    ctx.rect(el.x * s, el.y * s, el.w * s, el.h * s);
  }
}

function surfaceOf(
  spec: TemplateSpecV1,
  key: string | undefined,
): Surface | undefined {
  const k = key || 'front';
  for (const sf of spec.surfaces || []) if (sf.key === k) return sf;
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

function drawBackground(
  ctx: Ctx2D,
  bg: Background,
  input: RenderInput,
  W: number,
  H: number,
  report: RenderReport,
): void {
  // Print uses the print asset when present, otherwise web (order-viewer.js:101-106).
  const ref = input.mode === 'print' && bg.print ? bg.print : bg.web;
  const img = ref ? input.images.get(ref.asset_id) : undefined;
  if (ref && img) {
    if (bg.fit === 'cover') {
      const l = coverLayout(
        { x: 0, y: 0, w: W, h: H },
        ref.width,
        ref.height,
        DEFAULT_ADJ,
        1,
      );
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.clip();
      ctx.drawImage(img, l.dx, l.dy, l.dw, l.dh);
      ctx.restore();
    } else {
      // NPP stretches without keeping the aspect ratio.
      ctx.drawImage(img, 0, 0, W, H);
    }
    return;
  }
  if (ref) report.missing.push('background');
  ctx.fillStyle = bg.color || '#fff';
  ctx.fillRect(0, 0, W, H);
}

function drawText(
  ctx: Ctx2D,
  el: TextElement,
  input: RenderInput,
  report: RenderReport,
): boolean {
  const s = input.scale;
  if (
    input.fonts &&
    !input.fonts.has(el.font.family, el.font.weight, el.font.style)
  ) {
    report.missing.push(el.id);
    return false;
  }
  const text = resolveText(el, input.state, input.locale);
  const ref = finiteOr(
    input.spec.render && input.spec.render.fit_ref_px_per_mm,
    6,
  );
  const fs = (size: number, scale: number) => fontString(el.font, size, scale);
  // [dev] D5: fit at the reference scale, draw at the output scale.
  const size = fitTextSize(ctx, text, el, fs, ref);
  report.fitted[el.id] = size;
  ctx.font = fs(size, s);
  ctx.fillStyle = el.color || '#000';
  ctx.textBaseline = 'middle';
  ctx.textAlign = el.align || 'center';
  ctx.direction =
    el.direction === 'rtl' ? 'rtl' : el.direction === 'ltr' ? 'ltr' : 'inherit';
  const inset = finiteOr(el.inset, 4);
  const tx =
    el.align === 'left'
      ? (el.x + inset) * s
      : el.align === 'right'
        ? (el.x + el.w - inset) * s
        : (el.x + el.w / 2) * s;
  ctx.fillText(text, tx, (el.y + el.h / 2) * s);
  return true;
}

function drawSlot(
  ctx: Ctx2D,
  el: ImageSlotElement,
  input: RenderInput,
  report: RenderReport,
): boolean {
  const s = input.scale;
  const photo =
    input.state && input.state.photos ? input.state.photos[el.id] : undefined;
  if (photo) {
    const img = input.images.get(photo.asset_id);
    if (!img) {
      report.missing.push(el.id);
      return false;
    }
    ctx.save();
    slotPath(ctx, el, s);
    ctx.clip();
    // [dev] D6: geometry from the stored original dimensions.
    const l = coverLayout(
      el,
      photo.width,
      photo.height,
      photo.adj || DEFAULT_ADJ,
      s,
    );
    if (l.rot) {
      ctx.translate(l.cx, l.cy);
      ctx.rotate(l.rot * DEG);
      ctx.translate(-l.cx, -l.cy);
    }
    ctx.drawImage(img, l.dx, l.dy, l.dw, l.dh);
    ctx.restore();
    return true;
  }
  // Empty slot.
  ctx.fillStyle = EMPTY_SLOT_FILL;
  slotPath(ctx, el, s);
  ctx.fill();
  if (input.mode !== 'edit') return true; // proof/print: fill only (order-viewer.js:154-157)
  // Edit mode: NPP storefront look (product.js:176-186).
  const cx = (el.x + el.w / 2) * s;
  const cy = (el.y + el.h / 2) * s;
  ctx.strokeStyle = el.border_color || '#ccc';
  ctx.lineWidth = 2 * s;
  ctx.setLineDash([6 * s, 4 * s]);
  if (el.shape === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(
      cx,
      cy,
      (el.w * s) / 2 - s,
      (el.h * s) / 2 - s,
      0,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  } else {
    ctx.strokeRect(
      el.x * s + s,
      el.y * s + s,
      el.w * s - 2 * s,
      el.h * s - 2 * s,
    );
  }
  ctx.setLineDash([]);
  const ui = input.ui || {};
  const label = ui.emptySlotText
    ? ui.emptySlotText(el)
    : pickI18n(el.placeholder, input.locale) || 'Ladda upp bild';
  ctx.fillStyle = EMPTY_SLOT_TEXT;
  ctx.font = 14 * s + 'px "' + (ui.uiFontFamily || DEFAULT_UI_FONT) + '"';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, cx, cy);
  return true;
}

function drawImageEl(
  ctx: Ctx2D,
  el: ImageElement,
  input: RenderInput,
  report: RenderReport,
): boolean {
  const s = input.scale;
  const img = el.asset ? input.images.get(el.asset.asset_id) : undefined;
  if (!img) {
    report.missing.push(el.id);
    return false;
  }
  ctx.drawImage(img, el.x * s, el.y * s, el.w * s, el.h * s);
  return true;
}

function rotateAroundCentre(ctx: Ctx2D, el: ElementBase, s: number): void {
  const cx = (el.x + el.w / 2) * s;
  const cy = (el.y + el.h / 2) * s;
  ctx.translate(cx, cy);
  ctx.rotate(finiteOr(el.rot, 0) * DEG);
  ctx.translate(-cx, -cy);
}

/** Renders one surface. The caller sizes the canvas with canvasSize(spec, scale). */
export function renderDesign(ctx: Ctx2D, input: RenderInput): RenderReport {
  const report: RenderReport = { fitted: {}, missing: [], elements: 0 };
  const spec = input.spec;
  const surface = surfaceOf(spec, input.surface);
  const { width: W, height: H } = canvasSize(spec, input.scale);
  ctx.clearRect(0, 0, W, H);
  if (!surface) return report;

  // [dev] The background is always drawn first (z -10 in every NPP template).
  ctx.save();
  drawBackground(ctx, surface.background, input, W, H, report);
  ctx.restore();

  for (const el of sortElements(surface.elements || [])) {
    ctx.save();
    rotateAroundCentre(ctx, el, input.scale);
    let drawn = false;
    if (el.type === 'text') drawn = drawText(ctx, el, input, report);
    else if (el.type === 'image_slot') drawn = drawSlot(ctx, el, input, report);
    else if (el.type === 'image') drawn = drawImageEl(ctx, el, input, report);
    ctx.restore();
    if (drawn) report.elements++;
  }

  // Active-slot overlay: edit mode only, never in proof/print.
  const activeId = input.ui && input.ui.activeSlotId;
  if (input.mode === 'edit' && activeId) {
    const el = (surface.elements || []).find(
      (e) => e.id === activeId && e.type === 'image_slot',
    );
    if (el) {
      const s = input.scale;
      const accent = (input.ui && input.ui.accentColor) || DEFAULT_ACCENT;
      ctx.save();
      rotateAroundCentre(ctx, el, s);
      ctx.setLineDash([]);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.strokeRect(el.x * s, el.y * s, el.w * s, el.h * s);
      const hs = 8;
      ctx.fillStyle = accent;
      for (const [hx, hy] of [
        [el.x, el.y],
        [el.x + el.w, el.y],
        [el.x, el.y + el.h],
        [el.x + el.w, el.y + el.h],
      ]) {
        ctx.fillRect(hx * s - hs / 2, hy * s - hs / 2, hs, hs);
      }
      ctx.restore();
    }
  }
  return report;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export type StateRule =
  | 'required'
  | 'max_length'
  | 'chars'
  | 'photo_required'
  | 'adj_range'
  | 'asset';

export interface StateValidation {
  ok: boolean;
  errors: { element_id: string; rule: StateRule }[];
  normalized: DesignStateV1;
}

// U+FE0E / U+FE0F (built from code points so no invisible characters live in the source).
const VS_RE = new RegExp('[' + String.fromCharCode(0xfe0e, 0xfe0f) + ']', 'g');

/** C0/C1 controls (incl. newlines: text is single-line) and bidi embeddings/overrides/isolates. */
function isStripped(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** NFC + control/bidi-override removal (the stored form of customer text). */
export function normalizeText(v: string): string {
  const n = v.normalize('NFC');
  let out = '';
  for (let i = 0; i < n.length; i++) {
    if (!isStripped(n.charCodeAt(i))) out += n.charAt(i);
  }
  return out;
}

/**
 * Code points after NFC and removal of U+FE0E/U+FE0F. Same semantics as `charCount`
 * in multi-stores-shared/src/personalization/rules.ts (M4-INTEGRATION C14); duplicated
 * under a renderer-specific name because this file must stay import-free (D2 mirrors).
 */
export function designTextLength(v: string): number {
  // Array.from iterates code points, not UTF-16 units.
  return Array.from(v.normalize('NFC').replace(VS_RE, '')).length;
}

/** Longest accepted `allowed_chars` body (same cap as PERSONALIZATION_LIMITS.maxAllowedCharsLength). */
export const ALLOWED_CHARS_MAX_LENGTH = 200;

/**
 * Raw UTF-16 cap on a customer text before any normalization or regex. Texts are
 * at most 1000 code points (validateSpec), so anything this long already fails
 * max_length; refusing it early bounds the work done per request.
 */
export const DESIGN_TEXT_RAW_MAX = 8000;

// Property names accepted inside \p{…} / \P{…}: general categories, a few binary
// properties and Script / Script_Extensions values. The engine still validates them.
const PROP_RE = new RegExp(
  '^(?:' +
    '(?:L|Lu|Ll|Lt|Lm|Lo|M|Mn|Mc|Me|N|Nd|Nl|No|P|Pc|Pd|Ps|Pe|Pi|Pf|Po|S|Sm|Sc|Sk|So|Z|Zs|Zl|Zp)' +
    '|(?:Alphabetic|White_Space|Uppercase|Lowercase|Emoji|Emoji_Presentation|Extended_Pictographic)' +
    '|(?:Script|sc|Script_Extensions|scx)=[A-Za-z_]{1,40}' +
    ')$',
);

// Characters a class body may only contain escaped (refused when bare).
const BARE_META = '[]|()*+?{}';
// Characters that may follow a backslash as an identity escape (u-flag syntax chars and '-').
const BS = String.fromCharCode(0x5c); // backslash
const IDENTITY_ESCAPES = '^$.*+?()[]{}|/-' + BS;

type ClassToken = { kind: 'cp'; cp: number } | { kind: 'class'; src: string };

const hex = (cp: number): string => BS + 'u{' + cp.toString(16) + '}';

/** Reads one class atom at `i`; null when the body is refused. */
function readClassAtom(
  body: string,
  i: number,
): { tok: ClassToken; next: number } | null {
  const c = body.codePointAt(i) as number;
  const ch = String.fromCodePoint(c);
  if (ch !== BS) {
    if (BARE_META.indexOf(ch) >= 0) return null;
    return { tok: { kind: 'cp', cp: c }, next: i + ch.length };
  }
  const e = body.charAt(i + 1);
  if (e === '') return null;
  if (IDENTITY_ESCAPES.indexOf(e) >= 0)
    return { tok: { kind: 'cp', cp: e.charCodeAt(0) }, next: i + 2 };
  if ('dDwWsS'.indexOf(e) >= 0)
    return { tok: { kind: 'class', src: BS + e }, next: i + 2 };
  if (e === 't') return { tok: { kind: 'cp', cp: 9 }, next: i + 2 };
  if (e === 'x') {
    const m = /^[0-9A-Fa-f]{2}/.exec(body.slice(i + 2, i + 4));
    if (!m) return null;
    return { tok: { kind: 'cp', cp: parseInt(m[0], 16) }, next: i + 4 };
  }
  if (e === 'u') {
    if (body.charAt(i + 2) === '{') {
      const close = body.indexOf('}', i + 3);
      const digits = close < 0 ? '' : body.slice(i + 3, close);
      if (!/^[0-9A-Fa-f]{1,6}$/.test(digits)) return null;
      const cp = parseInt(digits, 16);
      if (cp > 0x10ffff) return null;
      return { tok: { kind: 'cp', cp }, next: close + 1 };
    }
    const m = /^[0-9A-Fa-f]{4}$/.exec(body.slice(i + 2, i + 6));
    if (!m) return null;
    return { tok: { kind: 'cp', cp: parseInt(m[0], 16) }, next: i + 6 };
  }
  if (e === 'p' || e === 'P') {
    if (body.charAt(i + 2) !== '{') return null;
    const close = body.indexOf('}', i + 3);
    if (close < 0) return null;
    const name = body.slice(i + 3, close);
    if (!PROP_RE.test(name)) return null;
    return {
      tok: { kind: 'class', src: BS + e + '{' + name + '}' },
      next: close + 1,
    };
  }
  // Backreferences (\1, \k<…>), word boundaries, control escapes and anything else.
  return null;
}

/**
 * Compiles an `allowed_chars` body as data, never as regex source: the body is
 * parsed into literal code points, `a-z` ranges and allowlisted escapes
 * (`\d \w \s`, `\p{…}`, `\uXXXX`, `\u{…}`, `\xHH`, escaped syntax characters),
 * and the class is rebuilt from those tokens with every literal written as
 * `\u{…}`. Bare `[ ] | ( ) * + ? { }`, backreferences and unknown escapes are
 * refused, so a body can never leave the class (e.g. `b]|^(a+)+$|[b`).
 * A leading bare `^` keeps its negation meaning. Accepted bodies match the
 * M4.0 `compileAllowedChars` (rules.ts) semantics: `^[<body>]*$` with `u`.
 * Returns null when the body is refused. Duplicated (not imported) because this
 * file must stay import-free (D2 mirrors).
 */
export function compileDesignAllowedChars(body: string): RegExp | null {
  if (
    typeof body !== 'string' ||
    body === '' ||
    body.length > ALLOWED_CHARS_MAX_LENGTH
  )
    return null;
  let i = 0;
  let negate = false;
  if (body.charAt(0) === '^') {
    negate = true;
    i = 1;
  }
  let out = '';
  while (i < body.length) {
    const a = readClassAtom(body, i);
    if (!a) return null;
    i = a.next;
    // A '-' between two atoms is a range; at either end of the body it is literal.
    if (body.charAt(i) === '-' && i + 1 < body.length) {
      const b = readClassAtom(body, i + 1);
      if (!b) return null;
      if (a.tok.kind !== 'cp' || b.tok.kind !== 'cp' || a.tok.cp > b.tok.cp)
        return null;
      out += hex(a.tok.cp) + '-' + hex(b.tok.cp);
      i = b.next;
      continue;
    }
    out += a.tok.kind === 'cp' ? hex(a.tok.cp) : a.tok.src;
  }
  if (out === '') return null;
  try {
    return new RegExp('^[' + (negate ? '^' : '') + out + ']*$', 'u');
  } catch {
    return null;
  }
}

function inRange(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && isFinite(v) && v >= lo && v <= hi;
}

/**
 * Validates and normalizes a design state against a template.
 * Unknown ids and non-string texts are dropped; empty texts are dropped (the default applies).
 * requireComplete adds the `required` / `photo_required` rules (cart/order time).
 */
export function validateState(
  spec: TemplateSpecV1,
  state: unknown,
  opts?: { requireComplete?: boolean },
): StateValidation {
  const requireComplete = !!(opts && opts.requireComplete);
  const errors: { element_id: string; rule: StateRule }[] = [];
  const normalized: DesignStateV1 = { v: 1, texts: {}, photos: {} };
  const src = (
    state && typeof state === 'object' ? state : {}
  ) as Partial<DesignStateV1>;
  const texts = src.texts && typeof src.texts === 'object' ? src.texts : {};
  const photos = src.photos && typeof src.photos === 'object' ? src.photos : {};
  const surface = surfaceOf(spec, 'front');
  for (const el of surface ? surface.elements : []) {
    if (el.type === 'text') {
      if (!el.editable) continue;
      const raw = Object.prototype.hasOwnProperty.call(texts, el.id)
        ? texts[el.id]
        : undefined;
      // Length cap before any normalization or regex work (DoS guard).
      if (typeof raw === 'string' && raw.length > DESIGN_TEXT_RAW_MAX) {
        errors.push({ element_id: el.id, rule: 'max_length' });
        continue;
      }
      const v = typeof raw === 'string' ? normalizeText(raw) : '';
      if (v === '' || v.trim() === '') {
        if (requireComplete && el.required)
          errors.push({ element_id: el.id, rule: 'required' });
        continue;
      }
      const tooLong = el.max_length > 0 && designTextLength(v) > el.max_length;
      if (tooLong) errors.push({ element_id: el.id, rule: 'max_length' });
      // The chars check only runs on texts within max_length.
      if (el.allowed_chars && !tooLong) {
        const re = compileDesignAllowedChars(el.allowed_chars);
        // Fail closed on an invalid class body (validateSpec rejects it at save time).
        if (!re || !re.test(v.replace(VS_RE, '')))
          errors.push({ element_id: el.id, rule: 'chars' });
      }
      normalized.texts[el.id] = v;
    } else if (el.type === 'image_slot') {
      const p = Object.prototype.hasOwnProperty.call(photos, el.id)
        ? (photos[el.id] as Partial<DesignPhoto> | undefined)
        : undefined;
      if (!p || typeof p !== 'object') {
        if (requireComplete && el.required)
          errors.push({ element_id: el.id, rule: 'photo_required' });
        continue;
      }
      if (
        typeof p.asset_id !== 'string' ||
        p.asset_id === '' ||
        !inRange(p.width, 1, 1e6) ||
        !inRange(p.height, 1, 1e6)
      ) {
        errors.push({ element_id: el.id, rule: 'asset' });
        continue;
      }
      const a: PhotoAdj =
        p.adj && typeof p.adj === 'object'
          ? p.adj
          : el.default_adj || DEFAULT_ADJ;
      const zl = el.adj_limits ? el.adj_limits.zoom : [1, 3];
      const rl = el.adj_limits ? el.adj_limits.rot : [-180, 180];
      if (
        !inRange(a.zoom, zl[0], zl[1]) ||
        !inRange(a.rot, rl[0], rl[1]) ||
        !inRange(a.panX, 0, 1) ||
        !inRange(a.panY, 0, 1)
      ) {
        errors.push({ element_id: el.id, rule: 'adj_range' });
      }
      normalized.photos[el.id] = {
        asset_id: p.asset_id,
        width: p.width,
        height: p.height,
        adj: { zoom: a.zoom, rot: a.rot, panX: a.panX, panY: a.panY },
      };
    }
  }
  return { ok: errors.length === 0, errors, normalized };
}

export interface SpecIssue {
  path: string;
  rule: string;
}

const ID_RE = /^[a-z0-9_-]{1,32}$/;

/**
 * Structural validation of a template spec (pure part of the server's validateSpec;
 * asset ownership is checked by the server).
 */
export function validateSpec(spec: unknown): {
  ok: boolean;
  errors: SpecIssue[];
} {
  const errors: SpecIssue[] = [];
  const push = (path: string, rule: string) => errors.push({ path, rule });
  const s = spec as TemplateSpecV1;
  if (!s || typeof s !== 'object')
    return { ok: false, errors: [{ path: '', rule: 'type' }] };
  if (s.schema !== 'designer.template/1') push('schema', 'value');
  if (s.unit !== 'mm') push('unit', 'value');
  if (!inRange(s.width, 1, 5000)) push('width', 'range');
  if (!inRange(s.height, 1, 5000)) push('height', 'range');
  if (!inRange(s.bleed_mm, 0, 50)) push('bleed_mm', 'range');
  const r = s.render;
  if (
    !r ||
    !inRange(r.preview_px_per_mm, 0.1, 50) ||
    !inRange(r.print_px_per_mm, 0.1, 50) ||
    !inRange(r.fit_ref_px_per_mm, 0.1, 50)
  ) {
    push('render', 'range');
  }
  const fontKeys = new Set<string>();
  (Array.isArray(s.fonts) ? s.fonts : []).forEach((f, i) => {
    if (
      !f ||
      typeof f.family !== 'string' ||
      !f.family ||
      !inRange(f.weight, 1, 1000) ||
      typeof f.asset_id !== 'string'
    ) {
      push('fonts[' + i + ']', 'value');
    } else
      fontKeys.add(f.family + '|' + f.weight + '|' + (f.style || 'normal'));
  });
  if (!Array.isArray(s.fonts)) push('fonts', 'type');
  if (!Array.isArray(s.surfaces) || s.surfaces.length === 0) {
    push('surfaces', 'type');
    return { ok: false, errors };
  }
  s.surfaces.forEach((sf, si) => {
    const base = 'surfaces[' + si + ']';
    if (!sf || sf.key !== 'front') push(base + '.key', 'value');
    if (!sf || !sf.background || typeof sf.background.color !== 'string')
      push(base + '.background', 'value');
    const ids = new Set<string>();
    (sf && Array.isArray(sf.elements) ? sf.elements : []).forEach((el, ei) => {
      const p = base + '.elements[' + ei + ']';
      if (!el || typeof el !== 'object') return push(p, 'type');
      if (typeof el.id !== 'string' || !ID_RE.test(el.id))
        push(p + '.id', 'format');
      else if (ids.has(el.id)) push(p + '.id', 'duplicate');
      else ids.add(el.id);
      if (!inRange(el.x, -10000, 10000) || !inRange(el.y, -10000, 10000))
        push(p, 'position');
      if (!inRange(el.w, 0.001, 10000) || !inRange(el.h, 0.001, 10000))
        push(p, 'size');
      if (!inRange(el.rot, -360, 360) || !inRange(el.z, -1000, 1000))
        push(p, 'rot_z');
      if (el.type === 'text') {
        if (!inRange(el.size, 1, 1000)) push(p + '.size', 'range');
        if (
          !el.font ||
          !fontKeys.has(
            el.font.family +
              '|' +
              el.font.weight +
              '|' +
              (el.font.style || 'normal'),
          )
        ) {
          push(p + '.font', 'undeclared');
        }
        if (
          !el.fit ||
          !inRange(el.fit.step, 0.01, 10) ||
          !inRange(el.fit.min, 1, 1000) ||
          !inRange(el.fit.pad_ref_px, 0, 1000)
        ) {
          push(p + '.fit', 'range');
        }
        if (!inRange(el.max_length, 0, 1000)) push(p + '.max_length', 'range');
        if (
          el.allowed_chars !== undefined &&
          (typeof el.allowed_chars !== 'string' ||
            !compileDesignAllowedChars(el.allowed_chars))
        ) {
          push(p + '.allowed_chars', 'regex');
        }
        if (['left', 'center', 'right'].indexOf(el.align) < 0)
          push(p + '.align', 'value');
      } else if (el.type === 'image_slot') {
        if (el.shape !== 'rect' && el.shape !== 'ellipse')
          push(p + '.shape', 'value');
        if (!inRange(el.radius, 0, 10000)) push(p + '.radius', 'range');
      } else if (el.type === 'image') {
        if (
          !el.asset ||
          typeof el.asset.asset_id !== 'string' ||
          !el.asset.asset_id
        )
          push(p + '.asset', 'value');
      } else {
        push(p + '.type', 'unsupported');
      }
    });
  });
  return { ok: errors.length === 0, errors };
}

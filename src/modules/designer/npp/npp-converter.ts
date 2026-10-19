/*
 * NPP (namez-poster-plugin 1.9.1) → TemplateSpecV1 converter (M4.2 §10). Pure: no I/O,
 * no Nest, no Prisma. The import service fetches the URLs listed in `fetch`, stores the
 * assets and then calls `finalizeTemplateAssets()` with the real ids and dimensions.
 *
 * Input shapes (auto-detected, arrays allowed at any level):
 *   (A) nppProduct: { productId, templateData, fonts, addons, pricing, basePrice, ... }
 *   (B) REST template: { id, name, size_mode, elements, thumbnail }
 *   (C) templates list item: { id, name, thumbnail, size_mode } (no elements → name/thumbnail only)
 *   (E) importer NTemplate: { ext_id, title, size_mode, elements, fonts: string[], thumbnail,
 *       linked_product_ext_ids, raw_meta } (M4-INTEGRATION C26)
 */
import type {
  AssetRef,
  Background,
  DesignElement,
  FontRef,
  I18n,
  ImageElement,
  ImageSlotElement,
  TemplateSpecV1,
  TextElement,
} from '@multi-stores/core/designer';

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

export type NppWarningCode =
  | 'INPUT_UNRECOGNIZED'
  | 'TEMPLATE_NO_ELEMENTS'
  | 'TEMPLATE_CONFLICT'
  | 'TEMPLATE_UNLINKED'
  | 'NAME_REVIEW'
  | 'UNKNOWN_SIZE_MODE'
  | 'PREMIUM_ASSUMED_BLEED'
  | 'NO_BACKGROUND'
  | 'PRINT_BG_FROM_WEB'
  | 'PRINT_BG_SAME_AS_WEB'
  | 'BG_SCALED_FALLBACK'
  | 'BG_SWAPPED'
  | 'BG_SWAP_UNDECIDED'
  | 'PRINT_BG_LOW_RES'
  | 'LABEL_NORMALIZED'
  | 'LABEL_NOT_NORMALIZED'
  | 'FONT_UNDECLARED'
  | 'FONT_WEIGHT_SUBSTITUTED'
  | 'FONT_WEIGHTS_UNKNOWN'
  | 'FONT_CUSTOM_UNSUPPORTED'
  | 'UNSUPPORTED_ELEMENT'
  | 'ELEMENT_NO_IMAGE'
  | 'ID_REWRITTEN'
  | 'PRODUCT_SKIPPED'
  | 'ASSET_MISSING';

export interface NppWarning {
  code: NppWarningCode;
  /** NPP template id (string) when the warning belongs to a template. */
  template_id?: string;
  element_id?: string;
  message: string;
  data?: Record<string, unknown>;
}

export type NppFetchRole = 'bg_web' | 'bg_print' | 'deco' | 'thumb';

/** One URL the import service must fetch; `key` is the pending asset_id used in the spec. */
export interface NppFetch {
  key: string;
  role: NppFetchRole;
  /** Preferred URL (`-scaled` stripped, U9). */
  url: string;
  /** Original NPP URL, tried when `url` fails (BG_SCALED_FALLBACK). */
  fallback_url?: string;
  element_id?: string;
}

/** Font face the font service must provide; `key` is the pending FontRef.asset_id. */
export interface NppFontNeed {
  key: string;
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  /** True when the family is not in the template's declared fonts (4315, 4350, 4355, 4359). */
  undeclared: boolean;
}

export interface NppConvertedTemplate {
  source_id: string;
  external_ref: string;
  name: string;
  /** Spec with pending asset ids (`pending:*`, width/height 0) until finalizeTemplateAssets(). */
  spec: TemplateSpecV1;
  fetch: NppFetch[];
  fonts: NppFontNeed[];
  thumbnail_url: string | null;
  linked_product_refs: string[];
  /** false for unlinked templates unless includeUnlinked (4410). */
  include: boolean;
  warnings: NppWarning[];
}

export interface NppProductLink {
  product_source_id: string;
  product_external_ref: string;
  template_source_id: string;
  template_external_ref: string;
  /** Raw NPP add-ons/pricing (always stored disabled in M4.2, D9). */
  addons: unknown;
  pricing: unknown;
}

export interface NppConversionResult {
  templates: NppConvertedTemplate[];
  product_links: NppProductLink[];
  warnings: NppWarning[];
}

export interface NppConvertOptions {
  /** Source host for external refs, e.g. 'namez.se' (C7 / X29). */
  siteHost: string;
  /** "Text" → Namn/Klass, "Photo" → Foto, English placeholders replaced. Default true. */
  normalizeLabels?: boolean;
  /** Mark unlinked templates as included. Default false. */
  includeUnlinked?: boolean;
  /** Locale of the NPP texts. Default 'sv'. */
  locale?: string;
  /** NPP product ids that are not imported (U4: '4326'). Default none. */
  skipProductIds?: string[];
  /** Extra/override Google font weights per family. */
  fontWeights?: Record<string, number[]>;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const SCALED_RE = /-scaled(\.[a-z0-9]+)$/i;
const ID_RE = /^[a-z0-9_-]{1,32}$/;
const ALL_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];

/** Static weights of the Google families used by NPP templates (fonts.google.com). */
export const KNOWN_GOOGLE_WEIGHTS: Record<string, number[]> = {
  Montserrat: ALL_WEIGHTS,
  Anton: [400],
  Righteous: [400],
};

/** NPP text constants (product.js:125-132, 152-159). */
const TEXT_FIT = { mode: 'shrink' as const, step: 0.5, min: 6, pad_ref_px: 8 };
const TEXT_INSET = 4;
const IMPORTED_MAX_LENGTH = 40;
/**
 * Character class of an imported text (M4.2 launch fix, §6.4): Latin
 * letters incl. Latin-1 Supplement and Latin Extended-A (Nordic / Western
 * European names), digits, space, the punctuation that occurs in names and
 * class labels (`.,'’&-!?:/()`) and the heart NPP customers used (drawn by
 * the host's emoji fallback font; U+FE0F is stripped before the check).
 * Compiled as data by `compileDesignAllowedChars` (never regex source).
 */
export const IMPORTED_ALLOWED_CHARS =
  "A-Za-z0-9 \\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u017F.,'\u2019&\\-!\\?:/\\(\\)\u2764";

const PENDING_BG_WEB = 'pending:bg_web';
const PENDING_BG_PRINT = 'pending:bg_print';
const PENDING_THUMB = 'pending:thumb';
const pendingDeco = (elementId: string) => 'pending:deco:' + elementId;
const pendingFont = (family: string, weight: number, style: string) =>
  'pending:font:' + family + ':' + weight + ':' + style;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
const num = (v: unknown, d: number): number => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && isFinite(n) ? n : d;
};

/** U9: strip WordPress's `-scaled` suffix; null when the URL has none. */
export function stripScaled(url: string): string | null {
  return SCALED_RE.test(url) ? url.replace(SCALED_RE, '$1') : null;
}

export const templateExternalRef = (host: string, id: string) =>
  `woo:${host}:npp_template:${id}`;
export const productExternalRef = (host: string, id: string) =>
  `woo:${host}:product:${id}`;

/**
 * CSS font matching (CSS Fonts 4 §5.2) for the weight actually rendered:
 * 400–500 → up to 500, then down, then up; < 400 → down then up; > 500 → up then down.
 */
export function nearestWeight(desired: number, available: number[]): number {
  if (!available.length || available.indexOf(desired) >= 0) return desired;
  const sorted = available.slice().sort((a, b) => a - b);
  const up = sorted.filter((w) => w > desired);
  const down = sorted.filter((w) => w < desired).reverse();
  if (desired >= 400 && desired <= 500) {
    const toFiveHundred = up.filter((w) => w <= 500);
    if (toFiveHundred.length) return toFiveHundred[0];
    if (down.length) return down[0];
    return up[0];
  }
  if (desired < 400) return down.length ? down[0] : up[0];
  return up.length ? up[0] : down[0];
}

function parseJsonMaybe(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Input collection                                                    */
/* ------------------------------------------------------------------ */

interface RawTemplate {
  id: string;
  externalRef?: string;
  name: string;
  sizeMode: string;
  elements: Obj[] | null;
  declaredFonts: { family: string; type: string }[];
  thumbnail: string;
  linkedProductRefs: string[];
}

interface Collected {
  templates: Map<string, RawTemplate>;
  listInfo: Map<string, { name: string; thumbnail: string }>;
  products: {
    productId: string;
    templateId: string;
    addons: unknown;
    pricing: unknown;
  }[];
  warnings: NppWarning[];
}

function declaredFontsOf(v: unknown): { family: string; type: string }[] {
  const arr = parseJsonMaybe(v);
  if (!Array.isArray(arr)) return [];
  const out: { family: string; type: string }[] = [];
  for (const f of arr) {
    if (typeof f === 'string' && f) out.push({ family: f, type: 'google' });
    else if (isObj(f) && str(f.family))
      out.push({ family: str(f.family), type: str(f.type) || 'google' });
  }
  return out;
}

function addTemplate(c: Collected, t: RawTemplate): void {
  const prev = c.templates.get(t.id);
  if (!prev) {
    c.templates.set(t.id, t);
    return;
  }
  if (JSON.stringify(prev.elements) !== JSON.stringify(t.elements)) {
    c.warnings.push({
      code: 'TEMPLATE_CONFLICT',
      template_id: t.id,
      message: `Template ${t.id} appears more than once with different elements; the first occurrence is used.`,
    });
  }
  // Merge information the first occurrence lacked.
  for (const f of t.declaredFonts) {
    if (!prev.declaredFonts.some((p) => p.family === f.family))
      prev.declaredFonts.push(f);
  }
  if (!prev.thumbnail && t.thumbnail) prev.thumbnail = t.thumbnail;
  for (const r of t.linkedProductRefs)
    if (prev.linkedProductRefs.indexOf(r) < 0) prev.linkedProductRefs.push(r);
}

function collect(input: unknown, c: Collected): void {
  if (Array.isArray(input)) {
    for (const x of input) collect(x, c);
    return;
  }
  if (!isObj(input)) {
    c.warnings.push({
      code: 'INPUT_UNRECOGNIZED',
      message: 'Input entry is not an object.',
    });
    return;
  }
  // (A) nppProduct
  if (isObj(input.templateData)) {
    const td = input.templateData;
    const tid = str(td.id);
    addTemplate(c, {
      id: tid,
      name: str(td.name),
      sizeMode: str(td.size_mode) || 'budget',
      elements: Array.isArray(td.elements) ? td.elements.filter(isObj) : null,
      declaredFonts: declaredFontsOf(input.fonts),
      thumbnail: str(td.thumbnail),
      linkedProductRefs: [],
    });
    const pid = str(input.productId);
    if (pid && tid)
      c.products.push({
        productId: pid,
        templateId: tid,
        addons: input.addons,
        pricing: input.pricing,
      });
    return;
  }
  // (E) importer NTemplate
  if (typeof input.ext_id === 'string' && 'elements' in input) {
    const ext = input.ext_id;
    const m = /^woo:[^:]+:npp_template:(.+)$/.exec(ext);
    const raw = isObj(input.raw_meta) ? input.raw_meta : {};
    const elements = Array.isArray(input.elements)
      ? input.elements
      : parseJsonMaybe(raw._npp_elements);
    const thumb = isObj(input.thumbnail)
      ? str(input.thumbnail.url)
      : str(raw._npp_thumbnail_url);
    const fonts = declaredFontsOf(input.fonts);
    for (const f of declaredFontsOf(raw._npp_fonts))
      if (!fonts.some((x) => x.family === f.family)) fonts.push(f);
    addTemplate(c, {
      id: m ? m[1] : ext,
      externalRef: m ? ext : undefined,
      name: str(input.title),
      sizeMode: str(input.size_mode) || str(raw._npp_size_mode) || 'budget',
      elements: Array.isArray(elements) ? elements.filter(isObj) : null,
      declaredFonts: fonts,
      thumbnail: thumb,
      linkedProductRefs: Array.isArray(input.linked_product_ext_ids)
        ? input.linked_product_ext_ids.map(str).filter(Boolean)
        : [],
    });
    return;
  }
  // (B) REST template
  if (
    (typeof input.id === 'number' || typeof input.id === 'string') &&
    Array.isArray(input.elements)
  ) {
    addTemplate(c, {
      id: str(input.id),
      name: str(input.name),
      sizeMode: str(input.size_mode) || 'budget',
      elements: input.elements.filter(isObj),
      declaredFonts: declaredFontsOf(input.fonts),
      thumbnail: str(input.thumbnail),
      linkedProductRefs: [],
    });
    return;
  }
  // (C) templates list item
  if (
    (typeof input.id === 'number' || typeof input.id === 'string') &&
    'name' in input
  ) {
    c.listInfo.set(str(input.id), {
      name: str(input.name),
      thumbnail: str(input.thumbnail),
    });
    return;
  }
  c.warnings.push({
    code: 'INPUT_UNRECOGNIZED',
    message: 'Input entry has no recognizable NPP shape.',
  });
}

/* ------------------------------------------------------------------ */
/* Template conversion                                                 */
/* ------------------------------------------------------------------ */

interface Ctx {
  opts: Required<NppConvertOptions>;
  /** Set per template by convertTemplate(). */
  warn: (w: Omit<NppWarning, 'template_id'>) => void;
}

function i18n(locale: string, v: string): I18n {
  return { [locale]: v };
}

function sanitizeIds(elements: Obj[], ctx: Ctx): Map<Obj, string> {
  const used = new Set<string>();
  const out = new Map<Obj, string>();
  elements.forEach((el, i) => {
    const raw = str(el.id);
    let id = raw;
    if (!ID_RE.test(id) || used.has(id)) {
      id =
        raw
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '_')
          .slice(0, 28) || 'el';
      let n = i;
      let cand = id;
      while (!ID_RE.test(cand) || used.has(cand))
        cand = (id + '_' + n++).slice(0, 32);
      id = cand;
      ctx.warn({
        code: 'ID_REWRITTEN',
        element_id: id,
        message: `Element id "${raw}" rewritten to "${id}".`,
      });
    }
    used.add(id);
    out.set(el, id);
  });
  return out;
}

function baseOf(el: Obj, id: string) {
  return {
    id,
    x: num(el.x, 0),
    y: num(el.y, 0),
    w: num(el.w, 0),
    h: num(el.h, 0),
    rot: num(el.rot, 0),
    z: num(el.z, 0),
    locked: el.locked === true,
  };
}

const GENERIC_TEXT_LABEL = /^\s*text\s*$/i;
const ENGLISH_PLACEHOLDER = /^\s*enter\b/i;

function convertTemplate(
  raw: RawTemplate,
  linked: string[],
  ctx: Ctx,
): NppConvertedTemplate {
  const { opts } = ctx;
  const loc = opts.locale;
  const warnings: NppWarning[] = [];
  ctx.warn = (w) => warnings.push({ ...w, template_id: raw.id });

  // Size mode (A:126-128): budget 500×700; premium 506×706 assumed to carry a 3 mm bleed.
  let width = 500;
  let height = 700;
  let bleed = 0;
  if (raw.sizeMode === 'premium') {
    width = 506;
    height = 706;
    bleed = 3;
    ctx.warn({
      code: 'PREMIUM_ASSUMED_BLEED',
      message: 'premium size mode mapped to 506×706 mm with a 3 mm bleed.',
    });
  } else if (raw.sizeMode !== 'budget') {
    ctx.warn({
      code: 'UNKNOWN_SIZE_MODE',
      message: `Unknown size_mode "${raw.sizeMode}", using budget 500×700.`,
    });
  }

  const elements = raw.elements || [];
  const ids = sanitizeIds(elements, ctx);
  const fetch: NppFetch[] = [];

  // Background.
  const bgEl = elements.find((e) => e.type === 'background');
  const background: Background = {
    color: (bgEl && str(bgEl.color)) || '#ffffff',
    fit: 'stretch',
  };
  const webRaw = bgEl ? str(bgEl.imageData) : '';
  const hiRaw = bgEl ? str(bgEl.imageDataHiRes) : '';
  const pendingRef = (key: string): AssetRef => ({
    asset_id: key,
    width: 0,
    height: 0,
  });
  const fetchFor = (
    key: string,
    role: NppFetchRole,
    url: string,
    element_id?: string,
  ): NppFetch => {
    const stripped = stripScaled(url);
    const f: NppFetch = { key, role, url: stripped || url };
    if (stripped) f.fallback_url = url;
    if (element_id) f.element_id = element_id;
    return f;
  };
  if (webRaw) {
    background.web = pendingRef(PENDING_BG_WEB);
    fetch.push(fetchFor(PENDING_BG_WEB, 'bg_web', webRaw));
    background.print = pendingRef(PENDING_BG_PRINT);
    if (!hiRaw) {
      ctx.warn({
        code: 'PRINT_BG_FROM_WEB',
        message:
          'No print background; the web background original is used for print.',
      });
      fetch.push(fetchFor(PENDING_BG_PRINT, 'bg_print', webRaw));
    } else {
      if (hiRaw === webRaw) {
        ctx.warn({
          code: 'PRINT_BG_SAME_AS_WEB',
          message: 'Print and web backgrounds are the same file.',
        });
      }
      fetch.push(fetchFor(PENDING_BG_PRINT, 'bg_print', hiRaw));
    }
  } else if (hiRaw) {
    // Print-only background: use it for both.
    background.web = pendingRef(PENDING_BG_WEB);
    background.print = pendingRef(PENDING_BG_PRINT);
    fetch.push(fetchFor(PENDING_BG_WEB, 'bg_web', hiRaw));
    fetch.push(fetchFor(PENDING_BG_PRINT, 'bg_print', hiRaw));
  } else {
    ctx.warn({
      code: 'NO_BACKGROUND',
      message: 'The template has no background image; the colour is used.',
    });
  }

  // Elements (array order kept; the renderer sorts by (z, index)).
  const out: DesignElement[] = [];
  for (const el of elements) {
    const type = str(el.type);
    const id = ids.get(el) as string;
    if (type === 'background') continue;
    if (type === 'text') {
      const editable = el.editable !== false;
      const align =
        el.textAlign === 'left' || el.textAlign === 'right'
          ? el.textAlign
          : 'center';
      const fieldLabel = str(el.fieldLabel);
      const t: TextElement = {
        ...baseOf(el, id),
        type: 'text',
        label: i18n(loc, fieldLabel || 'Text'),
        placeholder: i18n(loc, str(el.placeholder)),
        default_text: str(el.text),
        font: {
          family: str(el.fontFamily) || 'Montserrat',
          weight: num(el.fontWeight, 400),
          style: 'normal',
        },
        size: num(el.fontSize, 28),
        color: str(el.color) || '#000',
        align,
        transform: el.uppercase === true ? 'uppercase' : 'none',
        fit: { ...TEXT_FIT },
        inset: TEXT_INSET,
        editable,
        required: editable,
        max_length: IMPORTED_MAX_LENGTH,
        allowed_chars: IMPORTED_ALLOWED_CHARS,
        direction: 'ltr',
      };
      if (fieldLabel) t.source_label = fieldLabel;
      out.push(t);
    } else if (type === 'image-slot') {
      const s: ImageSlotElement = {
        ...baseOf(el, id),
        type: 'image_slot',
        label: i18n(loc, str(el.fieldLabel) || 'Photo'),
        placeholder: i18n(loc, str(el.placeholder)),
        shape: el.shape === 'circle' ? 'ellipse' : 'rect',
        radius: num(el.borderRadius, 0),
        border_color: str(el.borderColor) || '#ccc',
        required: true,
        adj_limits: { zoom: [1, 3], rot: [-180, 180] },
        default_adj: { zoom: 1, rot: 0, panX: 0.5, panY: 0.5 },
      };
      out.push(s);
    } else if (type === 'deco-image' || type === 'overlay') {
      const url = str(el.imageData);
      if (!url) {
        ctx.warn({
          code: 'ELEMENT_NO_IMAGE',
          element_id: id,
          message: `${type} without an image is skipped.`,
        });
        continue;
      }
      const key = pendingDeco(id);
      fetch.push(fetchFor(key, 'deco', url, id));
      const im: ImageElement = {
        ...baseOf(el, id),
        type: 'image',
        asset: pendingRef(key),
      };
      out.push(im);
    } else {
      ctx.warn({
        code: 'UNSUPPORTED_ELEMENT',
        element_id: id,
        message: `Element type "${type}" is not supported and is skipped.`,
      });
    }
  }

  if (opts.normalizeLabels) normalizeLabels(out, ctx);

  // Fonts: union of declared families and (family, weight) pairs used by text elements.
  const fonts = resolveFonts(raw, out, ctx);

  // Thumbnail.
  const thumbnail_url: string | null = raw.thumbnail || null;
  if (thumbnail_url)
    fetch.push({ key: PENDING_THUMB, role: 'thumb', url: thumbnail_url });

  // Name review: "(Copy)" / "new" suffixes are kept but flagged.
  if (/\(copy\)|\bnew\s*$/i.test(raw.name)) {
    ctx.warn({
      code: 'NAME_REVIEW',
      message: `Template name "${raw.name}" looks like a working copy; review before publishing.`,
    });
  }

  const include = linked.length > 0 || opts.includeUnlinked;
  if (!linked.length) {
    ctx.warn({
      code: 'TEMPLATE_UNLINKED',
      message: 'No product uses this template; it is not imported by default.',
    });
  }

  const spec: TemplateSpecV1 = {
    schema: 'designer.template/1',
    unit: 'mm',
    width,
    height,
    bleed_mm: bleed,
    render: { preview_px_per_mm: 2, print_px_per_mm: 6, fit_ref_px_per_mm: 6 },
    fonts: fonts.map(
      (f) =>
        ({
          family: f.family,
          weight: f.weight,
          style: f.style,
          asset_id: f.key,
        }) as FontRef,
    ),
    surfaces: [{ key: 'front', background, elements: out }],
  };
  return {
    source_id: raw.id,
    external_ref: raw.externalRef || templateExternalRef(opts.siteHost, raw.id),
    name: raw.name,
    spec,
    fetch,
    fonts,
    thumbnail_url,
    linked_product_refs: linked,
    include,
    warnings,
  };
}

/**
 * Label normalization (C:311-312, 648): among editable text elements sorted by y,
 * a generic "Text" label becomes "Namn" (1st) / "Klass" (2nd); "Photo" → "Foto";
 * English placeholders ("Enter Namn", "Enter text", "Upload image") are replaced.
 */
function normalizeLabels(els: DesignElement[], ctx: Ctx): void {
  const loc = ctx.opts.locale;
  const texts = els
    .map((e, i) => ({ e, i }))
    .filter((x) => x.e.type === 'text' && x.e.editable)
    .sort((a, b) => a.e.y - b.e.y || a.i - b.i)
    .map((x) => x.e as TextElement);
  const targets = ['Namn', 'Klass'];
  const taken = new Set(
    texts
      .map((t) => t.label[loc])
      .filter((l) => !GENERIC_TEXT_LABEL.test(l || '')),
  );
  texts.forEach((t, i) => {
    const label = t.label[loc] || '';
    if (!GENERIC_TEXT_LABEL.test(label)) return;
    const target = targets[i];
    if (!target || taken.has(target)) {
      ctx.warn({
        code: 'LABEL_NOT_NORMALIZED',
        element_id: t.id,
        message: `Generic label "${label}" kept (no free target).`,
      });
      return;
    }
    t.label = i18n(loc, target);
    taken.add(target);
    ctx.warn({
      code: 'LABEL_NORMALIZED',
      element_id: t.id,
      message: `Label "${label}" normalized to "${target}".`,
      data: { from: label, to: target },
    });
  });
  for (const e of els) {
    if (e.type === 'text') {
      if (ENGLISH_PLACEHOLDER.test(e.placeholder[loc] || ''))
        e.placeholder = i18n(loc, e.label[loc]);
    } else if (e.type === 'image_slot') {
      if (/^\s*photo\s*$/i.test(e.label[loc] || ''))
        e.label = i18n(loc, 'Foto');
      if (
        /^\s*upload image\s*$/i.test(e.placeholder[loc] || '') ||
        !e.placeholder[loc]
      ) {
        e.placeholder = i18n(loc, 'Ladda upp bild');
      }
    }
  }
}

function resolveFonts(
  raw: RawTemplate,
  els: DesignElement[],
  ctx: Ctx,
): NppFontNeed[] {
  const weightsOf = (family: string): number[] | undefined =>
    ctx.opts.fontWeights[family] || KNOWN_GOOGLE_WEIGHTS[family];
  const declared = new Set<string>();
  for (const f of raw.declaredFonts) {
    if (f.type === 'custom') {
      ctx.warn({
        code: 'FONT_CUSTOM_UNSUPPORTED',
        message: `Custom font "${f.family}" is treated as a Google family.`,
      });
    }
    declared.add(f.family);
  }
  const needs = new Map<string, NppFontNeed>();
  const add = (family: string, weight: number, style: 'normal' | 'italic') => {
    const key = pendingFont(family, weight, style);
    if (!needs.has(key))
      needs.set(key, {
        key,
        family,
        weight,
        style,
        undeclared: !declared.has(family),
      });
  };
  const warnedUnknown = new Set<string>();
  const warnedUndeclared = new Set<string>();
  const resolveWeight = (
    family: string,
    weight: number,
    elementId?: string,
  ): number => {
    const avail = weightsOf(family);
    if (!avail) {
      if (!warnedUnknown.has(family)) {
        warnedUnknown.add(family);
        ctx.warn({
          code: 'FONT_WEIGHTS_UNKNOWN',
          message: `Available weights of "${family}" are unknown; ${weight} is requested as-is.`,
        });
      }
      return weight;
    }
    const w = nearestWeight(weight, avail);
    if (w !== weight) {
      ctx.warn({
        code: 'FONT_WEIGHT_SUBSTITUTED',
        element_id: elementId,
        message: `${family} ${weight} is not available; the ${w} face is used.`,
        data: { family, requested: weight, used: w },
      });
    }
    return w;
  };
  for (const e of els) {
    if (e.type !== 'text') continue;
    const fam = e.font.family;
    e.font.weight = resolveWeight(fam, e.font.weight, e.id);
    if (!declared.has(fam) && !warnedUndeclared.has(fam)) {
      warnedUndeclared.add(fam);
      ctx.warn({
        code: 'FONT_UNDECLARED',
        message: `Font "${fam}" is used but not declared in the template; it is added.`,
      });
    }
    add(fam, e.font.weight, e.font.style);
  }
  // Declared but unused families get their regular face.
  for (const fam of declared) {
    if (!Array.from(needs.values()).some((n) => n.family === fam))
      add(fam, resolveWeight(fam, 400), 'normal');
  }
  return Array.from(needs.values()).sort((a, b) =>
    a.family < b.family
      ? -1
      : a.family > b.family
        ? 1
        : a.weight - b.weight || (a.style < b.style ? -1 : 1),
  );
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function convertNpp(
  payload: unknown,
  options: NppConvertOptions,
): NppConversionResult {
  const opts = {
    siteHost: options.siteHost,
    normalizeLabels: options.normalizeLabels !== false,
    includeUnlinked: options.includeUnlinked === true,
    locale: options.locale || 'sv',
    skipProductIds: options.skipProductIds || [],
    fontWeights: options.fontWeights || {},
  };
  const c: Collected = {
    templates: new Map(),
    listInfo: new Map(),
    products: [],
    warnings: [],
  };
  collect(payload, c);

  // Product links (deduped by product id, first occurrence wins).
  const product_links: NppProductLink[] = [];
  const seenProducts = new Set<string>();
  for (const p of c.products) {
    if (seenProducts.has(p.productId)) continue;
    seenProducts.add(p.productId);
    if (opts.skipProductIds.indexOf(p.productId) >= 0) {
      c.warnings.push({
        code: 'PRODUCT_SKIPPED',
        template_id: p.templateId,
        message: `Product ${p.productId} is skipped by configuration.`,
        data: { product_id: p.productId },
      });
      continue;
    }
    product_links.push({
      product_source_id: p.productId,
      product_external_ref: productExternalRef(opts.siteHost, p.productId),
      template_source_id: p.templateId,
      template_external_ref: '',
      addons: p.addons ?? null,
      pricing: p.pricing ?? null,
    });
  }

  // List-only entries enrich names/thumbnails or are reported.
  for (const [id, info] of c.listInfo) {
    const t = c.templates.get(id);
    if (t) {
      if (!t.name) t.name = info.name;
      if (!t.thumbnail) t.thumbnail = info.thumbnail;
    } else {
      c.warnings.push({
        code: 'TEMPLATE_NO_ELEMENTS',
        template_id: id,
        message: `Template ${id} ("${info.name}") is only listed; its elements are unknown.`,
      });
    }
  }

  const templates: NppConvertedTemplate[] = [];
  const ids = Array.from(c.templates.keys()).sort(
    (a, b) => num(a, 0) - num(b, 0) || (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const id of ids) {
    const raw = c.templates.get(id) as RawTemplate;
    if (!raw.elements) {
      c.warnings.push({
        code: 'TEMPLATE_NO_ELEMENTS',
        template_id: id,
        message: `Template ${id} has no elements.`,
      });
      continue;
    }
    const linked = product_links
      .filter((l) => l.template_source_id === id)
      .map((l) => l.product_external_ref);
    for (const r of raw.linkedProductRefs)
      if (linked.indexOf(r) < 0) linked.push(r);
    templates.push(
      convertTemplate(raw, linked, { opts, warn: () => undefined }),
    );
  }
  for (const l of product_links) {
    const t = templates.find((x) => x.source_id === l.template_source_id);
    l.template_external_ref = t
      ? t.external_ref
      : templateExternalRef(opts.siteHost, l.template_source_id);
  }
  // (E) links that only exist as linked_product_ext_ids.
  for (const t of templates) {
    for (const ref of t.linked_product_refs) {
      if (product_links.some((l) => l.product_external_ref === ref)) continue;
      const m = /:product:(.+)$/.exec(ref);
      product_links.push({
        product_source_id: m ? m[1] : ref,
        product_external_ref: ref,
        template_source_id: t.source_id,
        template_external_ref: t.external_ref,
        addons: null,
        pricing: null,
      });
    }
  }
  return { templates, product_links, warnings: c.warnings };
}

/* ------------------------------------------------------------------ */
/* Finalization after fetching                                         */
/* ------------------------------------------------------------------ */

export interface NppMediaInfo {
  asset_id: string;
  width: number;
  height: number;
  /** True when the `-scaled` original failed and fallback_url was used. */
  used_fallback?: boolean;
}

/**
 * Replaces pending asset ids with stored assets and applies the post-fetch rules:
 * BG_SWAPPED (web has more pixels than print: 4355/4410), BG_SWAP_UNDECIDED,
 * PRINT_BG_LOW_RES (< 0.8 × print size per side), BG_SCALED_FALLBACK.
 * `media` is keyed by NppFetch.key / NppFontNeed.key. Returns a new spec.
 */
export function finalizeTemplateAssets(
  t: NppConvertedTemplate,
  media: Record<string, NppMediaInfo | undefined>,
): { spec: TemplateSpecV1; warnings: NppWarning[]; missing: string[] } {
  const spec = JSON.parse(JSON.stringify(t.spec)) as TemplateSpecV1;
  const warnings: NppWarning[] = [];
  const missing: string[] = [];
  const warn = (w: Omit<NppWarning, 'template_id'>) =>
    warnings.push({ ...w, template_id: t.source_id });
  const resolve = (ref: AssetRef): AssetRef | undefined => {
    const m = media[ref.asset_id];
    if (!m) {
      missing.push(ref.asset_id);
      return undefined;
    }
    return { asset_id: m.asset_id, width: m.width, height: m.height };
  };
  for (const f of t.fetch) {
    const m = media[f.key];
    if (m && m.used_fallback) {
      warn({
        code: 'BG_SCALED_FALLBACK',
        message: `Original of ${f.url} unavailable; the -scaled file was used.`,
        data: { key: f.key },
      });
    }
  }
  const bg = spec.surfaces[0].background;
  let web = bg.web ? resolve(bg.web) : undefined;
  let print = bg.print ? resolve(bg.print) : undefined;
  const webFetch = t.fetch.find((f) => f.key === PENDING_BG_WEB);
  const printFetch = t.fetch.find((f) => f.key === PENDING_BG_PRINT);
  if (
    web &&
    print &&
    webFetch &&
    printFetch &&
    webFetch.url !== printFetch.url
  ) {
    const wpx = web.width * web.height;
    const ppx = print.width * print.height;
    if (wpx > ppx) {
      [web, print] = [print, web];
      warn({
        code: 'BG_SWAPPED',
        message:
          'Web background is larger than the print background; they were swapped.',
      });
    } else if (wpx === ppx) {
      warn({
        code: 'BG_SWAP_UNDECIDED',
        message:
          'Web and print backgrounds have the same size; NPP order kept.',
      });
    }
  }
  if (web) bg.web = web;
  else delete bg.web;
  if (print) bg.print = print;
  else delete bg.print;
  if (print) {
    const needW = spec.width * spec.render.print_px_per_mm * 0.8;
    const needH = spec.height * spec.render.print_px_per_mm * 0.8;
    if (print.width < needW || print.height < needH) {
      warn({
        code: 'PRINT_BG_LOW_RES',
        message: `Print background ${print.width}×${print.height} px is below 80% of the print size.`,
        data: { width: print.width, height: print.height },
      });
    }
  }
  for (const el of spec.surfaces[0].elements) {
    if (el.type === 'image') {
      const r = resolve(el.asset);
      if (r) el.asset = r;
    }
  }
  for (const f of spec.fonts) {
    const m = media[f.asset_id];
    if (m) f.asset_id = m.asset_id;
    else missing.push(f.asset_id);
  }
  for (const k of missing)
    warn({
      code: 'ASSET_MISSING',
      message: `No stored asset for ${k}.`,
      data: { key: k },
    });
  return { spec, warnings, missing };
}

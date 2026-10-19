/**
 * Print-ready PDF of a design (geometry + the PDF step after Chromium).
 *
 * Geometry (all sizes in mm unless suffixed `_pt`; 1 mm = 72 / 25.4 pt):
 *
 *   trim   = spec.width × spec.height (the PNG covers exactly this)
 *   bleed  = spec.bleed_mm (0..50), added on every side
 *   margin = bleed, or with crop marks max(bleed, CROP_MARK_OFFSET_MM) +
 *            CROP_MARK_LENGTH_MM (the marks sit in the slug, outside the
 *            bleed, so they never overprint artwork)
 *   page   = trim + 2 × margin  (no crop marks: trim + 2 × bleed, e.g.
 *            500×700 + 3 mm bleed → 506×706 mm; bleed 0 → the trim size)
 *
 * PDF boxes (PDF origin bottom-left; symmetric margins, so the same numbers
 * hold from the top): MediaBox = CropBox = [0 0 page], BleedBox = trim +
 * bleed, TrimBox = trim.
 *
 * The PDF step (`finalizePrintPdf`): Chromium rounds the paper size up to its
 * 300 dpi device grid (100 mm becomes 283.92 pt instead of 283.46 pt), so the
 * page is requested PDF_PAGE_PAD_MM larger than needed and the exact page is
 * then cut from its top-left corner: the page dictionary gets the exact
 * boxes, and a one-line content stream that shifts the drawing down by the
 * surplus is prepended to the page contents. The original bytes are kept;
 * only the page dictionary grows, a new object is appended and the xref
 * table is rebuilt with every offset moved accordingly.
 */

export const MM_TO_PT = 72 / 25.4;
/** Smallest gap between the trim edge and a crop mark. */
export const CROP_MARK_OFFSET_MM = 3;
/** Length of one crop mark. */
export const CROP_MARK_LENGTH_MM = 5;
/** Stroke weight of the crop marks (0.25 pt hairline). */
export const CROP_MARK_WEIGHT_MM = 0.25 / MM_TO_PT;
/** Extra paper requested from Chromium and cut away by the PDF step. */
export const PDF_PAGE_PAD_MM = 1;
/**
 * Largest surplus of Chromium's page over the wanted one: the pad, the
 * device-grid rounding (under 1/300 in) and slack.
 */
const MAX_PAGE_SURPLUS_PT = (PDF_PAGE_PAD_MM + 1) * MM_TO_PT;
/** Largest bleed the template validator accepts. */
export const MAX_BLEED_MM = 50;

export interface MmRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MmLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type PdfBox = [number, number, number, number];

export interface PrintPdfGeometry {
  trim_mm: { width: number; height: number };
  bleed_mm: number;
  /** Distance from the page edge to the trim edge. */
  margin_mm: number;
  page_mm: { width: number; height: number };
  page_pt: { width: number; height: number };
  /** Page coordinates, top-left origin. */
  bleed_box_mm: MmRect;
  trim_box_mm: MmRect;
  boxes_pt: { media: PdfBox; bleed: PdfBox; trim: PdfBox };
  crop_marks: boolean;
  /** Crop mark lines in page coordinates (empty without crop marks). */
  crop_mark_lines_mm: MmLine[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** mm → PDF points (4 decimals). */
export function mmToPt(mm: number): number {
  return r4(mm * MM_TO_PT);
}

/** The bleed of a spec, clamped to 0..MAX_BLEED_MM (0 when unset / invalid). */
export function specBleedMm(spec: { bleed_mm?: unknown }): number {
  const b = Number(spec?.bleed_mm);
  if (!Number.isFinite(b) || b <= 0) return 0;
  return Math.min(b, MAX_BLEED_MM);
}

/** Page geometry of the print PDF (pure). */
export function printPdfGeometry(
  spec: { width: number; height: number; bleed_mm?: unknown },
  opts: { cropMarks?: boolean } = {},
): PrintPdfGeometry {
  const W = Number(spec.width);
  const H = Number(spec.height);
  if (!(W > 0 && H > 0) || !Number.isFinite(W * H)) {
    throw new Error('printPdfGeometry: the trim size must be positive');
  }
  const b = specBleedMm(spec);
  const marks = opts.cropMarks === true;
  const offset = Math.max(b, CROP_MARK_OFFSET_MM);
  const margin = marks ? offset + CROP_MARK_LENGTH_MM : b;
  const pw = r3(W + 2 * margin);
  const ph = r3(H + 2 * margin);
  const bleedBox: MmRect = {
    x: r3(margin - b),
    y: r3(margin - b),
    width: r3(W + 2 * b),
    height: r3(H + 2 * b),
  };
  const trimBox: MmRect = { x: r3(margin), y: r3(margin), width: W, height: H };
  const lines: MmLine[] = [];
  if (marks) {
    const L = CROP_MARK_LENGTH_MM;
    for (const tx of [margin, margin + W]) {
      for (const ty of [margin, margin + H]) {
        const sx = tx === margin ? -1 : 1;
        const sy = ty === margin ? -1 : 1;
        // Horizontal mark on the trim line ty, vertical one on tx.
        lines.push({
          x1: r3(tx + sx * offset),
          y1: r3(ty),
          x2: r3(tx + sx * (offset + L)),
          y2: r3(ty),
        });
        lines.push({
          x1: r3(tx),
          y1: r3(ty + sy * offset),
          x2: r3(tx),
          y2: r3(ty + sy * (offset + L)),
        });
      }
    }
  }
  const box = (x0: number, y0: number, x1: number, y1: number): PdfBox => [
    mmToPt(x0),
    mmToPt(y0),
    mmToPt(x1),
    mmToPt(y1),
  ];
  return {
    trim_mm: { width: W, height: H },
    bleed_mm: b,
    margin_mm: r3(margin),
    page_mm: { width: pw, height: ph },
    page_pt: { width: mmToPt(pw), height: mmToPt(ph) },
    bleed_box_mm: bleedBox,
    trim_box_mm: trimBox,
    boxes_pt: {
      media: box(0, 0, pw, ph),
      bleed: box(margin - b, margin - b, margin + W + b, margin + H + b),
      trim: box(margin, margin, margin + W, margin + H),
    },
    crop_marks: marks,
    crop_mark_lines_mm: lines,
  };
}

// ── PDF step ────────────────────────────────────────────────────────────────

/** The Chromium output could not be finalized (deterministic). */
export class PrintPdfFinalizeError extends Error {
  constructor(message: string) {
    super(`PDF_FINALIZE_FAILED: ${message}`);
    this.name = 'PrintPdfFinalizeError';
  }
}

const num = (n: number) => {
  const s = r4(n)
    .toFixed(4)
    .replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};
const boxText = (b: PdfBox) => `[${b.map(num).join(' ')}]`;

interface XrefEntry {
  offset: number;
  gen: number;
  used: boolean;
}

/** Parses the single classic xref section Chromium (Skia) writes. */
function readXref(s: string): {
  xrefAt: number;
  entries: XrefEntry[];
  trailer: string;
} {
  const tail = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(s);
  if (!tail) throw new PrintPdfFinalizeError('no startxref');
  const xrefAt = Number(tail[1]);
  const head = /^xref\r?\n(\d+) (\d+)\r?\n/.exec(s.slice(xrefAt, xrefAt + 64));
  if (!head || head[1] !== '0') {
    throw new PrintPdfFinalizeError('unsupported xref section');
  }
  const count = Number(head[2]);
  const body = s.slice(xrefAt + head[0].length);
  const re = /^(\d{10}) (\d{5}) ([nf])[ \r]?\n/;
  const entries: XrefEntry[] = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const m = re.exec(body.slice(pos, pos + 24));
    if (!m) throw new PrintPdfFinalizeError(`bad xref entry ${i}`);
    entries.push({
      offset: Number(m[1]),
      gen: Number(m[2]),
      used: m[3] === 'n',
    });
    pos += m[0].length;
  }
  const rest = body.slice(pos);
  const t = /^trailer\s*(<<[\s\S]*?>>)\s*startxref/.exec(rest);
  if (!t) throw new PrintPdfFinalizeError('more than one xref subsection');
  if (/\/Prev\b/.test(t[1])) {
    throw new PrintPdfFinalizeError('incremental PDFs are not supported');
  }
  return { xrefAt, entries, trailer: t[1] };
}

/** Every in-use xref entry points at its own `<id> <gen> obj`. */
function verifyXref(s: string): void {
  const { entries } = readXref(s);
  entries.forEach((e, id) => {
    if (e.used && id > 0 && !s.startsWith(`${id} ${e.gen} obj`, e.offset)) {
      throw new PrintPdfFinalizeError(`rebuilt xref is wrong at object ${id}`);
    }
  });
}

/** Text of an object from its offset to its stream / endobj keyword. */
function objectHead(s: string, offset: number): string {
  const end = s.indexOf('endobj', offset);
  const chunk = s.slice(offset, end < 0 ? offset + 4096 : end);
  const st = chunk.search(/>>\s*stream\r?\n/);
  return st < 0 ? chunk : chunk.slice(0, st + 2);
}

export interface FinalizedPdfInfo {
  /** Page size Chromium produced (pt), before the cut. */
  raw_page_pt: { width: number; height: number };
}

/**
 * Cuts the exact page out of Chromium's (padded) single-page PDF and writes
 * MediaBox / CropBox / BleedBox / TrimBox. Throws PrintPdfFinalizeError on
 * anything it does not recognise.
 */
export function finalizePrintPdf(
  pdf: Buffer,
  g: Pick<PrintPdfGeometry, 'page_pt' | 'boxes_pt'>,
): { pdf: Buffer; info: FinalizedPdfInfo } {
  const s = pdf.toString('latin1');
  if (!s.startsWith('%PDF-')) throw new PrintPdfFinalizeError('not a PDF');
  const { xrefAt, entries, trailer } = readXref(s);
  const pages: { id: number; offset: number; head: string }[] = [];
  entries.forEach((e, id) => {
    if (!e.used || id === 0) return;
    const head = objectHead(s, e.offset);
    if (!head.startsWith(`${id} ${e.gen} obj`)) {
      throw new PrintPdfFinalizeError(`object ${id} is not at its offset`);
    }
    if (/\/Type\s*\/Page(?![A-Za-z])/.test(head)) {
      pages.push({ id, offset: e.offset, head });
    }
  });
  if (pages.length !== 1) {
    throw new PrintPdfFinalizeError(`expected one page, got ${pages.length}`);
  }
  const page = pages[0];
  const media =
    /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/.exec(
      page.head,
    );
  const contents = /\/Contents\s+(\d+\s+\d+\s+R|\[[^\]]*\])/.exec(page.head);
  if (!media || !contents) {
    throw new PrintPdfFinalizeError('page without MediaBox / Contents');
  }
  // A rotated / user-unit page would need other boxes and another shift.
  if (/\/(Rotate\s+-?[1-9]|UserUnit)/.test(page.head)) {
    throw new PrintPdfFinalizeError('rotated or scaled page');
  }
  const [x0, y0, x1, y1] = media.slice(1, 5).map(Number);
  const rawW = x1 - x0;
  const rawH = y1 - y0;
  const { width: W, height: H } = g.page_pt;
  // The drawing is anchored top-left; a page smaller than wanted lost content.
  if (x0 !== 0 || y0 !== 0 || rawW + 0.01 < W || rawH + 0.01 < H) {
    throw new PrintPdfFinalizeError(
      `Chromium page ${num(rawW)}×${num(rawH)} pt is smaller than ${num(W)}×${num(H)} pt`,
    );
  }
  // Much larger than requested (pad + device rounding): Chromium did not use
  // the requested paper (e.g. fell back to Letter); the cut would be wrong.
  if (rawW - W > MAX_PAGE_SURPLUS_PT || rawH - H > MAX_PAGE_SURPLUS_PT) {
    throw new PrintPdfFinalizeError(
      `Chromium page ${num(rawW)}×${num(rawH)} pt is not the requested ${num(W)}×${num(H)} pt (+ pad)`,
    );
  }
  const newId = entries.length;
  const refs = contents[1].startsWith('[')
    ? contents[1].slice(1, -1).trim()
    : contents[1];
  // Edits on the original bytes, in increasing position.
  const edits: { at: number; len: number; text: string }[] = [
    {
      at: page.offset + media.index,
      len: media[0].length,
      text:
        `/MediaBox ${boxText(g.boxes_pt.media)}\n` +
        `/CropBox ${boxText(g.boxes_pt.media)}\n` +
        `/BleedBox ${boxText(g.boxes_pt.bleed)}\n` +
        `/TrimBox ${boxText(g.boxes_pt.trim)}`,
    },
    {
      at: page.offset + contents.index,
      len: contents[0].length,
      text: `/Contents [${newId} 0 R ${refs}]`,
    },
    // Boxes the page already has are dropped (no duplicate keys).
    ...[
      ...page.head.matchAll(
        /\/(CropBox|BleedBox|TrimBox|ArtBox)\s*\[[-\d.\s]*\]/g,
      ),
    ].map((m) => ({ at: page.offset + m.index, len: m[0].length, text: '' })),
  ].sort((a, b) => a.at - b.at);
  const shift = `1 0 0 1 0 ${num(-(rawH - H))} cm\n`;
  const newObj =
    `${newId} 0 obj\n<</Length ${shift.length}>> stream\n` +
    `${shift}endstream\nendobj\n`;
  const moved = (offset: number) =>
    offset +
    edits
      .filter((e) => e.at < offset)
      .reduce((sum, e) => sum + e.text.length - e.len, 0);
  let out = '';
  let pos = 0;
  for (const e of edits) {
    out += s.slice(pos, e.at) + e.text;
    pos = e.at + e.len;
  }
  out += s.slice(pos, xrefAt);
  const newObjAt = out.length;
  out += newObj;
  const xrefStart = out.length;
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  let xref = `xref\n0 ${newId + 1}\n`;
  for (const e of entries) {
    xref += e.used
      ? `${pad(moved(e.offset), 10)} ${pad(e.gen, 5)} n \n`
      : `${pad(e.offset, 10)} ${pad(e.gen, 5)} f \n`;
  }
  xref += `${pad(newObjAt, 10)} 00000 n \n`;
  const newTrailer = /\/Size\s+\d+/.test(trailer)
    ? trailer.replace(/\/Size\s+\d+/, `/Size ${newId + 1}`)
    : trailer.replace(/^<</, `<</Size ${newId + 1}\n`);
  out += `${xref}trailer\n${newTrailer}\nstartxref\n${xrefStart}\n%%EOF\n`;
  // Never hand back a file whose xref does not match its bytes.
  verifyXref(out);
  return {
    pdf: Buffer.from(out, 'latin1'),
    info: { raw_page_pt: { width: r4(rawW), height: r4(rawH) } },
  };
}

/** Page boxes of a PDF's first page (pt), for specs and diagnostics. */
export function readPdfBoxes(
  pdf: Buffer,
): Partial<Record<'MediaBox' | 'CropBox' | 'BleedBox' | 'TrimBox', PdfBox>> {
  const s = pdf.toString('latin1');
  const out: Partial<
    Record<'MediaBox' | 'CropBox' | 'BleedBox' | 'TrimBox', PdfBox>
  > = {};
  for (const name of ['MediaBox', 'CropBox', 'BleedBox', 'TrimBox'] as const) {
    const m = new RegExp(
      `/${name}\\s*\\[\\s*([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)\\s*\\]`,
    ).exec(s);
    if (m) out[name] = m.slice(1, 5).map(Number) as PdfBox;
  }
  return out;
}

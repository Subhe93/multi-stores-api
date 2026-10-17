/**
 * Glyph coverage of an uploaded font file (M4.2 launch fix, §6.4): which
 * code points the face can draw, read from its `cmap` table. Pure; the
 * fonts service parses each FONT asset once and caches the result.
 *
 * Why: the renderer draws customer text with the face the creator uploaded
 * (nothing else is loaded in the render page), and Chromium silently falls
 * back to a system font for code points the face lacks. The storefront
 * preview (same bytes, FontFace API) does the same, so a customer never
 * notices before the print. The save / cart validation therefore refuses a
 * text whose code points the face does not cover
 * (DESIGNER_STATE_INVALID, rule `chars`), except emoji / pictographs, which
 * the platform draws from the host's emoji fallback font on purpose
 * (fonts-noto-color-emoji, see .env.example).
 *
 * Formats: TrueType / OpenType (`cmap` formats 0, 4, 6, 12 of the Unicode
 * subtables) and WOFF2 (table directory + one Brotli stream; `cmap` is
 * never transformed, so it is located by summing the preceding tables'
 * lengths). Anything else returns null (unknown coverage: the caller skips
 * the check rather than failing closed, the file was already validated by
 * `detectFontFormat`).
 */
import { brotliDecompressSync } from 'zlib';

/** Sorted, non-overlapping inclusive ranges of covered code points. */
export class CodePointSet {
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];

  constructor(ranges: [number, number][]) {
    const sorted = ranges
      .filter(([a, b]) => b >= a)
      .sort((x, y) => x[0] - y[0]);
    for (const [a, b] of sorted) {
      const n = this.ends.length;
      if (n > 0 && a <= this.ends[n - 1] + 1) {
        this.ends[n - 1] = Math.max(this.ends[n - 1], b);
      } else {
        this.starts.push(a);
        this.ends.push(b);
      }
    }
  }

  get rangeCount(): number {
    return this.starts.length;
  }

  /** Number of covered code points. */
  get size(): number {
    let n = 0;
    for (let i = 0; i < this.starts.length; i++)
      n += this.ends[i] - this.starts[i] + 1;
    return n;
  }

  has(cp: number): boolean {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cp < this.starts[mid]) hi = mid - 1;
      else if (cp > this.ends[mid]) lo = mid + 1;
      else return true;
    }
    return false;
  }
}

interface TableRecord {
  tag: string;
  offset: number;
  length: number;
}

/** sfnt (ttf / otf) table directory. */
function sfntTables(buf: Buffer): TableRecord[] | null {
  if (buf.length < 12) return null;
  const numTables = buf.readUInt16BE(4);
  if (numTables < 1 || numTables > 128 || buf.length < 12 + numTables * 16)
    return null;
  const out: TableRecord[] = [];
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = buf.toString('latin1', rec, rec + 4);
    const offset = buf.readUInt32BE(rec + 8);
    const length = buf.readUInt32BE(rec + 12);
    if (offset + length > buf.length) return null;
    out.push({ tag, offset, length });
  }
  return out;
}

/** WOFF2 known table tags (the spec's 63-entry list, in order). */
const WOFF2_TAGS = [
  'cmap',
  'head',
  'hhea',
  'hmtx',
  'maxp',
  'name',
  'OS/2',
  'post',
  'cvt ',
  'fpgm',
  'glyf',
  'loca',
  'prep',
  'CFF ',
  'VORG',
  'EBDT',
  'EBLC',
  'gasp',
  'hdmx',
  'kern',
  'LTSH',
  'PCLT',
  'VDMX',
  'vhea',
  'vmtx',
  'BASE',
  'GDEF',
  'GPOS',
  'GSUB',
  'EBSC',
  'JSTF',
  'MATH',
  'CBDT',
  'CBLC',
  'COLR',
  'CPAL',
  'SVG ',
  'sbix',
  'acnt',
  'avar',
  'bdat',
  'bloc',
  'bsln',
  'cvar',
  'fdsc',
  'feat',
  'fmtx',
  'fvar',
  'gvar',
  'hsty',
  'just',
  'lcar',
  'mort',
  'morx',
  'opbd',
  'prop',
  'trak',
  'Zapf',
  'Silf',
  'Glat',
  'Gloc',
  'Feat',
  'Sill',
];

function readBase128(buf: Buffer, pos: { i: number }): number | null {
  let v = 0;
  for (let n = 0; n < 5; n++) {
    if (pos.i >= buf.length) return null;
    const b = buf[pos.i++];
    if (v > 0x1ffffff) return null; // would overflow 32 bits
    v = (v << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) return v >>> 0;
  }
  return null;
}

/**
 * Decompresses a WOFF2 file into its `cmap` table bytes (null when the
 * file is not WOFF2 or has no cmap).
 */
function woff2Cmap(buf: Buffer): Buffer | null {
  if (buf.length < 48 || buf.readUInt32BE(0) !== 0x774f4632) return null;
  const numTables = buf.readUInt16BE(12);
  const totalCompressed = buf.readUInt32BE(20);
  const pos = { i: 48 };
  const tables: { tag: string; len: number }[] = [];
  for (let t = 0; t < numTables; t++) {
    if (pos.i >= buf.length) return null;
    const flags = buf[pos.i++];
    let tag: string;
    if ((flags & 0x3f) === 63) {
      if (pos.i + 4 > buf.length) return null;
      tag = buf.toString('latin1', pos.i, pos.i + 4);
      pos.i += 4;
    } else {
      tag = WOFF2_TAGS[flags & 0x3f];
    }
    const origLength = readBase128(buf, pos);
    if (origLength === null) return null;
    const transform = (flags >> 6) & 3;
    // glyf / loca: transform 0 is the transformed form; other tables: a
    // non-zero transform means transformed. Transformed tables carry
    // transformLength.
    const transformed =
      tag === 'glyf' || tag === 'loca' ? transform === 0 : transform !== 0;
    let len = origLength;
    if (transformed) {
      const tl = readBase128(buf, pos);
      if (tl === null) return null;
      len = tl;
    }
    tables.push({ tag, len });
  }
  // Collection directory (TTC flavour) would follow; skip when present.
  const compressed = buf.subarray(pos.i, pos.i + totalCompressed);
  if (compressed.length !== totalCompressed) return null;
  let data: Buffer;
  try {
    data = brotliDecompressSync(compressed, {
      maxOutputLength: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  let offset = 0;
  for (const t of tables) {
    if (t.tag === 'cmap') {
      if (offset + t.len > data.length) return null;
      return data.subarray(offset, offset + t.len);
    }
    offset += t.len;
  }
  return null;
}

/** Parses one cmap subtable into ranges (glyph 0 = missing is honoured). */
function parseSubtable(
  cmap: Buffer,
  offset: number,
  ranges: [number, number][],
): void {
  if (offset + 4 > cmap.length) return;
  const format = cmap.readUInt16BE(offset);
  if (format === 0) {
    // Byte encoding table: 256 glyph ids.
    const base = offset + 6;
    if (base + 256 > cmap.length) return;
    for (let c = 0; c < 256; c++) if (cmap[base + c] !== 0) ranges.push([c, c]);
    return;
  }
  if (format === 4) {
    const segX2 = cmap.readUInt16BE(offset + 6);
    const segCount = segX2 >> 1;
    const endP = offset + 14;
    const startP = endP + segX2 + 2;
    const deltaP = startP + segX2;
    const rangeP = deltaP + segX2;
    if (rangeP + segX2 > cmap.length) return;
    for (let s = 0; s < segCount; s++) {
      const end = cmap.readUInt16BE(endP + s * 2);
      const start = cmap.readUInt16BE(startP + s * 2);
      const delta = cmap.readInt16BE(deltaP + s * 2);
      const rangeOffset = cmap.readUInt16BE(rangeP + s * 2);
      if (start > end || start === 0xffff) continue;
      if (rangeOffset === 0) {
        // glyph = (c + delta) & 0xffff; only glyph 0 is "missing".
        const zeroAt = (0x10000 - delta) & 0xffff;
        if (zeroAt >= start && zeroAt <= end) {
          if (zeroAt > start) ranges.push([start, zeroAt - 1]);
          if (zeroAt < end) ranges.push([zeroAt + 1, end]);
        } else ranges.push([start, end]);
        continue;
      }
      let runStart = -1;
      for (let c = start; c <= end; c++) {
        const gi = rangeP + s * 2 + rangeOffset + (c - start) * 2;
        let glyph = 0;
        if (gi + 2 <= cmap.length) {
          glyph = cmap.readUInt16BE(gi);
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph !== 0) {
          if (runStart < 0) runStart = c;
        } else if (runStart >= 0) {
          ranges.push([runStart, c - 1]);
          runStart = -1;
        }
      }
      if (runStart >= 0) ranges.push([runStart, end]);
    }
    return;
  }
  if (format === 6) {
    const first = cmap.readUInt16BE(offset + 6);
    const count = cmap.readUInt16BE(offset + 8);
    const base = offset + 10;
    if (base + count * 2 > cmap.length) return;
    for (let i = 0; i < count; i++) {
      if (cmap.readUInt16BE(base + i * 2) !== 0)
        ranges.push([first + i, first + i]);
    }
    return;
  }
  if (format === 12) {
    if (offset + 16 > cmap.length) return;
    const nGroups = cmap.readUInt32BE(offset + 12);
    const base = offset + 16;
    if (nGroups > 200_000 || base + nGroups * 12 > cmap.length) return;
    for (let g = 0; g < nGroups; g++) {
      const p = base + g * 12;
      const start = cmap.readUInt32BE(p);
      const end = cmap.readUInt32BE(p + 4);
      const glyph = cmap.readUInt32BE(p + 8);
      if (end < start || start > 0x10ffff) continue;
      if (glyph === 0) {
        // The first code point maps to .notdef; the rest of the group does not.
        if (end > start) ranges.push([start + 1, Math.min(end, 0x10ffff)]);
      } else ranges.push([start, Math.min(end, 0x10ffff)]);
    }
  }
}

/** The union of the Unicode subtables of a `cmap` table. */
function parseCmapTable(cmap: Buffer): CodePointSet | null {
  if (cmap.length < 4) return null;
  const n = cmap.readUInt16BE(2);
  if (n < 1 || n > 64 || 4 + n * 8 > cmap.length) return null;
  const ranges: [number, number][] = [];
  let unicodeTables = 0;
  for (let i = 0; i < n; i++) {
    const rec = 4 + i * 8;
    const platform = cmap.readUInt16BE(rec);
    const encoding = cmap.readUInt16BE(rec + 2);
    const offset = cmap.readUInt32BE(rec + 4);
    const unicode =
      platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode || offset >= cmap.length) continue;
    unicodeTables++;
    parseSubtable(cmap, offset, ranges);
  }
  if (unicodeTables === 0) return null;
  return new CodePointSet(ranges);
}

/**
 * Code points a font file can draw, or null when the file cannot be read
 * (not sfnt / woff2, no Unicode cmap). Never throws.
 */
export function fontCodePoints(buf: Buffer): CodePointSet | null {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    const tag = buf.readUInt32BE(0);
    if (tag === 0x774f4632) {
      const cmap = woff2Cmap(buf);
      return cmap ? parseCmapTable(cmap) : null;
    }
    if (tag === 0x00010000 || tag === 0x74727565 || tag === 0x4f54544f) {
      const tables = sfntTables(buf);
      const rec = tables?.find((t) => t.tag === 'cmap');
      if (!rec) return null;
      return parseCmapTable(buf.subarray(rec.offset, rec.offset + rec.length));
    }
    return null;
  } catch {
    return null;
  }
}

// Pictographs are drawn by the host's emoji fallback font (documented in
// .env.example), joiners / variation selectors shape them; neither has to
// be in the face. Built from code points: no invisible characters here.
const EXEMPT_RE = new RegExp(
  '^(?:\\u200d|\\ufe0e|\\ufe0f|\\p{Extended_Pictographic}|[\\u{1f3fb}-\\u{1f3ff}])$',
  'u',
);

/** Code points of `text` (NFC) the face does not cover; empty = all covered. */
export function uncoveredCodePoints(
  text: string,
  coverage: CodePointSet,
): number[] {
  const out: number[] = [];
  for (const ch of text.normalize('NFC')) {
    const cp = ch.codePointAt(0) as number;
    if (coverage.has(cp)) continue;
    if (EXEMPT_RE.test(ch)) continue;
    if (!out.includes(cp)) out.push(cp);
  }
  return out;
}

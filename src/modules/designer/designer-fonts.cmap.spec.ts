/*
 * Glyph coverage (M4.2 launch fix, §6.4): the cmap of an uploaded font
 * file decides which code points a text may use. Real fonts from
 * node_modules (@fontsource woff2, the playwright codicon ttf) plus a
 * synthetic sfnt with a format-4 subtable.
 */
import { readFileSync } from 'fs';
import * as path from 'path';
import {
  CodePointSet,
  fontCodePoints,
  uncoveredCodePoints,
} from './designer-fonts.cmap';

const fontsource = (pkg: string, file: string) =>
  readFileSync(
    path.join(
      path.dirname(require.resolve(`@fontsource/${pkg}/package.json`)),
      'files',
      file,
    ),
  );

/** sfnt with one cmap (3,1) format-4 subtable: A–Z, a–z and `extra`. */
function sfntWithCmap4(extra: number[] = []): Buffer {
  const segs: [number, number][] = (
    [
      [0x41, 0x5a],
      [0x61, 0x7a],
      ...extra.map((c): [number, number] => [c, c]),
      [0xffff, 0xffff],
    ] as [number, number][]
  ).sort((x, y) => x[0] - y[0]);
  const segX2 = segs.length * 2;
  const sub = Buffer.alloc(16 + segX2 * 4);
  sub.writeUInt16BE(4, 0);
  sub.writeUInt16BE(sub.length, 2);
  sub.writeUInt16BE(segX2, 6);
  segs.forEach(([s, e], i) => {
    sub.writeUInt16BE(e, 14 + i * 2);
    sub.writeUInt16BE(s, 16 + segX2 + i * 2);
    // glyph = c + delta: map the segment start to glyph 1.
    sub.writeUInt16BE(
      s === 0xffff ? 1 : (1 - s) & 0xffff,
      16 + segX2 * 2 + i * 2,
    );
    sub.writeUInt16BE(0, 16 + segX2 * 3 + i * 2);
  });
  const cmap = Buffer.alloc(12 + sub.length);
  cmap.writeUInt16BE(0, 0);
  cmap.writeUInt16BE(1, 2);
  cmap.writeUInt16BE(3, 4);
  cmap.writeUInt16BE(1, 6);
  cmap.writeUInt32BE(12, 8);
  sub.copy(cmap, 12);
  const tags = ['cmap', 'glyf', 'head', 'name'];
  const dir = 12 + tags.length * 16;
  const buf = Buffer.alloc(dir + cmap.length + 3 * 16);
  buf.writeUInt32BE(0x00010000, 0);
  buf.writeUInt16BE(tags.length, 4);
  tags.forEach((t, i) => {
    const rec = 12 + i * 16;
    buf.write(t, rec, 'latin1');
    const offset = i === 0 ? dir : dir + cmap.length + (i - 1) * 16;
    buf.writeUInt32BE(offset, rec + 8);
    buf.writeUInt32BE(i === 0 ? cmap.length : 16, rec + 12);
  });
  cmap.copy(buf, dir);
  return buf;
}

describe('CodePointSet', () => {
  it('merges overlapping / adjacent ranges and answers has() by binary search', () => {
    const s = new CodePointSet([
      [10, 20],
      [5, 12],
      [21, 25],
      [40, 40],
      [30, 29],
    ]);
    expect(s.rangeCount).toBe(2);
    expect(s.size).toBe(22);
    expect([4, 5, 25, 26, 39, 40, 41].map((c) => s.has(c))).toEqual([
      false,
      true,
      true,
      false,
      false,
      true,
      false,
    ]);
  });
});

describe('fontCodePoints', () => {
  it('reads a format-4 cmap of a TrueType file, honouring the .notdef mapping', () => {
    const set = fontCodePoints(sfntWithCmap4([0xc5]))!;
    expect(set).not.toBeNull();
    expect(['A', 'z', 'Å'].map((c) => set.has(c.codePointAt(0)!))).toEqual([
      true,
      true,
      true,
    ]);
    expect(['0', ' ', 'ä', 'س'].map((c) => set.has(c.codePointAt(0)!))).toEqual(
      [false, false, false, false],
    );
    expect(set.has(0xffff)).toBe(false);
  });

  it('WOFF2 (@fontsource Noto Sans latin): Latin and Latin-1 letters yes, Arabic no', () => {
    const latin = fontCodePoints(
      fontsource('noto-sans', 'noto-sans-latin-400-normal.woff2'),
    )!;
    expect(latin).not.toBeNull();
    for (const ch of 'Åsa Öberg-Ängström 2026 .,!?&/()') {
      expect([ch, latin.has(ch.codePointAt(0)!)]).toEqual([ch, true]);
    }
    expect(latin.has('س'.codePointAt(0)!)).toBe(false);
    expect(latin.has(0x2764)).toBe(false); // the heart is not in Noto Sans latin
    const arabic = fontCodePoints(
      fontsource(
        'noto-sans-arabic',
        'noto-sans-arabic-arabic-400-normal.woff2',
      ),
    )!;
    expect(arabic.has('س'.codePointAt(0)!)).toBe(true);
  });

  it('TrueType from node_modules (playwright codicon icon font) parses to its private-use range', () => {
    const file = path.join(
      path.dirname(require.resolve('playwright-core/package.json')),
      'lib/vite/recorder/assets/codicon-DCmgc-ay.ttf',
    );
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      return; // the asset moved with a playwright update: nothing to check
    }
    const set = fontCodePoints(bytes)!;
    expect(set).not.toBeNull();
    expect(set.size).toBeGreaterThan(100);
    expect(set.has('A'.codePointAt(0)!)).toBe(false);
  });

  it('returns null for junk, a font without a Unicode cmap, and a truncated WOFF2', () => {
    expect(fontCodePoints(Buffer.from('not a font at all'))).toBeNull();
    const noCmap = sfntWithCmap4();
    noCmap.write('xxxx', 12, 'latin1');
    expect(fontCodePoints(noCmap)).toBeNull();
    const woff2 = fontsource('noto-sans', 'noto-sans-latin-400-normal.woff2');
    expect(fontCodePoints(woff2.subarray(0, 200))).toBeNull();
  });
});

describe('uncoveredCodePoints', () => {
  const latin = fontCodePoints(
    fontsource('noto-sans', 'noto-sans-latin-400-normal.woff2'),
  )!;

  it('lists the code points the face lacks, once each, after NFC', () => {
    expect(uncoveredCodePoints('Åsa Öberg', latin)).toEqual([]);
    // Decomposed Å (A + combining ring) normalizes to the covered U+00C5.
    expect(uncoveredCodePoints('Ås', latin)).toEqual([]);
    expect(uncoveredCodePoints('Sara سارة', latin)).toEqual(
      [...'سارة']
        .map((c) => c.codePointAt(0)!)
        .filter((c, i, a) => a.indexOf(c) === i),
    );
  });

  it('exempts emoji / pictographs, variation selectors, ZWJ and skin tones (host emoji font)', () => {
    expect(uncoveredCodePoints('Anna ❤️', latin)).toEqual([]);
    expect(
      uncoveredCodePoints('\u{1f44d}\u{1f3fd} \u{1f468}‍\u{1f4bb}', latin),
    ).toEqual([]);
    // A non-pictographic symbol the face lacks is still reported.
    expect(uncoveredCodePoints('∈', latin)).toEqual([0x2208]);
  });
});

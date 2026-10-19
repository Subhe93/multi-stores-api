import {
  CROP_MARK_LENGTH_MM,
  CROP_MARK_OFFSET_MM,
  finalizePrintPdf,
  MM_TO_PT,
  mmToPt,
  printPdfGeometry,
  PrintPdfFinalizeError,
  readPdfBoxes,
  specBleedMm,
} from './print-pdf';

/** A minimal single-page PDF laid out like Skia's (classic xref). */
function skiaLikePdf(pageW: number, pageH: number, extraPages = 0): Buffer {
  const objs: string[] = [];
  const content = `.24 0 0 -.24 0 ${pageH} cm\n0 0 1 rg\n0 0 100 100 re\nf\n`;
  objs[1] = '<</Producer (Skia/PDF m155)>>';
  objs[3] = `<</Length ${content.length}>> stream\n${content}endstream`;
  const kids = ['2 0 R'];
  objs[2] = `<</Type /Page\n/MediaBox [0 0 ${pageW} ${pageH}]\n/Contents 3 0 R\n/Parent 4 0 R>>`;
  for (let i = 0; i < extraPages; i++) {
    const id = 6 + i;
    objs[id] =
      `<</Type /Page\n/MediaBox [0 0 ${pageW} ${pageH}]\n/Contents 3 0 R\n/Parent 4 0 R>>`;
    kids.push(`${id} 0 R`);
  }
  objs[4] = `<</Type /Pages\n/Count ${kids.length}\n/Kids [${kids.join(' ')}]>>`;
  objs[5] = '<</Type /Catalog\n/Pages 4 0 R>>';
  let out = '%PDF-1.4\n%\xd3\xeb\xe9\xe1\n';
  const offsets: number[] = [];
  for (let id = 1; id < objs.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
  }
  const xrefAt = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objs.length; id++) {
    out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<</Size ${objs.length}\n/Root 5 0 R\n/Info 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

/** Rebuilds the xref of a hand-edited skiaLikePdf (objects found by text). */
function fixXref(pdf: Buffer): Buffer {
  let s = pdf.toString('latin1');
  const at = s.lastIndexOf('\nxref\n') + 1;
  const n = Number(/^xref\n0 (\d+)\n/.exec(s.slice(at))![1]);
  const trailer = s.slice(s.indexOf('trailer', at), s.indexOf('startxref', at));
  s = s.slice(0, at);
  let xref = `xref\n0 ${n}\n0000000000 65535 f \n`;
  for (let id = 1; id < n; id++) {
    const off = s.indexOf(`\n${id} 0 obj`) + 1;
    xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  return Buffer.from(`${s}${xref}${trailer}startxref\n${at}\n%%EOF`, 'latin1');
}

/** Checks every xref offset of a classic-xref PDF points at its object. */
function xrefConsistent(pdf: Buffer): boolean {
  const s = pdf.toString('latin1');
  const at = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(s)![1]);
  const head = /^xref\n0 (\d+)\n/.exec(s.slice(at))!;
  const n = Number(head[1]);
  const lines = s
    .slice(at + head[0].length)
    .split('\n')
    .slice(0, n);
  return lines.every((l, id) => {
    const [off, , kind] = l.trim().split(' ');
    return kind === 'f' || s.startsWith(`${id} 0 obj`, Number(off));
  });
}

describe('print PDF geometry', () => {
  it('page = trim + 2 × bleed (500×700 + 3 mm → 506×706 mm)', () => {
    const g = printPdfGeometry({ width: 500, height: 700, bleed_mm: 3 });
    expect(g.page_mm).toEqual({ width: 506, height: 706 });
    expect(g.trim_mm).toEqual({ width: 500, height: 700 });
    expect(g.margin_mm).toBe(3);
    expect(g.bleed_box_mm).toEqual({ x: 0, y: 0, width: 506, height: 706 });
    expect(g.trim_box_mm).toEqual({ x: 3, y: 3, width: 500, height: 700 });
    expect(g.page_pt.width).toBeCloseTo((506 * 72) / 25.4, 3);
    expect(g.page_pt.height).toBeCloseTo((706 * 72) / 25.4, 3);
    expect(g.boxes_pt.media).toEqual([0, 0, mmToPt(506), mmToPt(706)]);
    expect(g.boxes_pt.bleed).toEqual(g.boxes_pt.media);
    expect(g.boxes_pt.trim).toEqual([
      mmToPt(3),
      mmToPt(3),
      mmToPt(503),
      mmToPt(703),
    ]);
    expect(g.crop_marks).toBe(false);
    expect(g.crop_mark_lines_mm).toEqual([]);
  });

  it('bleed 0: the page is the trim size', () => {
    const g = printPdfGeometry({ width: 500, height: 700, bleed_mm: 0 });
    expect(g.page_mm).toEqual({ width: 500, height: 700 });
    expect(g.boxes_pt.trim).toEqual(g.boxes_pt.media);
    expect(printPdfGeometry({ width: 100, height: 50 }).page_mm).toEqual({
      width: 100,
      height: 50,
    });
  });

  it('clamps odd bleeds (negative / NaN → 0, > 50 → 50)', () => {
    expect(specBleedMm({ bleed_mm: -2 })).toBe(0);
    expect(specBleedMm({ bleed_mm: 'x' })).toBe(0);
    expect(specBleedMm({ bleed_mm: 80 })).toBe(50);
    expect(specBleedMm({ bleed_mm: 2.5 })).toBe(2.5);
    expect(
      printPdfGeometry({ width: 10, height: 10, bleed_mm: 2.5 }).page_mm,
    ).toEqual({ width: 15, height: 15 });
  });

  it('rejects a non-positive trim', () => {
    expect(() => printPdfGeometry({ width: 0, height: 10 })).toThrow();
  });

  it('crop marks add a slug outside the bleed and 8 marks', () => {
    const g = printPdfGeometry(
      { width: 500, height: 700, bleed_mm: 3 },
      { cropMarks: true },
    );
    const margin = Math.max(3, CROP_MARK_OFFSET_MM) + CROP_MARK_LENGTH_MM;
    expect(g.margin_mm).toBe(margin);
    expect(g.page_mm).toEqual({
      width: 500 + 2 * margin,
      height: 700 + 2 * margin,
    });
    expect(g.bleed_box_mm).toEqual({
      x: margin - 3,
      y: margin - 3,
      width: 506,
      height: 706,
    });
    expect(g.crop_mark_lines_mm).toHaveLength(8);
    // Every mark lies outside the bleed box and on a trim line.
    const bb = g.bleed_box_mm;
    for (const l of g.crop_mark_lines_mm) {
      const outside = (x: number, y: number) =>
        x <= bb.x + 1e-9 ||
        x >= bb.x + bb.width - 1e-9 ||
        y <= bb.y + 1e-9 ||
        y >= bb.y + bb.height - 1e-9;
      expect(outside(l.x1, l.y1) && outside(l.x2, l.y2)).toBe(true);
      const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
      expect(len).toBeCloseTo(CROP_MARK_LENGTH_MM, 6);
      const onTrimX = [margin, margin + 500].includes(l.x1) && l.x1 === l.x2;
      const onTrimY = [margin, margin + 700].includes(l.y1) && l.y1 === l.y2;
      expect(onTrimX || onTrimY).toBe(true);
    }
    // A bleed wider than the offset pushes the marks out with it.
    const wide = printPdfGeometry(
      { width: 100, height: 100, bleed_mm: 10 },
      { cropMarks: true },
    );
    expect(wide.margin_mm).toBe(10 + CROP_MARK_LENGTH_MM);
  });
});

describe('finalizePrintPdf', () => {
  const g = printPdfGeometry({ width: 100, height: 50, bleed_mm: 3 });
  // Chromium's rounded-up page (larger than wanted).
  const rawW = 300.96;
  const rawH = 161.28;

  it('writes the exact boxes, shifts the drawing up and keeps the xref valid', () => {
    const { pdf, info } = finalizePrintPdf(skiaLikePdf(rawW, rawH), g);
    expect(info.raw_page_pt).toEqual({ width: rawW, height: rawH });
    const boxes = readPdfBoxes(pdf);
    expect(boxes.MediaBox).toEqual([0, 0, mmToPt(106), mmToPt(56)]);
    expect(boxes.CropBox).toEqual(boxes.MediaBox);
    expect(boxes.BleedBox).toEqual(boxes.MediaBox);
    expect(boxes.TrimBox).toEqual([
      mmToPt(3),
      mmToPt(3),
      mmToPt(103),
      mmToPt(53),
    ]);
    // MediaBox size in points = (trim + 2 bleed) mm.
    expect(boxes.MediaBox![2]).toBeCloseTo(106 * MM_TO_PT, 3);
    expect(boxes.MediaBox![3]).toBeCloseTo(56 * MM_TO_PT, 3);
    const s = pdf.toString('latin1');
    expect(s).toMatch(/\/Contents \[6 0 R 3 0 R\]/);
    const shift = (rawH - mmToPt(56)).toFixed(4).replace(/\.?0+$/, '');
    expect(s).toContain(`1 0 0 1 0 -${shift} cm`);
    expect(s).toMatch(/trailer\n<<\/Size 7\n/);
    expect(xrefConsistent(pdf)).toBe(true);
    // The PDF step is idempotent on its own output's structure.
    expect(() => finalizePrintPdf(pdf, g)).not.toThrow();
  });

  it('refuses a page smaller than wanted, several pages or a non-PDF', () => {
    expect(() => finalizePrintPdf(skiaLikePdf(200, 100), g)).toThrow(
      PrintPdfFinalizeError,
    );
    expect(() => finalizePrintPdf(skiaLikePdf(rawW, rawH, 1), g)).toThrow(
      /expected one page, got 2/,
    );
    expect(() => finalizePrintPdf(Buffer.from('hello'), g)).toThrow(
      /PDF_FINALIZE_FAILED/,
    );
  });

  it('refuses a page far larger than requested (paper size ignored, e.g. Letter)', () => {
    expect(() => finalizePrintPdf(skiaLikePdf(612, 792), g)).toThrow(
      /not the requested/,
    );
  });

  it('refuses rotated pages and compressed (stream) xrefs', () => {
    const rotated = Buffer.from(
      skiaLikePdf(rawW, rawH)
        .toString('latin1')
        .replace('/Contents 3 0 R\n', '/Contents 3 0 R /Rotate 90\n'),
      'latin1',
    );
    expect(() => finalizePrintPdf(fixXref(rotated), g)).toThrow(
      /rotated or scaled page/,
    );
    const s = skiaLikePdf(rawW, rawH).toString('latin1');
    const xrefStream = s.replace(/xref\n[\s\S]*?trailer\n/, 'xxxx\n');
    expect(() =>
      finalizePrintPdf(Buffer.from(xrefStream, 'latin1'), g),
    ).toThrow(/unsupported xref section/);
  });

  it('keeps several content streams and replaces boxes the page already has', () => {
    const src = skiaLikePdf(rawW, rawH)
      .toString('latin1')
      .replace(
        '/Contents 3 0 R\n',
        '/Contents [3 0 R 3 0 R]\n/CropBox [0 0 10 10]\n/TrimBox [1 1 9 9]\n',
      );
    const { pdf } = finalizePrintPdf(fixXref(Buffer.from(src, 'latin1')), g);
    const s = pdf.toString('latin1');
    expect(s).toMatch(/\/Contents \[6 0 R 3 0 R 3 0 R\]/);
    expect(s.match(/\/CropBox/g)).toHaveLength(1);
    expect(s.match(/\/TrimBox/g)).toHaveLength(1);
    expect(readPdfBoxes(pdf).TrimBox).toEqual([
      mmToPt(3),
      mmToPt(3),
      mmToPt(103),
      mmToPt(53),
    ]);
    expect(xrefConsistent(pdf)).toBe(true);
    // The new content stream's /Length is its exact byte count.
    const obj = /6 0 obj\n<<\/Length (\d+)>> stream\n([\s\S]*?)endstream/.exec(
      s,
    )!;
    expect(Number(obj[1])).toBe(Buffer.byteLength(obj[2], 'latin1'));
  });
});

/*
 * Renderer golden tests (M4.2 WP11, §12.3 G3/G4 on the pure renderer).
 *
 * For each of the 10 converted NPP templates (`npp/__fixtures__/expected/`)
 * and each deterministic state (Swedish å/ä/ö, long names with ❤️ + VS16 that
 * drive the shrink loop down to the minimum, a photo with pan/zoom/rotate,
 * defaults with an empty slot), the full draw-call log of a recording Ctx2D
 * is compared with `__fixtures__/golden/renderer/<template>.json` at web
 * scale (proof/edit, 2 px/mm) and print scale (6 px/mm).
 *
 * UPDATE_GOLDEN=1 rewrites the goldens (review the diff; a change in the
 * drawn output needs a RENDERER_VERSION bump).
 *
 * Also covers the text-fit edge cases: the inclusive `w*6-8` threshold, the
 * 6 minimum, exact 0.5 steps, NPP parity of the shrink loop, the fixed
 * reference scale (D5) and the `direction` field (RTL).
 */
import {
  canvasSize,
  fitTextSize,
  fontString,
  renderDesign,
  RENDERER_VERSION,
  type DesignStateV1,
  type RenderInput,
  type TemplateSpecV1,
  type TextElement,
} from './design-renderer';
import {
  caseInput,
  compactLog,
  fakeImage,
  fakeMeasure,
  fontPx,
  GOLDEN_CASES,
  golden,
  HEART,
  loadTemplate,
  recordCase,
  RecordingCtx,
  TEMPLATE_IDS,
  type GoldenRecord,
  type LogEntry,
} from '../__fixtures__/golden/golden-kit.mockspec';

interface TemplateGolden {
  template: string;
  renderer_version: string;
  cases: Record<
    string,
    GoldenRecord & {
      input: Pick<RenderInput, 'state' | 'mode' | 'scale' | 'locale'> & {
        ui?: RenderInput['ui'];
      };
    }
  >;
}

function buildTemplateGolden(stem: string): TemplateGolden {
  const spec = loadTemplate(stem);
  const cases: TemplateGolden['cases'] = {};
  for (const c of GOLDEN_CASES) {
    const input = caseInput(spec, c);
    cases[c.key] = {
      input: {
        state: input.state,
        mode: input.mode,
        scale: input.scale,
        locale: input.locale,
        ui: input.ui,
      },
      ...recordCase(renderDesign, canvasSize, spec, c),
    };
  }
  return { template: stem, renderer_version: RENDERER_VERSION, cases };
}

describe('design-renderer golden draw logs (10 NPP templates)', () => {
  it('covers all 10 converted templates', () => {
    expect(TEMPLATE_IDS).toHaveLength(10);
  });

  describe.each(TEMPLATE_IDS)('%s', (stem) => {
    const actual = buildTemplateGolden(stem);
    const expected = golden<TemplateGolden>(
      `renderer/${stem}.json`,
      JSON.parse(JSON.stringify(actual)) as TemplateGolden,
    );

    it('golden was produced by the current RENDERER_VERSION', () => {
      expect(expected.renderer_version).toBe(RENDERER_VERSION);
    });

    it.each(GOLDEN_CASES.map((c) => c.key))(
      '%s matches the golden log',
      (key) => {
        const a = JSON.parse(JSON.stringify(actual.cases[key])) as unknown;
        // Compact log first: it gives a readable diff on failure.
        expect((a as GoldenRecord).log).toEqual(expected.cases[key].log);
        expect(a).toEqual(expected.cases[key]);
      },
    );

    it('canvas is 1000×1400 at web scale and 3000×4200 at print scale', () => {
      for (const c of GOLDEN_CASES) {
        expect(actual.cases[c.key].canvas).toEqual(
          c.scale === 6
            ? { width: 3000, height: 4200 }
            : { width: 1000, height: 1400 },
        );
      }
    });

    it('nothing is missing and every text is fitted', () => {
      const spec = loadTemplate(stem);
      const textIds = spec.surfaces[0].elements
        .filter((e) => e.type === 'text')
        .map((e) => e.id)
        .sort();
      for (const c of GOLDEN_CASES) {
        const rep = actual.cases[c.key].report;
        expect(rep.missing).toEqual([]);
        expect(Object.keys(rep.fitted).sort()).toEqual(textIds);
      }
    });

    it('G4: fitted sizes are identical at web (2) and print (6) scale', () => {
      for (const state of ['sv', 'long', 'defaults']) {
        const proof = actual.cases[`${state}@proof:2`].report.fitted;
        expect(actual.cases[`${state}@print:6`].report.fitted).toEqual(proof);
      }
      expect(actual.cases['sv@edit:2'].report.fitted).toEqual(
        actual.cases['sv@proof:2'].report.fitted,
      );
    });

    it('print draws the print background, proof/edit the web one', () => {
      const firstImage = (key: string) =>
        actual.cases[key].log.find((e) => e[0] === 'drawImage')?.[1];
      expect(firstImage('sv@print:6')).toBe('pending:bg_print');
      expect(firstImage('sv@proof:2')).toBe('pending:bg_web');
      expect(firstImage('sv@edit:2')).toBe('pending:bg_web');
    });

    it('rendering is deterministic (same log hash twice)', () => {
      const again = buildTemplateGolden(stem);
      for (const c of GOLDEN_CASES) {
        expect(again.cases[c.key].sha256).toBe(actual.cases[c.key].sha256);
      }
    });
  });

  it('the long state drives at least one text to the 6 minimum', () => {
    const hits = TEMPLATE_IDS.filter((stem) =>
      Object.values(
        buildTemplateGolden(stem).cases['long@print:6'].report.fitted,
      ).includes(6),
    );
    expect(hits.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Text fit edge cases                                                 */
/* ------------------------------------------------------------------ */

/** NPP 1.9.1 fitTextSize, vendored verbatim from admin/js/order-viewer.js:76-83. */
/* eslint-disable */
function nppFitTextSize(ctx: any, text: string, el: any, sf: number): number {
  var maxW = el.w * sf - 8,
    sz = el.fontSize || 28;
  for (var s = sz; s >= 6; s -= 0.5) {
    ctx.font =
      (el.fontWeight || 400) +
      ' ' +
      s * sf +
      'px "' +
      (el.fontFamily || 'Montserrat') +
      '"';
    if (ctx.measureText(text).width <= maxW) return s;
  }
  return 6;
}
/* eslint-enable */

const namn = (): { spec: TemplateSpecV1; el: TextElement } => {
  const spec = loadTemplate('template_4273');
  const el = spec.surfaces[0].elements.find(
    (e) => e.type === 'text' && e.label.sv === 'Namn',
  ) as TextElement;
  return { spec, el };
};

/** Fonts set while fitting one text (in order) and the measured widths. */
function scan(
  log: LogEntry[],
  text: string,
): { fonts: string[]; widths: number[] } {
  const fonts: string[] = [];
  const widths: number[] = [];
  for (let i = 0; i + 1 < log.length; i++) {
    if (
      log[i][0] === '=font' &&
      log[i + 1][0] === 'measureText' &&
      log[i + 1][1] === text
    ) {
      fonts.push(log[i][1] as string);
      widths.push(log[i + 1][2] as number);
    }
  }
  return { fonts, widths };
}

const textState = (id: string, v: string): DesignStateV1 => ({
  v: 1,
  texts: { [id]: v },
  photos: {},
});

function renderText(
  spec: TemplateSpecV1,
  state: DesignStateV1,
  scale: number,
  measure: (text: string, font: string) => number,
) {
  const ctx = new RecordingCtx(measure);
  const report = renderDesign(ctx, {
    spec,
    state,
    mode: 'print',
    scale,
    locale: 'sv',
    images: { get: (id: string) => fakeImage(id) },
  });
  return { ctx, report };
}

describe('text fit edge cases (golden)', () => {
  // 4273 Namn: w 300 mm, size 73 → maxW = 300*6 - 8 = 1792 px at the ref scale.
  const LIMIT = 300 * 6 - 8;

  it('threshold is inclusive: width exactly w*6-8 fits', () => {
    const { spec, el } = namn();
    // 40 mm at ref 6 = 240 px measures exactly the limit; anything larger overflows.
    const measure = (_t: string, font: string) => {
      const px = fontPx(font);
      return px === 240 ? LIMIT : px > 240 ? LIMIT + (px - 240) : LIMIT - 1;
    };
    for (const scale of [2, 6]) {
      const { ctx, report } = renderText(
        spec,
        textState(el.id, 'Åsa'),
        scale,
        measure,
      );
      expect(report.fitted[el.id]).toBe(40);
      const s = scan(ctx.log, 'Åsa');
      expect(s.fonts[s.fonts.length - 1]).toBe('600 240px "Montserrat"');
      expect(s.widths[s.widths.length - 1]).toBe(LIMIT);
      // Drawn at the output scale.
      const fill = ctx.log.findIndex((e) => e[0] === 'fillText');
      const lastFont = ctx.log
        .slice(0, fill)
        .filter((e) => e[0] === '=font')
        .pop();
      expect(lastFont).toEqual(['=font', `600 ${40 * scale}px "Montserrat"`]);
    }
  });

  it('one ulp over the threshold steps down another 0.5', () => {
    const { spec, el } = namn();
    const measure = (_t: string, font: string) => {
      const px = fontPx(font);
      return px === 240 ? LIMIT + 1e-9 : px > 240 ? LIMIT + px : LIMIT - 1;
    };
    const { report } = renderText(spec, textState(el.id, 'x'), 6, measure);
    expect(report.fitted[el.id]).toBe(39.5);
  });

  it('the minimum is 6: scans 73 → 6 in exact 0.5 steps, never below', () => {
    const { spec, el } = namn();
    const long = 'Å'.repeat(400) + HEART;
    const { ctx, report } = renderText(
      spec,
      textState(el.id, long),
      2,
      fakeMeasure,
    );
    expect(report.fitted[el.id]).toBe(6);
    const s = scan(ctx.log, long);
    const sizes = Array.from({ length: (73 - 6) / 0.5 + 1 }, (_, i) =>
      fontString(el.font, 73 - i * 0.5, 6),
    );
    expect(s.fonts).toEqual(sizes);
    expect(s.fonts[s.fonts.length - 1]).toBe('600 36px "Montserrat"');
    // Every width overflowed (so min is returned, not a fitted size).
    expect(s.widths.every((w) => w > LIMIT)).toBe(true);
    const fill = ctx.log.find((e) => e[0] === 'fillText' && e[1] === long);
    expect(fill).toBeDefined();
    const draw = ctx.log
      .slice(0, ctx.log.indexOf(fill!))
      .filter((e) => e[0] === '=font')
      .pop();
    expect(draw).toEqual(['=font', '600 12px "Montserrat"']);
  });

  it('fractional start sizes step without drift (size - i*step)', () => {
    const { el } = namn();
    const fake = { ...el, size: 7.3 };
    const ctx = new RecordingCtx(() => Number.MAX_VALUE);
    const fs = (s: number, k: number) => fontString(fake.font, s, k);
    expect(fitTextSize(ctx, 'x', fake, fs, 6)).toBe(6);
    expect(compactLog(ctx.log)).toEqual([
      ['fitScan', 'x', fs(7.3, 6), fs(7.3 - 2 * 0.5, 6), 3, Number.MAX_VALUE],
    ]);
  });

  it('matches NPP fitTextSize (order-viewer.js:76-83) on every template text × sample texts at sf 6', () => {
    const samples = [
      'Namn',
      'Åsa Öberg-Ängström',
      'NA3b',
      'Maximiliana Charlotta Åkesson-Lindqvist ' + HEART,
      'Teknikprogrammet ' + HEART + ' Göteborg 2026',
      'Å'.repeat(120),
      '',
    ];
    let compared = 0;
    for (const stem of TEMPLATE_IDS) {
      const spec = loadTemplate(stem);
      for (const el of spec.surfaces[0].elements) {
        if (el.type !== 'text') continue;
        for (const text of samples) {
          const ours = new RecordingCtx();
          const npp = new RecordingCtx();
          const a = fitTextSize(
            ours,
            text,
            el,
            (s, k) => fontString(el.font, s, k),
            6,
          );
          const b = nppFitTextSize(
            npp,
            text,
            {
              w: el.w,
              fontSize: el.size,
              fontWeight: el.font.weight,
              fontFamily: el.font.family,
            },
            6,
          );
          expect(a).toBe(b);
          expect(ours.log).toEqual(npp.log);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThanOrEqual(20 * samples.length);
  });

  it('D5: the 8 px pad is applied at the ref scale, so web and print agree where NPP did not', () => {
    const { spec, el } = namn();
    // Pick a text whose NPP preview (sf 2: maxW 592) and print (sf 6: 1792) differ.
    const text = 'Åsa Öberg-Ängström';
    const nppPreview = nppFitTextSize(
      new RecordingCtx(),
      text,
      { w: el.w, fontSize: el.size, fontWeight: 600, fontFamily: 'Montserrat' },
      2,
    );
    const nppPrint = nppFitTextSize(
      new RecordingCtx(),
      text,
      { w: el.w, fontSize: el.size, fontWeight: 600, fontFamily: 'Montserrat' },
      6,
    );
    const web = renderText(spec, textState(el.id, text), 2, fakeMeasure);
    const print = renderText(spec, textState(el.id, text), 6, fakeMeasure);
    expect(web.report.fitted[el.id]).toBe(nppPrint);
    expect(print.report.fitted[el.id]).toBe(nppPrint);
    expect(nppPreview).not.toBe(nppPrint);
    // Documented NPP inconsistency (golden of the numbers involved).
    expect({ nppPreview, nppPrint }).toEqual(
      golden('text-fit/d5-npp-preview-vs-print.json', {
        nppPreview,
        nppPrint,
      }),
    );
  });

  describe('direction (RTL)', () => {
    const rtlSpec = (
      direction: TextElement['direction'],
      align: TextElement['align'],
    ) => {
      const { spec, el } = namn();
      const copy = JSON.parse(JSON.stringify(spec)) as TemplateSpecV1;
      copy.surfaces[0].elements = [
        { ...el, direction, align, font: { ...el.font } },
      ];
      return { spec: copy, el: copy.surfaces[0].elements[0] as TextElement };
    };
    const arabic = 'سارة العلي';

    it.each([
      ['rtl', 'rtl'],
      ['ltr', 'ltr'],
      ['auto', 'inherit'],
    ] as const)('direction %s sets ctx.direction = %s before fillText', (dir, want) => {
      const { spec, el } = rtlSpec(dir, 'center');
      const { ctx } = renderText(spec, textState(el.id, arabic), 6, fakeMeasure);
      const fill = ctx.log.findIndex((e) => e[0] === 'fillText');
      const lastDir = ctx.log
        .slice(0, fill)
        .filter((e) => e[0] === '=direction')
        .pop();
      expect(lastDir).toEqual(['=direction', want]);
      expect(ctx.log[fill]).toEqual(['fillText', arabic, 240 * 6, 66 * 6]);
    });

    it.each([
      ['left', (90 + 4) * 6],
      ['right', (90 + 300 - 4) * 6],
      ['center', 240 * 6],
    ] as const)('RTL %s alignment anchors at the physical edge (x = %d)', (align, x) => {
      const { spec, el } = rtlSpec('rtl', align);
      const { ctx, report } = renderText(
        spec,
        textState(el.id, arabic),
        6,
        fakeMeasure,
      );
      const fill = ctx.log.find((e) => e[0] === 'fillText');
      expect(fill).toEqual(['fillText', arabic, x, 66 * 6]);
      expect(ctx.log).toContainEqual(['=textAlign', align]);
      // Fit is measured on the RTL string as-is: 9 × 0.5 em + one 0.28 em space
      // = 4.78 em; 62 × 6 × 4.78 = 1778.16 <= 1792 < 62.5 × 6 × 4.78.
      expect(report.fitted[el.id]).toBe(62);
    });
  });
});

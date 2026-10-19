/*
 * NPP → TemplateSpecV1 converter against the real namez.se data (M4.2 §12.2).
 * Fixtures in __fixtures__ are read-only copies of the scratchpad export
 * (25 nppProduct pages, template_4410 REST shape, templates list) with nonce
 * fields stripped, plus the raw `_npp_*` postmeta in the importer NTemplate shape.
 * Converted specs are compared against committed JSON in __fixtures__/expected/
 * (missing files are written on the first run; UPDATE_NPP_EXPECTED=1 rewrites them).
 */
import * as fs from 'fs';
import * as path from 'path';
import type {
  ImageElement,
  ImageSlotElement,
  TextElement,
} from '@multi-stores/core/designer';
import {
  compileDesignAllowedChars,
  sortElements,
} from '@multi-stores/core/designer';
import {
  convertNpp,
  IMPORTED_ALLOWED_CHARS,
  finalizeTemplateAssets,
  nearestWeight,
  NppConversionResult,
  NppConvertedTemplate,
  stripScaled,
} from './npp-converter';

const FIX = path.join(__dirname, '__fixtures__');
/** NPP REST template fixture shape (only what the tests mutate). */
interface RestFixture {
  elements: Record<string, unknown>[];
  size_mode: string;
}
const read = <T = Record<string, unknown>>(f: string): T =>
  JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8')) as T;
const productFiles = fs
  .readdirSync(FIX)
  .filter((f) => /^se_\d+\.json$/.test(f))
  .sort();
const ALL_INPUT = [
  ...productFiles.map(read),
  read('template_4410.json'),
  read('templates.json'),
];
const HOST = 'namez.se';
const LINKED = [
  '4273',
  '4281',
  '4308',
  '4315',
  '4350',
  '4355',
  '4359',
  '4364',
  '4368',
];

const result = convertNpp(ALL_INPUT, { siteHost: HOST });
const tpl = (r: NppConversionResult, id: string): NppConvertedTemplate => {
  const t = r.templates.find((x) => x.source_id === id);
  if (!t) throw new Error('template ' + id + ' not converted');
  return t;
};
const T = (id: string) => tpl(result, id);
const els = (t: NppConvertedTemplate) => t.spec.surfaces[0].elements;
const texts = (t: NppConvertedTemplate) =>
  els(t).filter((e): e is TextElement => e.type === 'text');
const slots = (t: NppConvertedTemplate) =>
  els(t).filter((e): e is ImageSlotElement => e.type === 'image_slot');
const images = (t: NppConvertedTemplate) =>
  els(t).filter((e): e is ImageElement => e.type === 'image');
const codes = (t: NppConvertedTemplate) => t.warnings.map((w) => w.code);
const byLabel = (t: NppConvertedTemplate, label: string) =>
  texts(t).find((e) => e.label.sv === label)!;
const fetchOf = (t: NppConvertedTemplate, key: string) =>
  t.fetch.find((f) => f.key === key)!;
const fontPairs = (t: NppConvertedTemplate) =>
  t.spec.fonts.map((f) => `${f.family} ${f.weight}`);

describe('npp-converter', () => {
  describe('imported allowed_chars', () => {
    it('compiles as data and accepts Latin / Latin-1 / Latin Ext-A names, digits, punctuation and the heart', () => {
      const re = compileDesignAllowedChars(IMPORTED_ALLOWED_CHARS)!;
      expect(re).not.toBeNull();
      for (const ok of [
        'Åsa Öberg-Ängström',
        'NA3b',
        "Zoë O'Neil & Søren",
        'Teknik \u2764 2026',
        'Łukasz Ðorđe Şeyma', // Latin Extended-A
        'Klass 3B (2026) / Nr. 7, ja!?',
        'Mäkelä \u2019',
      ]) {
        expect([ok, re.test(ok)]).toEqual([ok, true]);
      }
      for (const bad of [
        'سارة',
        '日本',
        '<script>',
        'a\tb',
        'x;y',
        'Ωmega',
        '\u{1F600}',
      ]) {
        expect([bad, re.test(bad)]).toEqual([bad, false]);
      }
      // The heart with VS16 passes the state validation (VS16 stripped first).
      expect(re.test('Anna \u2764\ufe0f'.replace(/[\ufe0e\ufe0f]/g, ''))).toBe(
        true,
      );
    });
  });

  describe('fixtures', () => {
    it('contain no nonce / endpoint fields', () => {
      for (const f of productFiles) {
        const d = read(f);
        for (const k of ['nonce', 'wcAjaxNonce', 'restUrl', 'ajaxUrl'])
          expect(d).not.toHaveProperty(k);
      }
      expect(productFiles).toHaveLength(25);
    });
  });

  describe('template set and product links', () => {
    it('dedupes to 10 templates: 9 linked + 4410 unlinked', () => {
      expect(result.templates.map((t) => t.source_id)).toEqual([
        ...LINKED,
        '4410',
      ]);
      expect(
        result.templates.filter((t) => t.include).map((t) => t.source_id),
      ).toEqual(LINKED);
      expect(result.warnings).toEqual([]);
    });

    it('4410 is flagged: unlinked, excluded by default, name review', () => {
      const t = T('4410');
      expect(t.include).toBe(false);
      expect(t.linked_product_refs).toEqual([]);
      expect(codes(t)).toEqual(
        expect.arrayContaining(['TEMPLATE_UNLINKED', 'NAME_REVIEW']),
      );
      expect(t.name).toBe('Studentskylt pris (Copy)');
      const inc = convertNpp(ALL_INPUT, {
        siteHost: HOST,
        includeUnlinked: true,
      });
      expect(tpl(inc, '4410').include).toBe(true);
    });

    it('links 25 products: 4273 → 17, every other linked template → 1', () => {
      expect(result.product_links).toHaveLength(25);
      const count = (id: string) =>
        result.product_links.filter((l) => l.template_source_id === id).length;
      expect(count('4273')).toBe(17);
      for (const id of LINKED.slice(1)) expect(count(id)).toBe(1);
      const l = result.product_links.find(
        (x) => x.product_source_id === '4275',
      )!;
      expect(l).toMatchObject({
        product_external_ref: 'woo:namez.se:product:4275',
        template_source_id: '4315',
        template_external_ref: 'woo:namez.se:npp_template:4315',
      });
      expect(l.pricing).toMatchObject({ double_extra: 199, poster_price: 0 });
      expect(l.addons).toEqual({
        double: false,
        raincover: false,
        poster: false,
        welcome: false,
      });
    });

    it('U4: skipping 4326 leaves 24 links (4273 → 16) with a warning', () => {
      const r = convertNpp(ALL_INPUT, {
        siteHost: HOST,
        skipProductIds: ['4326'],
      });
      expect(r.product_links).toHaveLength(24);
      expect(
        r.product_links.filter((l) => l.template_source_id === '4273'),
      ).toHaveLength(16);
      expect(r.warnings.map((w) => w.code)).toEqual(['PRODUCT_SKIPPED']);
    });

    it('uses the importer external ref format (C7)', () => {
      for (const t of result.templates)
        expect(t.external_ref).toBe(`woo:namez.se:npp_template:${t.source_id}`);
    });

    it('is idempotent: same input twice / converted twice gives the same result', () => {
      const twice = convertNpp([...ALL_INPUT, ...ALL_INPUT], {
        siteHost: HOST,
      });
      expect(twice).toEqual(result);
      expect(convertNpp(ALL_INPUT, { siteHost: HOST })).toEqual(result);
    });
  });

  describe('all 9 usable templates', () => {
    it.each(LINKED)(
      '%s converts to a front surface with 2 texts and 1 photo slot',
      (id) => {
        const t = T(id);
        expect(t.include).toBe(true);
        expect(t.spec).toMatchObject({
          schema: 'designer.template/1',
          unit: 'mm',
          width: 500,
          height: 700,
          bleed_mm: 0,
          render: {
            preview_px_per_mm: 2,
            print_px_per_mm: 6,
            fit_ref_px_per_mm: 6,
          },
        });
        expect(texts(t)).toHaveLength(2);
        expect(slots(t)).toHaveLength(1);
        expect(
          texts(t)
            .map((e) => e.label.sv)
            .sort(),
        ).toEqual(['Klass', 'Namn']);
        for (const e of texts(t)) {
          expect(e).toMatchObject({
            fit: { mode: 'shrink', step: 0.5, min: 6, pad_ref_px: 8 },
            inset: 4,
            editable: true,
            required: true,
            max_length: 40,
            allowed_chars: IMPORTED_ALLOWED_CHARS,
            direction: 'ltr',
            transform: 'none',
          });
        }
        const s = slots(t)[0];
        expect(s).toMatchObject({
          label: { sv: 'Foto' },
          placeholder: { sv: 'Ladda upp bild' },
          shape: 'rect',
          required: true,
        });
        expect(t.spec.surfaces[0].background.fit).toBe('stretch');
        // Every element font is declared in spec.fonts.
        const declared = new Set(
          t.spec.fonts.map((f) => `${f.family}|${f.weight}|${f.style}`),
        );
        for (const e of texts(t))
          expect(
            declared.has(`${e.font.family}|${e.font.weight}|${e.font.style}`),
          ).toBe(true);
      },
    );

    it('decoration counts: 4308 → 3, 4355 → 2, others 0', () => {
      const n = Object.fromEntries(
        LINKED.map((id) => [id, images(T(id)).length]),
      );
      expect(n).toEqual({
        4273: 0,
        4281: 0,
        4308: 3,
        4315: 0,
        4350: 0,
        4355: 2,
        4359: 0,
        4364: 0,
        4368: 0,
      });
    });

    it('ids are kept from NPP', () => {
      expect(els(T('4273')).map((e) => e.id)).toEqual([
        'nbpz06rrg',
        'kgakvmyxo',
        '1r0adoxwh',
      ]);
      expect(result.templates.flatMap((t) => codes(t))).not.toContain(
        'ID_REWRITTEN',
      );
    });
  });

  describe('per-template expectations (Discovery C:269-301)', () => {
    it('4273: Namn geometry/font exact; print background from web', () => {
      const t = T('4273');
      expect(byLabel(t, 'Namn')).toMatchObject({
        x: 90,
        y: 40,
        w: 300,
        h: 52,
        size: 73,
        color: '#ffffff',
        align: 'center',
        rot: 0,
        z: 2,
        font: { family: 'Montserrat', weight: 600, style: 'normal' },
        default_text: 'Namn',
        placeholder: { sv: 'Namn' },
        source_label: 'Namn',
      });
      expect(codes(t)).toContain('PRINT_BG_FROM_WEB');
      expect(fetchOf(t, 'pending:bg_print')).toEqual({
        key: 'pending:bg_print',
        role: 'bg_print',
        url: 'https://namez.se/wp-content/uploads/2026/04/Stilren-studentskylt-med-foto.jpg',
        fallback_url:
          'https://namez.se/wp-content/uploads/2026/04/Stilren-studentskylt-med-foto-scaled.jpg',
      });
      expect(fontPairs(t)).toEqual(['Montserrat 400', 'Montserrat 600']);
    });

    it('4281: both texts z3, array order kept', () => {
      const t = T('4281');
      expect(texts(t).map((e) => [e.label.sv, e.z])).toEqual([
        ['Namn', 3],
        ['Klass', 3],
      ]);
      expect(sortElements(els(t)).map((e) => e.id)).toEqual([
        'amhh6dz6m',
        'kv0nlqycf',
        '92o4p321p',
      ]);
      expect(fontPairs(t)).toEqual(['Montserrat 500', 'Montserrat 700']);
    });

    it('4308: draw order [slot, deco0, deco2, deco1, text, text]', () => {
      const t = T('4308');
      expect(images(t).map((e) => e.z)).toEqual([3, 4, 3]);
      expect(sortElements(els(t)).map((e) => e.id)).toEqual([
        'b3poke85i',
        '3kfdpwple',
        '63x4rv4qi',
        'excetwi1x',
        'i9bylqrdu',
        '88z14t3n6',
      ]);
      expect(images(t)[0].asset.asset_id).toBe('pending:deco:3kfdpwple');
      expect(fetchOf(t, 'pending:deco:3kfdpwple')).toMatchObject({
        role: 'deco',
        element_id: '3kfdpwple',
      });
    });

    it('4315: "Text" → Namn; fonts derived although _npp_fonts = []', () => {
      const t = T('4315');
      const first = texts(t).find((e) => e.id === 'yp6jnu7ld')!;
      expect(first.label).toEqual({ sv: 'Namn' });
      expect(first.source_label).toBe('Text');
      expect(first.placeholder).toEqual({ sv: 'Namn' }); // was "Enter text"
      expect(first.default_text).toBe('Text'); // kept as NPP had it (never printed: required)
      expect(
        t.warnings.find((w) => w.code === 'LABEL_NORMALIZED'),
      ).toMatchObject({
        element_id: 'yp6jnu7ld',
        data: { from: 'Text', to: 'Namn' },
      });
      expect(fontPairs(t)).toEqual(['Montserrat 400', 'Montserrat 700']);
      expect(t.fonts.every((f) => f.undeclared)).toBe(true);
      expect(codes(t)).toContain('FONT_UNDECLARED');
      // Print background has no -scaled suffix → no fallback.
      expect(fetchOf(t, 'pending:bg_print')).toEqual({
        key: 'pending:bg_print',
        role: 'bg_print',
        url: 'https://namez.se/wp-content/uploads/2026/04/Student-2026-4.png',
      });
    });

    it('4350: Anton 500 → 400 substituted; undeclared Montserrat 600 added', () => {
      const t = T('4350');
      expect(byLabel(t, 'Namn').font).toEqual({
        family: 'Anton',
        weight: 400,
        style: 'normal',
      });
      expect(
        t.warnings.find((w) => w.code === 'FONT_WEIGHT_SUBSTITUTED'),
      ).toMatchObject({
        element_id: 'yaymfva1j',
        data: { family: 'Anton', requested: 500, used: 400 },
      });
      expect(fontPairs(t)).toEqual(['Anton 400', 'Montserrat 600']);
      expect(t.fonts.map((f) => [f.family, f.undeclared])).toEqual([
        ['Anton', false],
        ['Montserrat', true],
      ]);
    });

    it('4355: Namn w504; Namn before slot at z3; background swap fixed after fetch', () => {
      const t = T('4355');
      expect(byLabel(t, 'Namn')).toMatchObject({ x: 1, y: 1, w: 504, z: 3 });
      const order = sortElements(els(t)).map((e) => e.id);
      expect(order.indexOf('137pxk46h')).toBeLessThan(
        order.indexOf('wayaptiut'),
      );
      // NPP stored the big file as web and the small one as print.
      expect(fetchOf(t, 'pending:bg_web').url).toBe(
        'https://namez.se/wp-content/uploads/2026/04/Studentskylt-pris-big.jpg',
      );
      expect(fetchOf(t, 'pending:bg_print').url).toBe(
        'https://namez.se/wp-content/uploads/2026/04/Studentskylt-pris-small.png',
      );
      const media = mediaFor(t, {
        'pending:bg_web': [3000, 4200],
        'pending:bg_print': [1000, 1400],
      });
      const f = finalizeTemplateAssets(t, media);
      expect(f.spec.surfaces[0].background.web).toEqual({
        asset_id: 'id:bg_print',
        width: 1000,
        height: 1400,
      });
      expect(f.spec.surfaces[0].background.print).toEqual({
        asset_id: 'id:bg_web',
        width: 3000,
        height: 4200,
      });
      expect(f.warnings.map((w) => w.code)).toEqual(['BG_SWAPPED']);
      expect(f.missing).toEqual([]);
      // The converted (pending) spec is not mutated.
      expect(t.spec.surfaces[0].background.web!.asset_id).toBe(
        'pending:bg_web',
      );
    });

    it('4359: second "Text" → Klass; slot z1 under the texts', () => {
      const t = T('4359');
      expect(texts(t).map((e) => [e.id, e.label.sv, e.source_label])).toEqual([
        ['7qc24i6pu', 'Namn', 'Namn'],
        ['jslm4rokj', 'Klass', 'Text'],
      ]);
      expect(sortElements(els(t))[0].id).toBe('us4lnkexi');
      expect(t.name).toBe('Studentskylt med rosa design new');
      expect(codes(t)).toContain('NAME_REVIEW');
    });

    it('4364: print = web file (same URL); Righteous 400', () => {
      const t = T('4364');
      expect(codes(t)).toContain('PRINT_BG_SAME_AS_WEB');
      expect(codes(t)).not.toContain('PRINT_BG_FROM_WEB');
      expect(fetchOf(t, 'pending:bg_web').url).toBe(
        fetchOf(t, 'pending:bg_print').url,
      );
      expect(fetchOf(t, 'pending:bg_web').fallback_url).toBeUndefined();
      expect(fontPairs(t)).toEqual(['Righteous 400']);
      // Same file: no swap decision.
      const f = finalizeTemplateAssets(t, mediaFor(t, {}));
      expect(f.warnings.map((w) => w.code)).not.toContain('BG_SWAP_UNDECIDED');
    });

    it('4368: slot rot 5; Namn x −1 kept exactly', () => {
      const t = T('4368');
      expect(slots(t)[0].rot).toBe(5);
      expect(byLabel(t, 'Namn').x).toBe(-1);
    });
  });

  describe('-scaled stripping (U9)', () => {
    it('stripScaled', () => {
      expect(stripScaled('https://x/a/b-scaled.jpg')).toBe('https://x/a/b.jpg');
      expect(stripScaled('https://x/a/b-SCALED.PNG')).toBe('https://x/a/b.PNG');
      expect(stripScaled('https://x/a/b-scaled-1.jpg')).toBeNull();
      expect(stripScaled('https://x/a/b.png')).toBeNull();
    });
    it('every background URL is stripped with the original as fallback', () => {
      for (const t of result.templates) {
        for (const f of t.fetch.filter(
          (x) => x.role === 'bg_web' || x.role === 'bg_print',
        )) {
          expect(f.url).not.toMatch(/-scaled\.[a-z0-9]+$/i);
          if (f.fallback_url) expect(stripScaled(f.fallback_url)).toBe(f.url);
        }
      }
      const withFallback = result.templates
        .filter((t) => fetchOf(t, 'pending:bg_web').fallback_url)
        .map((t) => t.source_id);
      expect(withFallback).toEqual([
        '4273',
        '4281',
        '4308',
        '4315',
        '4350',
        '4355',
        '4368',
        '4410',
      ]);
    });
    it('records BG_SCALED_FALLBACK when the service had to use the -scaled file', () => {
      const t = T('4281');
      const media = mediaFor(t, { 'pending:bg_web': [1000, 1400] });
      media['pending:bg_web'] = {
        ...media['pending:bg_web']!,
        used_fallback: true,
      };
      expect(
        finalizeTemplateAssets(t, media).warnings.map((w) => w.code),
      ).toEqual(['BG_SCALED_FALLBACK']);
    });
  });

  describe('labels', () => {
    it('no English placeholders remain; slots are Foto / Ladda upp bild', () => {
      for (const t of result.templates) {
        for (const e of texts(t))
          expect(e.placeholder.sv).not.toMatch(/^enter/i);
        for (const s of slots(t))
          expect([s.label.sv, s.placeholder.sv]).toEqual([
            'Foto',
            'Ladda upp bild',
          ]);
      }
      expect(byLabel(T('4273'), 'Namn').placeholder.sv).toBe('Namn'); // "Enter Namn"
    });
    it('normalizeLabels:false keeps NPP labels', () => {
      const r = convertNpp(ALL_INPUT, {
        siteHost: HOST,
        normalizeLabels: false,
      });
      expect(texts(tpl(r, '4315')).map((e) => e.label.sv)).toEqual([
        'Text',
        'Klass',
      ]);
      expect(slots(tpl(r, '4315'))[0].label.sv).toBe('Photo');
      expect(codes(tpl(r, '4315'))).not.toContain('LABEL_NORMALIZED');
    });
    it('only templates 4315 and 4359 are normalized', () => {
      const normalized = result.templates
        .filter((t) => codes(t).includes('LABEL_NORMALIZED'))
        .map((t) => t.source_id);
      expect(normalized).toEqual(['4315', '4359']);
    });
  });

  describe('fonts', () => {
    it('collects the union of declared and used (family, weight) pairs per template', () => {
      const table = Object.fromEntries(
        result.templates.map((t) => [t.source_id, fontPairs(t).join(', ')]),
      );
      expect(table).toEqual({
        4273: 'Montserrat 400, Montserrat 600',
        4281: 'Montserrat 500, Montserrat 700',
        4308: 'Montserrat 600, Montserrat 700',
        4315: 'Montserrat 400, Montserrat 700',
        4350: 'Anton 400, Montserrat 600',
        4355: 'Montserrat 400, Montserrat 700',
        4359: 'Montserrat 400, Montserrat 700',
        4364: 'Righteous 400',
        4368: 'Montserrat 400, Montserrat 700',
        4410: 'Montserrat 400, Montserrat 700',
      });
      const undeclaredTemplates = result.templates
        .filter((t) => codes(t).includes('FONT_UNDECLARED'))
        .map((t) => t.source_id);
      expect(undeclaredTemplates).toEqual([
        '4315',
        '4350',
        '4355',
        '4359',
        '4410',
      ]);
      for (const t of result.templates) {
        for (const f of t.fonts)
          expect(f.key).toBe(`pending:font:${f.family}:${f.weight}:${f.style}`);
      }
    });
    it('declared but unused families get their regular face', () => {
      const r = convertNpp(
        {
          ...read<Record<string, unknown>>('se_4347.json'),
          fonts: [{ family: 'Montserrat' }, { family: 'Righteous' }],
        },
        { siteHost: HOST },
      );
      expect(fontPairs(r.templates[0])).toEqual([
        'Montserrat 400',
        'Montserrat 600',
        'Righteous 400',
      ]);
    });
    it('unknown families keep the requested weight with a warning', () => {
      const d = read<RestFixture>('template_4410.json');
      d.elements[2].fontFamily = 'Lobster';
      const t = convertNpp(d, { siteHost: HOST }).templates[0];
      expect(fontPairs(t)).toContain('Lobster 700');
      expect(codes(t)).toContain('FONT_WEIGHTS_UNKNOWN');
      const t2 = convertNpp(d, {
        siteHost: HOST,
        fontWeights: { Lobster: [400] },
      }).templates[0];
      expect(fontPairs(t2)).toContain('Lobster 400');
    });
    it('nearestWeight follows CSS font matching', () => {
      expect(nearestWeight(500, [400])).toBe(400);
      expect(nearestWeight(400, [300, 500])).toBe(500);
      expect(nearestWeight(450, [300, 600])).toBe(300);
      expect(nearestWeight(300, [400, 700])).toBe(400);
      expect(nearestWeight(300, [100, 400])).toBe(100);
      expect(nearestWeight(600, [400, 800])).toBe(800);
      expect(nearestWeight(800, [400, 700])).toBe(700);
      expect(nearestWeight(600, [])).toBe(600);
    });
  });

  describe('input shapes', () => {
    it('(E) importer NTemplate from raw _npp_* postmeta gives the same specs and links', () => {
      const r = convertNpp(read('ntemplates_postmeta.json'), {
        siteHost: HOST,
      });
      expect(r.templates.map((t) => t.source_id)).toEqual([...LINKED, '4410']);
      for (const t of r.templates) {
        const a = T(t.source_id);
        expect(t.external_ref).toBe(a.external_ref);
        expect(t.name).toBe(a.name);
        expect(t.spec).toEqual(a.spec);
      }
      expect(r.product_links).toHaveLength(25);
      expect(
        r.product_links.filter((l) => l.template_source_id === '4273'),
      ).toHaveLength(17);
      expect(tpl(r, '4410').include).toBe(false);
      // Thumbnails come from _npp_thumbnail_url.
      expect(tpl(r, '4273').thumbnail_url).toMatch(/npp-thumbnails\/poster-/);
    });
    it('(C) list-only input enriches nothing and reports missing elements', () => {
      const r = convertNpp(read('templates.json'), { siteHost: HOST });
      expect(r.templates).toEqual([]);
      expect(r.warnings).toHaveLength(10);
      expect(new Set(r.warnings.map((w) => w.code))).toEqual(
        new Set(['TEMPLATE_NO_ELEMENTS']),
      );
    });
    it('(C) list entries fill the thumbnail of templates that have none', () => {
      expect(T('4273').thumbnail_url).toBe(
        'https://namez.se/wp-content/uploads/npp-thumbnails/poster-0IBMp6sF5Zgb.jpg',
      );
      expect(fetchOf(T('4273'), 'pending:thumb')).toMatchObject({
        role: 'thumb',
      });
    });
    it('unrecognized entries and unsupported elements are reported', () => {
      expect(
        convertNpp([42, { foo: 1 }], { siteHost: HOST }).warnings.map(
          (w) => w.code,
        ),
      ).toEqual(['INPUT_UNRECOGNIZED', 'INPUT_UNRECOGNIZED']);
      const d = read<RestFixture>('template_4410.json');
      d.elements.push({
        id: 'flag1',
        type: 'flag-slot',
        x: 0,
        y: 0,
        w: 10,
        h: 10,
        z: 9,
        flags: [],
      });
      d.elements.push({
        id: 'Bad Id!',
        type: 'deco-image',
        imageData: '',
        x: 0,
        y: 0,
        w: 1,
        h: 1,
      });
      d.size_mode = 'premium';
      const t = convertNpp(d, { siteHost: HOST }).templates[0];
      expect(codes(t)).toEqual(
        expect.arrayContaining([
          'UNSUPPORTED_ELEMENT',
          'ID_REWRITTEN',
          'ELEMENT_NO_IMAGE',
          'PREMIUM_ASSUMED_BLEED',
        ]),
      );
      expect(t.spec).toMatchObject({ width: 506, height: 706, bleed_mm: 3 });
      expect(els(t).map((e) => e.id)).not.toContain('flag1');
    });
  });

  describe('finalizeTemplateAssets', () => {
    it('fills asset ids and dimensions, flags low-res print backgrounds and missing media', () => {
      const t = T('4308');
      const media = mediaFor(t, {
        'pending:bg_web': [1000, 1400],
        'pending:bg_print': [2000, 2800],
      });
      delete media['pending:deco:excetwi1x'];
      const f = finalizeTemplateAssets(t, media);
      expect(f.spec.surfaces[0].background.print).toEqual({
        asset_id: 'id:bg_print',
        width: 2000,
        height: 2800,
      });
      expect(f.spec.fonts.map((x) => x.asset_id)).toEqual([
        'id:font:Montserrat:600:normal',
        'id:font:Montserrat:700:normal',
      ]);
      expect(f.missing).toEqual(['pending:deco:excetwi1x']);
      expect(f.warnings.map((w) => w.code)).toEqual([
        'PRINT_BG_LOW_RES',
        'ASSET_MISSING',
      ]);
    });
    it('equal-size web and print files keep NPP order with a warning', () => {
      const t = T('4281');
      const f = finalizeTemplateAssets(
        t,
        mediaFor(t, {
          'pending:bg_web': [3000, 4200],
          'pending:bg_print': [3000, 4200],
        }),
      );
      expect(f.warnings.map((w) => w.code)).toEqual(['BG_SWAP_UNDECIDED']);
      expect(f.spec.surfaces[0].background.web!.asset_id).toBe('id:bg_web');
    });
  });

  describe('committed expected specs', () => {
    const dir = path.join(FIX, 'expected');
    it.each([...LINKED, '4410'])(
      'template %s matches __fixtures__/expected',
      (id) => {
        const t = T(id);
        const actual = {
          external_ref: t.external_ref,
          name: t.name,
          include: t.include,
          spec: t.spec,
          fetch: t.fetch,
          warnings: t.warnings.map((w) => w.code),
        };
        const file = path.join(dir, `template_${id}.json`);
        if (process.env.UPDATE_NPP_EXPECTED === '1' || !fs.existsSync(file)) {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(file, JSON.stringify(actual, null, 2) + '\n');
        }
        expect(actual).toEqual(JSON.parse(fs.readFileSync(file, 'utf8')));
      },
    );
  });
});

/** Fake stored media for every fetch/font key: id = key with "pending:" → "id:". */
function mediaFor(
  t: NppConvertedTemplate,
  dims: Record<string, [number, number]>,
): Record<
  string,
  | { asset_id: string; width: number; height: number; used_fallback?: boolean }
  | undefined
> {
  const m: Record<
    string,
    | {
        asset_id: string;
        width: number;
        height: number;
        used_fallback?: boolean;
      }
    | undefined
  > = {};
  for (const f of t.fetch) {
    const [w, h] = dims[f.key] || [3000, 4200];
    m[f.key] = {
      asset_id: f.key.replace('pending:', 'id:'),
      width: w,
      height: h,
    };
  }
  for (const f of t.fonts)
    m[f.key] = {
      asset_id: f.key.replace('pending:', 'id:'),
      width: 0,
      height: 0,
    };
  return m;
}

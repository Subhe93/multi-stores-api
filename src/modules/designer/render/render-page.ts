/**
 * The page the designer Chromium host loads (M4.2 §5.1).
 *
 * Everything is served from memory under `https://designer.invalid/` (a
 * secure, same-origin context, so FontFace / createImageBitmap work and the
 * canvas is never tainted); every other request is aborted by the host.
 *
 *   /render.html   this document
 *   /renderer.js   the shared renderer (`@multi-stores/core/designer`, CommonJS
 *                  build) wrapped in a CommonJS shim → window.DesignRenderer
 *   /page.js       `window.__render(job)` below
 *   /f/<asset_id>  font bytes
 *   /a/<asset_id>  image bytes
 *
 * Customer text only reaches the page as JSON arguments of `page.evaluate`
 * and is only ever drawn through canvas `fillText`; it never becomes HTML.
 */
import { readFileSync } from 'fs';

export const RENDER_ORIGIN = 'https://designer.invalid';
export const RENDER_PAGE_URL = `${RENDER_ORIGIN}/render.html`;

export const RENDER_PAGE_HTML =
  '<!doctype html><html><head><meta charset="utf-8">' +
  '<script src="/renderer.js"></script><script src="/page.js"></script>' +
  '</head><body></body></html>';

/**
 * In-page entry point. Plain ES2020 (it runs in Chromium, not Node).
 * Job: {spec, state, mode, scale, locale?, type, quality?,
 *       fonts:[{family,weight,style,url}], assets:[{id,url,crop?}]}.
 * `crop` = {fx,fy,fw,fh}: the served bytes are that fraction of the
 * original (print photos are pre-cut to their visible region, §5.2); the
 * context's drawImage is remapped to the matching sub-rect so the shared
 * renderer keeps drawing whole images.
 * Returns {data: base64, width, height, report}; throws
 * `FONT_LOAD_FAILED:` / `ASSET_LOAD_FAILED:` / `RENDER_MISSING:` errors.
 */
export const RENDER_PAGE_SCRIPT = String.raw`
(function () {
  'use strict';
  function faceKey(family, weight, style) {
    return family + '|' + Number(weight) + '|' + (style === 'italic' ? 'italic' : 'normal');
  }
  window.__render = async function (job) {
    var R = window.DesignRenderer;
    if (!R || typeof R.renderDesign !== 'function') throw new Error('RENDERER_MISSING');
    var loaded = new Set();
    for (var i = 0; i < job.fonts.length; i++) {
      var f = job.fonts[i];
      var face = new FontFace(f.family, 'url(' + f.url + ')', {
        weight: String(f.weight),
        style: f.style === 'italic' ? 'italic' : 'normal',
      });
      try {
        await face.load();
      } catch (e) {
        throw new Error('FONT_LOAD_FAILED:' + f.family + ':' + f.weight + ':' + f.style);
      }
      document.fonts.add(face);
      loaded.add(faceKey(f.family, f.weight, f.style));
    }
    var images = new Map();
    try {
      for (var j = 0; j < job.assets.length; j++) {
        var a = job.assets[j];
        var res = await fetch(a.url);
        if (!res.ok) throw new Error('ASSET_LOAD_FAILED:' + a.id);
        var blob = await res.blob();
        var bitmap;
        try {
          bitmap = await createImageBitmap(blob);
        } catch (e) {
          throw new Error('ASSET_LOAD_FAILED:' + a.id);
        }
        images.set(a.id, a.crop ? { __bitmap: bitmap, __crop: a.crop } : bitmap);
      }
      var size = R.canvasSize(job.spec, job.scale);
      var canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      var ctx = canvas.getContext('2d', { alpha: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      // A cropped bitmap is drawn into the sub-rect its crop covers.
      var rawDrawImage = ctx.drawImage;
      ctx.drawImage = function (img, dx, dy, dw, dh) {
        if (img && img.__crop) {
          var c = img.__crop;
          return rawDrawImage.call(
            ctx, img.__bitmap, dx + c.fx * dw, dy + c.fy * dh, c.fw * dw, c.fh * dh);
        }
        return rawDrawImage.call(ctx, img, dx, dy, dw, dh);
      };
      var report = R.renderDesign(ctx, {
        spec: job.spec,
        surface: 'front',
        state: job.state,
        mode: job.mode,
        scale: job.scale,
        locale: job.locale,
        images: { get: function (id) { return images.get(id); } },
        fonts: { has: function (fa, w, s) { return loaded.has(faceKey(fa, w, s)); } },
      });
      if (report.missing.length) throw new Error('RENDER_MISSING:' + report.missing.join(','));
      var out = await new Promise(function (resolve) {
        canvas.toBlob(resolve, job.type, job.quality);
      });
      if (!out) throw new Error('ENCODE_FAILED');
      var dataUrl = await new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onload = function () { resolve(fr.result); };
        fr.onerror = function () { reject(fr.error); };
        fr.readAsDataURL(out);
      });
      canvas.width = 0;
      canvas.height = 0;
      return {
        data: dataUrl.slice(dataUrl.indexOf(',') + 1),
        width: size.width,
        height: size.height,
        report: report,
      };
    } finally {
      images.forEach(function (b) { try { (b.__bitmap || b).close(); } catch (e) {} });
    }
  };
})();
`;

export const RENDER_PDF_PAGE_URL = `${RENDER_ORIGIN}/print.html`;

/** The print-PDF document; `title` becomes the PDF's /Title. */
export function renderPdfPageHtml(title: string): string {
  const safe = title.replace(/[^A-Za-z0-9 ._-]/g, '');
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<title>${safe}</title>` +
    '<style>html,body{margin:0;padding:0;background:transparent}' +
    'canvas{position:absolute;display:block}</style>' +
    '<script src="/renderer.js"></script><script src="/pdf.js"></script>' +
    '</head><body></body></html>'
  );
}

/**
 * In-page entry points of the print PDF. Plain ES2020.
 *
 * `window.__preparePdf(job)` loads the fonts (FontFace) and the images
 * (as <img>, so Chromium embeds JPEG originals untouched as DCT streams)
 * and lays out two canvases over the bleed box: the background layer and
 * the element layer, plus a full-page crop-mark layer when asked. Nothing is
 * drawn yet: the drawing happens in the `beforeprint` handler, because
 * Chromium prints a 2D canvas drawn there as vector operations (text as
 * glyphs of the embedded font faces, images at their own resolution)
 * instead of a bitmap.
 *
 *   background layer  the shared renderer over a spec whose trim is the
 *                     bleed box and that has no elements: a cover / stretch
 *                     background or the background colour fills the bleed.
 *   element layer     the shared renderer over the real spec with a
 *                     transparent background, translated by the bleed, so
 *                     every element keeps its trim coordinates.
 *
 * Job: {spec, state, scale, locale?, fonts:[{family,weight,style,url}],
 *       assets:[{id,url}], geometry:{page_mm, bleed_mm, bleed_box_mm,
 *       crop_mark_lines_mm, crop_mark_weight_mm}}.
 * After `page.pdf()`, `window.__pdfOutcome()` returns {report} or {error}.
 */
export const RENDER_PDF_PAGE_SCRIPT = String.raw`
(function () {
  'use strict';
  function faceKey(family, weight, style) {
    return family + '|' + Number(weight) + '|' + (style === 'italic' ? 'italic' : 'normal');
  }
  var outcome = null;
  window.__pdfOutcome = function () { return outcome; };
  // Chromium replays a canvas recorded in 'beforeprint' with the ratio
  // (CSS box size / canvas pixels) FLOORED to 1/64 (LayoutUnit precision):
  // a 100 mm box over 600 px prints 99.2 mm. So every layer uses a canvas
  // density whose CSS-px-per-canvas-px ratio is exactly k/64 and gets its
  // CSS size from its pixel size; the renderer still draws at the job scale
  // through ctx.scale(density / scale). The density is at most the job
  // scale (k rounded up), so the canvases never exceed the PNG's limits.
  var CSS_PX_PER_MM = 96 / 25.4;
  function pdfDensity(scale) {
    var k = Math.max(1, Math.ceil((CSS_PX_PER_MM * 64) / scale));
    return { ratio: k / 64, perMm: CSS_PX_PER_MM / (k / 64) };
  }
  function layer(rect, d) {
    var c = document.createElement('canvas');
    // Rounded up: the layer covers at least its rect (the excess is cut by
    // the page edge or lies in the slug).
    c.width = Math.max(1, Math.ceil(rect.width * d.perMm - 1e-6));
    c.height = Math.max(1, Math.ceil(rect.height * d.perMm - 1e-6));
    c.style.left = rect.x + 'mm';
    c.style.top = rect.y + 'mm';
    c.style.width = c.width * d.ratio + 'px';
    c.style.height = c.height * d.ratio + 'px';
    document.body.appendChild(c);
    return c;
  }
  window.__preparePdf = async function (job) {
    var R = window.DesignRenderer;
    if (!R || typeof R.renderDesign !== 'function') throw new Error('RENDERER_MISSING');
    var loaded = new Set();
    for (var i = 0; i < job.fonts.length; i++) {
      var f = job.fonts[i];
      var face = new FontFace(f.family, 'url(' + f.url + ')', {
        weight: String(f.weight),
        style: f.style === 'italic' ? 'italic' : 'normal',
      });
      try {
        await face.load();
      } catch (e) {
        throw new Error('FONT_LOAD_FAILED:' + f.family + ':' + f.weight + ':' + f.style);
      }
      document.fonts.add(face);
      loaded.add(faceKey(f.family, f.weight, f.style));
    }
    var images = new Map();
    for (var j = 0; j < job.assets.length; j++) {
      var a = job.assets[j];
      var img = new Image();
      img.src = a.url;
      try {
        await img.decode();
      } catch (e) {
        throw new Error('ASSET_LOAD_FAILED:' + a.id);
      }
      images.set(a.id, img);
    }
    var g = job.geometry;
    var s = job.scale;
    var bb = g.bleed_box_mm;
    var front = null;
    for (var k = 0; k < (job.spec.surfaces || []).length; k++) {
      if (job.spec.surfaces[k].key === 'front') front = job.spec.surfaces[k];
    }
    if (!front) throw new Error('RENDER_MISSING:front');
    // The renderer fills round(width × scale) px: round up so the
    // background reaches the bleed edge (never a hairline short of it).
    var bgSpec = Object.assign({}, job.spec, {
      width: Math.ceil(bb.width * s - 1e-6) / s,
      height: Math.ceil(bb.height * s - 1e-6) / s,
      bleed_mm: 0,
      surfaces: [Object.assign({}, front, { elements: [] })],
    });
    var elSpec = Object.assign({}, job.spec, {
      surfaces: [Object.assign({}, front, {
        background: { color: 'rgba(0,0,0,0)', fit: front.background && front.background.fit },
      })],
    });
    var density = pdfDensity(s);
    var bgCanvas = layer(bb, density);
    var elCanvas = layer(bb, density);
    var markCanvas = g.crop_mark_lines_mm.length
      ? layer({ x: 0, y: 0, width: g.page_mm.width, height: g.page_mm.height }, density)
      : null;
    var lookups = {
      images: { get: function (id) { return images.get(id); } },
      fonts: { has: function (fa, w, st) { return loaded.has(faceKey(fa, w, st)); } },
    };
    function input(spec) {
      return {
        spec: spec,
        surface: 'front',
        state: job.state,
        mode: 'print',
        scale: s,
        locale: job.locale,
        images: lookups.images,
        fonts: lookups.fonts,
      };
    }
    // The 2D context of a layer: the renderer's initial clearRect is skipped
    // (the layers are fresh, transparent canvases; in a vector print it
    // would become an opaque white fill hiding the background layer), and
    // the job scale is mapped onto the layer's density (see pdfDensity).
    function prepared(canvas) {
      var ctx = canvas.getContext('2d', { alpha: true });
      if (!ctx) throw new Error('CANVAS_TOO_LARGE:' + canvas.width + 'x' + canvas.height);
      ctx.clearRect = function () {};
      ctx.scale(density.perMm / s, density.perMm / s);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      return ctx;
    }
    function draw() {
      if (outcome) return;
      try {
        var r1 = R.renderDesign(prepared(bgCanvas), input(bgSpec));
        var ectx = prepared(elCanvas);
        ectx.translate(g.bleed_mm * s, g.bleed_mm * s);
        var r2 = R.renderDesign(ectx, input(elSpec));
        if (markCanvas) {
          var m = prepared(markCanvas);
          m.strokeStyle = '#000';
          m.lineWidth = g.crop_mark_weight_mm * s;
          m.lineCap = 'butt';
          m.beginPath();
          for (var n = 0; n < g.crop_mark_lines_mm.length; n++) {
            var l = g.crop_mark_lines_mm[n];
            m.moveTo(l.x1 * s, l.y1 * s);
            m.lineTo(l.x2 * s, l.y2 * s);
          }
          m.stroke();
        }
        outcome = {
          report: {
            fitted: r2.fitted,
            missing: r1.missing.concat(r2.missing),
            elements: r2.elements,
          },
        };
      } catch (e) {
        outcome = { error: String((e && e.message) || e) };
      }
    }
    window.addEventListener('beforeprint', draw);
    return { layers: markCanvas ? 3 : 2 };
  };
})();
`;

let cachedBundle: string | null = null;

/**
 * The renderer as a classic script defining `window.DesignRenderer`.
 * The code is the CommonJS build of `@multi-stores/core/designer`, resolved
 * through the package `exports` (M5.3), so production, ts-jest and ts-node
 * serve the same bytes; the web bundles the ESM build of the same source.
 * The module has zero imports, so a minimal CommonJS shim is enough.
 */
export function rendererBundle(): string {
  if (cachedBundle) return cachedBundle;
  const code = readFileSync(
    require.resolve('@multi-stores/core/designer'),
    'utf8',
  );
  cachedBundle =
    '(function(){var module={exports:{}};var exports=module.exports;\n' +
    code +
    '\n;window.DesignRenderer=module.exports;})();';
  return cachedBundle;
}

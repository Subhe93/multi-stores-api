/**
 * The page the designer Chromium host loads (M4.2 §5.1).
 *
 * Everything is served from memory under `https://designer.invalid/` (a
 * secure, same-origin context, so FontFace / createImageBitmap work and the
 * canvas is never tainted); every other request is aborted by the host.
 *
 *   /render.html   this document
 *   /renderer.js   the shared renderer (`design-renderer.ts`, mirrored
 *                  byte-for-byte) wrapped in a CommonJS shim → window.DesignRenderer
 *   /page.js       `window.__render(job)` below
 *   /f/<asset_id>  font bytes
 *   /a/<asset_id>  image bytes
 *
 * Customer text only reaches the page as JSON arguments of `page.evaluate`
 * and is only ever drawn through canvas `fillText`; it never becomes HTML.
 */
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';

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

let cachedBundle: string | null = null;

/**
 * The renderer as a classic script defining `window.DesignRenderer`.
 * Production (`nest build`) has the compiled CommonJS `design-renderer.js`
 * next to this file; under ts-jest / ts-node only the `.ts` source exists and
 * is transpiled with the `typescript` dev dependency. The file has zero
 * imports, so a minimal CommonJS shim is enough.
 */
export function rendererBundle(dir: string = __dirname): string {
  if (cachedBundle && dir === __dirname) return cachedBundle;
  const js = path.join(dir, 'design-renderer.js');
  let code: string;
  if (existsSync(js)) {
    code = readFileSync(js, 'utf8');
  } else {
    const source = readFileSync(path.join(dir, 'design-renderer.ts'), 'utf8');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ts = require('typescript') as typeof import('typescript');
    code = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    }).outputText;
  }
  const bundle =
    '(function(){var module={exports:{}};var exports=module.exports;\n' +
    code +
    '\n;window.DesignRenderer=module.exports;})();';
  if (dir === __dirname) cachedBundle = bundle;
  return bundle;
}

/*
 * TEST FIXTURE — verbatim port of the NPP print renderer.
 *
 * Origin: namez-poster-plugin (NPP 1.9.1), file admin/js/order-viewer.js,
 * lines 56-171 ("Shape helpers", fitTextSize and "Core render"), plus the
 * module-level state those functions close over (lines 10-19: SIZES, data,
 * elements, imgAdj, sizeMode, imageCache, getAdj).
 *
 * Licence / ownership: the plugin is the client's (namez.se) own WordPress
 * plugin; this copy is kept ONLY as a reference oracle for the parity spec
 * `render/design-renderer.npp-parity.spec.ts` and is never shipped, bundled
 * or executed outside jest (it is a .js file under __fixtures__, excluded
 * from the Nest build and from the renderer mirrors).
 *
 * Port rules: the function bodies are byte-for-byte the plugin's. The only
 * additions are the factory wrapper below (the plugin read `nppOrderViewer`
 * from the page; here `data` and `imageCache` are injected) and the
 * `module.exports` line. Nothing else is adapted, fixed or reformatted.
 */
/* eslint-disable */
'use strict';

module.exports = function createNppRenderer(data, imageCache) {
  // order-viewer.js:10-19 (module state; `data` replaces `nppOrderViewer`).
  var SIZES = { budget: { w: 500, h: 700 } };
  var elements = data.elements || [];
  var imgAdj = data.imgAdj || {};
  var sizeMode = data.sizeMode || 'budget';

  function getAdj(id) {
    if (!imgAdj[id]) imgAdj[id] = { zoom: 1, rot: 0, panX: 0.5, panY: 0.5 };
    return imgAdj[id];
  }

  // order-viewer.js:56-171 (verbatim).
  /* ── Shape helpers ────────────────────────────────────────────── */
  function roundRect(ctx, x, y, w, h, r) {
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

  /**
   * Shrink fontSize only if the text is too WIDE for the box — matching the
   * dashboard which also allows vertical overflow.
   */
  function fitTextSize(ctx, text, el, sf) {
    var maxW = el.w * sf - 8, sz = el.fontSize || 28;
    for (var s = sz; s >= 6; s -= 0.5) {
      ctx.font = (el.fontWeight || 400) + ' ' + (s * sf) + 'px "' + (el.fontFamily || 'Montserrat') + '"';
      if (ctx.measureText(text).width <= maxW) return s;
    }
    return 6;
  }

  /* ── Core render ──────────────────────────────────────────────── */
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {number} sf - scale factor (2 = preview, 6 = print)
   * @param {string} [bgOverride] - optional hi-res background URL for print
   */
  function renderToCanvas(canvas, sf, bgOverride) {
    var sz = SIZES[sizeMode] || SIZES.budget;
    var w = sz.w * sf, h = sz.h * sf;
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    elements.slice().sort(function (a, b) { return (a.z || 0) - (b.z || 0); }).forEach(function (el) {
      ctx.save();

      if (el.type === 'background') {
        // Use hi-res override if provided and cached
        var bgSrc = (bgOverride && imageCache[bgOverride]) ? bgOverride : el.imageData;
        if (bgSrc && imageCache[bgSrc]) {
          ctx.drawImage(imageCache[bgSrc], 0, 0, w, h);
        } else {
          ctx.fillStyle = el.color || '#fff';
          ctx.fillRect(0, 0, w, h);
        }
      } else {
        var cx = (el.x + el.w / 2) * sf, cy = (el.y + el.h / 2) * sf;
        ctx.translate(cx, cy);
        ctx.rotate((el.rot || 0) * Math.PI / 180);
        ctx.translate(-cx, -cy);

        if (el.type === 'text') {
          // Match admin when text fits; shrink only if customer text is too long.
          var text0 = (el.customerValue !== undefined && el.customerValue !== '') ? el.customerValue : el.text;
          var text = el.uppercase ? (text0 || '').toUpperCase() : (text0 || el.placeholder || '');
          var fontSize = fitTextSize(ctx, text, el, sf);
          ctx.font = (el.fontWeight || 400) + ' ' + (fontSize * sf) + 'px "' + (el.fontFamily || 'Montserrat') + '"';
          ctx.fillStyle = el.color || '#000';
          ctx.textBaseline = 'middle';
          ctx.textAlign = el.textAlign || 'center';
          var tx = el.textAlign === 'left'  ? el.x * sf + 4 * sf
                 : el.textAlign === 'right' ? (el.x + el.w) * sf - 4 * sf
                 : (el.x + el.w / 2) * sf;
          ctx.fillText(text, tx, (el.y + el.h / 2) * sf);

        } else if (el.type === 'image-slot') {
          var imgD = el.customerImage || el.imageData;
          if (imgD && imageCache[imgD]) {
            ctx.save();
            ctx.beginPath();
            if (el.shape === 'circle') ctx.ellipse(cx, cy, el.w * sf / 2, el.h * sf / 2, 0, 0, Math.PI * 2);
            else if (el.borderRadius) roundRect(ctx, el.x * sf, el.y * sf, el.w * sf, el.h * sf, el.borderRadius * sf);
            else ctx.rect(el.x * sf, el.y * sf, el.w * sf, el.h * sf);
            ctx.clip();
            var img = imageCache[imgD], adj = getAdj(el.id);
            var iA = img.naturalWidth / img.naturalHeight, sA = el.w / el.h, bw, bh;
            if (iA > sA) { bh = el.h * sf; bw = bh * iA; } else { bw = el.w * sf; bh = bw / iA; }
            var zw = bw * adj.zoom, zh = bh * adj.zoom;
            var dx = el.x * sf - Math.max(0, zw - el.w * sf) * adj.panX;
            var dy = el.y * sf - Math.max(0, zh - el.h * sf) * adj.panY;
            if (adj.rot) {
              var icx = dx + zw / 2, icy = dy + zh / 2;
              ctx.translate(icx, icy);
              ctx.rotate(adj.rot * Math.PI / 180);
              ctx.translate(-icx, -icy);
            }
            ctx.drawImage(img, dx, dy, zw, zh);
            ctx.restore();
          } else {
            ctx.fillStyle = '#e8e8e8';
            ctx.fillRect(el.x * sf, el.y * sf, el.w * sf, el.h * sf);
          }

        } else if ((el.type === 'deco-image' || el.type === 'overlay') && el.imageData && imageCache[el.imageData]) {
          ctx.drawImage(imageCache[el.imageData], el.x * sf, el.y * sf, el.w * sf, el.h * sf);

        } else if (el.type === 'flag-slot' && el.flags && el.flags.length) {
          var flagUrl = el.selectedFlagUrl || ((el.flags.find(function (f) { return f.default; }) || el.flags[0]).url);
          if (flagUrl && imageCache[flagUrl]) {
            ctx.drawImage(imageCache[flagUrl], el.x * sf, el.y * sf, el.w * sf, el.h * sf);
          }
        }
      }
      ctx.restore();
    });
  }

  return { roundRect: roundRect, fitTextSize: fitTextSize, renderToCanvas: renderToCanvas };
};

/**
 * Magic-byte check of the generic upload route. The installed `file-type`
 * is ESM-only (not loadable from this CommonJS build), so the handful of
 * accepted formats are checked by hand: PNG, JPEG, WebP (RIFF/WEBP), PDF
 * (`%PDF-` within the first 1 KB, like customer uploads), AI (PDF-compatible
 * or `%!PS-Adobe`) and SVG (text that opens an `<svg` element after optional
 * BOM / XML prolog / comments / doctype).
 */

const SNIFFERS: Record<string, (buf: Buffer) => boolean> = {
  '.png': (b) =>
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a,
  '.jpg': isJpeg,
  '.jpeg': isJpeg,
  '.webp': (b) =>
    b.length >= 12 &&
    b.toString('latin1', 0, 4) === 'RIFF' &&
    b.toString('latin1', 8, 12) === 'WEBP',
  '.pdf': isPdf,
  '.ai': (b) => isPdf(b) || head(b).startsWith('%!PS-Adobe'),
  '.svg': isSvg,
};

function head(b: Buffer, n = 1024): string {
  return b.subarray(0, n).toString('latin1');
}

function isJpeg(b: Buffer): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

function isPdf(b: Buffer): boolean {
  return head(b).includes('%PDF-');
}

function isSvg(b: Buffer): boolean {
  // Strip a UTF-8 BOM and look at the first 4 KB as text; binary content
  // (NUL bytes) is never an SVG.
  let text = b.subarray(0, 4096).toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes('\0')) return false;
  const stripped = text
    .replace(/^\s+/, '')
    .replace(/^<\?xml[\s\S]*?\?>\s*/i, '')
    .replace(/^(<!--[\s\S]*?-->\s*)*/, '')
    .replace(/^<!DOCTYPE[^>]*>\s*/i, '')
    .replace(/^(<!--[\s\S]*?-->\s*)*/, '');
  return /^<svg[\s>/]/i.test(stripped);
}

/** True when the buffer starts like a file of type `ext` (lower-case, with dot). */
export function sniffUploadType(buffer: Buffer, ext: string): boolean {
  const check = SNIFFERS[ext.toLowerCase()];
  return check ? check(buffer) : false;
}

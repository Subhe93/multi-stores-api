// Text helpers of the feed builders: XML escaping, CSV quoting and the
// HTML -> plain-text conversion Google / Meta want for descriptions.

/** Escapes the five XML special characters; drops control chars XML forbids. */
export function xmlEscape(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * One CSV cell (RFC 4180): quoted when it holds a comma, a quote, a line
 * break or leading/trailing spaces; quotes doubled.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value == null) return '';
  const s = String(value);
  if (s === '') return '';
  if (/[",\r\n]/.test(s) || s !== s.trim()) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    const b = body.toLowerCase();
    if (b.startsWith('#x')) {
      const code = parseInt(b.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    if (b.startsWith('#')) {
      const code = parseInt(b.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[b] ?? m;
  });
}

/**
 * HTML (or already plain text) to plain text: scripts/styles dropped, block
 * boundaries become line breaks, entities decoded, whitespace collapsed,
 * capped at `max` characters (Google: 5000) without cutting a word in half
 * where possible.
 */
export function htmlToPlainText(
  html: string | null | undefined,
  max = 5000,
): string {
  if (!html) return '';
  let s = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|section|article)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.8 ? cut.slice(0, lastSpace) : cut).trim();
}

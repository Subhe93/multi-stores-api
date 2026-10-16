/**
 * Pure cleaning helpers (M4.4 §4.3, D22). Used by mapping (WP-C) to turn the
 * raw NormalizedCatalog strings into platform values, and by the dry-run
 * summarizer to count what would change.
 *
 * HTML sanitizing itself is a seam: `HtmlSanitizer` is implemented with
 * `sanitize-html` once that dependency is approved (M4-INTEGRATION B2).
 * Nothing here pretends to sanitize — `cleanHtml` requires a sanitizer.
 */

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  times: '×',
  euro: '€',
  bull: '•',
  middot: '·',
  shy: '\u00ad',
  zwsp: '\u200b',
  aring: 'å',
  Aring: 'Å',
  auml: 'ä',
  Auml: 'Ä',
  ouml: 'ö',
  Ouml: 'Ö',
  uuml: 'ü',
  Uuml: 'Ü',
  eacute: 'é',
  Eacute: 'É',
  egrave: 'è',
  aacute: 'á',
  oslash: 'ø',
  Oslash: 'Ø',
  aelig: 'æ',
  AElig: 'Æ',
  szlig: 'ß',
};

/** Decode HTML character references (numeric + a practical named subset). Unknown names are kept. */
export function decodeHtmlEntities(input: string): string {
  if (input.indexOf('&') === -1) return input;
  return input.replace(
    /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});/gi,
    (m, body: string) => {
      if (body[0] === '#') {
        const code =
          body[1] === 'x' || body[1] === 'X'
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10);
        if (
          !Number.isFinite(code) ||
          code === 0 ||
          code > 0x10ffff ||
          (code >= 0xd800 && code <= 0xdfff)
        )
          return '�';
        return String.fromCodePoint(code);
      }
      const v = NAMED_ENTITIES[body];
      return v !== undefined ? v : m;
    },
  );
}

/** Remove Unicode format characters (`\p{Cf}`: U+200B, U+FEFF, soft hyphen, bidi marks…). */
export function removeFormatChars(input: string): string {
  return input.replace(/\p{Cf}/gu, '');
}

export interface CleanTextOptions {
  /** Remove `\p{Cf}`, NBSP → space, NFC (default true). */
  unicode?: boolean;
  /** Decode HTML entities (default true). */
  entities?: boolean;
  /** Collapse runs of whitespace and trim (default true). */
  collapse?: boolean;
}

/** Normalize a plain-text name/label (D22 / §4.3 step 1). */
export function cleanText(
  input: string | null | undefined,
  opts: CleanTextOptions = {},
): string {
  let s = input ?? '';
  if (opts.entities !== false) s = decodeHtmlEntities(s);
  if (opts.unicode !== false) {
    s = removeFormatChars(s)
      .replace(/[\u00a0\u202f\u2007]/g, ' ')
      .normalize('NFC');
  }
  if (opts.collapse !== false) s = s.replace(/\s+/g, ' ').trim();
  return s;
}

export interface TermCleanupRules {
  unicode?: boolean;
  strip_price_suffix?: boolean;
  strip_trailing_colon?: boolean;
}

export type TermCleanupRule =
  | 'unicode'
  | 'entities'
  | 'whitespace'
  | 'price_suffix'
  | 'trailing_colon';

export interface CleanedTerm {
  before: string;
  value: string;
  changed: boolean;
  applied: TermCleanupRule[];
}

const PRICE_SUFFIX_RES = [
  /\s*[-–—]\s*\d+(?:[.,]\d+)?\s*(?:kr|sek)\.?\s*$/i,
  /\s*\(\s*\+\s*\d+(?:[.,]\d+)?\s*(?:kr|sek)\.?\s*\)\s*$/i,
];

/**
 * D22 term/option cleaning, rule by rule so Mapping review can show which
 * rule changed what: "Liten (13–16 cm) - 350 kr" → "Liten (13–16 cm)",
 * "2 Inskriptioner (+50 kr)" → "2 Inskriptioner", "1 produkt:" → "1 produkt".
 */
export function cleanTermName(
  raw: string,
  rules: TermCleanupRules = {},
): CleanedTerm {
  const applied: TermCleanupRule[] = [];
  let s = raw ?? '';
  const decoded = decodeHtmlEntities(s);
  if (decoded !== s) applied.push('entities');
  s = decoded;
  if (rules.unicode !== false) {
    const u = removeFormatChars(s)
      .replace(/[\u00a0\u202f\u2007]/g, ' ')
      .normalize('NFC');
    if (u !== s) applied.push('unicode');
    s = u;
  }
  const w = s.replace(/\s+/g, ' ').trim();
  if (w !== s) applied.push('whitespace');
  s = w;
  if (rules.strip_price_suffix !== false) {
    for (const re of PRICE_SUFFIX_RES) {
      const p = s.replace(re, '').trim();
      if (p !== s && p !== '') {
        applied.push('price_suffix');
        s = p;
        break;
      }
    }
  }
  if (rules.strip_trailing_colon !== false) {
    const c = s.replace(/\s*:\s*$/, '');
    if (c !== s && c !== '') {
      applied.push('trailing_colon');
      s = c;
    }
  }
  return { before: raw, value: s, changed: s !== raw, applied };
}

// ---------------------------------------------------------------------------
// SEO strings
// ---------------------------------------------------------------------------

export interface SeoTemplateVars {
  title?: string;
  term?: string;
  sep?: string;
  sitename?: string;
  excerpt?: string;
  term_description?: string;
}

/**
 * Resolve Rank Math variables (`%title% %term% %sep% %sitename% %excerpt%
 * %term_description%`) and decode entities. Unknown variables are removed,
 * as Rank Math does for empty variables; the result is whitespace-collapsed.
 */
export function resolveSeoTemplate(
  tpl: string | null | undefined,
  vars: SeoTemplateVars,
): string {
  if (!tpl) return '';
  const resolved = tpl.replace(/%([a-z_]+)%/gi, (_m, name: string) => {
    const v = (vars as Record<string, string | undefined>)[name.toLowerCase()];
    return v ?? '';
  });
  return cleanText(resolved);
}

/** Strip tags (block tags become spaces), decode entities and collapse whitespace. */
export function htmlToPlainText(html: string | null | undefined): string {
  if (!html) return '';
  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(
      /<\/?(p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|blockquote|section|article)\b[^>]*>/gi,
      ' ',
    )
    .replace(/<[^>]+>/g, '');
  s = stripShortcodes(s).html;
  return cleanText(s);
}

/** Cut at a word boundary to at most `max` characters (code points), no ellipsis. */
export function truncateWords(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max).join('');
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:–-]+$/, '');
}

/** Rank Math `%excerpt%` behaviour for `meta_desc`: plain excerpt cut to ≤160. */
export function metaDescriptionFromExcerpt(
  excerptHtml: string | null | undefined,
  max = 160,
): string {
  return truncateWords(htmlToPlainText(excerptHtml), max);
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

export interface ShortcodeResult {
  html: string;
  videos: string[];
  removed: { video: number; namez_card: number; caption: number };
}

const VIDEO_URL_ATTRS = ['mp4', 'm4v', 'webm', 'ogv', 'wmv', 'flv', 'src'];

function attrValue(attrs: string, name: string): string | null {
  const m = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s\\]]+))`,
    'i',
  ).exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

/**
 * §4.3 step 3 — only the known shortcodes are touched:
 * `[video …]…[/video]` (URL extracted, W_VIDEO_UNSUPPORTED), `[namez_card]`
 * (removed, W_SHORTCODE_REMOVED) and `[caption …]…[/caption]` (unwrapped).
 * Any other bracket text (`[data-…`, `calc(…)` …) is left alone.
 */
export function stripShortcodes(html: string): ShortcodeResult {
  const videos: string[] = [];
  const removed = { video: 0, namez_card: 0, caption: 0 };
  let out = html.replace(
    /\[video(\s[^\]]*)?\]([\s\S]*?\[\/video\])?/gi,
    (_m, attrs: string | undefined) => {
      removed.video++;
      for (const a of VIDEO_URL_ATTRS) {
        const v = attrValue(attrs ?? '', a);
        if (v && !videos.includes(v)) videos.push(v);
      }
      return '';
    },
  );
  out = out.replace(
    /\[namez_card(\s[^\]]*)?\](?:[\s\S]*?\[\/namez_card\])?/gi,
    () => {
      removed.namez_card++;
      return '';
    },
  );
  out = out.replace(
    /\[caption(\s[^\]]*)?\]([\s\S]*?)\[\/caption\]/gi,
    (_m, _a, inner: string) => {
      removed.caption++;
      return inner;
    },
  );
  return { html: out, videos, removed };
}

export interface HtmlScan {
  /** Number of `data-*` attributes (ChatGPT leftovers such as `data-start`). */
  data_attributes: number;
  /** `<script|style|iframe|object|embed|form>` elements. */
  unsafe_elements: number;
  /** `on*=` handler attributes. */
  event_handlers: number;
  javascript_urls: number;
  inline_images: string[];
  shortcodes: ShortcodeResult['removed'];
  videos: string[];
}

function countInTags(html: string, attrRe: RegExp): number {
  let n = 0;
  for (const tag of html.matchAll(/<[a-z][^>]*>/gi))
    n += tag[0].match(attrRe)?.length ?? 0;
  return n;
}

/** Report what cleaning/sanitizing will change, without changing anything. */
export function scanHtml(html: string | null | undefined): HtmlScan {
  const s = html ?? '';
  const sc = stripShortcodes(s);
  const images: string[] = [];
  for (const m of s.matchAll(
    /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
  )) {
    images.push(m[1] ?? m[2] ?? '');
  }
  return {
    data_attributes: countInTags(s, /\sdata-[\w-]+(?=\s*=|\s|\/|>)/gi),
    unsafe_elements: (
      s.match(/<(script|style|iframe|object|embed|form)\b/gi) ?? []
    ).length,
    event_handlers: countInTags(s, /\son[a-z]+\s*=/gi),
    javascript_urls: (
      s.match(/\b(?:href|src)\s*=\s*["']?\s*javascript:/gi) ?? []
    ).length,
    inline_images: images,
    shortcodes: sc.removed,
    videos: sc.videos,
  };
}

/** Allowlist sanitizer (sanitize-html, §4.3 step 4). Implemented in WP-C once the dependency is approved. */
export interface HtmlSanitizer {
  sanitize(html: string): string;
}

/** §4.3 step 4 allowlist, shared with the sanitizer implementation. */
export const HTML_ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'a',
  'img',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'span',
  'div',
  'hr',
] as const;
export const HTML_ALLOWED_ATTRIBUTES: Record<string, readonly string[]> = {
  a: ['href', 'title', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height'],
};

export interface CleanHtmlResult {
  html: string;
  videos: string[];
  removed_shortcodes: ShortcodeResult['removed'];
}

/** §4.3 steps 3–4: known shortcodes, then the allowlist sanitizer (required). */
export function cleanHtml(
  html: string | null | undefined,
  sanitizer: HtmlSanitizer,
): CleanHtmlResult {
  const sc = stripShortcodes(html ?? '');
  return {
    html: sanitizer.sanitize(sc.html).trim(),
    videos: sc.videos,
    removed_shortcodes: sc.removed,
  };
}

import { Injectable, Provider } from '@nestjs/common';
import sanitizeHtml from 'sanitize-html';
import {
  decodeHtmlEntities,
  HTML_ALLOWED_ATTRIBUTES,
  HTML_ALLOWED_TAGS,
  type HtmlSanitizer,
} from '../model/clean';

/**
 * HTML sanitizer seam of the importer (M4.4 D11, §4.3 step 4).
 *
 * Two implementations share the `IMPORTER_HTML_SANITIZER` token:
 *
 * - `AllowlistHtmlSanitizer` (`mode: 'allowlist'`, the default): `sanitize-html`
 *   with the allowlist of `model/clean.ts` (`HTML_ALLOWED_TAGS` /
 *   `HTML_ALLOWED_ATTRIBUTES`), http/https URLs only, no inline styles, no
 *   `on*` handlers, no `javascript:` / `data:` URLs, nested anchors
 *   flattened, external links get `rel="noopener nofollow"`, and `<img>` kept
 *   only when its host is allowed (the source host and the run option
 *   `inline_image_hosts`; without a context the caller is expected to have
 *   filtered hosts already, as `mapping/map-product.ts` does).
 * - `PlainTextHtmlSanitizer` (`mode: 'plain_text_fallback'`): keeps no source
 *   markup at all (text rebuilt as `<p>` / `<br>`). Selected with the env
 *   `IMPORTER_HTML_SANITIZER=plain` for emergencies; every plan / run that
 *   used it records `W_HTML_SANITIZER_FALLBACK`.
 *
 * The sanitized HTML is part of the ledger `source_hash`, so switching the
 * sanitizer makes every product with markup an UPDATE on the next run.
 */

export const IMPORTER_HTML_SANITIZER = Symbol('IMPORTER_HTML_SANITIZER');

/** Warning code recorded in every plan/run that used the fallback. */
export const W_HTML_SANITIZER_FALLBACK = 'W_HTML_SANITIZER_FALLBACK';

/** Env switch: `IMPORTER_HTML_SANITIZER=plain` binds the plain-text fallback. */
export const IMPORTER_HTML_SANITIZER_ENV = 'IMPORTER_HTML_SANITIZER';

/**
 * Optional host context for `<img>` / `<a>` decisions. Without it every
 * http(s) image is kept and every absolute link counts as external.
 */
export interface HtmlSanitizeContext {
  /** Host of the source site (images there are rewritten by the media pipeline). */
  source_host?: string | null;
  /** Extra hosts whose inline images are kept (run option `inline_image_hosts`). */
  image_hosts?: readonly string[];
}

export interface HtmlSanitizeResult {
  html: string;
  /** True when sanitizing removed or rewrote markup (→ `W_HTML_SANITIZED`). */
  changed: boolean;
  /** `<img>` dropped for their host or URL scheme (→ `W_HTML_IMAGE_REMOVED`). */
  images_removed: number;
}

export interface ImporterHtmlSanitizer extends HtmlSanitizer {
  /** `allowlist` = real sanitizer; `plain_text_fallback` = markup dropped. */
  readonly mode: 'allowlist' | 'plain_text_fallback';
  sanitize(html: string, ctx?: HtmlSanitizeContext): string;
  /** `sanitize` plus what it changed, for warnings. */
  sanitizeDetailed(html: string, ctx?: HtmlSanitizeContext): HtmlSanitizeResult;
}

/** Elements whose content is dropped together with the element. */
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'template',
  'noscript',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'head',
  'title',
  'xmp',
  'noembed',
  'noframes',
  'textarea',
  'select',
  'canvas',
  'audio',
  'video',
  'button',
]);

/** Elements that start/end a paragraph. */
const PARAGRAPH_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'aside',
  'nav',
  'main',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'dl',
  'table',
  'blockquote',
  'pre',
  'figure',
  'figcaption',
  'hr',
  'address',
  'details',
  'summary',
  'form',
  'fieldset',
]);

/** Elements that start a new line inside the current paragraph. */
const LINE_TAGS = new Set(['br', 'li', 'tr', 'dt', 'dd', 'caption']);

/** Elements whose content is separated by a space (table cells). */
const SPACE_TAGS = new Set(['td', 'th']);

type Piece =
  | { kind: 'text'; text: string }
  | { kind: 'para' | 'line' | 'bullet' };

const TAG_NAME_RE = /^<\/?([a-zA-Z][a-zA-Z0-9:-]*)/;

/** Index of the `>` that closes the tag starting at `from`, quotes respected; -1 when unterminated. */
function tagEnd(html: string, from: number): number {
  let quote: string | null = null;
  for (let j = from; j < html.length; j++) {
    const c = html[j];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return j;
  }
  return -1;
}

/** Splits HTML into text pieces and paragraph/line markers; markup itself is discarded. */
function tokenize(html: string): Piece[] {
  const out: Piece[] = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out.push({ kind: 'text', text: html.slice(i) });
      break;
    }
    if (lt > i) out.push({ kind: 'text', text: html.slice(i, lt) });
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    const next = html[lt + 1];
    if (next === '!' || next === '?') {
      // Doctype, CDATA, processing instruction: dropped.
      const end = html.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const m = TAG_NAME_RE.exec(html.slice(lt, lt + 80));
    if (!m) {
      // A lone "<" is text (escaped on output).
      out.push({ kind: 'text', text: '<' });
      i = lt + 1;
      continue;
    }
    const end = tagEnd(html, lt + m[0].length);
    if (end === -1) break; // unterminated tag: drop the rest
    const name = m[1].toLowerCase();
    const closing = next === '/';
    const selfClosing = html[end - 1] === '/';
    i = end + 1;
    if (!closing && !selfClosing && DROP_WITH_CONTENT.has(name)) {
      const closeRe = new RegExp(`</${name}[\\s/>]`, 'ig');
      closeRe.lastIndex = i;
      const close = closeRe.exec(html);
      if (!close) {
        i = n;
        break;
      }
      const closeEnd = tagEnd(html, close.index + 2 + name.length);
      i = closeEnd === -1 ? n : closeEnd + 1;
      continue;
    }
    if (PARAGRAPH_TAGS.has(name)) out.push({ kind: 'para' });
    else if (LINE_TAGS.has(name)) {
      if (!closing) out.push({ kind: 'line' });
      if (name === 'li' && !closing) out.push({ kind: 'bullet' });
    } else if (SPACE_TAGS.has(name)) out.push({ kind: 'text', text: ' ' });
  }
  return out;
}

export function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * HTML → escaped plain text in `<p>` paragraphs with `<br>` line breaks.
 * Text newlines follow WordPress `wpautop` (blank line = paragraph, single
 * newline = line break), because WooCommerce content is stored that way.
 * The output contains no source markup: every `<` of the text is escaped.
 */
export function htmlToSafeParagraphs(html: string | null | undefined): string {
  const paragraphs: string[][] = [[]];
  const current = () => paragraphs[paragraphs.length - 1];
  const newParagraph = () => {
    if (current().some((l) => l.trim() !== '')) paragraphs.push([]);
    else paragraphs[paragraphs.length - 1] = [];
  };
  const newLine = () => current().push('');
  const appendText = (text: string) => {
    const p = current();
    if (p.length === 0) p.push('');
    p[p.length - 1] += text;
  };

  // A list bullet is written in front of the item's first text, so markup
  // inside the item (<p>, <strong>) never leaves a lone "•".
  let bullet = false;
  for (const piece of tokenize(html ?? '')) {
    if (piece.kind === 'bullet') bullet = true;
    else if (piece.kind !== 'text') {
      if (piece.kind === 'para') newParagraph();
      else newLine();
    } else {
      // Whitespace-only text between tags is formatting, not wpautop breaks.
      if (/^\s*$/.test(piece.text)) {
        if (piece.text) appendText(' ');
        continue;
      }
      let text = decodeHtmlEntities(piece.text).replace(/\r\n?/g, '\n');
      if (bullet) {
        text = `• ${text.replace(/^\s+/, '')}`;
        bullet = false;
      }
      const blocks = text.split(/\n[ \t]*\n/);
      blocks.forEach((block, bi) => {
        if (bi > 0) newParagraph();
        block.split('\n').forEach((line, li) => {
          if (li > 0) newLine();
          appendText(line.replace(/[ \t\f\v]+/g, ' '));
        });
      });
    }
  }

  return paragraphs
    .map((lines) =>
      lines
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .filter((l, idx, arr) => l !== '' || (idx > 0 && arr[idx - 1] !== '')),
    )
    .map((lines) => {
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      return lines;
    })
    .filter((lines) => lines.length > 0)
    .map((lines) => `<p>${lines.map(escapeHtmlText).join('<br>')}</p>`)
    .join('');
}

/** Plain-text fallback (`IMPORTER_HTML_SANITIZER=plain`). */
@Injectable()
export class PlainTextHtmlSanitizer implements ImporterHtmlSanitizer {
  readonly mode = 'plain_text_fallback' as const;

  sanitize(html: string): string {
    return htmlToSafeParagraphs(html);
  }

  sanitizeDetailed(html: string): HtmlSanitizeResult {
    const out = htmlToSafeParagraphs(html);
    return {
      html: out,
      changed: out !== (html ?? ''),
      images_removed: (html ?? '').match(/<img\b/gi)?.length ?? 0,
    };
  }
}

// ── Allowlist sanitizer ───────────────────────────────────────────────────

/** Elements whose text content is dropped with the element (sanitize-html `nonTextTags`). */
const NON_TEXT_TAGS = [
  'script',
  'style',
  'textarea',
  'option',
  'select',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'head',
  'title',
  'xmp',
  'noembed',
  'noframes',
  'canvas',
  'audio',
  'video',
  'button',
];

const URL_SCHEMES = ['http', 'https'];
const DIMENSION_RE = /^\d{1,5}$/;

/**
 * Classifies a URL attribute: `relative` (no scheme, so on the source
 * host; `//host/...` is rewritten to https and treated as absolute),
 * `absolute` http(s) with its host, or `rejected` (any other scheme,
 * `javascript:`, `data:`, unparsable).
 */
function classifyUrl(
  raw: string,
):
  | { kind: 'relative' }
  | { kind: 'absolute'; url: string; host: string }
  | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (value.startsWith('//')) return classifyUrl(`https:${value}`);
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    // No scheme at all. A control character or a stray colon later on is
    // still a scheme attempt for some browsers: let sanitize-html decide.
    // eslint-disable-next-line no-control-regex
    return /^[\s\u0000-\u001f]*(javascript|data|vbscript)\s*:/i.test(value)
      ? null
      : { kind: 'relative' };
  }
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase();
    return host ? { kind: 'absolute', url: u.toString(), host } : null;
  } catch {
    return null;
  }
}

/**
 * sanitize-html keeps `<a>` inside `<a>` (htmlparser2 does not auto-close
 * it); the inner anchor's tags are removed, its text stays. The input is
 * sanitize-html output, so every tag is well formed and attribute values
 * are entity-escaped (no `>` inside them).
 */
export function unnestAnchors(html: string): string {
  if (!/<\/?a\b/i.test(html)) return html;
  let depth = 0;
  return html.replace(/<a\b[^>]*>|<\/a\s*>/gi, (tag) => {
    if (tag[1] === '/') {
      if (depth === 0) return '';
      depth--;
      return depth === 0 ? tag : '';
    }
    depth++;
    return depth === 1 ? tag : '';
  });
}

const BLOCK_TAG_RE =
  /<(p|div|ul|ol|li|h[1-6]|table|blockquote|pre|section|article|figure|hr)\b/i;

/**
 * WordPress stores content without `<p>` and applies `wpautop` at render
 * time. Content that has no block element at all but does have newlines
 * gets the same treatment (blank line = paragraph, newline = `<br>`), so
 * the storefront, which renders the stored HTML as is, keeps the breaks.
 * Content that already carries block markup is left alone.
 */
export function autoParagraphs(html: string): string {
  if (!/\n/.test(html) || BLOCK_TAG_RE.test(html)) return html;
  const text = html.replace(/\r\n?/g, '\n').trim();
  if (!text) return '';
  return text
    .split(/\n[ \t]*\n+/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => `<p>${p.replace(/[ \t]*\n[ \t]*/g, '<br />')}</p>`)
    .join('');
}

/**
 * The real D11 sanitizer. Pure and stateless: one instance serves every
 * run; the host context is passed per call.
 */
@Injectable()
export class AllowlistHtmlSanitizer implements ImporterHtmlSanitizer {
  readonly mode = 'allowlist' as const;

  sanitize(html: string, ctx: HtmlSanitizeContext = {}): string {
    return this.run(html, ctx).html;
  }

  sanitizeDetailed(
    html: string,
    ctx: HtmlSanitizeContext = {},
  ): HtmlSanitizeResult {
    const r = this.run(html, ctx);
    // "Changed" compares against the same serializer with nothing removed,
    // so `<br/>` → `<br />` re-serialization alone never counts as a change.
    const canonical = sanitizeHtml(autoParagraphs(html ?? ''), {
      allowedTags: false,
      allowedAttributes: false,
      allowVulnerableTags: true,
      allowProtocolRelative: true,
      nonTextTags: [],
    });
    return {
      html: r.html,
      changed: r.html !== canonical.trim() || r.images_removed > 0,
      images_removed: r.images_removed,
    };
  }

  private run(
    html: string,
    ctx: HtmlSanitizeContext,
  ): { html: string; images_removed: number } {
    const sourceHost = ctx.source_host?.toLowerCase() || null;
    const imageHosts = new Set(
      [sourceHost, ...(ctx.image_hosts ?? [])]
        .filter((h): h is string => !!h)
        .map((h) => h.toLowerCase()),
    );
    const restrictImages = sourceHost !== null || imageHosts.size > 0;
    let images_removed = 0;
    const out = sanitizeHtml(autoParagraphs(html ?? ''), {
      allowedTags: [...HTML_ALLOWED_TAGS],
      allowedAttributes: Object.fromEntries(
        Object.entries(HTML_ALLOWED_ATTRIBUTES).map(([k, v]) => [k, [...v]]),
      ),
      allowedSchemes: URL_SCHEMES,
      allowedSchemesAppliedToAttributes: ['href', 'src'],
      allowProtocolRelative: false,
      disallowedTagsMode: 'discard',
      nonTextTags: NON_TEXT_TAGS,
      parseStyleAttributes: false,
      transformTags: {
        a: (tagName, attribs) => {
          const link = classifyUrl(attribs.href ?? '');
          const external =
            link?.kind === 'absolute' && link.host !== sourceHost;
          const rel = new Set(
            (attribs.rel ?? '')
              .toLowerCase()
              .split(/\s+/)
              .filter((t) => /^(nofollow|noopener|noreferrer)$/.test(t)),
          );
          const blank = attribs.target === '_blank';
          if (external || blank) {
            rel.add('noopener');
            if (external) rel.add('nofollow');
          }
          const kept: Record<string, string> = {};
          // Rejected schemes are left to sanitize-html's own check (dropped).
          if (link?.kind === 'absolute') kept.href = link.url;
          else if (attribs.href) kept.href = attribs.href;
          if (attribs.title) kept.title = attribs.title;
          if (blank) kept.target = '_blank';
          if (rel.size) kept.rel = [...rel].sort().join(' ');
          return { tagName, attribs: kept };
        },
        img: (tagName, attribs) => {
          const kept: Record<string, string> = {};
          const src = classifyUrl(attribs.src ?? '');
          // Relative = on the source host; absolute = host must be allowed.
          const keep =
            src?.kind === 'relative' ||
            (src?.kind === 'absolute' &&
              (!restrictImages || imageHosts.has(src.host)));
          if (keep) {
            kept.src = src.kind === 'absolute' ? src.url : attribs.src.trim();
            if (attribs.alt !== undefined) kept.alt = attribs.alt;
            if (DIMENSION_RE.test(attribs.width ?? ''))
              kept.width = attribs.width;
            if (DIMENSION_RE.test(attribs.height ?? ''))
              kept.height = attribs.height;
          }
          return { tagName, attribs: kept };
        },
      },
      // Images without an acceptable src are dropped as a whole, not kept as `<img />`.
      exclusiveFilter: (frame) => {
        if (frame.tag === 'img' && !frame.attribs.src) {
          images_removed++;
          return true;
        }
        return false;
      },
    });
    return { html: unnestAnchors(out).trim(), images_removed };
  }
}

/** `IMPORTER_HTML_SANITIZER=plain` → fallback; anything else → allowlist. */
export function createImporterHtmlSanitizer(
  env: NodeJS.ProcessEnv = process.env,
): ImporterHtmlSanitizer {
  return (env[IMPORTER_HTML_SANITIZER_ENV] ?? '').trim().toLowerCase() ===
    'plain'
    ? new PlainTextHtmlSanitizer()
    : new AllowlistHtmlSanitizer();
}

/** Nest binding of the token (resolved once at boot from the env). */
export const importerHtmlSanitizerProvider: Provider = {
  provide: IMPORTER_HTML_SANITIZER,
  useFactory: () => createImporterHtmlSanitizer(),
};

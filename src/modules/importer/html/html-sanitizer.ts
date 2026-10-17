import { Injectable, Provider } from '@nestjs/common';
import { decodeHtmlEntities, type HtmlSanitizer } from '../model/clean';

/**
 * HTML sanitizer seam of the importer (M4.4 D11, §4.3 step 4).
 *
 * STATUS: the `sanitize-html` dependency the design calls for (allowlist in
 * `model/clean.ts`: `HTML_ALLOWED_TAGS` / `HTML_ALLOWED_ATTRIBUTES`) is
 * PENDING APPROVAL (M4-INTEGRATION B2) and is not installed. No allowlist
 * sanitizer is written by hand in its place.
 *
 * WHAT RUNS TODAY: the token is bound to `PlainTextHtmlSanitizer`
 * (`mode: 'plain_text_fallback'`). It keeps no source markup: the HTML is
 * tokenized only to find paragraph / line boundaries and to drop the content
 * of script, style, iframe, form and similar elements; every tag and
 * attribute is discarded, the remaining text is HTML-escaped, and the output
 * is rebuilt as `<p>` / `<br>` that the sanitizer itself generates
 * (`htmlToSafeParagraphs`). Descriptions therefore lose their formatting and
 * inline images, and every plan / run that used it records
 * `W_HTML_SANITIZER_FALLBACK`.
 *
 * Switching to the real sanitizer once approved is one place: implement
 * `ImporterHtmlSanitizer` with `mode: 'allowlist'` over `sanitize-html`
 * (allowedTags = HTML_ALLOWED_TAGS, allowedAttributes =
 * HTML_ALLOWED_ATTRIBUTES, allowedSchemes http/https/mailto) and change
 * `useClass` in `importerHtmlSanitizerProvider` below.
 */

export const IMPORTER_HTML_SANITIZER = Symbol('IMPORTER_HTML_SANITIZER');

/** Warning code recorded in every plan/run that used the fallback. */
export const W_HTML_SANITIZER_FALLBACK = 'W_HTML_SANITIZER_FALLBACK';

export interface ImporterHtmlSanitizer extends HtmlSanitizer {
  /** `allowlist` = real sanitizer; `plain_text_fallback` = markup dropped. */
  readonly mode: 'allowlist' | 'plain_text_fallback';
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

/** Safe fallback bound until `sanitize-html` is approved (see the file header). */
@Injectable()
export class PlainTextHtmlSanitizer implements ImporterHtmlSanitizer {
  readonly mode = 'plain_text_fallback' as const;

  sanitize(html: string): string {
    return htmlToSafeParagraphs(html);
  }
}

/** The one binding to change when the allowlist sanitizer lands. */
export const importerHtmlSanitizerProvider: Provider = {
  provide: IMPORTER_HTML_SANITIZER,
  useClass: PlainTextHtmlSanitizer,
};

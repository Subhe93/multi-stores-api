import sanitizeHtml from 'sanitize-html';

/**
 * Write-time sanitizer for creator-authored HTML that the storefront renders
 * with `dangerouslySetInnerHTML` (product description / short_description,
 * product FAQ answers, category / collection descriptions, the store
 * description and legacy static page content).
 *
 * The profile keeps what the dashboard Tiptap editor produces (block and
 * inline formatting, links, images, tables, embedded video) and drops every
 * active-content vector: `script` / `style` tags, `on*` handlers, `form` /
 * `input` / `object` / `embed`, `javascript:` and `data:` URLs, inline
 * styles outside a small allowlist, and `iframe`s whose src is not an https
 * YouTube / Vimeo embed. External links that open in a new tab get
 * `rel="noopener noreferrer"`.
 *
 * The WooCommerce importer has its own sanitizer
 * (`modules/importer/html/html-sanitizer.ts`); this one is for the dashboard
 * write paths and the one-off `prisma/scripts/sanitize-existing-html.ts`.
 * Pure and stateless: one shared options object serves every call.
 */

const ALLOWED_TAGS = [
  'p',
  'br',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'blockquote',
  'ul',
  'ol',
  'li',
  'a',
  'img',
  'figure',
  'figcaption',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'hr',
  'span',
  'div',
  'code',
  'pre',
  'sub',
  'sup',
  'mark',
  'video',
  'source',
  'iframe',
] as const;

/** Attributes allowed on every tag; URL-bearing ones are scheme-checked. */
const GLOBAL_ATTRIBUTES = ['class', 'title', 'style'] as const;

const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions['allowedAttributes'] = {
  '*': [...GLOBAL_ATTRIBUTES],
  a: ['href', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height', 'loading'],
  video: ['src', 'controls', 'poster', 'width', 'height'],
  source: ['src'],
  iframe: ['src', 'width', 'height', 'title', 'loading'],
  th: ['colspan', 'rowspan'],
  td: ['colspan', 'rowspan'],
};

/** Hosts whose https embeds are kept in `<iframe src>` (subdomains included). */
const IFRAME_DOMAINS = ['youtube.com', 'youtube-nocookie.com', 'vimeo.com'];

const COLOR_RE =
  /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\)|[a-z]{3,20})$/i;

/** Elements whose text content is dropped together with the element. */
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
  'button',
];

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...ALLOWED_TAGS],
  allowedAttributes: ALLOWED_ATTRIBUTES,
  // Same scheme policy as the importer: no javascript:, no data: (not even
  // data:image on <img>), no vbscript:. Relative URLs stay as they are.
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { iframe: ['https'] },
  allowedSchemesAppliedToAttributes: ['href', 'src', 'poster'],
  allowProtocolRelative: false,
  allowedIframeDomains: IFRAME_DOMAINS,
  allowIframeRelativeUrls: false,
  allowedStyles: {
    '*': {
      'text-align': [/^(left|right|center|justify|start|end)$/i],
      color: [COLOR_RE],
      'background-color': [COLOR_RE],
      'font-weight': [/^(normal|bold|bolder|lighter|[1-9]00)$/i],
    },
  },
  disallowedTagsMode: 'discard',
  nonTextTags: NON_TEXT_TAGS,
  // `source` is a void element too; sanitize-html's default list lacks it.
  selfClosing: [
    'img',
    'br',
    'hr',
    'area',
    'base',
    'basefont',
    'input',
    'link',
    'meta',
    'source',
  ],
  transformTags: {
    a: (tagName, attribs) => {
      const kept: Record<string, string> = { ...attribs };
      const blank = attribs.target === '_blank';
      if (attribs.target !== undefined && !blank) delete kept.target;
      const rel = new Set(
        (attribs.rel ?? '')
          .toLowerCase()
          .split(/\s+/)
          .filter((t) => /^(nofollow|noopener|noreferrer)$/.test(t)),
      );
      if (blank) {
        rel.add('noopener');
        rel.add('noreferrer');
      }
      if (rel.size) kept.rel = [...rel].sort().join(' ');
      else delete kept.rel;
      return { tagName, attribs: kept };
    },
  },
  // An <iframe> / <img> / <source> whose URL was rejected is dropped as a
  // whole instead of being kept as an empty element.
  exclusiveFilter: (frame) =>
    (frame.tag === 'iframe' || frame.tag === 'img' || frame.tag === 'source') &&
    !frame.attribs.src,
};

/**
 * Sanitizes creator HTML for storage. `null` / `undefined` / whitespace-only
 * input, and input that is empty after sanitizing, give `null`.
 */
export function sanitizeCreatorHtml(
  html: string | null | undefined,
): string | null {
  if (html == null) return null;
  if (html.trim() === '') return null;
  const out = sanitizeHtml(html, OPTIONS).trim();
  return out === '' ? null : out;
}

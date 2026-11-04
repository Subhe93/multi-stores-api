import { StaticPageType } from '@prisma/client';
import {
  STORE_LEGAL_TEMPLATES,
  type StoreLegalSlug,
  type StoreLegalTemplate,
  type TemplateLocale,
} from './templates.data';

export type { StoreLegalSlug, TemplateLocale } from './templates.data';

/**
 * Store legal pages (plans/store-legal-pages/SPEC.md): the `/legal/{slug}`
 * slugs of a storefront, in their fixed display order.
 */
export const STORE_LEGAL_SLUGS: readonly StoreLegalSlug[] = Object.freeze([
  'privacy',
  'terms',
  'refund',
  'shipping',
]);

/** Store page kind (legacy StaticPage.type / v2 Page.static_kind) of each slug. */
export const STORE_LEGAL_KIND: Readonly<
  Record<StoreLegalSlug, StaticPageType>
> = Object.freeze({
  privacy: StaticPageType.PRIVACY_POLICY,
  terms: StaticPageType.TERMS,
  refund: StaticPageType.RETURN_POLICY,
  shipping: StaticPageType.SHIPPING_POLICY,
});

/** Base slug of the v2 page `from-template` creates for each legal slug. */
export const STORE_LEGAL_PAGE_SLUG: Readonly<Record<StoreLegalSlug, string>> =
  Object.freeze({
    privacy: 'privacy-policy',
    terms: 'terms',
    refund: 'return-policy',
    shipping: 'shipping-policy',
  });

export function isStoreLegalSlug(value: unknown): value is StoreLegalSlug {
  return (
    typeof value === 'string' &&
    (STORE_LEGAL_SLUGS as readonly string[]).includes(value)
  );
}

/** `sv-SE` / `SV` → `sv`; anything else as lower case. */
function baseLocale(locale?: string | null): string {
  return (locale ?? '').trim().toLowerCase().split(/[-_]/)[0];
}

/** Whether a template exists for exactly this locale (no fallback). */
export function hasTemplate(
  slug: StoreLegalSlug,
  locale?: string | null,
): boolean {
  const l = baseLocale(locale) as TemplateLocale;
  return Boolean(STORE_LEGAL_TEMPLATES[slug]?.[l]);
}

/**
 * The template of a slug in `locale`, else English, else any available
 * locale. `locale` is the locale the returned text is written in.
 */
export function pickTemplate(
  slug: StoreLegalSlug,
  locale?: string | null,
): (StoreLegalTemplate & { locale: TemplateLocale }) | null {
  const byLocale = STORE_LEGAL_TEMPLATES[slug];
  if (!byLocale) return null;
  const wanted = baseLocale(locale) as TemplateLocale;
  if (byLocale[wanted]) return { ...byLocale[wanted], locale: wanted };
  if (byLocale.en) return { ...byLocale.en, locale: 'en' };
  const first = (Object.keys(byLocale) as TemplateLocale[]).find(
    (l) => byLocale[l],
  );
  return first ? { ...byLocale[first]!, locale: first } : null;
}

/** Placeholder values of a template, keyed like `trader.legal_name`. */
export type StoreTemplateContext = Record<string, string | null | undefined>;

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function valueOf(ctx: StoreTemplateContext, key: string): string {
  const v = ctx[key];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * An innermost `<span data-if="key">…</span>` (its body holds no other
 * `<span`), so nested conditionals resolve from the inside out.
 */
const DATA_IF_SPAN =
  /<span\s+data-if\s*=\s*(["'])([\w.]+)\1\s*>((?:(?!<span[\s>])[\s\S])*?)<\/span>/gi;

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/** A `<p>` / `<li>` with nothing but whitespace (plus its line break). */
const EMPTY_BLOCK = /<(p|li)>\s*<\/\1>\n?/g;

/**
 * Fills a store legal template: every `<span data-if="key">` is removed when
 * the value is empty, else unwrapped (its content kept); then every
 * `{{key}}` is replaced by the HTML-escaped value (unknown or empty keys
 * become ''). A paragraph or list item left empty by a removed conditional
 * (e.g. `<p><span data-if="trader.address">…</span></p>`) is dropped. The
 * result still goes through the HTML sanitizer.
 */
export function fillStoreTemplate(
  html: string,
  ctx: StoreTemplateContext,
): string {
  let out = html;
  for (let guard = 0; guard < 20; guard++) {
    const next = out.replace(
      DATA_IF_SPAN,
      (_m, _q: string, key: string, body: string) =>
        valueOf(ctx, key) ? body : '',
    );
    if (next === out) break;
    out = next;
  }
  out = out.replace(EMPTY_BLOCK, '');
  return out.replace(PLACEHOLDER, (_m, key: string) =>
    escapeHtml(valueOf(ctx, key)),
  );
}

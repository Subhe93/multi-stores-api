// Store SEO settings as the storefront payload exposes them
// (`theme.seo`, from the freeform `Store.theme_config.seo` JSON).
//
// M166 F: `brandName` is the explicit brand / organization name of the
// schema.org output (Organization name, Product brand). The dashboard trims
// and caps it on input; this guard keeps the public payload safe for any
// value already stored or written through the API: a string only, control
// characters removed, whitespace collapsed, at most BRAND_NAME_MAX
// characters. Empty or invalid values are dropped, so the storefront falls
// back to its automatic name. Every other seo key passes through unchanged.

export const BRAND_NAME_MAX = 70;

export function sanitizeBrandName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b\u2028\u2029\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return undefined;
  // Cap by code points (never split a surrogate pair), then re-trim.
  return Array.from(clean).slice(0, BRAND_NAME_MAX).join('').trim() || undefined;
}

export function sanitizeThemeSeo(seo: unknown): Record<string, unknown> {
  if (!seo || typeof seo !== 'object' || Array.isArray(seo)) return {};
  const out: Record<string, unknown> = { ...(seo as Record<string, unknown>) };
  if ('brandName' in out) {
    const brandName = sanitizeBrandName(out.brandName);
    if (brandName) out.brandName = brandName;
    else delete out.brandName;
  }
  return out;
}

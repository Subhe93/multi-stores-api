// Brand fields the legacy `theme_config` may carry. When a theme (or a look
// preset) is applied these must be dropped so the theme's own colours/fonts
// take effect, while non-brand config (socials, contact, SEO, translations,
// header) is preserved untouched.
const BRAND_KEYS = [
  'primaryColor',
  'secondaryColor',
  'fontFamily',
  'typography',
] as const;

/**
 * Return a copy of `theme_config` without the legacy brand override fields.
 * Accepts the raw Prisma JSON value; non-object input yields `{}`.
 */
export function stripBrandFromThemeConfig(
  themeConfig: unknown,
): Record<string, unknown> {
  if (!themeConfig || typeof themeConfig !== 'object') return {};
  if (Array.isArray(themeConfig)) return {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(
    themeConfig as Record<string, unknown>,
  )) {
    if ((BRAND_KEYS as readonly string[]).includes(key)) continue;
    rest[key] = value;
  }
  return rest;
}

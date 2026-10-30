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

// Storefront account pages (login / register / password reset) look,
// stored as `theme_config.auth`. Lives in theme_config so applying a theme
// or look preset keeps it (only brand keys are stripped).
export type AuthImagePosition = 'center' | 'top' | 'bottom';

export interface AuthPagesConfig {
  background_image?: string;
  background_color?: string;
  image_position?: AuthImagePosition;
  overlay_opacity?: number;
}

const AUTH_IMAGE_POSITIONS: readonly AuthImagePosition[] = [
  'center',
  'top',
  'bottom',
];
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// Absolute http(s) URL or a root-relative upload path; no quotes,
// parentheses, brackets or whitespace (safe inside CSS url() and attributes).
const SAFE_IMAGE_URL = /^(?:https?:\/\/|\/(?!\/))[^\s"'()<>\\]+$/i;
const MAX_IMAGE_URL_LENGTH = 2048;
const MAX_OVERLAY_OPACITY = 90;

/**
 * Whitelist + normalise the freeform `theme_config.auth` object before it is
 * served to the storefront. Unknown keys and invalid values are dropped;
 * the result is `{}` when nothing valid is set.
 */
export function sanitizeAuthPagesConfig(raw: unknown): AuthPagesConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const out: AuthPagesConfig = {};

  const image = src.background_image;
  if (
    typeof image === 'string' &&
    image.length <= MAX_IMAGE_URL_LENGTH &&
    SAFE_IMAGE_URL.test(image.trim())
  ) {
    out.background_image = image.trim();
  }

  const color = src.background_color;
  if (typeof color === 'string' && HEX_COLOR.test(color.trim())) {
    out.background_color = color.trim();
  }

  const position = src.image_position;
  if (
    typeof position === 'string' &&
    (AUTH_IMAGE_POSITIONS as readonly string[]).includes(position)
  ) {
    out.image_position = position as AuthImagePosition;
  }

  const opacity = src.overlay_opacity;
  if (typeof opacity === 'number' && Number.isFinite(opacity) && opacity > 0) {
    out.overlay_opacity = Math.min(MAX_OVERLAY_OPACITY, Math.round(opacity));
  }

  return out;
}

/**
 * Store-wide custom CSS lives in `theme_customizations.customCss` next to the
 * design tokens, but it is owner content, not a look token: resetting the
 * tokens (applying a preset, picking a base theme with reset) must keep it.
 *
 * Returns `{ customCss }` when the previous customizations carry a non-empty
 * string, else `{}` — spread it into the new customizations object.
 */
export function keepOwnerCss(previous: unknown): { customCss?: string } {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) {
    return {};
  }
  const css = (previous as { customCss?: unknown }).customCss;
  return typeof css === 'string' && css.trim() !== '' ? { customCss: css } : {};
}

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

/**
 * Everything of the store's own that survives a look reset (a preset apply,
 * "Reset to theme"): the custom CSS plus the store's behaviour settings.
 *  - `motion`: kept when it is a non-empty plain object.
 *  - `product.card`: kept when it is not null/undefined. Other `product` keys
 *    (e.g. `swatchShape`) are look tokens and are reset.
 *
 * Spread the result into the new customizations object; when the new look
 * carries its own `product` keys, merge `card` into them.
 */
export function keepOwnerSettings(previous: unknown): {
  customCss?: string;
  motion?: Record<string, unknown>;
  product?: { card: unknown };
} {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) {
    return {};
  }
  const prev = previous as { motion?: unknown; product?: unknown };
  const kept: {
    customCss?: string;
    motion?: Record<string, unknown>;
    product?: { card: unknown };
  } = { ...keepOwnerCss(previous) };

  const motion = prev.motion;
  if (
    motion &&
    typeof motion === 'object' &&
    !Array.isArray(motion) &&
    Object.keys(motion).length > 0
  ) {
    kept.motion = motion as Record<string, unknown>;
  }

  const product = prev.product;
  if (product && typeof product === 'object' && !Array.isArray(product)) {
    const card = (product as { card?: unknown }).card;
    if (card !== null && card !== undefined) {
      kept.product = { card };
    }
  }
  return kept;
}

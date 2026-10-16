import type { NSwatchType } from '../../../model/normalized';
import { decodeOption, MetaBag, WpTables } from '../wp-tables';

/**
 * Variation Swatches for WooCommerce (WVS, Discovery C §4.1–4.2): the swatch
 * type is stored as the Woo `attribute_type`; colours and images live in
 * termmeta (`product_attribute_color`, `product_attribute_image`).
 */

const SWATCH_TYPES: readonly NSwatchType[] = [
  'color',
  'image',
  'button',
  'radio',
  'select',
];

export function swatchType(attributeType: string): NSwatchType | null {
  const t = attributeType.trim().toLowerCase() as NSwatchType;
  return SWATCH_TYPES.includes(t) ? t : null;
}

/** `#rgb` / `#rrggbb` / `#rrggbbaa`, lower-cased; anything else → undefined. */
export function termColor(termMeta: MetaBag): string | undefined {
  const v = (termMeta.first('product_attribute_color') ?? '').trim();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)
    ? v.toLowerCase()
    : undefined;
}

export function termImageId(termMeta: MetaBag): number | null {
  const n = Number.parseInt(
    termMeta.first('product_attribute_image') ?? '',
    10,
  );
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function wvsSettings(
  tables: WpTables,
): Record<string, string> | undefined {
  const v = decodeOption(tables, 'woo_variation_swatches');
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (
      typeof val === 'string' ||
      typeof val === 'number' ||
      typeof val === 'boolean'
    )
      out[k] = String(val);
  }
  return out;
}

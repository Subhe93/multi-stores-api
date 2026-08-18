/**
 * Which image represents a chosen variant.
 *
 * A creator can attach an image to an option VALUE (the Shopify model: one
 * photo per colour, shared by every variant carrying it) in
 * `Product.variant_option_config`, and/or attach images to a specific variant
 * row. The product page resolves those in a fixed order; cart lines, order
 * lines and order emails must resolve them the SAME way, otherwise the buyer
 * sees one photo while choosing and a different one in their cart.
 *
 * Order (mirrors VariantSelector.findVariantImage on the storefront):
 *   1. the option config's `imageMap` entry for this variant's value
 *   2. an image attached directly to this variant
 *   3. nothing — the caller falls back to the product's own image
 */

interface OptionConfigEntry {
  name?: string;
  style?: string;
  imageMap?: Record<string, string>;
}

export interface VariantImageInput {
  /** `Product.variant_option_config` — an ordered array, or null/garbage. */
  optionConfig: unknown;
  /** `ProductVariant.options`, e.g. { Color: "Blue", Size: "M" }. */
  variantOptions: unknown;
  /** Images attached to the variant row itself, lowest priority. */
  variantImages?: { url: string }[] | null;
}

export function resolveVariantImage(input: VariantImageInput): string | null {
  const options = asStringMap(input.variantOptions);

  if (options) {
    for (const entry of asConfigArray(input.optionConfig)) {
      if (!entry.name || !entry.imageMap) continue;
      const value = options[entry.name];
      if (!value) continue;
      const url = entry.imageMap[value];
      // Walk every option rather than guessing which one is "the colour":
      // the first that actually has an image for the chosen value wins, so
      // colour-style and image-style options both work without naming rules.
      if (typeof url === 'string' && url.trim()) return url;
    }
  }

  const own = input.variantImages?.[0]?.url;
  return typeof own === 'string' && own.trim() ? own : null;
}

function asConfigArray(value: unknown): OptionConfigEntry[] {
  return Array.isArray(value) ? (value as OptionConfigEntry[]) : [];
}

function asStringMap(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, string>;
}

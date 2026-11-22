// Guest cart line titles in the page locale (M160). Guest carts keep the
// title / variant label of the page they were added on; the storefront asks
// for fresh display text here. Display only: orders are built from ids.

import { pickTitleTranslation } from '../../common/catalog/pick-title-translation';
import {
  formatOptionPairs,
  labelsForLocale,
  optionDisplayEntries,
  type LabelRow,
} from '../../common/catalog/variant-option-labels';

export interface CartDisplayLine {
  product_id?: string | null;
  custom_product_id?: string | null;
  variant_id?: string | null;
}

export interface CartDisplayEntry {
  title: string | null;
  variant: string | null;
}

type TitleRow = { locale: string; title: string };
type TitleLabelRow = TitleRow & LabelRow;

export interface CartDisplayData {
  /** Own published products of the store's creator. */
  products: ReadonlyMap<string, { id: string; translations: TitleLabelRow[] }>;
  /** Published custom products of the store's creator. */
  customProducts: ReadonlyMap<
    string,
    {
      id: string;
      product_id: string;
      translations: TitleRow[];
      product: { translations: TitleLabelRow[] };
    }
  >;
  variants: ReadonlyMap<
    string,
    { id: string; product_id: string; options: unknown }
  >;
}

/**
 * Display entry per line, same order and length as `lines`. Unknown,
 * foreign or unpublished products answer null (the client keeps its
 * stored text). Same rules as the signed-in cart (`enrichCartItems`):
 * custom title, else its base product title; variant label from the
 * base product's M159 option labels.
 */
export function resolveCartDisplay(
  lines: readonly CartDisplayLine[],
  data: CartDisplayData,
  locale: string | null | undefined,
  canonicalLocale: string | null | undefined,
): (CartDisplayEntry | null)[] {
  return lines.map((line) => {
    let title: string | null = null;
    let baseProductId: string;
    let labelRows: TitleLabelRow[];
    if (line.custom_product_id) {
      const cp = data.customProducts.get(line.custom_product_id);
      if (!cp) return null;
      title =
        pickTitleTranslation(cp.translations, locale, canonicalLocale)?.title ||
        pickTitleTranslation(cp.product.translations, locale, canonicalLocale)
          ?.title ||
        null;
      baseProductId = cp.product_id;
      labelRows = cp.product.translations;
    } else if (line.product_id) {
      const p = data.products.get(line.product_id);
      if (!p) return null;
      title =
        pickTitleTranslation(p.translations, locale, canonicalLocale)?.title ||
        null;
      baseProductId = p.id;
      labelRows = p.translations;
    } else {
      return null;
    }
    let variant: string | null = null;
    const v = line.variant_id ? data.variants.get(line.variant_id) : undefined;
    if (v && v.product_id === baseProductId) {
      variant =
        formatOptionPairs(
          optionDisplayEntries(v.options, labelsForLocale(labelRows, locale)),
        ) || null;
    }
    return { title, variant };
  });
}

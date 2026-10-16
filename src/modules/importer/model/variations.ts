import type { NProduct, NVariation } from './normalized';

/**
 * Woo "any value" variations (M4.4 D21). A variation with a `null`
 * attribute matches every value of that attribute. If concrete variations
 * already cover every combination it stands for, it is dropped (Namez 2826:
 * 12 "any font" rows, Discovery C §2.3). Otherwise it is expanded into the
 * uncovered concrete combinations (capped), each with a derived ext_id
 * `<variation ext_id>.<n>`, and the caller reports a warning.
 */

export const ANY_EXPANSION_LIMIT = 500;

export interface ExpandedVariation extends NVariation {
  expanded_from: string;
}

export interface AnyVariationResolution {
  /** Concrete variations, untouched, in source order. */
  concrete: NVariation[];
  /** "Any" variations fully covered by concrete ones. */
  dropped: NVariation[];
  /** Concrete combinations generated from uncovered "any" variations. */
  expanded: ExpandedVariation[];
  /** "Any" variations whose expansion exceeded the limit (not expanded). */
  too_large: NVariation[];
}

function comboKey(
  keys: string[],
  attrs: Record<string, string | null>,
): string {
  return JSON.stringify(keys.map((k) => attrs[k] ?? null));
}

export function resolveAnyVariations(
  product: NProduct,
  limit = ANY_EXPANSION_LIMIT,
): AnyVariationResolution {
  const varAttrs = product.attributes.filter((a) => a.variation);
  const keys = varAttrs.map((a) => a.key);
  const valuesOf = new Map(varAttrs.map((a) => [a.key, a.values]));
  const concrete: NVariation[] = [];
  const anys: NVariation[] = [];
  for (const v of product.variations) {
    if (keys.some((k) => v.attrs[k] === null || v.attrs[k] === undefined))
      anys.push(v);
    else concrete.push(v);
  }
  const covered = new Set(concrete.map((v) => comboKey(keys, v.attrs)));
  const out: AnyVariationResolution = {
    concrete,
    dropped: [],
    expanded: [],
    too_large: [],
  };

  for (const v of anys) {
    // Cartesian product over the "any" keys.
    let combos: Record<string, string | null>[] = [{ ...v.attrs }];
    let size = 1;
    for (const k of keys) {
      if (v.attrs[k] !== null && v.attrs[k] !== undefined) continue;
      const vals = valuesOf.get(k) ?? [];
      size *= Math.max(vals.length, 1);
      if (size > limit) break;
      combos = combos.flatMap((c) => vals.map((val) => ({ ...c, [k]: val })));
    }
    if (size > limit) {
      out.too_large.push(v);
      continue;
    }
    const missing = combos.filter((c) => !covered.has(comboKey(keys, c)));
    if (!missing.length) {
      out.dropped.push(v);
      continue;
    }
    missing.forEach((attrs, i) => {
      covered.add(comboKey(keys, attrs));
      out.expanded.push({
        ...v,
        attrs,
        ext_id: `${v.ext_id}.${i + 1}`,
        expanded_from: v.ext_id,
      });
    });
  }
  return out;
}

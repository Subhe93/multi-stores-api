import type { NMechanism, NProductAttribute } from '../../../model/normalized';
import type { MetaBag } from '../wp-tables';

/**
 * iWings custom-field plugins (Discovery C §1.3, §12.4):
 * A `_enable_custom_text_fields`         → two names (+ `hint_1..3` placeholders)
 * B `_enable_custom_text_field_v3`       → one name
 * C1 `_enable_dynamic_name_color_fields`  → name + colour per item, quantity from `pa_rakna`
 * C2 `_enable_dnc_v2_name_color_fields`   → same, quantity from `pa_<_dnc_v2_attribute_slug>` (default `valj-antal`)
 * D `_enable_custom_text_fields_v2`      → engraving lines driven by `pa_antal-inskriptioner`
 * A flag counts only when its value is `yes`. A C/D config whose driving
 * attribute is not a variation attribute of the product is `broken`
 * (4414 C2, Discovery C Q2) and is never applied.
 */

export const IWINGS_META_KEYS = [
  '_enable_custom_text_fields',
  '_enable_custom_text_field_v3',
  '_enable_dynamic_name_color_fields',
  '_enable_dnc_v2_name_color_fields',
  '_dnc_v2_attribute_slug',
  '_enable_custom_text_fields_v2',
  'hint_1',
  'hint_2',
  'hint_3',
] as const;

export const IWINGS_C1_QUANTITY_ATTRIBUTE = 'pa_rakna';
export const IWINGS_C2_DEFAULT_SLUG = 'valj-antal';
export const IWINGS_PALETTE_ATTRIBUTE = 'pa_farg';
export const IWINGS_D_COUNT_ATTRIBUTE = 'pa_antal-inskriptioner';
/** Engraving line length enforced by the D plugin (`maxlength=15`). */
export const IWINGS_D_MAX_LENGTH = 15;

const SV_NUMBERS: Record<string, number> = {
  en: 1,
  ett: 1,
  tva: 2,
  två: 2,
  tre: 3,
  fyra: 4,
  fem: 5,
  sex: 6,
  sju: 7,
  atta: 8,
  åtta: 8,
  nio: 9,
  tio: 10,
};

/** Number of items a quantity term stands for: leading digits ("2-produkter") or a Swedish number word ("tva"). */
export function quantityFromTerm(slug: string, name?: string): number | null {
  for (const s of [slug, name ?? '']) {
    const t = s.trim().toLowerCase();
    const digits = /^(\d{1,3})(?!\d)/.exec(t);
    if (digits) return Number(digits[1]);
    const word = /^([a-zåäö]+)/.exec(t);
    if (word && SV_NUMBERS[word[1]] !== undefined) return SV_NUMBERS[word[1]];
  }
  return null;
}

function yes(meta: MetaBag, key: string): boolean {
  return (meta.first(key) ?? '').trim().toLowerCase() === 'yes';
}

function hint(meta: MetaBag, key: string): string | null {
  const v = meta.first(key);
  return v && v.trim() !== '' ? v : null;
}

export interface TermNameLookup {
  (taxonomy: string, slug: string): string | undefined;
}

function quantityMechanism(
  detector: 'iwings.c1' | 'iwings.c2',
  quantityAttribute: string,
  attributes: NProductAttribute[],
  termName: TermNameLookup,
): NMechanism {
  const qa = attributes.find((a) => a.key === quantityAttribute && a.variation);
  if (!qa) {
    return {
      kind: 'broken',
      detector,
      reason: `quantity attribute ${quantityAttribute} is not a variation attribute of the product`,
    };
  }
  const palette = attributes.find(
    (a) => a.key === IWINGS_PALETTE_ATTRIBUTE && a.variation,
  );
  if (!palette) {
    return {
      kind: 'broken',
      detector,
      reason: `palette attribute ${IWINGS_PALETTE_ATTRIBUTE} is not a variation attribute of the product`,
    };
  }
  const counts: Record<string, number> = {};
  for (const slug of qa.values) {
    const n = quantityFromTerm(slug, termName(qa.key, slug));
    if (n === null) {
      return {
        kind: 'broken',
        detector,
        reason: `cannot read a quantity from term ${quantityAttribute}/${slug}`,
      };
    }
    counts[slug] = n;
  }
  const values = Object.values(counts);
  if (!values.length)
    return {
      kind: 'broken',
      detector,
      reason: `quantity attribute ${quantityAttribute} has no values`,
    };
  return {
    kind: 'name_color_per_item',
    detector,
    quantity_attribute: quantityAttribute,
    counts,
    max: Math.max(...values),
    palette_attribute: IWINGS_PALETTE_ATTRIBUTE,
  };
}

export function detectIwings(
  meta: MetaBag,
  attributes: NProductAttribute[],
  termName: TermNameLookup,
): NMechanism[] {
  const out: NMechanism[] = [];
  if (yes(meta, '_enable_custom_text_fields')) {
    out.push({
      kind: 'two_names',
      detector: 'iwings.a',
      placeholders: [
        hint(meta, 'hint_1'),
        hint(meta, 'hint_2'),
        hint(meta, 'hint_3'),
      ],
    });
  }
  if (yes(meta, '_enable_custom_text_field_v3')) {
    out.push({ kind: 'single_name', detector: 'iwings.b' });
  }
  if (yes(meta, '_enable_dynamic_name_color_fields')) {
    out.push(
      quantityMechanism(
        'iwings.c1',
        IWINGS_C1_QUANTITY_ATTRIBUTE,
        attributes,
        termName,
      ),
    );
  }
  if (yes(meta, '_enable_dnc_v2_name_color_fields')) {
    const slug =
      (meta.first('_dnc_v2_attribute_slug') ?? '').trim() ||
      IWINGS_C2_DEFAULT_SLUG;
    out.push(
      quantityMechanism(
        'iwings.c2',
        `pa_${slug.replace(/^pa_/, '')}`,
        attributes,
        termName,
      ),
    );
  }
  if (yes(meta, '_enable_custom_text_fields_v2')) {
    const ca = attributes.find(
      (a) => a.key === IWINGS_D_COUNT_ATTRIBUTE && a.variation,
    );
    if (!ca) {
      out.push({
        kind: 'broken',
        detector: 'iwings.d',
        reason: `count attribute ${IWINGS_D_COUNT_ATTRIBUTE} is not a variation attribute of the product`,
      });
    } else {
      const counts = ca.values.map((slug) =>
        quantityFromTerm(slug, termName(ca.key, slug)),
      );
      const known = counts.filter((n): n is number => n !== null);
      out.push(
        known.length === counts.length && known.length > 0
          ? {
              kind: 'engraving_lines',
              detector: 'iwings.d',
              count_attribute: ca.key,
              max: Math.max(...known),
              max_length: IWINGS_D_MAX_LENGTH,
            }
          : {
              kind: 'broken',
              detector: 'iwings.d',
              reason: `cannot read line counts from ${ca.key}`,
            },
      );
    }
  }
  return out;
}

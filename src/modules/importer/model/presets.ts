import { cleanTermName, cleanText, TermCleanupRules } from './clean';
import type {
  NAttribute,
  NMechanism,
  NormalizedCatalog,
  NProduct,
} from './normalized';

/**
 * Personalization flags → M4.1 preset descriptors (M4-INTEGRATION C25/X15,
 * M4.4 §8.1). The importer's port adapter (WP-C) passes these to
 * `PersonalizationPresetsService.applyInTx(tx, productId, key, params,
 * {mode, source_ref}, actor)`. Help images for `names_equal_length` are
 * added by WP-C after it has downloaded them (`params.help_images`).
 */

export type PresetKey =
  | 'names_equal_length'
  | 'single_name'
  | 'name_color_per_item'
  | 'engravings'
  | 'checkbox_group';

export interface PresetDescriptor {
  key: PresetKey;
  params: Record<string, unknown>;
  /** `woo:<host>:product:<id>#<mechanism kind>` */
  source_ref: string;
  mechanism: Exclude<NMechanism['kind'], 'broken'>;
  detector: string;
}

export interface PresetSkip {
  source_ref: string;
  detector: string;
  reason: string;
}

export interface PresetMappingOptions {
  /** attribute taxonomy → option label (§12.2 `label_overrides`). */
  label_overrides?: Record<string, string>;
  term_cleanup?: TermCleanupRules;
}

/** P1 constants from M4-INTEGRATION X15. */
export const NAMES_EQUAL_LENGTH_NAME_MAX = 11;
export const NAME_COLOR_START_INDEX = 2;
export const PPOM_CHECKBOX_FIELD_NAME = 'ppom_details';

/** The option label the platform will show for an attribute (override, else cleaned label). */
export function optionLabel(
  attr: Pick<NAttribute, 'taxonomy' | 'label'>,
  opts: PresetMappingOptions = {},
): string {
  const override = opts.label_overrides?.[attr.taxonomy];
  return override !== undefined ? override : cleanText(attr.label);
}

/** The option value the platform will store for a term (D22 cleaned name). */
export function optionValue(
  catalog: NormalizedCatalog,
  taxonomy: string,
  slugOrValue: string,
  opts: PresetMappingOptions = {},
): string {
  const attr = catalog.attributes.find((a) => a.taxonomy === taxonomy);
  const term = attr?.terms.find((t) => t.slug === slugOrValue);
  return cleanTermName(term ? term.name : slugOrValue, opts.term_cleanup).value;
}

function attrLabel(
  catalog: NormalizedCatalog,
  product: NProduct,
  key: string,
  opts: PresetMappingOptions,
): string {
  const global = catalog.attributes.find((a) => a.taxonomy === key);
  if (global) return optionLabel(global, opts);
  const local = product.attributes.find((a) => a.key === key);
  return opts.label_overrides?.[key] ?? cleanText(local?.label ?? key);
}

export function presetDescriptorsFor(
  product: NProduct,
  catalog: NormalizedCatalog,
  opts: PresetMappingOptions = {},
): { presets: PresetDescriptor[]; skipped: PresetSkip[] } {
  const presets: PresetDescriptor[] = [];
  const skipped: PresetSkip[] = [];
  for (const m of product.personalization) {
    const source_ref = `${product.ext_id}#${m.kind === 'broken' ? m.detector : m.kind}`;
    switch (m.kind) {
      case 'broken':
        skipped.push({ source_ref, detector: m.detector, reason: m.reason });
        break;
      case 'two_names':
        presets.push({
          key: 'names_equal_length',
          params: { name_max: NAMES_EQUAL_LENGTH_NAME_MAX, model_text: true },
          source_ref,
          mechanism: m.kind,
          detector: m.detector,
        });
        break;
      case 'single_name':
        presets.push({
          key: 'single_name',
          params: {},
          source_ref,
          mechanism: m.kind,
          detector: m.detector,
        });
        break;
      case 'name_color_per_item': {
        const count_map: Record<string, number> = {};
        for (const [slug, n] of Object.entries(m.counts))
          count_map[optionValue(catalog, m.quantity_attribute, slug, opts)] = n;
        presets.push({
          key: 'name_color_per_item',
          params: {
            quantity_option: attrLabel(
              catalog,
              product,
              m.quantity_attribute,
              opts,
            ),
            count_map,
            max: m.max,
            palette_option: attrLabel(
              catalog,
              product,
              m.palette_attribute,
              opts,
            ),
            start_index: NAME_COLOR_START_INDEX,
            lead: true,
          },
          source_ref,
          mechanism: m.kind,
          detector: m.detector,
        });
        break;
      }
      case 'engraving_lines':
        presets.push({
          key: 'engravings',
          params: {
            count_option: attrLabel(catalog, product, m.count_attribute, opts),
            count: m.max,
            max_length: m.max_length,
          },
          source_ref,
          mechanism: m.kind,
          detector: m.detector,
        });
        break;
      case 'checkbox_group':
        presets.push({
          key: 'checkbox_group',
          params: {
            name: PPOM_CHECKBOX_FIELD_NAME,
            label: cleanText(m.label),
            options: m.options.map((o) => cleanText(o.label)),
            default_checked: m.options
              .filter((o) => o.checked)
              .map((o) => cleanText(o.label)),
          },
          source_ref,
          mechanism: m.kind,
          detector: m.detector,
        });
        break;
    }
  }
  return { presets, skipped };
}

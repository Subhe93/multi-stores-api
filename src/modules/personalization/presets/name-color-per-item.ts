import {
  localized,
  type FieldDraft,
  type PresetDefinition,
} from './preset.types';
import {
  SINGLE_NAME_FIELD,
  SINGLE_NAME_LABELS,
  SINGLE_NAME_PATTERN_MSG,
  SINGLE_NAME_RULES,
  singleNameField,
} from './single-name';

/**
 * P3 `name_color_per_item` (namez mechanisms C1/C2): items 2..N each get a
 * colour (from the product's own colour option, which fixes the olivgrön
 * leak) and a name. Item 1 (the lead) is the variant colour plus P2's name,
 * applied first when missing.
 */

const ITEM = {
  en: 'Item {i}',
  sv: 'Artikel {i}',
  ar: 'القطعة {i}',
  de: 'Artikel {i}',
  fr: 'Article {i}',
  tr: 'Ürün {i}',
};
const COLOR = {
  en: { label: 'Color', required: 'Item {i}: Color must be selected' },
  sv: { label: 'Färg', required: 'Artikel {i}: Färg måste väljas' },
  ar: { label: 'اللون', required: 'القطعة {i}: يجب اختيار اللون' },
  de: { label: 'Farbe', required: 'Artikel {i}: Farbe muss ausgewählt werden' },
  fr: {
    label: 'Couleur',
    required: 'Article {i} : la couleur doit être choisie',
  },
  tr: { label: 'Renk', required: 'Ürün {i}: Renk seçilmelidir' },
};
const NAME_REQUIRED = {
  en: 'Item {i}: Name must be filled in',
  sv: 'Artikel {i}: Namn måste fyllas i',
  ar: 'القطعة {i}: يجب إدخال الاسم',
  de: 'Artikel {i}: Name muss ausgefüllt werden',
  fr: 'Article {i} : le nom doit être renseigné',
  tr: 'Ürün {i}: Ad doldurulmalıdır',
};

type Table = Parameters<typeof localized>[0];
const locales = Object.keys(ITEM) as (keyof typeof ITEM)[];
const table = (f: (l: keyof typeof ITEM) => Record<string, unknown>): Table =>
  Object.fromEntries(locales.map((l) => [l, f(l)])) as unknown as Table;

export const nameColorPerItemPreset: PresetDefinition = {
  key: 'name_color_per_item',
  version: 1,
  params: [
    { key: 'quantity_option', type: 'option', required: true },
    { key: 'count_map', type: 'option_value_map', ref: 'quantity_option' },
    { key: 'start_index', type: 'number', min: 1, max: 20, default: 2 },
    { key: 'max', type: 'number', min: 1, max: 20, default: 6 },
    { key: 'palette_option', type: 'option', default: 'Färg' },
    { key: 'lead', type: 'boolean', default: true },
  ],
  build(params, ctx) {
    const paletteOption = params.palette_option as string;
    const lead = params.lead === true;
    const countMap = params.count_map as Record<string, number> | undefined;
    const out: FieldDraft[] = [];
    if (lead && !ctx.existingNames.has(SINGLE_NAME_FIELD)) {
      out.push({ ...singleNameField(), preset_key: 'single_name' });
    }
    out.push({
      name: 'dnc_items',
      type: 'REPEATER',
      is_required: false,
      repeat: {
        count: {
          option: params.quantity_option as string,
          ...(countMap && Object.keys(countMap).length > 0
            ? { map: countMap }
            : {}),
        },
        start_index: params.start_index as number,
        max: params.max as number,
        ...(lead
          ? { lead: { fields: [SINGLE_NAME_FIELD], options: [paletteOption] } }
          : {}),
      },
      ui: { placement: 'after_variants', validation_summary: true },
      translations: localized(table((l) => ({ label: ITEM[l] }))),
      children: [
        {
          name: 'color',
          type: 'COLOR_PALETTE',
          is_required: true,
          ui: { palette_from_option: paletteOption },
          translations: localized(
            table((l) => ({
              label: COLOR[l].label,
              messages: { required: COLOR[l].required },
            })),
          ),
        },
        {
          name: 'name',
          type: 'TEXT',
          is_required: true,
          validation_rules: { ...SINGLE_NAME_RULES },
          translations: localized(
            table((l) => ({
              ...SINGLE_NAME_LABELS[l],
              messages: {
                required: NAME_REQUIRED[l],
                pattern: SINGLE_NAME_PATTERN_MSG[l],
              },
            })),
          ),
        },
      ],
    });
    return out;
  },
};

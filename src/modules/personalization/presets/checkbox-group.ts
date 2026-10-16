import type { PresetDefinition } from './preset.types';

/**
 * P5 `checkbox_group` (namez PPOM checkbox, product 4414): a list of
 * checkboxes, by default all checked, no prices. The label is written in
 * `locale` (default: the store's primary locale).
 */
export const checkboxGroupPreset: PresetDefinition = {
  key: 'checkbox_group',
  version: 1,
  params: [
    { key: 'name', type: 'string', default: 'ppom_details' },
    { key: 'label', type: 'string', required: true },
    { key: 'options', type: 'string_list', required: true },
    {
      key: 'default_checked',
      type: 'checked_list',
      ref: 'options',
      default: 'all',
    },
    { key: 'locale', type: 'string' },
  ],
  build(params, ctx) {
    const options = params.options as string[];
    const checked =
      params.default_checked === 'all'
        ? [...options]
        : (params.default_checked as string[]);
    const locale =
      typeof params.locale === 'string' && params.locale !== ''
        ? params.locale
        : ctx.primaryLocale;
    return [
      {
        name: params.name as string,
        type: 'CHECKBOX_GROUP',
        is_required: false,
        options: [...options],
        ui: { default_checked: checked, placement: 'after_variants' },
        translations: [{ locale, label: params.label as string }],
      },
    ];
  },
};

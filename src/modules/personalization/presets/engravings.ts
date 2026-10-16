import {
  localized,
  type FieldDraft,
  type PresetDefinition,
} from './preset.types';

/**
 * P4 `engravings` (namez mechanism D): 1–4 inscriptions; inscription i ≥ 2
 * is shown (and required) when the count option's value is ≥ i.
 */

const LABELS = {
  en: [
    'Front engraving',
    'Left inscription',
    'Back inscription',
    'Right inscription',
  ],
  sv: [
    'Framsidan gravyr',
    'Vänster inskription',
    'Baksidan inskription',
    'Höger inskription',
  ],
  ar: ['نقش الواجهة الأمامية', 'النقش الأيسر', 'النقش الخلفي', 'النقش الأيمن'],
  de: [
    'Gravur Vorderseite',
    'Linke Inschrift',
    'Inschrift Rückseite',
    'Rechte Inschrift',
  ],
  fr: [
    'Gravure avant',
    'Inscription gauche',
    'Inscription arrière',
    'Inscription droite',
  ],
  tr: ['Ön yüz gravürü', 'Sol yazı', 'Arka yazı', 'Sağ yazı'],
};
const UP_TO = {
  en: 'Up to {max} characters',
  sv: 'Upp till {max} tecken',
  ar: 'حتى {max} حرفًا',
  de: 'Bis zu {max} Zeichen',
  fr: "Jusqu'à {max} caractères",
  tr: 'En fazla {max} karakter',
};
const REQUIRED = {
  en: 'Please fill in all required fields.',
  sv: 'Vänligen fyll i alla obligatoriska fält.',
  ar: 'يرجى ملء جميع الحقول المطلوبة.',
  de: 'Bitte fülle alle Pflichtfelder aus.',
  fr: 'Veuillez remplir tous les champs obligatoires.',
  tr: 'Lütfen tüm zorunlu alanları doldurun.',
};

export const ENGRAVINGS_MAX = 4;

export const engravingsPreset: PresetDefinition = {
  key: 'engravings',
  version: 1,
  params: [
    { key: 'count_option', type: 'option', default: 'Antal inskriptioner' },
    { key: 'count', type: 'number', min: 1, max: ENGRAVINGS_MAX, default: 4 },
    { key: 'max_length', type: 'number', min: 1, max: 200, default: 15 },
  ],
  // One inscription needs no count option.
  optionParamsUsed: (params) =>
    (params.count as number) >= 2 ? ['count_option'] : [],
  build(params) {
    const count = params.count as number;
    const max = params.max_length as number;
    const out: FieldDraft[] = [];
    for (let i = 1; i <= count; i++) {
      const table = Object.fromEntries(
        (Object.keys(LABELS) as (keyof typeof LABELS)[]).map((l) => [
          l,
          {
            label: LABELS[l][i - 1],
            sublabel: UP_TO[l].replace('{max}', String(max)),
            messages: { required: REQUIRED[l] },
          },
        ]),
      ) as unknown as Parameters<typeof localized>[0];
      out.push({
        name: `field_${i}_v2`,
        type: 'TEXT',
        is_required: true,
        validation_rules: { max_length: max },
        ui: { placement: 'after_variants' },
        ...(i >= 2
          ? {
              conditions: {
                match: 'all',
                rules: [
                  {
                    source: 'option',
                    key: params.count_option as string,
                    op: 'gte',
                    value: i,
                  },
                ],
              },
            }
          : {}),
        translations: localized(table),
      });
    }
    return out;
  },
};

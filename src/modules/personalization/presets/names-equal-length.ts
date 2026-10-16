import {
  localized,
  type FieldDraft,
  type PresetDefinition,
} from './preset.types';

/**
 * P1 `names_equal_length` (namez mechanism A): two names of equal length,
 * padded with ❤, plus an optional text on the front of the model.
 */

const ALLOWED = 'A-Za-z❤';
const NAME_1_EXAMPLES = 'PATRIK\nMARKUS\nPAPPA\nCHEFEN';
const NAME_2_EXAMPLES =
  'Emma\n❤SARA❤\n❤Jan❤\n❤❤Axel\nEmil❤❤\n❤Joel❤\nOlle❤\nLina❤\nElsa❤';

const ALLOWED_MSG = {
  en: 'Only English letters are allowed (A-Z).',
  sv: 'Endast engelska bokstäver tillåtna (A-Z).',
  ar: 'يُسمح بالأحرف الإنجليزية فقط (A-Z).',
  de: 'Nur englische Buchstaben erlaubt (A-Z).',
  fr: 'Seules les lettres anglaises sont autorisées (A-Z).',
  tr: 'Yalnızca İngilizce harflere izin verilir (A-Z).',
};
const EXAMPLE = {
  en: 'Example:',
  sv: 'Exempel:',
  ar: 'مثال:',
  de: 'Beispiel:',
  fr: 'Exemple :',
  tr: 'Örnek:',
};

function modelExamples(lines: {
  together: string;
  birthday: string;
  anniversary: string;
  best: string;
}): string {
  const { together, birthday, anniversary, best } = lines;
  return [
    together,
    `❤ ${together} ❤`,
    `❤ ${together} ❤ 18/9/2022 ❤`,
    birthday,
    `❤ ${birthday} ❤`,
    `❤ ${anniversary} ❤`,
    `❤ ${anniversary} ❤ 18/9/2014 ❤`,
    best,
  ].join('\n');
}

const MODEL = {
  en: {
    together: 'Forever together',
    birthday: 'Happy birthday',
    anniversary: '10th wedding anniversary',
    best: "❤ World's best ❤ DAD ❤",
  },
  sv: {
    together: 'För alltid tillsammans',
    birthday: 'Grattis på födelsedagen',
    anniversary: '10 årig bröllopsdag',
    best: '❤ Världens bästa ❤ PAPPA ❤',
  },
  ar: {
    together: 'معًا إلى الأبد',
    birthday: 'عيد ميلاد سعيد',
    anniversary: 'الذكرى العاشرة للزواج',
    best: '❤ أفضل ❤ أب ❤ في العالم',
  },
  de: {
    together: 'Für immer zusammen',
    birthday: 'Alles Gute zum Geburtstag',
    anniversary: '10. Hochzeitstag',
    best: '❤ Weltbester ❤ PAPA ❤',
  },
  fr: {
    together: 'Ensemble pour toujours',
    birthday: 'Joyeux anniversaire',
    anniversary: '10 ans de mariage',
    best: '❤ Meilleur ❤ PAPA ❤ du monde',
  },
  tr: {
    together: 'Sonsuza dek birlikte',
    birthday: 'Doğum günün kutlu olsun',
    anniversary: '10. evlilik yıl dönümü',
    best: '❤ Dünyanın en iyi ❤ BABASI ❤',
  },
};

function helpImage(
  params: Record<string, unknown>,
  key: string,
): string | null {
  const map = params.help_images as Record<string, unknown> | undefined;
  const v = map?.[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

export const namesEqualLengthPreset: PresetDefinition = {
  key: 'names_equal_length',
  version: 1,
  params: [
    {
      key: 'placement',
      type: 'enum',
      values: ['before_variants', 'after_variants'],
      default: 'before_variants',
    },
    { key: 'name_max', type: 'number', min: 1, max: 50, default: 11 },
    { key: 'model_text', type: 'boolean', default: true },
    { key: 'model_text_max', type: 'number', min: 1, max: 200, default: 25 },
    {
      key: 'help_images',
      type: 'image_map',
      keys: ['name_1', 'name_2', 'model_text'],
    },
  ],
  build(params) {
    const placement = params.placement as string;
    const nameMax = params.name_max as number;
    const name1Image = helpImage(params, 'name_1');
    const name2Image = helpImage(params, 'name_2');
    const modelImage = helpImage(params, 'model_text');
    const rules = { max_length: nameMax, allowed_chars: ALLOWED };

    const name1: FieldDraft = {
      name: 'name_1',
      type: 'TEXT',
      is_required: true,
      validation_rules: rules,
      ui: { placement, transform: 'uppercase', counter: true },
      translations: localized(
        {
          en: {
            label: 'First text',
            sublabel: 'Use the text with the most letters here',
            messages: {
              required: 'Enter a value for the first text.',
              allowed_chars: ALLOWED_MSG.en,
            },
          },
          sv: {
            label: 'Första texten',
            sublabel: 'Använd texten med flest bokstäver här',
            messages: {
              required: 'Ange ett värde för Första texten.',
              allowed_chars: ALLOWED_MSG.sv,
            },
          },
          ar: {
            label: 'النص الأول',
            sublabel: 'استخدم هنا النص الذي يحتوي على أكبر عدد من الأحرف',
            messages: {
              required: 'أدخل قيمة للنص الأول.',
              allowed_chars: ALLOWED_MSG.ar,
            },
          },
          de: {
            label: 'Erster Text',
            sublabel: 'Verwende hier den Text mit den meisten Buchstaben',
            messages: {
              required: 'Gib einen Wert für den ersten Text ein.',
              allowed_chars: ALLOWED_MSG.de,
            },
          },
          fr: {
            label: 'Premier texte',
            sublabel: 'Utilisez ici le texte qui a le plus de lettres',
            messages: {
              required: 'Saisissez une valeur pour le premier texte.',
              allowed_chars: ALLOWED_MSG.fr,
            },
          },
          tr: {
            label: 'Birinci metin',
            sublabel: 'En çok harf içeren metni buraya yazın',
            messages: {
              required: 'Birinci metin için bir değer girin.',
              allowed_chars: ALLOWED_MSG.tr,
            },
          },
        },
        { placeholder: 'KRISTOFER', help_image_url: name1Image },
      ).map((t) => ({
        ...t,
        help_text: `${EXAMPLE[t.locale as keyof typeof EXAMPLE]}\n${NAME_1_EXAMPLES}`,
      })),
    };

    const note = {
      en: 'The number of letters in the first and second text must match, or add ❤ to make them equal.',
      sv: 'Antalet bokstäver i första och andra text måste matcha, eller lägg till ❤ för att göra lika.',
      ar: 'يجب أن يتطابق عدد الأحرف في النصين الأول والثاني، أو أضف ❤ لجعلهما متساويين.',
      de: 'Die Anzahl der Buchstaben im ersten und zweiten Text muss übereinstimmen, oder füge ❤ hinzu, um sie anzugleichen.',
      fr: 'Le nombre de lettres du premier et du deuxième texte doit être identique, ou ajoutez ❤ pour les égaliser.',
      tr: 'Birinci ve ikinci metindeki harf sayısı eşit olmalı ya da eşitlemek için ❤ ekleyin.',
    };
    const name2: FieldDraft = {
      name: 'name_2',
      type: 'TEXT',
      is_required: true,
      validation_rules: rules,
      linked_validation: {
        type: 'equal_length',
        target: 'name_1',
        fill_char: '❤',
      },
      ui: {
        placement,
        transform: 'uppercase',
        counter: 'linked',
        insert_char: '❤',
        limit_to_target: true,
      },
      translations: localized(
        {
          en: {
            label: 'Second text',
            sublabel: 'Use the text with fewer letters here',
            note: note.en,
            messages: {
              required: 'Enter a value for the second text.',
              equal_length: 'The lengths do not match!',
              allowed_chars: ALLOWED_MSG.en,
            },
          },
          sv: {
            label: 'Andra texten',
            sublabel: 'Använd texten med färre bokstäver här',
            note: note.sv,
            messages: {
              required: 'Ange ett värde för Andra texten.',
              equal_length: 'Längderna stämmer inte överens!',
              allowed_chars: ALLOWED_MSG.sv,
            },
          },
          ar: {
            label: 'النص الثاني',
            sublabel: 'استخدم هنا النص الذي يحتوي على عدد أقل من الأحرف',
            note: note.ar,
            messages: {
              required: 'أدخل قيمة للنص الثاني.',
              equal_length: 'الأطوال غير متطابقة!',
              allowed_chars: ALLOWED_MSG.ar,
            },
          },
          de: {
            label: 'Zweiter Text',
            sublabel: 'Verwende hier den Text mit weniger Buchstaben',
            note: note.de,
            messages: {
              required: 'Gib einen Wert für den zweiten Text ein.',
              equal_length: 'Die Längen stimmen nicht überein!',
              allowed_chars: ALLOWED_MSG.de,
            },
          },
          fr: {
            label: 'Deuxième texte',
            sublabel: 'Utilisez ici le texte qui a le moins de lettres',
            note: note.fr,
            messages: {
              required: 'Saisissez une valeur pour le deuxième texte.',
              equal_length: 'Les longueurs ne correspondent pas !',
              allowed_chars: ALLOWED_MSG.fr,
            },
          },
          tr: {
            label: 'İkinci metin',
            sublabel: 'Daha az harf içeren metni buraya yazın',
            note: note.tr,
            messages: {
              required: 'İkinci metin için bir değer girin.',
              equal_length: 'Uzunluklar eşleşmiyor!',
              allowed_chars: ALLOWED_MSG.tr,
            },
          },
        },
        { placeholder: '❤❤KARIN❤❤', help_image_url: name2Image },
      ).map((t) => ({
        ...t,
        help_text: `${EXAMPLE[t.locale as keyof typeof EXAMPLE]}\n${NAME_2_EXAMPLES}`,
      })),
    };

    const out = [name1, name2];
    if (params.model_text) {
      const labels = {
        en: 'Text on the front of the model',
        sv: 'Texten på framsidan av modellen',
        ar: 'النص على واجهة المجسّم',
        de: 'Text auf der Vorderseite des Modells',
        fr: 'Texte sur le devant du modèle',
        tr: 'Modelin ön yüzündeki metin',
      };
      const table = Object.fromEntries(
        (Object.keys(labels) as (keyof typeof labels)[]).map((l) => [
          l,
          {
            label: labels[l],
            placeholder: MODEL[l].together,
            help_text: `${EXAMPLE[l]}\n${modelExamples(MODEL[l])}`,
          },
        ]),
      ) as unknown as Parameters<typeof localized>[0];
      out.push({
        name: 'model_text',
        type: 'TEXT',
        is_required: false,
        validation_rules: { max_length: params.model_text_max as number },
        ui: { placement, counter: true },
        translations: localized(table, { help_image_url: modelImage }),
      });
    }
    return out;
  },
};

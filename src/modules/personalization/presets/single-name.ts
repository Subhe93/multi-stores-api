import {
  localized,
  type FieldDraft,
  type PresetDefinition,
} from './preset.types';

/** P2 `single_name` (namez mechanism B): one name, letters Å Ä Ö and digits, max 12. */

export const SINGLE_NAME_FIELD = 'custom_name_v3';

export const SINGLE_NAME_RULES = {
  max_length: 12,
  allowed_chars: 'A-Za-zÅÄÖåäö0-9',
  pattern: '^[A-Za-zÅÄÖåäö0-9]{1,12}$',
};

/** "Only letters … max 12" per locale (P2 pattern / allowed_chars, P3 child pattern). */
export const SINGLE_NAME_PATTERN_MSG = {
  en: 'Only letters (A–Z, Å, Ä, Ö) and digits allowed, max 12 characters.',
  sv: 'Endast bokstäver (A–Z, Å, Ä, Ö) och siffror tillåtna, max 12 tecken.',
  ar: 'يُسمح بالأحرف (A–Z، Å، Ä، Ö) والأرقام فقط، بحد أقصى 12 حرفًا.',
  de: 'Nur Buchstaben (A–Z, Å, Ä, Ö) und Ziffern erlaubt, max. 12 Zeichen.',
  fr: 'Seules les lettres (A–Z, Å, Ä, Ö) et les chiffres sont autorisés, 12 caractères max.',
  tr: 'Yalnızca harfler (A–Z, Å, Ä, Ö) ve rakamlar, en fazla 12 karakter.',
};

/** Form label / cart label of the name input (P2 and the P3 child). */
export const SINGLE_NAME_LABELS = {
  en: { label: 'Write the name here:', display_label: 'Name' },
  sv: { label: 'Skriv namn här:', display_label: 'Namn' },
  ar: { label: 'اكتب الاسم هنا:', display_label: 'الاسم' },
  de: { label: 'Name hier eingeben:', display_label: 'Name' },
  fr: { label: 'Écrivez le nom ici :', display_label: 'Nom' },
  tr: { label: 'Adı buraya yazın:', display_label: 'Ad' },
};

const REQUIRED = {
  en: 'Please enter a name.',
  sv: 'Vänligen skriv ett namn.',
  ar: 'يرجى كتابة اسم.',
  de: 'Bitte gib einen Namen ein.',
  fr: 'Veuillez saisir un nom.',
  tr: 'Lütfen bir ad yazın.',
};

export function singleNameField(): FieldDraft {
  const table = Object.fromEntries(
    (
      Object.keys(SINGLE_NAME_LABELS) as (keyof typeof SINGLE_NAME_LABELS)[]
    ).map((l) => [
      l,
      {
        ...SINGLE_NAME_LABELS[l],
        messages: {
          required: REQUIRED[l],
          pattern: SINGLE_NAME_PATTERN_MSG[l],
          allowed_chars: SINGLE_NAME_PATTERN_MSG[l],
        },
      },
    ]),
  ) as unknown as Parameters<typeof localized>[0];
  return {
    name: SINGLE_NAME_FIELD,
    type: 'TEXT',
    is_required: true,
    validation_rules: { ...SINGLE_NAME_RULES },
    ui: { placement: 'after_variants' },
    translations: localized(table),
  };
}

export const singleNamePreset: PresetDefinition = {
  key: 'single_name',
  version: 1,
  params: [],
  build: () => [singleNameField()],
};

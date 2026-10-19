/**
 * Double-sided designs (M5.6, NPP "Baksida" parity): the pure helpers of
 * `Design.back`.
 *
 *   { mode: 'same' }                                  back = the front again
 *   { mode: 'other', template_id, template_version_id, state }
 *                                                     another template, with
 *                                                     its own texts / photos
 *
 * The back exists only while an add-on that enables it is selected
 * (`backEnabledBy`, designer-addons.ts); the server clears it otherwise.
 * Allowed back templates = the product's own template plus the link's
 * `back_template_ids` (both must be the store's PUBLISHED templates). The
 * services do the DB checks; this module only reads / shapes values.
 */
import type { DesignStateV1 } from '@multi-stores/core/designer';
import { isUuid } from './designs.util';

export type BackMode = 'same' | 'other';

export type DesignBack =
  | { mode: 'same' }
  | {
      mode: 'other';
      template_id: string;
      template_version_id: string;
      state: DesignStateV1;
    };

/** Print / proof side. */
export type DesignSide = 'front' | 'back';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Side of a print file / asset row (`side` is absent on single-sided rows). */
export function sideOf(v: { side?: unknown } | null | undefined): DesignSide {
  return v?.side === 'back' ? 'back' : 'front';
}

/**
 * Shape-only read of a stored / sent back value. `null` for null, `false`
 * when the shape is wrong (the caller answers 400); the state of an 'other'
 * back is NOT validated here (the service validates it against the back
 * template's spec).
 */
export function readBack(raw: unknown): DesignBack | null | false {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) return false;
  if (raw.mode === 'same') return { mode: 'same' };
  if (raw.mode !== 'other') return false;
  if (!isUuid(raw.template_id)) return false;
  if (
    raw.template_version_id !== undefined &&
    raw.template_version_id !== null &&
    !isUuid(raw.template_version_id)
  ) {
    return false;
  }
  const state = isRecord(raw.state) ? raw.state : {};
  return {
    mode: 'other',
    template_id: raw.template_id,
    // Resolved to the template's current version by the service when absent.
    template_version_id:
      typeof raw.template_version_id === 'string'
        ? raw.template_version_id
        : '',
    state: {
      v: 1,
      texts: isRecord(state.texts)
        ? (state.texts as Record<string, string>)
        : {},
      photos: isRecord(state.photos)
        ? (state.photos as DesignStateV1['photos'])
        : {},
    },
  };
}

/** `{back}` of a view when a back is stored, else `{}` (G0: no new key). */
export function backViewOf(raw: unknown): { back?: DesignBack } {
  const b = readBack(raw);
  return b ? { back: b } : {};
}

/** Photos of the back state (empty for 'same' / none). */
export function backPhotos(back: DesignBack | null): DesignStateV1['photos'] {
  return back?.mode === 'other' ? (back.state.photos ?? {}) : {};
}

/**
 * The templates a product offers for the back: its own template first,
 * then the link's list (deduplicated, never the own template twice).
 */
export function allowedBackTemplateIds(link: {
  template_id: string;
  back_template_ids?: string[] | null;
}): string[] {
  const out = [link.template_id];
  for (const id of link.back_template_ids ?? []) {
    if (isUuid(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Labels of the "Back" prefix of back text rows (order emails / views). */
export const BACK_SIDE_LABELS: Record<string, string> = {
  sv: 'Baksida',
  en: 'Back',
  de: 'Rückseite',
  fr: 'Verso',
  tr: 'Arka yüz',
  ar: 'الوجه الخلفي',
};

/** `{locale: "Baksida: <label>"}` for every locale of `label` (plus the six app locales). */
export function backLabels(
  label: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const locales = new Set([
    ...Object.keys(BACK_SIDE_LABELS),
    ...Object.keys(label),
  ]);
  for (const loc of locales) {
    const prefix =
      BACK_SIDE_LABELS[loc.toLowerCase().split(/[-_]/)[0]] ??
      BACK_SIDE_LABELS.en;
    const text = label[loc] ?? label.en ?? Object.values(label)[0] ?? '';
    out[loc] = text ? `${prefix}: ${text}` : prefix;
  }
  return out;
}

/**
 * The `{label, value}` back text rows of a frozen `text_values` column
 * (customer order views): the rows tagged `side:'back'`, and only for an
 * 'other' back (a 'same' back prints the front texts again).
 */
export function backTextRowsOf(
  mode: unknown,
  textValues: unknown,
): { label: string; value: string }[] {
  if (mode !== 'other' || !Array.isArray(textValues)) return [];
  return textValues
    .filter(
      (t): t is Record<string, unknown> => isRecord(t) && sideOf(t) === 'back',
    )
    .map((t) => ({
      label: typeof t.label === 'string' ? t.label : '',
      value: typeof t.value === 'string' ? t.value : '',
    }));
}

/** Element id of a back text in snapshot / value rows (`back:<element_id>`). */
export function backElementId(elementId: string): string {
  return `back:${elementId}`;
}

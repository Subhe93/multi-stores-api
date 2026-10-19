/**
 * Pure helpers of the designer's designs and commerce flow (M4.2 WP4):
 * canonical JSON + hashes, the text values a design prints (cart display,
 * order snapshot, the `source:'DESIGN'` value rows) and the asset refs of a
 * template spec. No Nest, no Prisma.
 */
import { createHash } from 'crypto';
import {
  pickI18n,
  type DesignStateV1,
  type I18n,
  type TemplateSpecV1,
  type TextElement,
} from '@multi-stores/core/designer';

/** Lowercase RFC 4122 uuid (the one definition of the designer module). */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/** JSON with object keys sorted at every level (stable hashes). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** `DesignTemplateVersion.spec_sha256`. */
export function specSha256(spec: unknown): string {
  return sha256Hex(canonicalJson(spec));
}

/**
 * The state hash a proof is rendered from (§5.4):
 * sha256(canonical(state) + template_version_id). WP5 stores it in
 * `Design.proof_state_sha` after rendering a proof; PATCH clears it.
 */
export function designProofSha(state: unknown, versionId: string): string {
  return sha256Hex(canonicalJson(state) + versionId);
}

/** Editable text elements of the front surface, in spec order. */
export function editableTexts(spec: TemplateSpecV1): TextElement[] {
  const front = (spec.surfaces ?? []).find((s) => s && s.key === 'front');
  return (front?.elements ?? []).filter(
    (e): e is TextElement => e?.type === 'text' && e.editable,
  );
}

/** One text a design prints, with the template label (never the client's). */
export interface DesignTextValue {
  element_id: string;
  /** Label of the order/request locale (falls back to the first label). */
  label: string;
  /** Full label map (snapshot rows keep every locale). */
  labels: I18n;
  /** Customer text, or the element's default text when left empty. */
  value: string;
}

/**
 * Text values of a validated state: one entry per editable text element
 * that prints something (customer text, else the default text; elements
 * that would print nothing are left out).
 */
export function designTextValues(
  spec: TemplateSpecV1,
  state: DesignStateV1,
  locale?: string | null,
): DesignTextValue[] {
  const out: DesignTextValue[] = [];
  for (const el of editableTexts(spec)) {
    const typed = state.texts?.[el.id];
    const value =
      typeof typed === 'string' && typed.trim() !== ''
        ? typed
        : (el.default_text ?? '');
    if (value === '') continue;
    const labels: I18n = { ...(el.label ?? {}) };
    out.push({
      element_id: el.id,
      label: pickI18n(labels, locale ?? undefined) || el.id,
      labels,
      value,
    });
  }
  return out;
}

/** Role of an asset inside a template spec. */
export type SpecAssetRole = 'bg_web' | 'bg_print' | 'deco' | 'font';

export interface SpecAssetUse {
  asset_id: string;
  role: SpecAssetRole;
  element_id?: string;
}

/** Every asset a spec references (backgrounds, decorations, fonts). */
export function specAssetUses(spec: TemplateSpecV1): SpecAssetUse[] {
  const out: SpecAssetUse[] = [];
  for (const s of spec.surfaces ?? []) {
    const bg = s?.background;
    if (bg?.web?.asset_id)
      out.push({ asset_id: bg.web.asset_id, role: 'bg_web' });
    if (bg?.print?.asset_id) {
      out.push({ asset_id: bg.print.asset_id, role: 'bg_print' });
    }
    for (const el of s?.elements ?? []) {
      if (el?.type === 'image' && el.asset?.asset_id) {
        out.push({
          asset_id: el.asset.asset_id,
          role: 'deco',
          element_id: el.id,
        });
      }
    }
  }
  for (const f of spec.fonts ?? []) {
    if (f?.asset_id) out.push({ asset_id: f.asset_id, role: 'font' });
  }
  return out;
}

/** A blank native template (500×700 mm, white, no elements). */
export function blankTemplateSpec(): TemplateSpecV1 {
  return {
    schema: 'designer.template/1',
    unit: 'mm',
    width: 500,
    height: 700,
    bleed_mm: 0,
    render: { preview_px_per_mm: 2, print_px_per_mm: 6, fit_ref_px_per_mm: 6 },
    fonts: [],
    surfaces: [
      {
        key: 'front',
        background: { color: '#ffffff', fit: 'stretch' },
        elements: [],
      },
    ],
  };
}

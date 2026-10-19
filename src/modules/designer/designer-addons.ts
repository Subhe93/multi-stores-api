/**
 * Paid designer add-ons (M5.5, NPP parity): `ProductDesigner.addons` v2 and
 * the per-design selection (`Design.addons`).
 *
 * Config (creator side, `PUT designer/my/products/:id/addons`):
 *   { v: 2, items: [{ key, type: 'toggle'|'quantity', label: {locale: text},
 *     price (store base currency, >= 0), max_qty? (quantity, 1..20),
 *     enabled, sort? }], imported?: <legacy NPP shape, server-kept> }
 * The legacy NPP import shape `{double, raincover, poster, welcome}` (all
 * disabled, never priced) is still read: it only yields "suggested presets"
 * the dashboard can adopt in one click. Nothing is priced unless a v2 item
 * is enabled, so stores / products without add-ons are unchanged (G0).
 *
 * Selection (customer side, stored with the design draft):
 *   { [key]: qty }  — toggles use 1, quantity add-ons 1..max_qty; 0/absent
 *   means not chosen. Pricing re-reads the CURRENT config on the server:
 *   unknown or disabled keys are ignored, quantities are clamped to max_qty.
 */

export const ADDONS_VERSION = 2;
export const ADDONS_MAX_ITEMS = 10;
export const ADDON_QTY_MAX = 20;
/** Upper bound of one add-on price (fits Decimal(10,2) with headroom). */
export const ADDON_PRICE_MAX = 100_000;
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const LOCALE_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i;
const LABEL_MAX = 80;

export type AddonType = 'toggle' | 'quantity';

export interface DesignerAddonItem {
  key: string;
  type: AddonType;
  label: Record<string, string>;
  price: number;
  max_qty?: number;
  enabled: boolean;
  sort?: number;
}

export interface DesignerAddonsV2 {
  v: 2;
  items: DesignerAddonItem[];
}

export interface AddonIssue {
  path: string;
  rule:
    | 'shape'
    | 'unknown_key'
    | 'version'
    | 'too_many'
    | 'key'
    | 'duplicate_key'
    | 'type'
    | 'label'
    | 'price'
    | 'max_qty'
    | 'enabled'
    | 'sort';
}

export type AddonSelection = Record<string, number>;

/** One priced add-on of a line (per unit of the line). */
export interface PricedAddon {
  key: string;
  type: AddonType;
  label: Record<string, string>;
  qty: number;
  /** Unit price of the add-on (base currency here; converted by callers). */
  unit_price: number;
  /** unit_price × qty. */
  amount: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const round2 = (n: number) => Math.round(n * 100) / 100;

const ITEM_KEYS = new Set([
  'key',
  'type',
  'label',
  'price',
  'max_qty',
  'enabled',
  'sort',
]);

/**
 * Strict validator of a creator-sent v2 config (unknown keys rejected at
 * every level). Returns the normalized config (items sorted by `sort`, then
 * input order; `sort` rewritten 0..n-1) or the issues.
 */
export function validateAddonsConfig(
  raw: unknown,
): { ok: true; value: DesignerAddonsV2 } | { ok: false; errors: AddonIssue[] } {
  const errors: AddonIssue[] = [];
  if (!isRecord(raw))
    return { ok: false, errors: [{ path: '', rule: 'shape' }] };
  for (const k of Object.keys(raw)) {
    if (k !== 'v' && k !== 'items')
      errors.push({ path: k, rule: 'unknown_key' });
  }
  if (raw.v !== ADDONS_VERSION) errors.push({ path: 'v', rule: 'version' });
  if (!Array.isArray(raw.items)) {
    errors.push({ path: 'items', rule: 'shape' });
    return { ok: false, errors };
  }
  if (raw.items.length > ADDONS_MAX_ITEMS) {
    errors.push({ path: 'items', rule: 'too_many' });
  }
  const seen = new Set<string>();
  const items: (DesignerAddonItem & { _i: number })[] = [];
  raw.items.slice(0, ADDONS_MAX_ITEMS).forEach((it, i) => {
    const p = `items.${i}`;
    if (!isRecord(it)) {
      errors.push({ path: p, rule: 'shape' });
      return;
    }
    for (const k of Object.keys(it)) {
      if (!ITEM_KEYS.has(k))
        errors.push({ path: `${p}.${k}`, rule: 'unknown_key' });
    }
    const key = it.key;
    if (typeof key !== 'string' || !KEY_RE.test(key)) {
      errors.push({ path: `${p}.key`, rule: 'key' });
    } else if (seen.has(key)) {
      errors.push({ path: `${p}.key`, rule: 'duplicate_key' });
    } else seen.add(key);
    const type = it.type;
    if (type !== 'toggle' && type !== 'quantity') {
      errors.push({ path: `${p}.type`, rule: 'type' });
    }
    const label: Record<string, string> = {};
    if (!isRecord(it.label)) {
      errors.push({ path: `${p}.label`, rule: 'label' });
    } else {
      for (const [loc, text] of Object.entries(it.label)) {
        if (
          !LOCALE_RE.test(loc) ||
          typeof text !== 'string' ||
          text.length > LABEL_MAX
        ) {
          errors.push({ path: `${p}.label.${loc}`, rule: 'label' });
          continue;
        }
        const tx = text.trim();
        if (tx) label[loc.toLowerCase()] = tx;
      }
      if (!Object.keys(label).length)
        errors.push({ path: `${p}.label`, rule: 'label' });
    }
    const price = it.price;
    if (
      typeof price !== 'number' ||
      !Number.isFinite(price) ||
      price < 0 ||
      price > ADDON_PRICE_MAX ||
      Math.abs(round2(price) - price) > 1e-9
    ) {
      errors.push({ path: `${p}.price`, rule: 'price' });
    }
    let maxQty: number | undefined;
    if (type === 'quantity') {
      const m = it.max_qty;
      if (
        !Number.isInteger(m) ||
        (m as number) < 1 ||
        (m as number) > ADDON_QTY_MAX
      ) {
        errors.push({ path: `${p}.max_qty`, rule: 'max_qty' });
      } else maxQty = m as number;
    } else if (it.max_qty !== undefined && it.max_qty !== null) {
      errors.push({ path: `${p}.max_qty`, rule: 'max_qty' });
    }
    if (typeof it.enabled !== 'boolean') {
      errors.push({ path: `${p}.enabled`, rule: 'enabled' });
    }
    if (
      it.sort !== undefined &&
      it.sort !== null &&
      !(
        Number.isInteger(it.sort) &&
        (it.sort as number) >= 0 &&
        (it.sort as number) < 1000
      )
    ) {
      errors.push({ path: `${p}.sort`, rule: 'sort' });
    }
    items.push({
      key: String(key),
      type: type as AddonType,
      label,
      price: typeof price === 'number' ? round2(price) : 0,
      ...(maxQty !== undefined ? { max_qty: maxQty } : {}),
      enabled: it.enabled === true,
      sort: Number.isInteger(it.sort) ? (it.sort as number) : i,
      _i: i,
    });
  });
  if (errors.length) return { ok: false, errors };
  items.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a._i - b._i);
  return {
    ok: true,
    value: {
      v: 2,
      items: items.map(({ _i, ...rest }, n) => ({ ...rest, sort: n })),
    },
  };
}

/** True when the stored value is a v2 config (whatever its items). */
export function isAddonsV2(stored: unknown): boolean {
  return isRecord(stored) && stored.v === ADDONS_VERSION;
}

/**
 * The v2 config of a stored value, or null (legacy NPP shape, `{}`, or a
 * value that no longer validates — never priced then).
 */
export function readAddonsConfig(stored: unknown): DesignerAddonsV2 | null {
  if (!isRecord(stored) || stored.v !== ADDONS_VERSION) return null;
  const res = validateAddonsConfig({ v: stored.v, items: stored.items });
  return res.ok ? res.value : null;
}

/** Enabled items of a stored value, in display order (empty when none). */
export function enabledAddons(stored: unknown): DesignerAddonItem[] {
  return (readAddonsConfig(stored)?.items ?? []).filter((i) => i.enabled);
}

/** The legacy NPP block of a stored value (top level, or kept under v2 `imported`). */
function legacyBlock(stored: unknown): Record<string, unknown> | null {
  if (!isRecord(stored)) return null;
  const src = stored.v === ADDONS_VERSION ? stored.imported : stored;
  if (!isRecord(src)) return null;
  return ['double', 'raincover', 'poster'].some((k) => isRecord(src[k]))
    ? src
    : null;
}

/** Labels of the NPP presets in the six app locales (namez.se wording in sv). */
const PRESET_LABELS: Record<string, Record<string, string>> = {
  double: {
    sv: 'Dubbelsidig',
    en: 'Double-sided',
    de: 'Doppelseitig',
    fr: 'Recto verso',
    tr: 'Çift taraflı',
    ar: 'وجهان',
  },
  raincover: {
    sv: 'Regnskydd',
    en: 'Rain cover',
    de: 'Regenschutz',
    fr: 'Housse de pluie',
    tr: 'Yağmur koruması',
    ar: 'غطاء مطر',
  },
  poster: {
    sv: 'Poster 50×70 cm',
    en: 'Poster 50×70 cm',
    de: 'Poster 50×70 cm',
    fr: 'Affiche 50×70 cm',
    tr: 'Poster 50×70 cm',
    ar: 'ملصق 50×70 سم',
  },
};

/** NPP's own prices when the import carried none. */
const PRESET_DEFAULT_PRICES: Record<string, number> = {
  double: 149,
  raincover: 29,
  poster: 179,
};

/**
 * Suggested (DISABLED) v2 items from imported NPP data: double-sided and
 * rain cover as toggles, the poster copy as a quantity add-on (1..10). The
 * welcome sign is a separate template in NPP and is not offered. Empty when
 * the link has no imported NPP block.
 */
export function legacyAddonPresets(stored: unknown): DesignerAddonItem[] {
  const legacy = legacyBlock(stored);
  if (!legacy) return [];
  const out: DesignerAddonItem[] = [];
  for (const key of ['double', 'raincover', 'poster']) {
    const e = legacy[key];
    if (!isRecord(e)) continue;
    const raw =
      typeof e.price === 'number' && Number.isFinite(e.price) ? e.price : null;
    const price =
      raw !== null && raw >= 0 && raw <= ADDON_PRICE_MAX
        ? round2(raw)
        : PRESET_DEFAULT_PRICES[key];
    out.push({
      key,
      type: key === 'poster' ? 'quantity' : 'toggle',
      label: { ...PRESET_LABELS[key] },
      price,
      ...(key === 'poster' ? { max_qty: 10 } : {}),
      enabled: false,
      sort: out.length,
    });
  }
  return out;
}

/** Value to store for a validated config: keeps the imported NPP block. */
export function storedAddonsValue(
  config: DesignerAddonsV2,
  current: unknown,
): Record<string, unknown> {
  const legacy = legacyBlock(current);
  return { v: 2, items: config.items, ...(legacy ? { imported: legacy } : {}) };
}

/**
 * Shape-only check of a customer selection (the config is applied at
 * pricing time): at most 10 entries, slug keys, integer 0..20. Zero
 * entries are dropped. Returns null when the shape is wrong.
 */
export function sanitizeSelection(raw: unknown): AddonSelection | null {
  if (!isRecord(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length > ADDONS_MAX_ITEMS) return null;
  const out: AddonSelection = {};
  for (const [k, v] of entries) {
    if (!KEY_RE.test(k)) return null;
    if (
      !Number.isInteger(v) ||
      (v as number) < 0 ||
      (v as number) > ADDON_QTY_MAX
    )
      return null;
    if ((v as number) > 0) out[k] = v as number;
  }
  return out;
}

/**
 * Prices a selection against the CURRENT config (base currency). Only
 * enabled items count; toggles are 1×, quantities clamp to max_qty.
 * Zero-priced add-ons still appear as line details.
 */
export function priceAddons(
  stored: unknown,
  selection: unknown,
): { lines: PricedAddon[]; total: number } {
  const items = enabledAddons(stored);
  const sel = sanitizeSelection(selection) ?? {};
  const lines: PricedAddon[] = [];
  for (const it of items) {
    const want = sel[it.key] ?? 0;
    if (want <= 0) continue;
    const qty = it.type === 'toggle' ? 1 : Math.min(want, it.max_qty ?? 1);
    lines.push({
      key: it.key,
      type: it.type,
      label: { ...it.label },
      qty,
      unit_price: it.price,
      amount: round2(it.price * qty),
    });
  }
  return { lines, total: round2(lines.reduce((s, l) => s + l.amount, 0)) };
}

/**
 * Lines in another currency: every UNIT price is converted with `convert`
 * (the market's base-amount conversion), amounts recomputed from it so
 * "Poster × 2" always equals 2 × the shown unit price.
 */
export function convertAddonLines(
  lines: PricedAddon[],
  convert: ((amount: number) => number) | null,
): { lines: PricedAddon[]; total: number } {
  const out = lines.map((l) => {
    const unit = convert ? convert(l.unit_price) : l.unit_price;
    return { ...l, unit_price: unit, amount: round2(unit * l.qty) };
  });
  return { lines: out, total: round2(out.reduce((s, l) => s + l.amount, 0)) };
}

/** `map[locale]` → same language → `[primary]` → en → first. */
export function addonLabel(
  label: Record<string, string>,
  locale?: string | null,
  primary?: string | null,
): string {
  const want = (locale ?? '').toLowerCase();
  const lang = want.split(/[-_]/)[0];
  const keys = Object.keys(label);
  if (want && label[want]) return label[want];
  const sameLang = keys.find((k) => k.split(/[-_]/)[0] === lang && label[k]);
  if (lang && sameLang) return label[sameLang];
  return (
    (primary ? label[primary.toLowerCase()] : undefined) ??
    label.en ??
    label[keys[0]] ??
    ''
  );
}

/** "149 kr" in the locale's money format (whole amounts without decimals). */
export function formatAddonMoney(
  amount: number,
  currency: string,
  locale?: string | null,
): string {
  const whole = Math.abs(amount - Math.round(amount)) < 1e-9;
  try {
    return new Intl.NumberFormat(locale || 'en', {
      style: 'currency',
      currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${whole ? Math.round(amount) : amount.toFixed(2)} ${currency}`;
  }
}

/**
 * Readable detail of one priced add-on: "+149 kr" (toggle) or
 * "× 2 (+358 kr)" (quantity). The label travels separately.
 */
export function addonDetailText(
  line: PricedAddon,
  currency: string,
  locale?: string | null,
): string {
  const money = formatAddonMoney(line.amount, currency, locale);
  return line.type === 'quantity' ? `× ${line.qty} (+${money})` : `+${money}`;
}

/** M5.5: the add-ons frozen in an order design's `price_breakdown`. */
export function orderAddonsOf(breakdown: unknown): PricedAddon[] {
  const b = isRecord(breakdown) ? breakdown : {};
  const list = Array.isArray(b.addons) ? b.addons : [];
  return list.filter(isRecord).map((a) => ({
    key: typeof a.key === 'string' ? a.key : '',
    type: a.type === 'quantity' ? 'quantity' : 'toggle',
    label: isRecord(a.label) ? (a.label as Record<string, string>) : {},
    qty: Number(a.qty) || 1,
    unit_price: Number(a.unit_price) || 0,
    amount: Number(a.amount) || 0,
  }));
}

/** Currency of the frozen add-on amounts (null on rows without add-ons). */
export function orderAddonsCurrencyOf(breakdown: unknown): string | null {
  const b = isRecord(breakdown) ? breakdown : {};
  return typeof b.currency === 'string' ? b.currency : null;
}

/**
 * Short add-on names for a payment line name ("Dubbelsidig, Poster × 2"),
 * '' without add-ons.
 */
export function addonNamesText(
  lines: Pick<PricedAddon, 'label' | 'qty' | 'type'>[],
  locale?: string | null,
): string {
  return lines
    .map((a) => {
      const name = addonLabel(a.label, locale);
      return a.type === 'quantity' ? `${name} × ${a.qty}` : name;
    })
    .filter(Boolean)
    .join(', ');
}

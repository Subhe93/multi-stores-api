import type { NFaqItem, NTermCard } from '../../../model/normalized';
import { maybeUnserialize } from '../php-unserialize';
import type { MetaBag, WpTables } from '../wp-tables';

/**
 * Advanced Custom Fields (Discovery C §5): field definitions are posts
 * (`acf-field-group` / `acf-field`), values are meta `<name>` with a
 * reference meta `_<name>` = `field_…`.
 */

export interface AcfField {
  /** Post ID of the field definition. */
  id: number;
  /** `field_…` key (post_name). */
  key: string;
  name: string;
  label: string;
  type: string;
  group_id: number;
  parent_id: number;
}

export interface AcfGroup {
  id: number;
  key: string;
  title: string;
  /** Flattened location rules, e.g. `post_type==product`, `taxonomy==pa_storlek`. */
  locations: string[];
}

export interface AcfIndex {
  groups: Map<number, AcfGroup>;
  fieldsByKey: Map<string, AcfField>;
  /** Top-level fields of groups located on products. */
  productFields: AcfField[];
}

function settings(content: string): Record<string, unknown> {
  const m = maybeUnserialize(content);
  return m.ok &&
    m.value &&
    typeof m.value === 'object' &&
    !Array.isArray(m.value)
    ? (m.value as Record<string, unknown>)
    : {};
}

export function buildAcfIndex(tables: WpTables): AcfIndex {
  const groups = new Map<number, AcfGroup>();
  for (const p of tables.posts.values()) {
    if (p.type !== 'acf-field-group') continue;
    const s = settings(p.content);
    const locations: string[] = [];
    const loc = s.location;
    const orGroups = Array.isArray(loc) ? loc : [];
    for (const and of orGroups) {
      for (const rule of Array.isArray(and) ? and : []) {
        const r = rule as Record<string, unknown>;
        if (r && typeof r.param === 'string')
          locations.push(
            `${r.param}${typeof r.operator === 'string' ? r.operator : '=='}${typeof r.value === 'string' || typeof r.value === 'number' ? r.value : ''}`,
          );
      }
    }
    groups.set(p.id, { id: p.id, key: p.name, title: p.title, locations });
  }
  const fieldsByKey = new Map<string, AcfField>();
  const fieldPosts = [...tables.posts.values()].filter(
    (p) => p.type === 'acf-field',
  );
  const byId = new Map(fieldPosts.map((p) => [p.id, p]));
  for (const p of fieldPosts) {
    const s = settings(p.content);
    // Walk up to the owning group (sub-fields of repeaters have a field parent).
    let groupId = p.parent;
    for (let i = 0; i < 16 && byId.has(groupId); i++)
      groupId = byId.get(groupId)!.parent;
    fieldsByKey.set(p.name, {
      id: p.id,
      key: p.name,
      name: p.excerpt,
      label: p.title,
      type: typeof s.type === 'string' ? s.type : '',
      group_id: groupId,
      parent_id: p.parent,
    });
  }
  const productGroupIds = new Set(
    [...groups.values()]
      .filter((g) => g.locations.includes('post_type==product'))
      .map((g) => g.id),
  );
  const productFields = [...fieldsByKey.values()].filter(
    (f) => productGroupIds.has(f.group_id) && f.parent_id === f.group_id,
  );
  return { groups, fieldsByKey, productFields };
}

/** Value of an ACF field on an object, `null` when empty / not an ACF value. */
export function acfValue(meta: MetaBag, name: string): string | null {
  const v = meta.first(name);
  if (v === undefined || v === null || v.trim() === '') return null;
  return v;
}

/** True when `key` is an ACF reference meta (`_<name>` = `field_…`). */
export function isAcfReferenceKey(meta: MetaBag, key: string): boolean {
  if (!key.startsWith('_')) return false;
  const v = meta.first(key);
  return typeof v === 'string' && /^field_[0-9a-z]+$/i.test(v.trim());
}

/**
 * FAQ candidates: wysiwyg fields of product groups (care / size & fit /
 * delivery on Namez) plus rows of a `product_faq`-style repeater whose
 * sub-fields are a text title and a wysiwyg content.
 */
export function detectFaq(meta: MetaBag, acf: AcfIndex): NFaqItem[] {
  const out: NFaqItem[] = [];
  for (const f of acf.productFields) {
    if (f.type === 'wysiwyg') {
      const html = acfValue(meta, f.name);
      if (html) out.push({ field: f.name, label: f.label, html });
    } else if (f.type === 'repeater') {
      const rows = Number.parseInt(meta.first(f.name) ?? '0', 10);
      if (!Number.isFinite(rows) || rows <= 0) continue;
      const subs = [...acf.fieldsByKey.values()].filter(
        (s) => s.parent_id === f.id,
      );
      const titleSub = subs.find((s) => s.type === 'text');
      const bodySub = subs.find(
        (s) => s.type === 'wysiwyg' || s.type === 'textarea',
      );
      if (!titleSub || !bodySub) continue;
      for (let i = 0; i < Math.min(rows, 100); i++) {
        const label = acfValue(meta, `${f.name}_${i}_${titleSub.name}`);
        const html = acfValue(meta, `${f.name}_${i}_${bodySub.name}`);
        if (label && html) out.push({ field: `${f.name}_${i}`, label, html });
      }
    }
  }
  return out;
}

/** Product video URLs held in ACF url/file fields whose name mentions "video". */
export function detectAcfVideos(meta: MetaBag, acf: AcfIndex): string[] {
  const out: string[] = [];
  for (const f of acf.productFields) {
    if (
      !/video/i.test(f.name) ||
      (f.type !== 'url' && f.type !== 'file' && f.type !== 'text')
    )
      continue;
    const v = acfValue(meta, f.name);
    if (v && /^https?:\/\//i.test(v.trim())) out.push(v.trim());
  }
  return out;
}

/** Product fields the adapter consumes (FAQ, videos) — everything else is "known ACF". */
export function consumedAcfFieldNames(acf: AcfIndex): Set<string> {
  return new Set(acf.productFields.map((f) => f.name));
}

/**
 * ACF term fields → variation-card data (Discovery C §4.3). Slots by field
 * name: label, size → size, extra → badge, colorbadge → badge_color,
 * price → price_text, shipment → shipment_text (the last two are report-only, D15).
 */
const CARD_SLOTS: Record<string, keyof NTermCard> = {
  label: 'label',
  size: 'size',
  extra: 'badge',
  colorbadge: 'badge_color',
  price: 'price_text',
  shipment: 'shipment_text',
};

export function detectTermCard(termMeta: MetaBag): NTermCard | undefined {
  const card: NTermCard = {};
  let any = false;
  for (const [name, slot] of Object.entries(CARD_SLOTS)) {
    if (!isAcfReferenceKey(termMeta, `_${name}`)) continue;
    const v = acfValue(termMeta, name);
    if (v !== null) {
      card[slot] = v;
      any = true;
    }
  }
  return any ? card : undefined;
}

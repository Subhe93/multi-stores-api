import type {
  NIssue,
  NMediaRef,
  NProductDesigner,
  NTemplate,
} from '../../../model/normalized';
import type { ExternalRefKind } from '../../../model/external-ref';
import { maybeUnserialize } from '../php-unserialize';
import type { MediaRefResolver } from '../media-refs';
import { decodeOption, metaOf, MetaBag, WpTables } from '../wp-tables';

/**
 * namez-poster-plugin (NPP, Discovery C §3): `npp_template` posts with
 * `_npp_*` meta, linked from products by `_npp_enabled` + `_npp_template_id`.
 * The importer does not interpret elements — it stages them raw for M4.2
 * (C26), plus the asset URLs it must fetch to private storage.
 */

export const NPP_PRODUCT_META_PREFIX = '_npp_';

/** Decode a meta value that may be JSON or PHP-serialized; raw string otherwise. */
export function decodeLoose(raw: string | null | undefined): unknown {
  if (raw === undefined || raw === null) return null;
  const t = raw.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(t);
    } catch {
      /* fall through */
    }
  }
  const m = maybeUnserialize(raw);
  return m.ok ? m.value : raw;
}

function templateId(meta: MetaBag): number {
  const n = Number.parseInt(meta.first('_npp_template_id') ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Designer hand-off for one product; null when the product has no NPP meta at all. */
export function detectNppProduct(
  meta: MetaBag,
  tables: WpTables,
  ref: (kind: ExternalRefKind, id: string | number) => string,
): NProductDesigner | null {
  if (!meta.keys().some((k) => k.startsWith(NPP_PRODUCT_META_PREFIX)))
    return null;
  const tid = templateId(meta);
  const tpl = tid ? tables.posts.get(tid) : undefined;
  const flag = (meta.first('_npp_enabled') ?? '').trim();
  const enabled =
    (flag === '1' || flag === 'yes') && !!tpl && tpl.type === 'npp_template';
  const out: NProductDesigner = {
    enabled,
    template_ext_id: tid ? ref('npp_template', tid) : null,
  };
  if (meta.has('_npp_addons'))
    out.addons = decodeLoose(meta.first('_npp_addons'));
  if (meta.has('_npp_pricing'))
    out.pricing = decodeLoose(meta.first('_npp_pricing'));
  return out;
}

/** Element properties that hold asset URLs (backgrounds, decorations). */
const ASSET_KEYS = ['imageData', 'imageDataHiRes', 'src', 'url'];

export function buildTemplates(
  tables: WpTables,
  media: MediaRefResolver,
  ref: (kind: ExternalRefKind, id: string | number) => string,
  linkedProducts: Map<number, string[]>,
  issues: NIssue[],
): NTemplate[] {
  const out: NTemplate[] = [];
  const posts = [...tables.posts.values()]
    .filter((p) => p.type === 'npp_template')
    .sort((a, b) => a.id - b.id);
  for (const p of posts) {
    const meta = metaOf(tables.postmeta, p.id);
    const ext = ref('npp_template', p.id);
    const raw_meta: Record<string, unknown> = {};
    for (const k of meta.keys()) {
      if (k.startsWith(NPP_PRODUCT_META_PREFIX))
        raw_meta[k] = decodeLoose(meta.first(k));
    }
    const elementsRaw = raw_meta._npp_elements;
    let elements: unknown[] = [];
    if (Array.isArray(elementsRaw)) elements = elementsRaw;
    else if (elementsRaw !== undefined && elementsRaw !== null) {
      issues.push({
        level: 'warn',
        code: 'W_TEMPLATE_ELEMENTS_UNREADABLE',
        message: `Template ${p.id}: _npp_elements could not be read`,
        external_ref: ext,
      });
    }
    const fontsRaw = raw_meta._npp_fonts;
    const fonts = Array.isArray(fontsRaw)
      ? fontsRaw.filter((f): f is string => typeof f === 'string')
      : [];

    const assets: NMediaRef[] = [];
    const seen = new Set<string>();
    const pushAsset = (url: unknown) => {
      if (typeof url !== 'string' || !url) return;
      if (url.startsWith('data:')) {
        issues.push({
          level: 'warn',
          code: 'W_TEMPLATE_INLINE_ASSET',
          message: `Template ${p.id} embeds an inline data: asset (kept in raw_meta)`,
          external_ref: ext,
        });
        return;
      }
      const r = media.fromUrl(url);
      if (r && !seen.has(r.url)) {
        seen.add(r.url);
        assets.push(r);
      }
    };
    for (const el of elements) {
      if (!el || typeof el !== 'object') continue;
      for (const k of ASSET_KEYS) pushAsset((el as Record<string, unknown>)[k]);
    }

    let thumbnail: NMediaRef | null = null;
    const thumbId = Number.parseInt(meta.first('_npp_thumbnail_id') ?? '', 10);
    if (Number.isFinite(thumbId) && thumbId > 0)
      thumbnail = media.fromAttachment(thumbId, { external_ref: ext });
    if (!thumbnail) thumbnail = media.fromUrl(meta.first('_npp_thumbnail_url'));

    out.push({
      ext_id: ext,
      source_id: String(p.id),
      title: p.title,
      size_mode:
        typeof raw_meta._npp_size_mode === 'string'
          ? raw_meta._npp_size_mode
          : '',
      elements,
      fonts,
      thumbnail,
      assets,
      linked_product_ext_ids: linkedProducts.get(p.id) ?? [],
      raw_meta,
    });
  }
  return out;
}

export function nppDisplaySettings(
  tables: WpTables,
): Record<string, unknown> | undefined {
  const v = decodeOption(tables, 'npp_display');
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

export { templateId as nppTemplateId };

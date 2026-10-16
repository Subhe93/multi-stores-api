import { CustomizationType, ProductType } from '@prisma/client';
import { validateOptionConfig } from '../../personalization/personalization-config.validator';
import {
  cleanTermName,
  cleanText,
  metaDescriptionFromExcerpt,
  resolveSeoTemplate,
  stripShortcodes,
  htmlToPlainText,
  type HtmlSanitizer,
} from '../model/clean';
import type {
  NAttribute,
  NMediaRef,
  NormalizedCatalog,
  NProduct,
  NVariation,
} from '../model/normalized';
import {
  presetDescriptorsFor,
  type PresetDescriptor,
  type PresetSkip,
} from '../model/presets';
import { resolveAnyVariations } from '../model/variations';
import type {
  ImportRunOptions,
  TargetProductStatus,
} from '../runs/run-options';
import { money } from './hash';
import { platformSlug } from './slug';

/**
 * Product → platform rows (M4.4 §4.2, D19–D22, D14/D15). Pure: the result
 * is what the planner hashes and the applier writes. Media stay source URLs
 * here; the applier swaps them for the uploaded URLs.
 */

export type OptionStyle = 'color' | 'image' | 'text' | 'card';

export interface ValueMeta {
  label?: string;
  sublabel?: string;
  badge?: string;
  badge_color?: string;
  count?: number;
}

export interface MappedOptionConfig {
  name: string;
  style: OptionStyle;
  values: string[];
  colorMap?: Record<string, string>;
  /** value → swatch image SOURCE url (D14; never the variant image). */
  swatchMap?: Record<string, string>;
  valueMeta?: Record<string, ValueMeta>;
}

export interface MappedVariant {
  ref: string;
  sku: string | null;
  price_adjustment: string;
  compare_at_price: string | null;
  stock_quantity: number | null;
  is_active: boolean;
  options: Record<string, string>;
}

export interface MappedImage {
  source_url: string;
  candidates: string[];
  alt: string | null;
}

export interface MappedFaq {
  field: string;
  question: string;
  answer: string;
}

export interface MappedProduct {
  ref: string;
  source_id: string;
  source_title: string;
  /** Desired slug (D25 suffixing is the planner's job). */
  slug: string;
  status: TargetProductStatus;
  product_type: ProductType;
  customization_type: CustomizationType | null;
  base_price: string;
  compare_at_price: string | null;
  sku: string | null;
  track_inventory: boolean;
  stock_quantity: number | null;
  weight: string | null;
  /** Platform unit of `weight` (kg | g | lb); null = platform default. */
  weight_unit: string | null;
  tax_exempt: boolean;
  option_config: MappedOptionConfig[] | null;
  variants: MappedVariant[];
  images: MappedImage[];
  category_refs: string[];
  tags: string[];
  faqs: MappedFaq[];
  translation: {
    title: string;
    description: string;
    short_description: string | null;
    meta_title: string | null;
    meta_desc: string | null;
  };
  presets: PresetDescriptor[];
  broken_presets: PresetSkip[];
  /** NPP designer link (D28) when the source product uses a template. */
  npp: {
    template_ref: string | null;
    addons?: unknown;
    pricing?: unknown;
  } | null;
  shipping_class_slug: string | null;
  menu_order: number;
  /** Inline `<img>` on the source uploads (rewritten by the applier). */
  inline_images: MappedImage[];
  /** Swatch images of image-style options (D14). */
  swatch_media: MappedImage[];
  /** Preset help images (C25/X15): preset source_ref → image key → media. */
  help_images: Record<string, Record<string, MappedImage>>;
}

export interface MapWarning {
  code: string;
  external_ref: string;
  title: string;
  message: string;
}

export interface ProductMapContext {
  catalog: NormalizedCatalog;
  options: ImportRunOptions;
  sanitizer: HtmlSanitizer;
  now: Date;
  warn: (w: MapWarning) => void;
  /** Source host aliases rewritten to the site host (D10). */
  host_aliases?: string[];
}

function nullIfEmpty(s: string | null | undefined): string | null {
  const t = (s ?? '').trim();
  return t === '' ? null : t;
}

function isSourceHostUrl(url: string, siteHost: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === siteHost;
  } catch {
    return false;
  }
}

/**
 * §4.3 step 5: inline `<img>` of other hosts are removed (W_HTML_IMAGE_REMOVED),
 * images on the source host are kept for the applier to rewrite.
 */
function splitInlineImages(
  html: string,
  catalog: NormalizedCatalog,
  aliases: Map<string, string>,
): { html: string; local: MappedImage[]; removed: number } {
  const local: MappedImage[] = [];
  let removed = 0;
  const out = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const raw = m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
    let url: string | null = null;
    try {
      const u = new URL(raw, `https://${catalog.meta.site_host}/`);
      const host =
        aliases.get(u.hostname.toLowerCase()) ?? u.hostname.toLowerCase();
      u.hostname = host;
      u.protocol = 'https:';
      url = u.toString();
    } catch {
      url = null;
    }
    if (!url || !isSourceHostUrl(url, catalog.meta.site_host)) {
      removed++;
      return '';
    }
    const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    local.push({
      source_url: url,
      candidates: [url.replace(/-scaled(\.[a-z0-9]+)$/i, '$1'), url],
      alt: alt ? cleanText(alt[1] ?? alt[2] ?? '') || null : null,
    });
    return tag;
  });
  return { html: out, local, removed };
}

/** D19 effective price of a simple product (sale schedule respected). */
function simplePrice(
  p: NProduct,
  now: Date,
  warn: (msg: string) => void,
): { effective: number; compare: number | null } {
  const { regular, sale, current } = p.price;
  let saleActive = sale !== null && (regular === null || sale < regular);
  if (saleActive && p.price.sale_from) {
    const from = Date.parse(p.price.sale_from);
    if (Number.isFinite(from) && from > now.getTime()) {
      saleActive = false;
      warn(`scheduled sale from ${p.price.sale_from} ignored`);
    }
  }
  if (saleActive && p.price.sale_to) {
    const to = Date.parse(p.price.sale_to);
    if (Number.isFinite(to) && to < now.getTime()) saleActive = false;
  }
  const effective = saleActive ? sale! : (regular ?? current ?? sale ?? 0);
  const compare =
    saleActive && regular !== null && regular > effective ? regular : null;
  return { effective, compare };
}

/** D19 effective price of a variation (`_price` is maintained by WooCommerce). */
function variationPrice(v: NVariation): {
  effective: number;
  compare: number | null;
} {
  const { regular, sale, current } = v.price;
  const effective =
    current ??
    (sale !== null && (regular === null || sale < regular) ? sale : regular) ??
    0;
  const compare = regular !== null && regular > effective ? regular : null;
  return { effective, compare };
}

function variationActive(v: NVariation): boolean {
  return !(v.status === 'private' || v.stock.status === 'outofstock');
}

export function customizationFor(
  p: NProduct,
  options: ImportRunOptions,
): { product_type: ProductType; customization_type: CustomizationType | null } {
  const kinds = p.personalization
    .filter((m) => m.kind !== 'broken')
    .map((m) => m.kind as string);
  const designerOn = !!p.designer?.enabled;
  if (!kinds.length && !designerOn) {
    return { product_type: ProductType.TRADITIONAL, customization_type: null };
  }
  const rule = options.customization_type_rules.find(
    (r) =>
      (r.mechanisms && r.mechanisms.some((m) => kinds.includes(m))) ||
      (r.designer && designerOn),
  );
  return {
    product_type: ProductType.CUSTOMIZABLE,
    customization_type: rule ? rule.type : CustomizationType.OTHER,
  };
}

/** Option label shown on the platform (override, else cleaned label). */
function optionName(
  key: string,
  def: NAttribute | undefined,
  localLabel: string,
  options: ImportRunOptions,
): string {
  const override = options.label_overrides[key];
  if (override !== undefined) return override;
  return cleanText(def?.label ?? localLabel ?? key);
}

/**
 * M4.1 `validateOptionConfig` semantics at planning time (fix 11): every
 * valueMeta key that the product save path would reject (non-hex
 * `badge_color`, text over the limit, count out of range, value too long)
 * is dropped with W_VALUE_META_DROPPED instead of being written.
 */
export function sanitizeValueMeta(
  option: { name: string },
  meta: Record<string, ValueMeta>,
  warn: (message: string) => void,
): Record<string, ValueMeta> {
  const out: Record<string, ValueMeta> = {};
  for (const [value, entry] of Object.entries(meta)) {
    const whole = validateOptionConfig([
      { values: [value], valueMeta: { [value]: {} } },
    ]);
    if (whole.length) {
      warn(`${option.name} / ${value}: ${whole.map((i) => i.code).join(',')}`);
      continue;
    }
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entry)) {
      const issues = validateOptionConfig([
        { values: [value], valueMeta: { [value]: { [k]: v as unknown } } },
      ]);
      if (issues.length) {
        warn(
          `${option.name} / ${value}: ${k} dropped (${issues.map((i) => i.code).join(',')})`,
        );
        continue;
      }
      kept[k] = v;
    }
    if (Object.keys(kept).length) out[value] = kept as ValueMeta;
  }
  return out;
}

function mapUnit(u: string): string | null {
  if (u === 'kg' || u === 'g') return u;
  if (u === 'lbs' || u === 'lb' || u === 'oz') return 'lb';
  return null;
}

/** Woo `woocommerce_weight_unit` → platform unit, with the value converted for oz (§4.2). */
export function platformWeight(
  weight: number | null,
  unit: string | null | undefined,
): { weight: number | null; unit: string | null; converted: boolean } {
  const u = (unit ?? '').trim().toLowerCase();
  if (u === 'oz' && weight !== null)
    return { weight: weight / 16, unit: 'lb', converted: true };
  return { weight, unit: u ? mapUnit(u) : null, converted: false };
}

interface BuiltOptions {
  config: MappedOptionConfig[];
  swatches: MappedImage[];
  /** attribute key → (term slug or local value → option value) */
  valueOf: Map<string, Map<string, string>>;
  nameOf: Map<string, string>;
}

function buildOptionConfig(p: NProduct, ctx: ProductMapContext): BuiltOptions {
  const { catalog, options } = ctx;
  const attrByTax = new Map(catalog.attributes.map((a) => [a.taxonomy, a]));
  const config: MappedOptionConfig[] = [];
  const valueOf = new Map<string, Map<string, string>>();
  const nameOf = new Map<string, string>();
  const counts = new Map<string, Record<string, number>>();
  for (const m of p.personalization) {
    if (m.kind === 'name_color_per_item')
      counts.set(m.quantity_attribute, m.counts);
  }
  const usedNames = new Set<string>();
  const swatches: MappedImage[] = [];
  const attrs = p.attributes
    .filter((a) => a.variation)
    .slice()
    .sort((a, b) => a.position - b.position);
  for (const a of attrs) {
    const def = a.is_taxonomy ? attrByTax.get(a.key) : undefined;
    let name = optionName(a.key, def, a.label, options);
    if (usedNames.has(name)) name = `${name} (${a.key})`;
    usedNames.add(name);
    nameOf.set(a.key, name);
    const map = new Map<string, string>();
    const used = new Set<string>();
    const values: string[] = [];
    const colorMap: Record<string, string> = {};
    const swatchMap: Record<string, string> = {};
    const valueMeta: Record<string, ValueMeta> = {};
    const termList = def
      ? def.terms.filter((t) => a.values.includes(t.slug))
      : a.values.map(
          (v) => ({ slug: v, name: v }) as NAttribute['terms'][number],
        );
    for (const t of termList) {
      let value = cleanTermName(t.name, options.term_cleanup).value;
      if (used.has(value)) value = cleanText(t.name);
      if (used.has(value)) value = `${value} (${t.slug})`;
      used.add(value);
      map.set(t.slug, value);
      values.push(value);
      if (t.color) colorMap[value] = t.color;
      if (t.image && !t.image.missing && t.image.url) {
        swatchMap[value] = t.image.url;
        if (def?.swatch_type === 'image') swatches.push(mediaRefOf(t.image));
      }
      const meta: ValueMeta = {};
      if (t.card?.label) meta.label = cleanText(t.card.label);
      if (t.card?.size) meta.sublabel = cleanText(t.card.size);
      if (t.card?.badge) meta.badge = cleanText(t.card.badge);
      if (t.card?.badge_color) meta.badge_color = t.card.badge_color;
      const c = counts.get(a.key)?.[t.slug];
      if (typeof c === 'number') meta.count = c;
      if (Object.keys(meta).length) valueMeta[value] = meta;
    }
    valueOf.set(a.key, map);
    const entry: MappedOptionConfig = { name, style: 'text', values };
    if (def?.swatch_type === 'color' && Object.keys(colorMap).length) {
      entry.style = 'color';
      entry.colorMap = colorMap;
    } else if (def?.swatch_type === 'image' && Object.keys(swatchMap).length) {
      entry.style = 'image';
      entry.swatchMap = swatchMap;
    } else if (Object.keys(valueMeta).length) {
      entry.style = 'card';
    }
    const cleanMeta = sanitizeValueMeta(entry, valueMeta, (message) =>
      ctx.warn({
        code: 'W_VALUE_META_DROPPED',
        external_ref: p.ext_id,
        title: cleanText(p.title),
        message,
      }),
    );
    if (Object.keys(cleanMeta).length) entry.valueMeta = cleanMeta;
    else if (entry.style === 'card') entry.style = 'text';
    config.push(entry);
  }
  return { config, swatches, valueOf, nameOf };
}

export function mapProduct(p: NProduct, ctx: ProductMapContext): MappedProduct {
  const { catalog, options, sanitizer } = ctx;
  const title = cleanText(p.title);
  const warn = (code: string, message: string) =>
    ctx.warn({ code, external_ref: p.ext_id, title, message });
  const aliases = new Map<string, string>(
    (ctx.host_aliases ?? []).map((a) => [
      a.toLowerCase(),
      catalog.meta.site_host,
    ]),
  );

  // Prices, variants and option config (D19–D21).
  let base_price: number;
  let compare_at_price: number | null;
  let variants: MappedVariant[] = [];
  let option_config: MappedOptionConfig[] | null = null;
  let swatch_media: MappedImage[] = [];
  if (p.type === 'variable' && p.variations.length) {
    const built = buildOptionConfig(p, ctx);
    option_config = built.config.length ? built.config : null;
    swatch_media = built.swatches;
    const res = resolveAnyVariations(p);
    if (res.too_large.length) {
      warn(
        'W_VARIATION_ANY_TOO_LARGE',
        `${res.too_large.length} "any" variations not expanded`,
      );
    }
    const kept = [...res.concrete, ...res.expanded];
    const priced = kept.map((v) => ({
      v,
      ...variationPrice(v),
      active: variationActive(v),
    }));
    const pool = priced.filter((x) => x.active).length
      ? priced.filter((x) => x.active)
      : priced;
    const cheapest = pool.reduce<(typeof priced)[number] | null>(
      (best, x) => (!best || x.effective < best.effective ? x : best),
      null,
    );
    base_price = cheapest?.effective ?? 0;
    compare_at_price = cheapest?.compare ?? null;
    const valuesOf = new Map(
      built.config.map((o) => [o.name, new Set(o.values)]),
    );
    const outside = new Set<string>();
    variants = priced.map(({ v, effective, compare, active }) => {
      const opts: Record<string, string> = {};
      for (const [key, raw] of Object.entries(v.attrs)) {
        const name = built.nameOf.get(key);
        if (!name || raw === null) continue;
        const value =
          built.valueOf.get(key)?.get(raw) ??
          cleanTermName(raw, options.term_cleanup).value;
        opts[name] = value;
        // Fix 18: a value the option does not list cannot be picked in the selector.
        if (!valuesOf.get(name)?.has(value)) outside.add(`${name}: ${value}`);
      }
      return {
        ref: v.ext_id,
        sku: nullIfEmpty(v.sku),
        price_adjustment: money(effective - base_price)!,
        compare_at_price: money(compare),
        stock_quantity: v.stock.manage ? v.stock.qty : null,
        is_active: active,
        options: opts,
      };
    });
    for (const o of outside)
      warn(
        'W_VARIANT_VALUE_NOT_IN_OPTIONS',
        `variation value "${o}" is not one of the option values`,
      );
    if (p.variations.some((v) => v.image && !v.image.missing)) {
      warn('W_VARIATION_IMAGE_UNMAPPED', 'variation images are not imported');
    }
  } else {
    const sp = simplePrice(p, ctx.now, (m) =>
      warn('W_SALE_SCHEDULE_IGNORED', m),
    );
    base_price = sp.effective;
    compare_at_price = sp.compare;
  }

  // Images (product level, D8/D9).
  const images: MappedImage[] = [];
  const seenImg = new Set<string>();
  for (const img of p.images) {
    if (img.missing || !img.url || seenImg.has(img.url)) continue;
    seenImg.add(img.url);
    images.push({
      source_url: img.url,
      candidates: img.candidates.length ? img.candidates : [img.url],
      alt: nullIfEmpty(cleanText(img.alt ?? '')),
    });
  }

  // HTML: shortcodes → inline images → sanitizer (§4.3).
  const inline_images: MappedImage[] = [];
  const html = (raw: string): string => {
    const sc = stripShortcodes(raw ?? '');
    const split = splitInlineImages(sc.html, catalog, aliases);
    if (split.removed)
      warn(
        'W_HTML_IMAGE_REMOVED',
        `${split.removed} inline image(s) on other hosts`,
      );
    // The plain-text fallback drops every tag, so inline images are not fetched then.
    if ((sanitizer as { mode?: string }).mode !== 'plain_text_fallback')
      inline_images.push(...split.local);
    return sanitizer.sanitize(split.html).trim();
  };
  const description = html(p.content_html);
  const short_description = nullIfEmpty(html(p.excerpt_html));

  const rm = catalog.store_settings.rank_math ?? {};
  const seoVars = {
    title,
    sep: rm.sep ?? '-',
    sitename: rm.site_name ?? '',
    excerpt: htmlToPlainText(p.excerpt_html),
  };
  const meta_title = p.seo.title
    ? nullIfEmpty(resolveSeoTemplate(p.seo.title, seoVars))
    : null;
  const meta_desc = p.seo.description
    ? nullIfEmpty(resolveSeoTemplate(p.seo.description, seoVars))
    : nullIfEmpty(metaDescriptionFromExcerpt(p.excerpt_html));

  // Tags (cleaned names) and FAQs.
  const tagByRef = new Map(catalog.tags.map((t) => [t.ext_id, t]));
  const tags = [
    ...new Set(
      p.tag_ext_ids
        .map((r) => tagByRef.get(r))
        .filter((t): t is NonNullable<typeof t> => !!t)
        .map((t) => cleanText(t.name))
        .filter(Boolean),
    ),
  ];
  const faqs: MappedFaq[] = [];
  for (const f of p.extras.faq) {
    const answer = html(f.html);
    if (!answer) {
      warn('W_FAQ_EMPTY_SKIPPED', `${f.field}: nothing left after cleaning`);
      continue;
    }
    faqs.push({
      field: f.field,
      question: options.faq_labels[f.field] ?? cleanText(f.label),
      answer,
    });
  }

  if (p.tax.class)
    warn(
      'W_TAX_CLASS_UNMAPPED',
      `tax class "${p.tax.class}" left at the store default`,
    );

  const { presets, skipped: broken_presets } = presetDescriptorsFor(
    p,
    catalog,
    {
      label_overrides: options.label_overrides,
      term_cleanup: options.term_cleanup,
    },
  );
  const custom = customizationFor(p, options);

  // Preset help images (C25/X15) from the run options, source host only.
  const help_images: MappedProduct['help_images'] = {};
  for (const d of presets) {
    const wanted = options.preset_help_images?.[d.key];
    if (!wanted) continue;
    const map: Record<string, MappedImage> = {};
    for (const [k, raw] of Object.entries(wanted)) {
      const url = sourceHostUrl(raw, catalog, aliases);
      if (!url) {
        warn('W_HELP_IMAGE_REJECTED', `${d.key}.${k}: not on the source host`);
        continue;
      }
      map[k] = {
        source_url: url,
        candidates: [url.replace(/-scaled(\.[a-z0-9]+)$/i, '$1'), url],
        alt: null,
      };
    }
    if (Object.keys(map).length) help_images[d.source_ref] = map;
  }
  const w = platformWeight(p.weight, catalog.meta.weight_unit);
  if (w.converted)
    warn(
      'W_WEIGHT_CONVERTED',
      `${p.weight} oz stored as ${money(w.weight)} lb`,
    );

  return {
    ref: p.ext_id,
    source_id: p.source_id,
    source_title: p.title,
    slug: platformSlug(p.slug),
    status: options.status_map[p.status] ?? 'DRAFT',
    product_type: custom.product_type,
    customization_type: custom.customization_type,
    base_price: money(base_price)!,
    compare_at_price: money(compare_at_price),
    sku: nullIfEmpty(p.sku),
    track_inventory: p.stock.manage,
    stock_quantity: p.stock.manage ? p.stock.qty : null,
    weight: money(w.weight),
    weight_unit: w.unit,
    tax_exempt: p.tax.status === 'none',
    option_config,
    variants,
    images,
    category_refs: [...new Set(p.category_ext_ids)],
    tags,
    faqs,
    translation: {
      title,
      description,
      short_description,
      meta_title,
      meta_desc,
    },
    presets,
    broken_presets,
    npp: p.designer?.enabled
      ? {
          template_ref: p.designer.template_ext_id,
          addons: p.designer.addons,
          pricing: p.designer.pricing,
        }
      : null,
    shipping_class_slug: p.shipping_class_slug,
    menu_order: p.menu_order,
    inline_images,
    swatch_media,
    help_images,
  };
}

/** Absolute https URL on the source host (aliases rewritten), else null. */
function sourceHostUrl(
  raw: string,
  catalog: NormalizedCatalog,
  aliases: Map<string, string>,
): string | null {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    u.hostname = aliases.get(host) ?? host;
    u.protocol = 'https:';
    const url = u.toString();
    return isSourceHostUrl(url, catalog.meta.site_host) ? url : null;
  } catch {
    return null;
  }
}

/** Swaps inline `<img src>` source URLs for uploaded URLs; drops images that were not stored. */
export function rewriteInlineImages(
  html: string,
  resolve: (sourceUrl: string) => string | null,
  siteHost: string,
): string {
  if (!html.includes('<img')) return html;
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const raw = m ? (m[1] ?? m[2] ?? '') : '';
    let url: string | null = null;
    try {
      const u = new URL(raw, `https://${siteHost}/`);
      u.protocol = 'https:';
      url = u.toString();
    } catch {
      url = null;
    }
    const target = url ? resolve(url) : null;
    if (!target || !m) return '';
    return tag.replace(m[0], `src="${target.replace(/"/g, '&quot;')}"`);
  });
}

/** Category position of products inside each collection: (menu_order, title) — D24. */
export function collectionPositions(
  products: MappedProduct[],
): Map<string, Map<string, number>> {
  const byCat = new Map<string, MappedProduct[]>();
  for (const p of products)
    for (const c of p.category_refs) {
      const list = byCat.get(c) ?? [];
      list.push(p);
      byCat.set(c, list);
    }
  const out = new Map<string, Map<string, number>>();
  for (const [cat, list] of byCat) {
    const sorted = list
      .slice()
      .sort(
        (a, b) =>
          a.menu_order - b.menu_order ||
          a.translation.title.localeCompare(b.translation.title, 'sv') ||
          (a.ref < b.ref ? -1 : 1),
      );
    out.set(cat, new Map(sorted.map((p, i) => [p.ref, i])));
  }
  return out;
}

/** Source URL of every media this product needs (images, swatches, inline). */
export function productMediaRefs(p: MappedProduct): MappedImage[] {
  return [...p.images, ...p.inline_images, ...p.swatch_media];
}

/** Help images of one planned preset (C25/X15). */
export function presetHelpRefs(
  p: MappedProduct,
  sourceRef: string,
): MappedImage[] {
  return Object.values(p.help_images?.[sourceRef] ?? {});
}

export function mediaRefOf(ref: NMediaRef): MappedImage {
  return {
    source_url: ref.url,
    candidates: ref.candidates.length ? ref.candidates : [ref.url],
    alt: ref.alt ?? null,
  };
}

/**
 * One-off setup (M91 pilot): create a separate TEST store `layout-pilot`, a
 * small faithful copy of Namez (`namez-se`), so the product page can be
 * compared as the classic monolith template vs "Convert to blocks" with the
 * `product_layout` store app (PageSection.parent_id containers + product
 * blocks). Nothing of Namez is changed: every row is read from Namez and
 * written as a NEW row (new ids, relations remapped) owned by a NEW creator.
 *
 * COPIED (new ids, relations remapped):
 *   - Owner: new User (role CREATOR, ACTIVE, email verified, bcrypt cost 12
 *     like auth.service.ts) + Creator profile (onboarding survey completed).
 *     The random password goes ONLY to the access file (mode 0600).
 *   - Store `layout-pilot` "Layout Pilot (test)", status DRAFT (coming soon
 *     publicly; the owner previews through the dashboard cookie):
 *     store_type, currency, theme_key, theme_customizations, theme_config,
 *     description, logo_url, favicon_url, checkout_settings,
 *     show_vendor_name, cache_enabled, consent_required and the tax settings
 *     (pricing mode, basis, country, OSS flag, platform-rates flag, display
 *     incl. tax, shipping tax class remapped).
 *   - StoreLanguageConfig (primary / secondary / fallback locale).
 *   - The six mandatory legacy StaticPage rows, as StoresService.create seeds.
 *   - Store-scoped TaxClass + TaxRate rows of Namez (so product tax classes
 *     and price display resolve the same way).
 *   - Markets: every Namez Market row (key, countries, locales, currency,
 *     price rule, status) WITHOUT domains and without payment_check;
 *     indexing forced to NEVER. ProductMarketPrice rows of the copied
 *     products / variants.
 *   - Store apps: `personalization`, `markets`, `b2b` copied as Namez has
 *     them (available / enabled / settings), plus `product_layout`
 *     available + enabled for this store only (enabled_by = new owner).
 *   - Products (default: the 7 real Namez products of the web parity
 *     fixtures, multi-stores-web/src/test/fixtures/products; the synthetic
 *     derived-bundles-sku fixture is skipped; override with --products=):
 *     product row (status kept, external_ref dropped), translations (same
 *     slugs: slugs are unique per creator, the owner is new), variants
 *     (options, prices; a SKU gets the suffix `-LP` because
 *     ProductVariant.sku is globally unique; external_ref dropped), images
 *     (same URLs, product- and variant-level; no file is copied),
 *     variant_option_config as-is (imageMap / swatchMap / valueMeta URLs
 *     reused), attributes (global templates), custom fields with
 *     translations (parents before children, parent_id + id references in
 *     linked_validation / conditions remapped), FAQs with translations,
 *     collection links + primary collection.
 *   - Collections (CreatorCategory) linked to those products, plus their
 *     ancestors (breadcrumbs), with translations; external_ref dropped;
 *     ids in match_tags remapped.
 *   - Shipping: the profiles the products use plus Namez's default profile
 *     (free-shipping threshold fallback), with zones and methods.
 *   - Bundles (with translations, offers, offer translations) attached to a
 *     copied product; only links to copied products are created.
 *   - Promotions shown on the product page: CREATOR_TO_CUSTOMER, ACTIVE,
 *     not COUPON, no coupon_code (globally unique), store-wide or targeting
 *     a copied product; product_ids / category_ids remapped; usage reset.
 *   - Menus + items (header / footer chrome). PAGE items and items whose
 *     product / collection is not copied become CUSTOM (url kept).
 *   - Pages v2: PRODUCT_TEMPLATE, HEADER, FOOTER copied from Namez's WORKING
 *     DRAFT (translations, seo, sections incl. hidden ones, section
 *     translations, parent_id remapped), then published with the API's own
 *     buildPublishSnapshot + publishPageTx from dist/ (one PageVersion each).
 *     A warning is printed when Namez's draft differs from its published
 *     version. Ids inside section settings / content that point at a copied
 *     row are remapped; other UUID strings are left and listed in the report.
 *
 * DELIBERATELY SKIPPED:
 *   - Payment: Stripe accounts / restricted keys (StoreStripeKeys), Kustom
 *     credentials, cod_enabled; mail (StoreMailSettings, Zoho, templates);
 *     custom_domain + StoreDomain rows; trader_details / legal profiles;
 *     tracking ids (GA4, Meta pixel / CAPI token, TikTok); notification
 *     email; orders, carts, customers, invoices, archived orders, imports,
 *     redirects, uploaded-file records.
 *   - Designer app: templates / versions / ProductDesigner links and design
 *     assets are store-scoped with private storage keys (heavy, and they
 *     would point at Namez's private files). Products keep working without
 *     the designer block; the count of skipped designer links is reported.
 *   - Custom products (marketplace imports), legacy ProductTag rows,
 *     personalization field library, HOME / STATIC / LANDING / listing
 *     template pages, page version history, other store apps.
 *   - Nothing is converted to blocks: the owner presses "Convert to blocks".
 *
 *   node scripts/ops/layout-pilot-store-create.js --owner-email=x@y.z            (dry run)
 *   node scripts/ops/layout-pilot-store-create.js --owner-email=x@y.z --apply    (write + publish)
 *
 * Options: --access-file=<path> (default /root/layout-pilot-access.txt, must
 * not exist), --report=<path> (default
 * /root/backups/multi-stores/layout-pilot-<UTC>.json), --products=slug1,slug2.
 *
 * Run from the API directory after a build (dist/ is used for the publish
 * helpers) with the production environment loaded (DATABASE_URL;
 * STOREFRONT_URL + REVALIDATE_SECRET for the cache refresh). No secret and
 * no password is ever printed. Refuses to run when `layout-pilot` exists.
 *
 * Rollback (ids are in the report): delete the copied products
 * (Product.creator_id = new creator), the promotions of the new creator, then
 * the new User (cascades Creator -> Store -> pages, apps, markets, tax rows,
 * collections, bundles, shipping profiles).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');

const SOURCE_SLUG = 'namez-se';
const TARGET_SLUG = 'layout-pilot';
const TARGET_NAME = 'Layout Pilot (test)';
const VERSION_LABEL = 'Layout pilot copy of namez-se';
const SKU_SUFFIX = '-LP';
// Same cost as PASSWORD_BCRYPT_COST in src/modules/auth/auth.service.ts.
const BCRYPT_COST = 12;
// Store apps copied from Namez as they are (no secrets in their settings).
const COPIED_APPS = ['personalization', 'markets', 'b2b'];
const PILOT_APP = 'product_layout';
const PAGE_TYPES = ['PRODUCT_TEMPLATE', 'HEADER', 'FOOTER'];
// Sv slugs of the real Namez products in the web parity fixtures.
const DEFAULT_PRODUCTS = [
  'personlig-3d-namnpresent',
  'personlig-studentpresent-till-kille-eller-tjej',
  'termosflaska-for-barn-med-graverat-namn-450-ml',
  '3d-bokstav-med-namn',
  '3d-bokstav-med-namn2',
  'dalahast-svenska-presenter-sverige',
  'personligt-3d-namnhalsband-med-ett-eller-flera-namn',
];
// Mandatory legacy static pages, as StoresService.create seeds them.
const STATIC_SEED = [
  ['ABOUT', 'about'],
  ['CONTACT', 'contact'],
  ['PRIVACY_POLICY', 'privacy-policy'],
  ['TERMS', 'terms'],
  ['SHIPPING_POLICY', 'shipping-policy'],
  ['RETURN_POLICY', 'return-policy'],
];

// ── Arguments ───────────────────────────────────────────────────

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : undefined;
}
const APPLY = process.argv.includes('--apply');
const STAMP = new Date().toISOString().replace(/[:.]/g, '');
const OWNER_EMAIL = (arg('owner-email') || '').toLowerCase();
const ACCESS_FILE = arg('access-file') || '/root/layout-pilot-access.txt';
const REPORT_FILE = arg('report') || `/root/backups/multi-stores/layout-pilot-${STAMP}.json`;
const PRODUCT_SLUGS = arg('products')
  ? arg('products').split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_PRODUCTS;

// Minimal error format: a failed create must not pretty-print its data
// argument (the owner's password hash) into the console.
const prisma = new PrismaClient({ errorFormat: 'minimal' });

// ── Helpers ─────────────────────────────────────────────────────

const newId = () => crypto.randomUUID();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Old id -> new id of every copied row (all tables share one map). */
const idMap = new Map();
/** UUID strings in copied JSON that do not point at a copied row. */
const foreignRefs = new Set();

function mapId(oldId) {
  if (!idMap.has(oldId)) idMap.set(oldId, newId());
  return idMap.get(oldId);
}
const mapped = (oldId) => (oldId ? idMap.get(oldId) ?? null : null);

/** Deep copy of a JSON value with every string equal to a copied id replaced. */
function remapJson(value) {
  if (typeof value === 'string') {
    if (idMap.has(value)) return idMap.get(value);
    if (UUID_RE.test(value)) foreignRefs.add(value);
    return value;
  }
  if (Array.isArray(value)) return value.map(remapJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = remapJson(v);
    return out;
  }
  return value;
}

/** Nullable Json column: SQL NULL is written by leaving the field out. */
const J = (v) => (v === null || v === undefined ? undefined : v);
const JR = (v) => (v === null || v === undefined ? undefined : remapJson(v));

/** Rows ordered so every parent comes before its children. */
function parentsFirst(rows) {
  const ids = new Set(rows.map((r) => r.id));
  const out = [];
  const done = new Set();
  const visit = (r) => {
    if (done.has(r.id)) return;
    if (r.parent_id && ids.has(r.parent_id)) visit(rows.find((x) => x.id === r.parent_id));
    done.add(r.id);
    out.push(r);
  };
  rows.forEach(visit);
  return out;
}

function loadPagesService() {
  for (const base of ['dist/src/modules/pages-v2', 'dist/modules/pages-v2']) {
    const file = path.resolve(base, 'pages-v2.service.js');
    if (!fs.existsSync(file)) continue;
    const mod = require(file);
    if (typeof mod.buildPublishSnapshot !== 'function' || typeof mod.publishPageTx !== 'function') {
      throw new Error('dist pages-v2.service.js has no buildPublishSnapshot / publishPageTx: rebuild the API.');
    }
    return mod;
  }
  throw new Error('API build (dist/) not found: run from the API directory after a build.');
}

async function revalidate(slug) {
  const base = process.env.STOREFRONT_URL;
  const secret = process.env.REVALIDATE_SECRET;
  if (!base || !secret) {
    console.log('Revalidation skipped (STOREFRONT_URL / REVALIDATE_SECRET not set).');
    return;
  }
  try {
    const res = await fetch(`${base}/api/revalidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-revalidate-secret': secret },
      body: JSON.stringify({ slug }),
    });
    console.log(`Revalidation: HTTP ${res.status}`);
  } catch (err) {
    console.log(`Revalidation failed: ${err.message}`);
  }
}

/** Comparable form of snapshot sections (ids and parent ids left out). */
const comparable = (sections) =>
  JSON.stringify(
    (sections || []).map((s) => [
      s.section_key,
      s.settings,
      s.sort_order,
      [...(s.translations || [])]
        .sort((a, b) => a.locale.localeCompare(b.locale))
        .map((t) => [t.locale, t.content]),
    ]),
  );

// ── Load (read-only) ────────────────────────────────────────────

async function loadSource() {
  const store = await prisma.store.findUnique({
    where: { slug: SOURCE_SLUG },
    // Explicit select: secret columns (meta_capi_token, ...) are never read.
    select: {
      id: true,
      creator_id: true,
      store_type: true,
      currency: true,
      theme_key: true,
      theme_customizations: true,
      theme_config: true,
      description: true,
      logo_url: true,
      favicon_url: true,
      checkout_settings: true,
      show_vendor_name: true,
      cache_enabled: true,
      consent_required: true,
      tax_pricing_mode: true,
      tax_basis: true,
      tax_country: true,
      oss_registered: true,
      use_platform_tax_rates: true,
      shipping_tax_class_id: true,
      display_prices_incl_tax: true,
      language_config: true,
    },
  });
  if (!store) throw new Error(`Store ${SOURCE_SLUG} not found`);
  const creatorId = store.creator_id;

  const products = [];
  const missing = [];
  for (const slug of PRODUCT_SLUGS) {
    const p = await prisma.product.findFirst({
      where: { creator_id: creatorId, translations: { some: { slug } } },
      include: {
        translations: true,
        images: true,
        attributes: true,
        variants: true,
        creator_categories: true,
        custom_fields: { include: { translations: true } },
        faqs: { include: { translations: true } },
        market_prices: true,
        bundles: true,
        designer: { select: { product_id: true } },
      },
    });
    if (!p) missing.push(slug);
    else if (!products.some((x) => x.id === p.id)) products.push(p);
  }
  if (missing.length) throw new Error(`Products not found in ${SOURCE_SLUG}: ${missing.join(', ')}`);
  const productIds = new Set(products.map((p) => p.id));

  // Collections linked to the products, plus their ancestors.
  const allCats = await prisma.creatorCategory.findMany({
    where: { creator_id: creatorId },
    include: { translations: true },
  });
  const byId = new Map(allCats.map((c) => [c.id, c]));
  const catIds = new Set();
  const addCat = (id) => {
    for (let c = byId.get(id); c && !catIds.has(c.id); c = byId.get(c.parent_id)) catIds.add(c.id);
  };
  for (const p of products) {
    p.creator_categories.forEach((l) => addCat(l.creator_category_id));
    if (p.primary_creator_category_id) addCat(p.primary_creator_category_id);
  }
  const collections = allCats.filter((c) => catIds.has(c.id));

  // Shipping profiles used by the products + the creator's default profile.
  const profileIds = new Set(products.map((p) => p.shipping_profile_id).filter(Boolean));
  const profiles = await prisma.shippingProfile.findMany({
    where: { creator_id: creatorId, OR: [{ id: { in: [...profileIds] } }, { is_default: true }] },
    include: { zones: { include: { methods: true } } },
  });
  const foreignProfiles = [...profileIds].filter((id) => !profiles.some((p) => p.id === id));

  const taxClasses = await prisma.taxClass.findMany({ where: { store_id: store.id } });
  // Store rates, on the store's own classes or on platform classes.
  const taxRates = await prisma.taxRate.findMany({ where: { store_id: store.id } });
  const markets = await prisma.market.findMany({ where: { store_id: store.id } });
  const apps = await prisma.storeApp.findMany({
    where: { store_id: store.id, app_key: { in: COPIED_APPS } },
  });

  const bundleIds = new Set(products.flatMap((p) => p.bundles.map((b) => b.bundle_id)));
  const bundles = await prisma.bundle.findMany({
    where: { id: { in: [...bundleIds] }, creator_id: creatorId },
    include: { translations: true, offers: { include: { translations: true } }, products: true },
  });

  const promoRows = await prisma.promotion.findMany({
    where: {
      creator_id: creatorId,
      level: 'CREATOR_TO_CUSTOMER',
      status: 'ACTIVE',
      type: { notIn: ['COUPON'] },
    },
    include: { translations: true },
  });
  const promotions = [];
  const skippedPromotions = [];
  for (const p of promoRows) {
    const ids = (p.conditions && p.conditions.product_ids) || [];
    const relevant = !ids.length || ids.some((id) => productIds.has(id));
    if (!relevant) continue;
    if (p.coupon_code) skippedPromotions.push({ id: p.id, reason: 'coupon_code is globally unique' });
    else promotions.push(p);
  }

  const menus = await prisma.menu.findMany({ where: { store_id: store.id }, include: { items: true } });

  const pages = [];
  for (const type of PAGE_TYPES) {
    const page = await prisma.page.findFirst({
      where: { store_id: store.id, type },
      include: {
        translations: true,
        sections: { include: { translations: true }, orderBy: { sort_order: 'asc' } },
        published_version: { select: { snapshot: true } },
      },
    });
    if (page) pages.push(page);
  }

  return {
    store,
    creatorId,
    products,
    collections,
    profiles,
    foreignProfiles,
    taxClasses,
    taxRates,
    markets,
    apps,
    bundles,
    promotions,
    skippedPromotions,
    menus,
    pages,
  };
}

// ── Plan (pure: builds every row with its new id) ───────────────

function buildPlan(src, owner, pagesMod) {
  const rows = {};
  const add = (model, row) => (rows[model] = rows[model] || []).push(row);
  const now = new Date();

  // Pre-assign every new id first so JSON references can be remapped.
  const userId = newId();
  const creatorId = newId();
  const storeId = newId();
  idMap.set(src.creatorId, creatorId);
  idMap.set(src.store.id, storeId);
  src.taxClasses.forEach((c) => mapId(c.id));
  src.taxRates.forEach((r) => mapId(r.id));
  src.markets.forEach((m) => mapId(m.id));
  src.profiles.forEach((p) => {
    mapId(p.id);
    p.zones.forEach((z) => {
      mapId(z.id);
      z.methods.forEach((m) => mapId(m.id));
    });
  });
  src.collections.forEach((c) => mapId(c.id));
  for (const p of src.products) {
    mapId(p.id);
    p.variants.forEach((v) => mapId(v.id));
    p.images.forEach((i) => mapId(i.id));
    p.custom_fields.forEach((f) => mapId(f.id));
    p.faqs.forEach((f) => mapId(f.id));
  }
  src.bundles.forEach((b) => {
    mapId(b.id);
    b.offers.forEach((o) => mapId(o.id));
  });
  src.promotions.forEach((p) => mapId(p.id));
  src.menus.forEach((m) => {
    mapId(m.id);
    m.items.forEach((i) => mapId(i.id));
  });
  src.pages.forEach((pg) => {
    mapId(pg.id);
    pg.sections.forEach((s) => mapId(s.id));
  });

  // Owner (password hash is filled in at apply time only).
  add('user', {
    id: userId,
    email: owner.email,
    password_hash: owner.passwordHash,
    role: 'CREATOR',
    status: 'ACTIVE',
    email_verified_at: now,
  });
  add('creator', {
    id: creatorId,
    user_id: userId,
    display_name: 'Layout Pilot',
    onboarding_profile: { account_kind: 'independent', completed_at: now.toISOString() },
  });

  const s = src.store;
  add('store', {
    id: storeId,
    creator_id: creatorId,
    slug: TARGET_SLUG,
    name: TARGET_NAME,
    description: s.description,
    logo_url: s.logo_url,
    favicon_url: s.favicon_url,
    store_type: s.store_type,
    currency: s.currency,
    theme_key: s.theme_key,
    theme_customizations: remapJson(s.theme_customizations),
    theme_config: remapJson(s.theme_config),
    status: 'DRAFT',
    is_active: false,
    cache_enabled: s.cache_enabled,
    show_vendor_name: s.show_vendor_name,
    consent_required: s.consent_required,
    checkout_settings: J(s.checkout_settings),
    tax_pricing_mode: s.tax_pricing_mode,
    tax_basis: s.tax_basis,
    tax_country: s.tax_country,
    oss_registered: s.oss_registered,
    use_platform_tax_rates: s.use_platform_tax_rates,
    // A store class is remapped; a platform class id is kept.
    shipping_tax_class_id: s.shipping_tax_class_id ? mapped(s.shipping_tax_class_id) || s.shipping_tax_class_id : null,
    display_prices_incl_tax: s.display_prices_incl_tax,
  });

  const lc = s.language_config;
  add('storeLanguageConfig', {
    id: newId(),
    store_id: storeId,
    primary_locale: lc?.primary_locale || 'en',
    secondary_locales: lc?.secondary_locales || [],
    auto_translate: lc?.auto_translate ?? false,
    fallback_locale: lc?.fallback_locale || 'en',
  });
  STATIC_SEED.forEach(([type, slug], i) =>
    add('staticPage', { id: newId(), store_id: storeId, type, slug, is_required: true, sort_order: i + 1, status: 'DRAFT' }),
  );

  for (const a of src.apps) {
    add('storeApp', {
      id: newId(),
      store_id: storeId,
      app_key: a.app_key,
      available: a.available,
      enabled: a.enabled,
      settings: remapJson(a.settings),
      enabled_at: a.enabled ? now : null,
      enabled_by: a.enabled ? userId : null,
    });
  }
  add('storeApp', {
    id: newId(),
    store_id: storeId,
    app_key: PILOT_APP,
    available: true,
    enabled: true,
    settings: {},
    enabled_at: now,
    enabled_by: userId,
  });

  for (const c of src.taxClasses) {
    add('taxClass', { id: mapped(c.id), store_id: storeId, key: c.key, name: c.name, is_default: c.is_default, sort_order: c.sort_order });
  }
  for (const r of src.taxRates) {
    add('taxRate', {
      id: mapped(r.id),
      store_id: storeId,
      // A store class is remapped; a platform class id is kept.
      tax_class_id: mapped(r.tax_class_id) || r.tax_class_id,
      country: r.country,
      region: r.region,
      postcode_pattern: r.postcode_pattern,
      rate_bp: r.rate_bp,
      label: r.label,
      priority: r.priority,
      applies_to_shipping: r.applies_to_shipping,
      is_active: r.is_active,
    });
  }

  for (const m of src.markets) {
    add('market', {
      id: mapped(m.id),
      store_id: storeId,
      key: m.key,
      name: m.is_default ? TARGET_NAME : m.name,
      countries: m.countries,
      default_locale: m.default_locale,
      locales: m.locales,
      currency: m.currency,
      is_default: m.is_default,
      status: m.status,
      price_rule: m.price_rule,
      // Test store: never indexed, whatever the host.
      indexing: 'NEVER',
    });
  }

  for (const p of src.profiles) {
    add('shippingProfile', { id: mapped(p.id), creator_id: creatorId, name: p.name, is_default: p.is_default });
    for (const z of p.zones) {
      add('shippingZone', {
        id: mapped(z.id),
        profile_id: mapped(p.id),
        name: z.name,
        countries: z.countries,
        base_cost: z.base_cost,
        per_item_cost: z.per_item_cost,
        free_threshold: z.free_threshold,
        estimated_days_min: z.estimated_days_min,
        estimated_days_max: z.estimated_days_max,
        hide_others_when_free: z.hide_others_when_free,
      });
      for (const m of z.methods) {
        add('shippingMethod', {
          id: mapped(m.id),
          zone_id: mapped(z.id),
          name: m.name,
          translations: J(m.translations),
          type: m.type,
          base_cost: m.base_cost,
          per_item_cost: m.per_item_cost,
          free_threshold: m.free_threshold,
          estimated_days_min: m.estimated_days_min,
          estimated_days_max: m.estimated_days_max,
          is_active: m.is_active,
          sort_order: m.sort_order,
        });
      }
    }
  }

  for (const c of parentsFirst(src.collections)) {
    add('creatorCategory', {
      id: mapped(c.id),
      creator_id: creatorId,
      parent_id: mapped(c.parent_id),
      slug: c.slug,
      thumbnail_url: c.thumbnail_url,
      match_rule: c.match_rule,
      match_tags: remapJson(c.match_tags),
      sort_order: c.sort_order,
      is_active: c.is_active,
      noindex_when_empty: c.noindex_when_empty,
      visibility: c.visibility,
    });
    for (const t of c.translations) {
      add('creatorCategoryTranslation', {
        id: newId(),
        creator_category_id: mapped(c.id),
        locale: t.locale,
        name: t.name,
        description: t.description,
        long_description: t.long_description,
        meta_title: t.meta_title,
        meta_desc: t.meta_desc,
      });
    }
  }

  const skipped = { designer_links: 0, foreign_shipping_profiles: src.foreignProfiles.length, variant_skus_suffixed: 0 };
  for (const p of src.products) {
    const pid = mapped(p.id);
    if (p.designer) skipped.designer_links += 1;
    add('product', {
      id: pid,
      provider_id: p.provider_id,
      creator_id: creatorId,
      category_id: p.category_id,
      product_type: p.product_type,
      customization_type: p.customization_type,
      base_price: p.base_price,
      compare_at_price: p.compare_at_price,
      cost_price: p.cost_price,
      sku: p.sku,
      track_inventory: p.track_inventory,
      stock_quantity: p.stock_quantity,
      weight: p.weight,
      weight_unit: p.weight_unit,
      variant_option_config: JR(p.variant_option_config),
      shipping_profile_id: mapped(p.shipping_profile_id),
      tax_class_id: p.tax_class_id ? mapped(p.tax_class_id) || p.tax_class_id : null,
      tax_exempt: p.tax_exempt,
      status: p.status,
      is_featured: p.is_featured,
      gtin: p.gtin,
      mpn: p.mpn,
      brand: p.brand,
      google_product_category: p.google_product_category,
      condition: p.condition,
      // The copy never reaches a feed.
      feed_excluded: true,
      primary_creator_category_id: mapped(p.primary_creator_category_id),
    });
    for (const t of p.translations) {
      add('productTranslation', {
        id: newId(),
        product_id: pid,
        locale: t.locale,
        title: t.title,
        description: t.description,
        slug: t.slug,
        meta_title: t.meta_title,
        meta_desc: t.meta_desc,
        short_description: t.short_description,
      });
    }
    for (const v of p.variants) {
      if (v.sku) skipped.variant_skus_suffixed += 1;
      add('productVariant', {
        id: mapped(v.id),
        product_id: pid,
        sku: v.sku ? `${v.sku}${SKU_SUFFIX}` : null,
        price_adjustment: v.price_adjustment,
        compare_at_price: v.compare_at_price,
        stock_quantity: v.stock_quantity,
        is_active: v.is_active,
        options: v.options,
      });
    }
    for (const i of p.images) {
      add('productImage', {
        id: mapped(i.id),
        product_id: pid,
        variant_id: mapped(i.variant_id),
        url: i.url,
        alt_text: i.alt_text,
        sort_order: i.sort_order,
        is_featured: i.is_featured,
      });
    }
    for (const a of p.attributes) {
      add('productAttribute', { id: newId(), product_id: pid, template_id: a.template_id, value: a.value });
    }
    for (const f of parentsFirst(p.custom_fields)) {
      add('productCustomField', {
        id: mapped(f.id),
        product_id: pid,
        name: f.name,
        type: f.type,
        is_required: f.is_required,
        placeholder: f.placeholder,
        // Every JSON column is remapped: only exact copied-id strings change.
        options: JR(f.options),
        validation_rules: JR(f.validation_rules),
        linked_validation: JR(f.linked_validation),
        sort_order: f.sort_order,
        parent_id: mapped(f.parent_id),
        conditions: JR(f.conditions),
        pricing: JR(f.pricing),
        repeat: JR(f.repeat),
        ui: JR(f.ui),
        preset_key: f.preset_key,
        preset_ref: f.preset_ref,
      });
      for (const t of f.translations) {
        add('customFieldTranslation', {
          id: newId(),
          field_id: mapped(f.id),
          locale: t.locale,
          label: t.label,
          placeholder: t.placeholder,
          option_labels: JR(t.option_labels),
          display_label: t.display_label,
          sublabel: t.sublabel,
          note: t.note,
          help_text: t.help_text,
          help_image_url: t.help_image_url,
          messages: J(t.messages),
        });
      }
    }
    for (const f of p.faqs) {
      add('productFaq', { id: mapped(f.id), product_id: pid, sort_order: f.sort_order });
      for (const t of f.translations) {
        add('productFaqTranslation', { id: newId(), faq_id: mapped(f.id), locale: t.locale, question: t.question, answer: t.answer });
      }
    }
    for (const l of p.creator_categories) {
      add('productCreatorCategory', {
        product_id: pid,
        creator_category_id: mapped(l.creator_category_id),
        sort_order: l.sort_order,
      });
    }
    for (const mp of p.market_prices) {
      if (!mapped(mp.market_id)) continue;
      add('productMarketPrice', {
        id: newId(),
        market_id: mapped(mp.market_id),
        product_id: pid,
        variant_id: mapped(mp.variant_id),
        price: mp.price,
        compare_at_price: mp.compare_at_price,
        available: mp.available,
      });
    }
  }

  for (const b of src.bundles) {
    add('bundle', { id: mapped(b.id), creator_id: creatorId, status: b.status });
    for (const t of b.translations) add('bundleTranslation', { id: newId(), bundle_id: mapped(b.id), locale: t.locale, name: t.name });
    for (const o of b.offers) {
      add('bundleOffer', {
        id: mapped(o.id),
        bundle_id: mapped(b.id),
        quantity: o.quantity,
        discount_type: o.discount_type,
        discount_value: o.discount_value,
        sort_order: o.sort_order,
      });
      for (const t of o.translations) {
        add('bundleOfferTranslation', {
          id: newId(),
          offer_id: mapped(o.id),
          locale: t.locale,
          title: t.title,
          label: t.label,
          sticker_text: t.sticker_text,
        });
      }
    }
    for (const bp of b.products) {
      if (mapped(bp.product_id)) add('bundleProduct', { bundle_id: mapped(b.id), product_id: mapped(bp.product_id) });
    }
  }

  for (const p of src.promotions) {
    const conditions = { ...(p.conditions || {}) };
    // Targets outside the copy are dropped (store-wide stays store-wide).
    if (Array.isArray(conditions.product_ids) && conditions.product_ids.length) {
      conditions.product_ids = conditions.product_ids.map(mapped).filter(Boolean);
    }
    if (Array.isArray(conditions.category_ids)) {
      conditions.category_ids = conditions.category_ids.map((id) => mapped(id) || id);
    }
    add('promotion', {
      id: mapped(p.id),
      creator_id: creatorId,
      type: p.type,
      level: p.level,
      value: p.value,
      conditions: remapJson(conditions),
      usage_limit: p.usage_limit,
      usage_count: 0,
      starts_at: p.starts_at,
      expires_at: p.expires_at,
      status: p.status,
    });
    for (const t of p.translations) {
      add('promotionTranslation', { id: newId(), promotion_id: mapped(p.id), locale: t.locale, title: t.title, description: t.description });
    }
  }

  let customizedMenuItems = 0;
  for (const m of src.menus) {
    add('menu', { id: mapped(m.id), store_id: storeId, key: m.key, name: m.name });
    for (const i of parentsFirst(m.items)) {
      const target = i.kind === 'PAGE' ? null : mapped(i.resource_id);
      const keep = i.kind === 'CUSTOM' || !!target;
      if (!keep) customizedMenuItems += 1;
      add('menuItem', {
        id: mapped(i.id),
        menu_id: mapped(m.id),
        parent_id: mapped(i.parent_id),
        sort_order: i.sort_order,
        kind: keep ? i.kind : 'CUSTOM',
        resource_id: keep ? target : null,
        label: i.label,
        label_i18n: i.label_i18n,
        url: i.url,
        open_in_new_tab: i.open_in_new_tab,
      });
    }
  }
  skipped.menu_items_made_custom = customizedMenuItems;

  // Pages: draft rows + an in-memory copy for the dry-run snapshot check.
  const draftWarnings = [];
  for (const pg of src.pages) {
    const published = pg.published_version?.snapshot;
    const draftSnap = pagesMod.buildPublishSnapshot(pg);
    if (!published) draftWarnings.push(`${pg.type}: Namez has no published version`);
    else if (comparable(draftSnap.sections) !== comparable(published.sections)) {
      draftWarnings.push(`${pg.type}: Namez's working draft differs from its published version (the draft is copied)`);
    }
    const pageId = mapped(pg.id);
    add('page', {
      id: pageId,
      store_id: storeId,
      type: pg.type,
      static_kind: pg.static_kind,
      slug: pg.slug,
      is_required: pg.is_required,
      sort_order: pg.sort_order,
      status: 'DRAFT',
      seo: remapJson(pg.seo),
    });
    for (const t of pg.translations) {
      add('pageTranslation', {
        id: newId(),
        page_id: pageId,
        locale: t.locale,
        title: t.title,
        meta_title: t.meta_title,
        meta_description: t.meta_description,
      });
    }
    for (const sec of parentsFirst(pg.sections)) {
      add('pageSection', {
        id: mapped(sec.id),
        page_id: pageId,
        section_key: sec.section_key,
        parent_id: mapped(sec.parent_id),
        settings: remapJson(sec.settings),
        sort_order: sec.sort_order,
        is_hidden: sec.is_hidden,
      });
      for (const t of sec.translations) {
        add('pageSectionTranslation', { id: newId(), section_id: mapped(sec.id), locale: t.locale, content: remapJson(t.content) });
      }
    }
  }

  // Dry-run check: the copied draft builds a publish snapshot.
  for (const page of rows.page || []) {
    const sections = (rows.pageSection || [])
      .filter((x) => x.page_id === page.id)
      .map((x) => ({ ...x, translations: (rows.pageSectionTranslation || []).filter((t) => t.section_id === x.id) }));
    const translations = (rows.pageTranslation || []).filter((t) => t.page_id === page.id);
    pagesMod.buildPublishSnapshot({ ...page, translations, sections });
  }

  return { rows, userId, creatorId, storeId, skipped, draftWarnings };
}

// Insert order: parents before children (foreign keys).
const ORDER = [
  'user',
  'creator',
  'store',
  'storeLanguageConfig',
  'staticPage',
  'storeApp',
  'taxClass',
  'taxRate',
  'market',
  'shippingProfile',
  'shippingZone',
  'shippingMethod',
  'creatorCategory',
  'creatorCategoryTranslation',
  'product',
  'productTranslation',
  'productVariant',
  'productImage',
  'productAttribute',
  'productCustomField',
  'customFieldTranslation',
  'productFaq',
  'productFaqTranslation',
  'productCreatorCategory',
  'productMarketPrice',
  'bundle',
  'bundleTranslation',
  'bundleOffer',
  'bundleOfferTranslation',
  'bundleProduct',
  'promotion',
  'promotionTranslation',
  'menu',
  'menuItem',
  'page',
  'pageTranslation',
  'pageSection',
  'pageSectionTranslation',
];
// Self-referencing tables are inserted row by row (parents already sorted first).
const ONE_BY_ONE = new Set(['user', 'creator', 'store', 'creatorCategory', 'productCustomField', 'menuItem', 'pageSection']);

// ── Main ────────────────────────────────────────────────────────

(async () => {
  let accessFd = null;
  let committed = false;
  try {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(OWNER_EMAIL)) {
      throw new Error('--owner-email=<address> is required (the new owner login; no default).');
    }
    const pagesMod = loadPagesService();

    // Second-run guards.
    if (await prisma.store.findUnique({ where: { slug: TARGET_SLUG }, select: { id: true } })) {
      throw new Error(`Store ${TARGET_SLUG} already exists; nothing to do.`);
    }
    const taken = await prisma.user.findFirst({
      where: { store_id: null, email: { equals: OWNER_EMAIL, mode: 'insensitive' } },
      select: { id: true },
    });
    if (taken) throw new Error('A staff account with this email already exists; pick another --owner-email.');
    if (fs.existsSync(ACCESS_FILE)) throw new Error(`Access file ${ACCESS_FILE} already exists; move it away first.`);

    const src = await loadSource();
    const skus = src.products.flatMap((p) => p.variants.filter((v) => v.sku).map((v) => `${v.sku}${SKU_SUFFIX}`));
    if (skus.length) {
      const clash = await prisma.productVariant.findFirst({ where: { sku: { in: skus } }, select: { sku: true } });
      if (clash) throw new Error(`Variant SKU ${clash.sku} already exists; stopping.`);
    }

    console.log(`Source ${SOURCE_SLUG}: ${src.products.length} product(s), ${src.collections.length} collection(s), ` +
      `${src.pages.length} page(s) [${src.pages.map((p) => p.type).join(', ')}], ${src.menus.length} menu(s), ` +
      `${src.markets.length} market(s), apps [${src.apps.map((a) => `${a.app_key}:${a.enabled ? 'on' : 'off'}`).join(', ')}]`);
    for (const p of src.products) {
      const t = p.translations.find((x) => PRODUCT_SLUGS.includes(x.slug)) || p.translations[0];
      console.log(`  product ${t?.slug} (${p.status}) variants=${p.variants.length} fields=${p.custom_fields.length} images=${p.images.length}`);
    }

    let password = null;
    let passwordHash = 'dry-run';
    if (APPLY) {
      // The access file is reserved (exclusive create, 0600) before any write.
      fs.mkdirSync(path.dirname(path.resolve(ACCESS_FILE)), { recursive: true });
      // The report directory must be writable too: it is written after the
      // commit and holds the id map needed for a rollback.
      fs.mkdirSync(path.dirname(path.resolve(REPORT_FILE)), { recursive: true });
      fs.accessSync(path.dirname(path.resolve(REPORT_FILE)), fs.constants.W_OK);
      if (fs.existsSync(REPORT_FILE)) throw new Error(`Report file ${REPORT_FILE} already exists.`);
      accessFd = fs.openSync(ACCESS_FILE, 'wx', 0o600);
      password = crypto.randomBytes(24).toString('base64url');
      passwordHash = await require('bcrypt').hash(password, BCRYPT_COST);
    }

    const plan = buildPlan(src, { email: OWNER_EMAIL, passwordHash }, pagesMod);
    const counts = {};
    for (const model of ORDER) counts[model] = (plan.rows[model] || []).length;
    counts.pageVersion = counts.page;
    const skipped = {
      ...plan.skipped,
      promotions: src.skippedPromotions,
      unmapped_uuid_strings: [...foreignRefs],
      draft_warnings: plan.draftWarnings,
    };

    console.log('Rows to create:', JSON.stringify(counts));
    console.log('Skipped / notes:', JSON.stringify({ ...skipped, unmapped_uuid_strings: foreignRefs.size }));
    plan.draftWarnings.forEach((w) => console.log(`WARNING: ${w}`));

    if (!APPLY) {
      console.log('Dry run. Re-run with --apply to create the store and publish its pages.');
      return;
    }

    await prisma.$transaction(
      async (tx) => {
        for (const model of ORDER) {
          const list = plan.rows[model] || [];
          if (!list.length) continue;
          if (ONE_BY_ONE.has(model)) {
            for (const data of list) await tx[model].create({ data });
          } else {
            await tx[model].createMany({ data: list });
          }
        }
        for (const page of plan.rows.page || []) {
          const fresh = await tx.page.findUniqueOrThrow({
            where: { id: page.id },
            include: { translations: true, sections: { include: { translations: true }, orderBy: { sort_order: 'asc' } } },
          });
          const version = await pagesMod.publishPageTx(tx, page.id, pagesMod.buildPublishSnapshot(fresh), VERSION_LABEL);
          console.log(`Published ${page.type} version ${version.id}`);
        }
      },
      { timeout: 180000, maxWait: 10000 },
    );
    committed = true;

    fs.writeSync(
      accessFd,
      [
        `Layout pilot test store (${TARGET_SLUG}), created ${new Date().toISOString()}`,
        `Dashboard login email: ${OWNER_EMAIL}`,
        `Password: ${password}`,
        'Store status DRAFT: the storefront shows "coming soon"; preview it as the owner from the dashboard.',
        '',
      ].join('\n'),
    );
    fs.closeSync(accessFd);
    accessFd = null;
    console.log(`Owner access written to ${ACCESS_FILE} (mode 0600).`);

    const report = {
      created_at: new Date().toISOString(),
      source_store: SOURCE_SLUG,
      store: { id: plan.storeId, slug: TARGET_SLUG },
      owner: { user_id: plan.userId, creator_id: plan.creatorId, email: OWNER_EMAIL },
      products: PRODUCT_SLUGS,
      counts,
      skipped,
      // old id -> new id, for audits and rollback.
      id_map: Object.fromEntries(idMap),
    };
    fs.mkdirSync(path.dirname(path.resolve(REPORT_FILE)), { recursive: true });
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(`Report written: ${REPORT_FILE}`);
    console.log(`New store ${plan.storeId}, owner user ${plan.userId}`);

    await revalidate(TARGET_SLUG);
    console.log('Done.');
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exitCode = 1;
  } finally {
    if (accessFd !== null) {
      fs.closeSync(accessFd);
      // Nothing was created: drop the empty reserved access file.
      if (!committed) fs.rmSync(ACCESS_FILE, { force: true });
      else console.error(`The store was created but the access file could not be written: reset the owner password.`);
    }
    await prisma.$disconnect();
  }
})();

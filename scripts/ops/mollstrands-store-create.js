/**
 * One-off setup (headless checkout, client Möllstrands Trafikskola AB): create
 * the DRAFT store `mollstrands` with its owner, collections and products from
 * a catalog JSON file. The public site mollstrands.se is a separate custom
 * site; its buy buttons link to this store
 * (https://checkout.mollstrands.se/products/<slug>?qty=N), so every product
 * slug is exactly the old `/product/<slug>/` path segment.
 *
 * The catalog is client material and is NOT in this repo: pass the file
 * (client-stores/mollstrands/catalog.json, copied to the server) with
 * --catalog=<path>. Shape: { store: { slug, name, currency, primary_locale,
 * tax_country, trader_details }, categories: [{ slug, name, description,
 * meta_title, sort_order }], participant_fields: [{ name, label, type,
 * required, placeholder?, validation_rules? }], products: [{ slug, title,
 * price, compare_at_price, category, max_per_order, participant_fields,
 * publish, sort_order, short_description, description, meta_title,
 * meta_desc }] }.
 *
 * CREATED (only what is missing; an existing row is never updated):
 *   - Owner (only when the store does not exist): User (role CREATOR, ACTIVE,
 *     email verified, bcrypt cost 12 like auth.service.ts) + Creator profile
 *     (onboarding survey completed, account kind independent). The password
 *     comes from $MOLLSTRANDS_OWNER_PASSWORD (min 12 characters) or is
 *     generated; a generated password goes ONLY to the access file (mode
 *     0600, must not exist). It is never printed and never in the report.
 *   - Store `mollstrands` "Möllstrands Trafikskola" the way
 *     StoresService.create builds one: INDEPENDENT, status DRAFT (coming soon
 *     publicly), currency SEK, prices tax inclusive (pricing mode INCLUSIVE,
 *     shown incl. tax), tax country SE, trader details from the catalog,
 *     StoreLanguageConfig (primary sv), the six mandatory legacy StaticPage
 *     rows and the default Market row (as MarketsService.ensureDefaultMarket).
 *   - Collections (CreatorCategory + sv translation), matched by slug.
 *   - Products (Product + sv ProductTranslation + collection link + primary
 *     collection), matched by slug among ALL products of the store (any
 *     status): an existing slug is skipped, never duplicated and never
 *     overwritten (a differing price is only listed). Products are services:
 *     no shipping profile, track_inventory off, no stock, `max_per_order`
 *     from the catalog, status PUBLISHED (`publish: false` in the catalog
 *     gives DRAFT), so they are purchasable once the store is LIVE.
 *   - With --with-fields: the participant fields of the catalog (TEXT rows,
 *     the personnummer one with validation_rules.format = 'personnummer')
 *     with sv labels on every product marked `participant_fields` that has
 *     NO custom field yet, plus the `personalization` store app row
 *     (available + enabled) when missing: field rules belong to that app.
 *     Refused when the app row exists but is switched off.
 *
 * DELIBERATELY NOT SET (manual steps, plans/headless-booking/P6-STORE-SETUP.md):
 *   custom_domain / StoreDomain (checkout.mollstrands.se), payments (Kustom
 *   credentials, Stripe keys, COD), cache settings, checkout_settings
 *   (external website / return URL), theme, logo, menus, pages v2, mail
 *   settings and templates, notification email, tracking ids, legal texts,
 *   tax rates (platform rates apply), product images, go-live.
 *
 *   node scripts/ops/mollstrands-store-create.js --catalog=<file> --owner-email=x@y.z --platform-category=<slug|id>            (dry run)
 *   node scripts/ops/mollstrands-store-create.js --catalog=<file> --owner-email=x@y.z --platform-category=<slug|id> --apply    (write)
 *   node scripts/ops/mollstrands-store-create.js --catalog=<file> --platform-category=<slug|id> --with-fields --apply          (later run: fields / new products)
 *
 * Options:
 *   --catalog=<file>            required; the catalog JSON.
 *   --owner-email=<address>     owner login (or $MOLLSTRANDS_OWNER_EMAIL); required
 *                               while the store does not exist, optional after.
 *   --platform-category=<v>     slug or id of the platform Category every
 *                               product row needs (Product.category_id);
 *                               required when a product is created. Without
 *                               it the dry run lists the available ones.
 *   --with-fields               also create the participant fields (above).
 *   --access-file=<path>        default <backup dir>/mollstrands-access.txt.
 *   --backup-dir=<dir>          report dir (default: $MS_OPS_BACKUP_DIR, else
 *                               $MOLLSTRANDS_BACKUP_DIR, else
 *                               /var/lib/multistores/backups).
 *
 * The run writes a JSON report (state found before the run, every created
 * id, skipped rows) to <backup dir>/mollstrands-store-create-<UTC>.json.
 *
 * Run from the API directory with the production environment loaded
 * (DATABASE_URL; STOREFRONT_URL + REVALIDATE_SECRET for the cache refresh).
 * No secret and no password is ever printed.
 *
 * Rollback (ids are in the report): delete the created products
 * (Product.id in report.created.products), then, when the run created the
 * store, the new User (cascades Creator -> Store -> pages, market, apps,
 * collections). A later run only lists product / collection / field ids.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveBackupDir, checkBackupDir } = require('./backup-dir');

// Same cost as PASSWORD_BCRYPT_COST in src/modules/auth/auth.service.ts.
const BCRYPT_COST = 12;
const LOCALE = 'sv';
const FIELDS_APP = 'personalization';
// Mandatory legacy static pages, as StoresService.create seeds them.
const STATIC_SEED = [
  ['ABOUT', 'about'],
  ['CONTACT', 'contact'],
  ['PRIVACY_POLICY', 'privacy-policy'],
  ['TERMS', 'terms'],
  ['SHIPPING_POLICY', 'shipping-policy'],
  ['RETURN_POLICY', 'return-policy'],
];
// Tags the catalog HTML may use (a subset of the creator HTML allow-list;
// the rows are written directly, so the text is checked here instead).
const HTML_TAG_RE = /<\/?([a-z0-9]+)((?:\s[^<>]*)?)>/gi;
const HTML_TAGS = new Set(['p', 'h2', 'h3', 'ul', 'ol', 'li', 'a', 'strong', 'em', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
const HREF_ATTR_RE = /^\s+href="https?:\/\/[^"\s<>]+"$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,47}$/;
const FIELD_RULE_KEYS = new Set(['min_length', 'max_length', 'format']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Arguments ───────────────────────────────────────────────────

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : undefined;
}
const APPLY = process.argv.includes('--apply');
const WITH_FIELDS = process.argv.includes('--with-fields');
const STAMP = new Date().toISOString().replace(/[:.]/g, '');
const CATALOG_FILE = arg('catalog');
const OWNER_EMAIL = (arg('owner-email') || process.env.MOLLSTRANDS_OWNER_EMAIL || '').trim().toLowerCase();
const PLATFORM_CATEGORY = arg('platform-category');

const newId = () => crypto.randomUUID();

// ── Catalog (pure: read + validate, no database) ────────────────

function checkHtml(html, where, problems) {
  if (html === null || html === undefined || html === '') return;
  if (typeof html !== 'string') {
    problems.push(`${where}: must be a string`);
    return;
  }
  for (const m of html.matchAll(HTML_TAG_RE)) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] || '';
    if (!HTML_TAGS.has(tag)) problems.push(`${where}: tag <${tag}> is not allowed`);
    else if (attrs && !(tag === 'a' && HREF_ATTR_RE.test(attrs))) {
      problems.push(`${where}: attributes not allowed on <${tag}> (only <a href="http(s)://...">)`);
    }
  }
  // Anything that still looks like markup after removing the allowed tags.
  if (/[<>]/.test(html.replace(HTML_TAG_RE, ''))) problems.push(`${where}: stray "<" or ">"`);
}

function loadCatalog(file) {
  if (!file) throw new Error('--catalog=<file> is required (client-stores/mollstrands/catalog.json).');
  let raw;
  try {
    raw = fs.readFileSync(path.resolve(file), 'utf8');
  } catch (err) {
    throw new Error(`Catalog file ${file} cannot be read: ${err.code || err.message}`);
  }
  let catalog;
  try {
    catalog = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Catalog file ${file} is not valid JSON: ${err.message}`);
  }
  const problems = [];
  const s = catalog.store || {};
  if (!SLUG_RE.test(String(s.slug || ''))) problems.push('store.slug is missing or not a slug');
  if (!String(s.name || '').trim()) problems.push('store.name is missing');
  if (!/^[A-Z]{3}$/.test(String(s.currency || ''))) problems.push('store.currency must be ISO 4217');
  if (!/^[a-z]{2}$/.test(String(s.primary_locale || ''))) problems.push('store.primary_locale must be two letters');
  if (!/^[A-Z]{2}$/.test(String(s.tax_country || ''))) problems.push('store.tax_country must be ISO2');
  const t = s.trader_details || {};
  for (const key of ['legal_name', 'org_number', 'address_line1', 'postal_code', 'city', 'country', 'phone', 'support_email']) {
    if (!String(t[key] || '').trim()) problems.push(`store.trader_details.${key} is missing`);
  }
  if (t.business_type !== 'company' && t.business_type !== 'private') problems.push('store.trader_details.business_type must be company or private');

  const categories = Array.isArray(catalog.categories) ? catalog.categories : [];
  const catSlugs = new Set();
  for (const c of categories) {
    if (!SLUG_RE.test(String(c.slug || ''))) problems.push(`category "${c.slug}": bad slug`);
    if (catSlugs.has(c.slug)) problems.push(`category "${c.slug}": duplicate`);
    catSlugs.add(c.slug);
    if (!String(c.name || '').trim()) problems.push(`category "${c.slug}": name is missing`);
  }

  const fields = Array.isArray(catalog.participant_fields) ? catalog.participant_fields : [];
  const fieldNames = new Set();
  for (const f of fields) {
    if (!FIELD_NAME_RE.test(String(f.name || ''))) problems.push(`field "${f.name}": bad name`);
    if (fieldNames.has(f.name)) problems.push(`field "${f.name}": duplicate`);
    fieldNames.add(f.name);
    if (f.type !== 'TEXT') problems.push(`field "${f.name}": only TEXT fields are supported by this script`);
    if (!String(f.label || '').trim()) problems.push(`field "${f.name}": label is missing`);
    for (const [k, v] of Object.entries(f.validation_rules || {})) {
      if (!FIELD_RULE_KEYS.has(k)) problems.push(`field "${f.name}": rule "${k}" is not supported by this script`);
      else if (k === 'format' && v !== 'personnummer') problems.push(`field "${f.name}": unknown format "${v}"`);
      else if (k !== 'format' && !(Number.isInteger(v) && v >= 0 && v <= 5000)) problems.push(`field "${f.name}": ${k} must be an integer 0..5000`);
    }
  }

  const products = Array.isArray(catalog.products) ? catalog.products : [];
  if (!products.length) problems.push('products: the list is empty');
  const slugs = new Set();
  for (const p of products) {
    const id = `product "${p.slug}"`;
    if (!SLUG_RE.test(String(p.slug || ''))) problems.push(`${id}: bad slug`);
    if (slugs.has(p.slug)) problems.push(`${id}: duplicate slug`);
    slugs.add(p.slug);
    if (!String(p.title || '').trim()) problems.push(`${id}: title is missing`);
    if (!(typeof p.price === 'number' && Number.isFinite(p.price) && p.price > 0 && p.price < 1e8)) problems.push(`${id}: price must be a positive number`);
    if (p.compare_at_price !== null && p.compare_at_price !== undefined && !(typeof p.compare_at_price === 'number' && p.compare_at_price > p.price)) {
      problems.push(`${id}: compare_at_price must be null or higher than price`);
    }
    if (!catSlugs.has(p.category)) problems.push(`${id}: unknown category "${p.category}"`);
    if (p.max_per_order !== null && p.max_per_order !== undefined && !(Number.isInteger(p.max_per_order) && p.max_per_order >= 1 && p.max_per_order <= 9999)) {
      problems.push(`${id}: max_per_order must be null or an integer 1..9999`);
    }
    if (typeof p.description !== 'string') problems.push(`${id}: description must be a string`);
    checkHtml(p.description, `${id} description`, problems);
    checkHtml(p.short_description, `${id} short_description`, problems);
  }
  if (problems.length) throw new Error(`Catalog problems:\n  - ${problems.join('\n  - ')}`);
  return {
    store: s,
    categories,
    fields,
    products,
    sha256: crypto.createHash('sha256').update(raw).digest('hex'),
  };
}

// ── Helpers ─────────────────────────────────────────────────────

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

/** Id of the platform category every product row needs, or a readable error. */
async function resolvePlatformCategory(prisma, value) {
  if (value) {
    const row = await prisma.category.findFirst({
      where: UUID_RE.test(value) ? { id: value } : { slug: value },
      select: { id: true, slug: true, is_active: true },
    });
    if (row) {
      if (!row.is_active) console.log(`WARNING: platform category ${row.slug} is not active.`);
      return row;
    }
  }
  const rows = await prisma.category.findMany({
    where: { is_active: true },
    select: { slug: true, parent_id: true, translations: { where: { locale: { in: ['en', LOCALE] } }, select: { locale: true, name: true } } },
    orderBy: [{ sort_order: 'asc' }, { slug: 'asc' }],
  });
  console.log('Platform categories (pass one with --platform-category=<slug>):');
  for (const r of rows) {
    const name = (r.translations.find((x) => x.locale === 'en') || r.translations[0] || {}).name || '';
    console.log(`  ${r.parent_id ? '  ' : ''}${r.slug}${name ? `  (${name})` : ''}`);
  }
  throw new Error(
    value
      ? `Platform category "${value}" not found.`
      : '--platform-category=<slug|id> is required: products are created and Product.category_id is mandatory.',
  );
}

// ── Load (read-only) ────────────────────────────────────────────

async function loadState(prisma, catalog) {
  const store = await prisma.store.findUnique({
    where: { slug: catalog.store.slug },
    // Explicit select: secret columns are never read.
    select: {
      id: true,
      creator_id: true,
      name: true,
      status: true,
      store_type: true,
      currency: true,
      creator: { select: { user_id: true, user: { select: { email: true } } } },
    },
  });
  if (!store) return { store: null, categories: new Map(), products: new Map(), app: null };

  const catRows = await prisma.creatorCategory.findMany({
    where: { creator_id: store.creator_id, slug: { in: catalog.categories.map((c) => c.slug) } },
    select: { id: true, slug: true },
  });
  // Every status counts (ARCHIVED too): a slug that exists is never recreated.
  const prodRows = await prisma.product.findMany({
    where: {
      creator_id: store.creator_id,
      translations: { some: { slug: { in: catalog.products.map((p) => p.slug) } } },
    },
    select: {
      id: true,
      status: true,
      base_price: true,
      max_per_order: true,
      translations: { select: { locale: true, slug: true } },
      _count: { select: { custom_fields: true } },
    },
  });
  const wanted = new Set(catalog.products.map((p) => p.slug));
  const products = new Map();
  for (const row of prodRows) {
    for (const tr of row.translations) {
      if (wanted.has(tr.slug) && !products.has(tr.slug)) products.set(tr.slug, row);
    }
  }
  const app = await prisma.storeApp.findUnique({
    where: { store_id_app_key: { store_id: store.id, app_key: FIELDS_APP } },
    select: { id: true, available: true, enabled: true },
  });
  return { store, categories: new Map(catRows.map((c) => [c.slug, c.id])), products, app };
}

// ── Plan (pure: builds every row with its new id) ───────────────

function buildPlan(catalog, state, owner, platformCategoryId) {
  const rows = {};
  const add = (model, row) => (rows[model] = rows[model] || []).push(row);
  const now = new Date();
  const lines = [];
  const skipped = { categories: [], products: [], price_differs: [], fields_kept: [] };

  let storeId = state.store ? state.store.id : null;
  let creatorId = state.store ? state.store.creator_id : null;
  let userId = state.store ? state.store.creator.user_id : null;
  const createStore = !state.store;

  if (createStore) {
    userId = newId();
    creatorId = newId();
    storeId = newId();
    const s = catalog.store;
    add('user', {
      id: userId,
      email: owner.email,
      // Filled in at apply time only.
      password_hash: owner.passwordHash,
      role: 'CREATOR',
      status: 'ACTIVE',
      email_verified_at: now,
    });
    add('creator', {
      id: creatorId,
      user_id: userId,
      display_name: s.name,
      onboarding_profile: { account_kind: 'independent', country: s.tax_country, completed_at: now.toISOString() },
    });
    add('store', {
      id: storeId,
      creator_id: creatorId,
      slug: s.slug,
      name: s.name,
      store_type: 'INDEPENDENT',
      currency: s.currency,
      // New stores start as DRAFT (coming soon); is_active is derived.
      status: 'DRAFT',
      is_active: false,
      tax_pricing_mode: 'INCLUSIVE',
      display_prices_incl_tax: true,
      tax_country: s.tax_country,
      trader_details: { ...s.trader_details, completed_at: now.toISOString() },
    });
    add('storeLanguageConfig', { id: newId(), store_id: storeId, primary_locale: s.primary_locale, secondary_locales: [] });
    STATIC_SEED.forEach(([type, slug], i) =>
      add('staticPage', { id: newId(), store_id: storeId, type, slug, is_required: true, sort_order: i + 1, status: 'DRAFT' }),
    );
    // Same row as MarketsService.ensureDefaultMarket creates.
    add('market', {
      id: newId(),
      store_id: storeId,
      key: 'default',
      name: s.name,
      countries: [],
      default_locale: s.primary_locale,
      locales: [],
      currency: s.currency,
      is_default: true,
      status: 'LIVE',
      price_rule: { mode: 'convert', source: 'manual', rate: 1 },
    });
    lines.push(`store ${s.slug}: CREATE (INDEPENDENT, DRAFT, ${s.currency}, ${s.primary_locale}, tax ${s.tax_country} inclusive), owner ${owner.email}`);
  } else {
    lines.push(`store ${state.store.id} (${state.store.status}, ${state.store.store_type}, ${state.store.currency || 'platform currency'}): exists, kept as it is`);
  }

  const categoryIds = new Map(state.categories);
  for (const c of catalog.categories) {
    if (categoryIds.has(c.slug)) {
      skipped.categories.push(c.slug);
      lines.push(`collection ${c.slug}: exists, skipped`);
      continue;
    }
    const id = newId();
    categoryIds.set(c.slug, id);
    add('creatorCategory', { id, creator_id: creatorId, slug: c.slug, sort_order: Number.isInteger(c.sort_order) ? c.sort_order : 0, is_active: true });
    add('creatorCategoryTranslation', {
      id: newId(),
      creator_category_id: id,
      locale: LOCALE,
      name: c.name,
      description: c.description || null,
      meta_title: c.meta_title || null,
      meta_desc: c.meta_desc || null,
    });
    lines.push(`collection ${c.slug} "${c.name}": CREATE`);
  }

  // Product id -> participant fields are created for it in this run.
  const fieldTargets = [];
  for (const p of catalog.products) {
    const existing = state.products.get(p.slug);
    const wantsFields = WITH_FIELDS && p.participant_fields === true && catalog.fields.length > 0;
    if (existing) {
      skipped.products.push(p.slug);
      const notes = [`exists (${existing.status})`, 'skipped'];
      if (Number(existing.base_price) !== p.price) {
        skipped.price_differs.push({ slug: p.slug, store: Number(existing.base_price), catalog: p.price });
        notes.push(`price in store ${Number(existing.base_price)} differs from catalog ${p.price} (not changed)`);
      }
      if (wantsFields) {
        if (existing._count.custom_fields === 0) {
          fieldTargets.push(existing.id);
          notes.push(`+${catalog.fields.length} participant fields`);
        } else {
          skipped.fields_kept.push(p.slug);
          notes.push(`has ${existing._count.custom_fields} field(s), fields not touched`);
        }
      }
      lines.push(`product ${p.slug}: ${notes.join(', ')}`);
      continue;
    }
    const id = newId();
    const categoryId = categoryIds.get(p.category);
    add('product', {
      id,
      creator_id: creatorId,
      category_id: platformCategoryId,
      product_type: 'TRADITIONAL',
      base_price: p.price,
      ...(p.compare_at_price ? { compare_at_price: p.compare_at_price } : {}),
      // Services: no stock, no shipping profile.
      track_inventory: false,
      max_per_order: p.max_per_order ?? null,
      status: p.publish === false ? 'DRAFT' : 'PUBLISHED',
      primary_creator_category_id: categoryId,
    });
    add('productTranslation', {
      id: newId(),
      product_id: id,
      locale: LOCALE,
      title: p.title,
      description: p.description || '',
      slug: p.slug,
      meta_title: p.meta_title || null,
      meta_desc: p.meta_desc || null,
      short_description: p.short_description || null,
    });
    add('productCreatorCategory', {
      product_id: id,
      creator_category_id: categoryId,
      sort_order: Number.isInteger(p.sort_order) ? p.sort_order : 0,
    });
    if (wantsFields) fieldTargets.push(id);
    lines.push(
      `product ${p.slug} "${p.title}": CREATE ${p.price} ${catalog.store.currency}, ${p.category}, max ${p.max_per_order ?? 'unlimited'}, ` +
        `${p.publish === false ? 'DRAFT' : 'PUBLISHED'}${wantsFields ? `, +${catalog.fields.length} participant fields` : ''}`,
    );
  }

  if (fieldTargets.length) {
    if (!state.app) {
      add('storeApp', {
        id: newId(),
        store_id: storeId,
        app_key: FIELDS_APP,
        available: true,
        enabled: true,
        settings: {},
        enabled_at: now,
        enabled_by: userId,
      });
      lines.push(`store app ${FIELDS_APP}: CREATE (available + enabled)`);
    }
    for (const productId of fieldTargets) {
      catalog.fields.forEach((f, i) => {
        const fieldId = newId();
        const rules = f.validation_rules && Object.keys(f.validation_rules).length ? f.validation_rules : undefined;
        add('productCustomField', {
          id: fieldId,
          product_id: productId,
          name: f.name,
          type: f.type,
          is_required: f.required !== false,
          placeholder: f.placeholder || null,
          ...(rules ? { validation_rules: rules } : {}),
          sort_order: i,
        });
        add('customFieldTranslation', {
          id: newId(),
          field_id: fieldId,
          locale: LOCALE,
          label: f.label,
          placeholder: f.placeholder || null,
        });
      });
    }
  }

  return { rows, lines, skipped, createStore, storeId, creatorId, userId, fieldTargets };
}

// Insert order: parents before children (foreign keys).
const ORDER = [
  'user',
  'creator',
  'store',
  'storeLanguageConfig',
  'staticPage',
  'market',
  'storeApp',
  'creatorCategory',
  'creatorCategoryTranslation',
  'product',
  'productTranslation',
  'productCreatorCategory',
  'productCustomField',
  'customFieldTranslation',
];
const ONE_BY_ONE = new Set(['user', 'creator', 'store']);

// ── Main ────────────────────────────────────────────────────────

(async () => {
  let prisma = null;
  let accessFd = null;
  let accessFile = null;
  let committed = false;
  try {
    // Everything that needs no database first: a bad argument or catalog
    // stops the run before a connection is opened.
    const catalog = loadCatalog(CATALOG_FILE);
    if (OWNER_EMAIL && !EMAIL_RE.test(OWNER_EMAIL)) throw new Error('--owner-email is not an email address.');
    const envPassword = process.env.MOLLSTRANDS_OWNER_PASSWORD || '';
    if (envPassword && envPassword.length < 12) throw new Error('MOLLSTRANDS_OWNER_PASSWORD must be at least 12 characters.');

    const backupDir = resolveBackupDir({ envVar: 'MOLLSTRANDS_BACKUP_DIR' });
    const dirCheck = checkBackupDir(backupDir);
    if (!dirCheck.ok) throw new Error(dirCheck.error);
    if (dirCheck.warning) console.log(`WARNING: ${dirCheck.warning}`);
    const reportFile = path.join(backupDir, `mollstrands-store-create-${STAMP}.json`);
    accessFile = arg('access-file') || path.join(backupDir, 'mollstrands-access.txt');

    console.log(
      `Catalog ${path.resolve(CATALOG_FILE)} (sha256 ${catalog.sha256.slice(0, 12)}): ` +
        `${catalog.products.length} product(s), ${catalog.categories.length} collection(s), ${catalog.fields.length} participant field(s)`,
    );

    // Minimal error format: a failed create must not pretty-print its data
    // argument (the owner's password hash) into the console.
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient({ errorFormat: 'minimal' });

    const state = await loadState(prisma, catalog);

    // Run guards.
    if (!state.store) {
      if (!OWNER_EMAIL) throw new Error('--owner-email=<address> (or MOLLSTRANDS_OWNER_EMAIL) is required: the store does not exist yet.');
      const taken = await prisma.user.findFirst({
        where: { store_id: null, email: { equals: OWNER_EMAIL, mode: 'insensitive' } },
        select: { id: true },
      });
      if (taken) throw new Error('A staff account with this email already exists; pick another --owner-email.');
      if (!envPassword && fs.existsSync(accessFile)) throw new Error(`Access file ${accessFile} already exists; move it away first.`);
    } else {
      const current = (state.store.creator.user.email || '').toLowerCase();
      if (OWNER_EMAIL && OWNER_EMAIL !== current) {
        throw new Error(`Store ${catalog.store.slug} exists and belongs to another owner than --owner-email; stopping.`);
      }
      if (state.store.store_type !== 'INDEPENDENT') console.log(`WARNING: store type is ${state.store.store_type}, expected INDEPENDENT.`);
    }
    if (WITH_FIELDS && state.app && !state.app.enabled) {
      throw new Error(`Store app ${FIELDS_APP} exists but is switched off: enable it in the dashboard (Manage apps) or run without --with-fields.`);
    }

    const toCreate = catalog.products.filter((p) => !state.products.has(p.slug)).length;
    const platformCategory = toCreate > 0 ? await resolvePlatformCategory(prisma, PLATFORM_CATEGORY) : null;

    let password = null;
    let passwordHash = 'dry-run';
    const creatingOwner = !state.store;
    if (APPLY) {
      if (fs.existsSync(reportFile)) throw new Error(`Report file ${reportFile} already exists.`);
      if (creatingOwner) {
        if (envPassword) {
          password = envPassword;
        } else {
          // The access file is reserved (exclusive create, 0600) before any write.
          fs.mkdirSync(path.dirname(path.resolve(accessFile)), { recursive: true });
          accessFd = fs.openSync(accessFile, 'wx', 0o600);
          password = crypto.randomBytes(24).toString('base64url');
        }
        passwordHash = await require('bcrypt').hash(password, BCRYPT_COST);
      }
    }

    const plan = buildPlan(catalog, state, { email: OWNER_EMAIL, passwordHash }, platformCategory ? platformCategory.id : null);
    const counts = {};
    for (const model of ORDER) counts[model] = (plan.rows[model] || []).length;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);

    console.log('Plan:');
    plan.lines.forEach((l) => console.log(`  ${l}`));
    if (platformCategory) console.log(`Platform category of the new products: ${platformCategory.slug}`);
    console.log('Rows to create:', JSON.stringify(counts));
    console.log(
      `Skipped: ${plan.skipped.products.length} product(s), ${plan.skipped.categories.length} collection(s)` +
        (plan.skipped.price_differs.length ? `; ${plan.skipped.price_differs.length} price difference(s) listed above (not changed)` : ''),
    );
    if (!WITH_FIELDS) console.log('Participant fields: not created (run with --with-fields, or add them in the dashboard).');
    console.log('Not set by this script: custom domain, payments, cache, checkout settings, theme, mail, legal texts, go-live.');

    if (!APPLY) {
      console.log('Dry run. Re-run with --apply to write.');
      return;
    }
    if (total === 0) {
      console.log('Nothing to create; no write, no report.');
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
      },
      { timeout: 120000, maxWait: 10000 },
    );
    committed = true;

    if (accessFd !== null) {
      fs.writeSync(
        accessFd,
        [
          `Mollstrands store (${catalog.store.slug}), created ${new Date().toISOString()}`,
          `Dashboard login email: ${OWNER_EMAIL}`,
          `Password: ${password}`,
          'Store status DRAFT: the storefront shows "coming soon"; preview it as the owner from the dashboard.',
          'Change the password after the first sign-in and turn on 2FA.',
          '',
        ].join('\n'),
      );
      fs.closeSync(accessFd);
      accessFd = null;
      console.log(`Owner access written to ${accessFile} (mode 0600).`);
    } else if (creatingOwner) {
      console.log('Owner password taken from MOLLSTRANDS_OWNER_PASSWORD (not written anywhere).');
    }

    const ids = (model) => (plan.rows[model] || []).map((r) => r.id);
    const report = {
      created_at: new Date().toISOString(),
      catalog: { file: path.resolve(CATALOG_FILE), sha256: catalog.sha256 },
      store: { id: plan.storeId, slug: catalog.store.slug, created: plan.createStore },
      owner: { user_id: plan.userId, creator_id: plan.creatorId, ...(plan.createStore ? { email: OWNER_EMAIL } : {}) },
      platform_category: platformCategory ? { id: platformCategory.id, slug: platformCategory.slug } : null,
      with_fields: WITH_FIELDS,
      counts,
      // State found before the run (nothing of it was changed).
      before: {
        store_existed: !plan.createStore,
        collections: Object.fromEntries(state.categories),
        products: Object.fromEntries(
          [...state.products].map(([slug, row]) => [
            slug,
            { id: row.id, status: row.status, base_price: Number(row.base_price), max_per_order: row.max_per_order, custom_fields: row._count.custom_fields },
          ]),
        ),
      },
      // Every id written by this run, for audits and rollback.
      created: {
        collections: (plan.rows.creatorCategory || []).map((r) => ({ id: r.id, slug: r.slug })),
        products: (plan.rows.productTranslation || []).map((r) => ({ id: r.product_id, slug: r.slug })),
        custom_fields: ids('productCustomField'),
        products_given_fields: plan.fieldTargets,
        store_apps: (plan.rows.storeApp || []).map((r) => ({ id: r.id, app_key: r.app_key })),
        static_pages: ids('staticPage'),
        market: ids('market'),
      },
      skipped: plan.skipped,
    };
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(`Report written: ${reportFile}`);
    console.log(`Store ${plan.storeId}${plan.createStore ? `, owner user ${plan.userId}` : ''}`);

    await revalidate(catalog.store.slug);
    console.log('Done.');
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exitCode = 1;
  } finally {
    if (accessFd !== null) {
      fs.closeSync(accessFd);
      // Nothing was created: drop the empty reserved access file.
      if (!committed) fs.rmSync(accessFile, { force: true });
      else console.error('The store was created but the access file could not be written: reset the owner password.');
    }
    if (prisma) await prisma.$disconnect();
  }
})();

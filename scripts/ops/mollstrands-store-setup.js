/**
 * One-off setup (client Möllstrands Trafikskola AB): finish the LIVE store
 * `mollstrands` through the OWNER API, the same calls the dashboard makes.
 * No database access and no dependency: plain Node 22 (global fetch /
 * FormData / Blob). The file is self-contained so it can be copied to the
 * server on its own.
 *
 * The script signs in as the store owner (POST /auth/login) with the password
 * from the access file written by mollstrands-store-create.js (a line
 * `Password: <value>`; a file holding only the password, `password=<value>`
 * or JSON `{ "password": "..." }` is accepted too). The password, the tokens
 * and the Authorization header are never printed; a failed sign-in prints
 * the status code only.
 *
 * STEPS (each reads first and skips when the store is already as wanted):
 *   theme     PUT /stores/my/theme-selection { theme_customizations }: brand
 *             colours and fonts merged over the stored object (every other
 *             key is kept; theme_key and theme_config are not touched).
 *   logo      POST /uploads?folder=logos|favicons (multipart `file`), then
 *             PUT /stores/my/store { logo_url, favicon_url }. A field that
 *             is already set is kept (--replace-logo uploads again).
 *             Files in --assets: logo.(svg|png|webp|jpg|jpeg),
 *             favicon.(png|svg|webp|jpg|jpeg).
 *   menus     Menus `header` (the four collections) and `footer` (privacy,
 *             terms, link to mollstrands.se): POST /menus + PUT
 *             /menus/:id/items. The storefront renders a menu ONLY where a
 *             published HEADER / FOOTER builder page names it
 *             (header-bar `settings.menu_key`, footer-columns
 *             `content.columns[].menu_key`); without such a page the
 *             built-in header / footer is used and no menu is shown.
 *             --publish-chrome also provisions those two pages, points them
 *             at the menus and publishes them (this switches the store from
 *             the built-in header / footer to the builder ones).
 *   email     PUT /notification-templates/store/order_confirmation: the
 *             current platform default with one Swedish paragraph added.
 *             Skipped when the store already has an override.
 *   settings  PUT /stores/my/store with only the keys that differ:
 *             cache_enabled false, consent_required true,
 *             checkout_settings.after_add_to_cart 'checkout'.
 *   return    (only with --site-url) PUT /stores/my/store
 *             { checkout_settings, current_password }: external website,
 *             return URL `<site>/tack/?order={order_number}`, a "back to the
 *             website" button (not the automatic redirect) and its Swedish
 *             label. A new or changed site URL needs the password again
 *             (and --totp-code when the owner has 2FA); it is sent in this
 *             request only.
 *   images    For every product without an image: POST /uploads?folder=products
 *             then PUT /products/:id { images: [{ url, alt_text, is_featured }] }.
 *             Files: <assets>/products/<slug>.(jpg|jpeg|png|webp) or the
 *             file named in <assets>/products/manifest.json. A missing file
 *             is reported and skipped.
 *
 * NOT TOUCHED: payments, domain, tracking ids, notification email, trader
 * details, theme_key, theme_config, products (other than a first image).
 *
 *   node mollstrands-store-setup.js --assets=<dir>                         (dry run)
 *   node mollstrands-store-setup.js --assets=<dir> --apply                 (write)
 *   node mollstrands-store-setup.js --only=return --site-url=https://example.se --apply
 *
 * Options:
 *   --api=<base>            default https://api.shopsdoor.com/api
 *   --email=<owner email>   default mollstrands@shopsdoor.com
 *   --password-file=<path>  default /var/lib/multistores/backups/mollstrands-access.txt
 *   --assets=<dir>          folder with the logo / favicon / products files
 *   --only=<step,step>      run only these steps (names above)
 *   --site-url=<https origin>  the store's own website (step `return`)
 *   --totp-code=<code>      2FA code for step `return` (owner with 2FA only)
 *   --replace-logo          upload logo / favicon even when one is set
 *   --publish-chrome        see step `menus`
 *   --backup-dir=<dir>      default: the directory of the password file
 *   --apply                 write; without it nothing is changed
 *
 * DRY RUN (default): signs in, reads the current state and prints the plan
 * per step. The only non-GET request is the sign-in.
 *
 * Before the first write the values about to change are saved to
 * <backup dir>/mollstrands-store-setup-before-<UTC>.json (mode 0600) so the
 * change can be undone by hand. A failing step stops the run with exit code
 * 1 and says which steps were already applied; a re-run continues where it
 * stopped.
 */
const fs = require('fs');
const path = require('path');

// ── Wanted state ────────────────────────────────────────────────

const STORE_SLUG = 'mollstrands';
const LOCALE = 'sv';

// Token names: multi-stores-web/src/themes/types.ts (ColorTokens).
const COLORS = {
  primary: '#117a2f',
  secondary: '#e3efe4',
  accent: '#f1c232',
  background: '#ffffff',
  surface: '#f5f3ec',
  text: '#1d2420',
  muted: '#5d655f',
  border: '#d9d6ca',
  link: '#117a2f',
  price: '#117a2f',
  sale: '#f1c232',
  // Deep brand green as the text on the light / yellow fills.
  secondaryContrast: '#0c3a22',
  accentContrast: '#0c3a22',
  saleContrast: '#0c3a22',
};
// Both families are in the storefront / dashboard catalog (lib/google-fonts.ts).
const FONTS = { heading: 'Familjen Grotesk', body: 'Figtree' };
// Legacy theme_config keys that override the tokens on the storefront.
const LEGACY_BRAND_KEYS = ['primaryColor', 'secondaryColor', 'fontFamily', 'typography'];

const HEADER_MENU = { key: 'header', name: 'Huvudmeny' };
const FOOTER_MENU = { key: 'footer', name: 'Sidfot' };
const HEADER_COLLECTIONS = [
  { slug: 'bil-b-korkort', label: 'B-körkort' },
  { slug: 'mc-korkort', label: 'MC-körkort' },
  { slug: 'be-tungtslap', label: 'Släpkörkort' },
  { slug: 'ovrigt', label: 'Övriga utbildningar' },
];
const FOOTER_LEGAL = [
  { kind: 'PRIVACY_POLICY', fallback: 'Integritetspolicy' },
  { kind: 'TERMS', fallback: 'Köpvillkor' },
];
const FOOTER_EXTERNAL = { label: 'Till mollstrands.se', url: 'https://mollstrands.se' };
const FOOTER_COLUMN_HEADING = 'Information';
const CHROME_PUBLISH_LABEL = 'mollstrands-store-setup: menus';

const EMAIL_EVENT = 'order_confirmation';
const EMAIL_PARAGRAPH =
  'Vi kontaktar dig för att boka tid. Har du frågor når du oss på 042-10 61 11 eller kontakt@mollstrands.se.';

const AFTER_ADD_TO_CART = ['stay', 'cart', 'checkout'];
const RETURN_PATH = '/tack/?order={order_number}';
const RETURN_MODE = 'button';
const BACK_LABEL = { sv: 'Tillbaka till Möllstrands Trafikskola' };

// POST /uploads: allowed extensions and size (uploads.service.ts).
const UPLOAD_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.svg'];
const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};
const LOGO_NAMES = ['logo.svg', 'logo.png', 'logo.webp', 'logo.jpg', 'logo.jpeg'];
const FAVICON_NAMES = ['favicon.png', 'favicon.svg', 'favicon.webp', 'favicon.jpg', 'favicon.jpeg'];
const PRODUCT_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

const STEP_NAMES = ['theme', 'logo', 'menus', 'email', 'settings', 'return', 'images'];

// ── Arguments ───────────────────────────────────────────────────

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : undefined;
}
const flag = (name) => process.argv.includes(`--${name}`);

const APPLY = flag('apply');
const REPLACE_LOGO = flag('replace-logo');
const PUBLISH_CHROME = flag('publish-chrome');
const API_BASE = (arg('api') || 'https://api.shopsdoor.com/api').replace(/\/+$/, '');
const PASSWORD_FILE = arg('password-file') || '/var/lib/multistores/backups/mollstrands-access.txt';
const ASSETS_DIR = arg('assets') ? path.resolve(arg('assets')) : null;
const SITE_URL = arg('site-url');
const TOTP_CODE = arg('totp-code');
const BACKUP_DIR = arg('backup-dir') || path.dirname(path.resolve(PASSWORD_FILE));
const STAMP = new Date().toISOString().replace(/[:.]/g, '');

// ── Secrets (never printed) ─────────────────────────────────────

const secrets = new Set();

/** Removes every known secret from a text that is about to be printed. */
function redact(text) {
  let out = String(text);
  for (const s of secrets) if (s) out = out.split(s).join('[redacted]');
  return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]');
}

/**
 * Reads the owner credentials file: the `Password: <value>` line written by
 * mollstrands-store-create.js, `password=<value>`, JSON `{ password, email? }`
 * or a file whose only non-empty line is the password.
 */
function readCredentials(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Password file ${file} cannot be read: ${err.code || 'error'}`);
  }
  raw = raw.replace(/^﻿/, '');
  let password = '';
  let email = '';
  if (raw.trim().startsWith('{')) {
    try {
      const json = JSON.parse(raw);
      password = typeof json.password === 'string' ? json.password : '';
      email = typeof json.email === 'string' ? json.email : '';
    } catch {
      throw new Error(`Password file ${file} looks like JSON but cannot be parsed.`);
    }
  } else {
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const m = /^\s*password\s*[:=]\s*(.*?)\s*$/i.exec(line);
      if (m && m[1]) {
        password = m[1];
        break;
      }
    }
    if (!password) {
      const filled = lines.map((l) => l.trim()).filter(Boolean);
      if (filled.length === 1) password = filled[0];
    }
  }
  if (!password) throw new Error(`No password found in ${file} (expected a "Password: ..." line).`);
  return { password, email };
}

// ── HTTP ────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(method, route, status, body) {
    super(`${method} ${route} -> HTTP ${status}${body ? `: ${body}` : ''}`);
    this.status = status;
  }
}

const http = { token: '', requests: 0, writes: 0 };

/**
 * One API call; returns the `data` of the `{ success, data }` envelope.
 * `opts.silent` (the sign-in): an error carries the status code only.
 */
async function api(method, route, opts = {}) {
  const headers = { Accept: 'application/json' };
  if (http.token && opts.auth !== false) headers.Authorization = `Bearer ${http.token}`;
  let body;
  if (opts.form) {
    body = opts.form;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  http.requests += 1;
  if (method !== 'GET') http.writes += 1;
  let res;
  try {
    res = await fetch(`${API_BASE}${route}`, { method, headers, body });
  } catch (err) {
    const cause = err && err.cause && (err.cause.code || err.cause.message);
    throw new Error(`${method} ${route}: network error (${cause || err.message})`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(method, route, res.status, opts.silent ? '' : redact(text.slice(0, 800)));
  }
  if (!text) return null;
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${route}: the answer is not JSON`);
  }
  return json && typeof json === 'object' && 'success' in json && 'data' in json ? json.data : json;
}

async function login(email, password) {
  let data;
  try {
    data = await api('POST', '/auth/login', { body: { email, password }, auth: false, silent: true });
  } catch (err) {
    if (err instanceof ApiError) throw new Error(`Sign-in failed (HTTP ${err.status}).`);
    throw err;
  }
  const token = data && typeof data.access_token === 'string' ? data.access_token : '';
  if (!token) {
    throw new Error('Sign-in gave no access token (the account may ask for a 2FA code; this script cannot sign in then).');
  }
  secrets.add(token);
  if (data && typeof data.refresh_token === 'string') secrets.add(data.refresh_token);
  http.token = token;
}

// ── Small helpers ───────────────────────────────────────────────

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (v) => (v === undefined || v === null || v === '' ? '(none)' : String(v));

function fileInfo(file) {
  const ext = path.extname(file).toLowerCase();
  const size = fs.statSync(file).size;
  if (!UPLOAD_EXTS.includes(ext)) throw new Error(`${file}: type ${ext} is not accepted by the upload endpoint`);
  if (size > UPLOAD_MAX_BYTES) throw new Error(`${file}: larger than the 50 MB upload limit`);
  if (size === 0) throw new Error(`${file}: empty file`);
  return { ext, size };
}

function firstExisting(dir, names) {
  if (!dir) return null;
  for (const name of names) {
    const file = path.join(dir, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return null;
}

/** POST /uploads?folder=<folder> (multipart field `file`); returns the stored URL. */
async function upload(file, folder) {
  const { ext } = fileInfo(file);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: MIME[ext] }), path.basename(file));
  const data = await api('POST', `/uploads?folder=${encodeURIComponent(folder)}`, { form });
  const url = data && typeof data.url === 'string' ? data.url : '';
  if (!url) throw new Error(`Upload of ${path.basename(file)} returned no url`);
  return url;
}

const kb = (bytes) => `${Math.max(1, Math.round(bytes / 1024))} kB`;

// ── Context (shared reads) ──────────────────────────────────────

const ctx = {
  password: '',
  _store: null,
  /** GET /stores/my/store; `fresh` re-reads (always done right before a write). */
  async store(fresh = false) {
    if (!this._store || fresh) this._store = await api('GET', '/stores/my/store');
    return this._store;
  },
};

// ── Step: theme ─────────────────────────────────────────────────

function themeNext(current) {
  const cur = isObj(current) ? current : {};
  const next = clone(cur);
  next.colors = { ...(isObj(cur.colors) ? cur.colors : {}), ...COLORS };
  const typo = isObj(cur.typography) ? cur.typography : {};
  next.typography = {
    ...typo,
    fontFamily: { ...(isObj(typo.fontFamily) ? typo.fontFamily : {}), ...FONTS },
  };
  const diffs = [];
  for (const [k, v] of Object.entries(COLORS)) {
    const old = isObj(cur.colors) ? cur.colors[k] : undefined;
    if (old !== v) diffs.push(`colors.${k}: ${show(old)} -> ${v}`);
  }
  for (const [k, v] of Object.entries(FONTS)) {
    const old = isObj(typo.fontFamily) ? typo.fontFamily[k] : undefined;
    if (old !== v) diffs.push(`typography.fontFamily.${k}: ${show(old)} -> ${v}`);
  }
  return { next, diffs };
}

async function planTheme() {
  const store = await ctx.store();
  const { diffs } = themeNext(store.theme_customizations);
  const notes = [];
  const legacy = isObj(store.theme_config) ? LEGACY_BRAND_KEYS.filter((k) => store.theme_config[k]) : [];
  if (legacy.length) {
    notes.push(
      `NOTE: theme_config carries legacy brand keys (${legacy.join(', ')}); on the storefront they win over the tokens. ` +
        'Not changed by this script: clear them in the dashboard (Design) if the colours do not show.',
    );
  }
  if (!diffs.length) return { change: false, summary: `already as wanted (theme ${show(store.theme_key)})`, lines: notes };
  return {
    change: true,
    summary: `${diffs.length} token(s) to set on theme ${show(store.theme_key)}`,
    lines: [...diffs, ...notes],
    before: { theme_key: store.theme_key ?? null, theme_customizations: store.theme_customizations ?? null },
    async apply() {
      const fresh = await ctx.store(true);
      const { next } = themeNext(fresh.theme_customizations);
      const saved = await api('PUT', '/stores/my/theme-selection', { body: { theme_customizations: next } });
      const got = saved && isObj(saved.theme_customizations) ? saved.theme_customizations : {};
      if (!isObj(got.colors) || got.colors.primary !== COLORS.primary) {
        throw new Error('the answer does not carry the new colours');
      }
      ctx._store = null;
      return `${diffs.length} token(s) saved`;
    },
  };
}

// ── Step: logo ──────────────────────────────────────────────────

async function planLogo() {
  const store = await ctx.store();
  const targets = [
    { field: 'logo_url', folder: 'logos', names: LOGO_NAMES },
    { field: 'favicon_url', folder: 'favicons', names: FAVICON_NAMES },
  ];
  const lines = [];
  const todo = [];
  for (const t of targets) {
    const current = store[t.field];
    if (current && !REPLACE_LOGO) {
      lines.push(`${t.field}: already set (${current}), kept (--replace-logo uploads again)`);
      continue;
    }
    const file = firstExisting(ASSETS_DIR, t.names);
    if (!file) {
      lines.push(
        `${t.field}: ASSET MISSING, not set (${ASSETS_DIR ? `none of ${t.names.join(', ')} in ${ASSETS_DIR}` : 'no --assets=<dir> given'})`,
      );
      continue;
    }
    const info = fileInfo(file);
    lines.push(`${t.field}: ${show(current)} -> upload ${path.basename(file)} (${kb(info.size)}) to folder ${t.folder}`);
    todo.push({ ...t, file });
  }
  if (!todo.length) return { change: false, summary: 'nothing to upload', lines };
  return {
    change: true,
    summary: `${todo.length} file(s) to upload`,
    lines,
    before: { logo_url: store.logo_url ?? null, favicon_url: store.favicon_url ?? null },
    async apply() {
      const body = {};
      for (const t of todo) body[t.field] = await upload(t.file, t.folder);
      const saved = await api('PUT', '/stores/my/store', { body });
      for (const t of todo) if (!saved || !saved[t.field]) throw new Error(`${t.field} is empty in the answer`);
      ctx._store = null;
      return todo.map((t) => `${t.field} = ${saved[t.field]}`).join(', ');
    },
  };
}

// ── Step: menus ─────────────────────────────────────────────────

/** `/collections/<path>` of a collection in the owner tree, by slug. */
function findCollection(tree, slug, trail = []) {
  for (const node of Array.isArray(tree) ? tree : []) {
    const here = [...trail, node.slug];
    if (node.slug === slug) return { node, url: `/collections/${here.join('/')}` };
    const below = findCollection(node.children, slug, here);
    if (below) return below;
  }
  return null;
}

const itemShape = (it) => ({
  kind: it.kind || 'CUSTOM',
  resource_id: (it.kind || 'CUSTOM') === 'CUSTOM' ? null : (it.resource_id ?? null),
  label: it.label,
  url: it.url,
  open_in_new_tab: Boolean(it.open_in_new_tab),
});

/** True when the stored menu is exactly the wanted flat list, in order. */
function menuMatches(menu, wanted) {
  const stored = [...(menu.items || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  if (stored.some((it) => it.parent_id)) return false;
  return same(stored.map(itemShape), wanted.map(itemShape));
}

/** The PUT /menus/:id/items body; a kept item re-sends its id (keeps label_i18n). */
function menuPayload(menu, wanted) {
  const used = new Set();
  return {
    items: wanted.map((w) => {
      const shape = itemShape(w);
      const prev = ((menu && menu.items) || []).find(
        (it) => !used.has(it.id) && !it.parent_id && same({ ...itemShape(it), label: '' }, { ...shape, label: '' }),
      );
      if (prev) used.add(prev.id);
      return { ...(prev ? { id: prev.id } : {}), ...shape };
    }),
  };
}

/** Reads one chrome page (HEADER / FOOTER) and its section of `sectionKey`. */
async function readChrome(pages, type, sectionKey) {
  const page = (Array.isArray(pages) ? pages : []).find((p) => p.type === type) || null;
  if (!page) return { page: null, section: null };
  const sections = await api('GET', `/v2/pages/${page.id}/sections`);
  const section = (Array.isArray(sections) ? sections : []).find((s) => s.section_key === sectionKey && !s.is_hidden) || null;
  return { page, section };
}

function footerContent(section, locale) {
  const tr = section && Array.isArray(section.translations) ? section.translations.find((t) => t.locale === locale) : null;
  const content = tr && isObj(tr.content) ? tr.content : {};
  const columns = Array.isArray(content.columns) ? content.columns : [];
  return { content, columns };
}

async function planMenus() {
  const store = await ctx.store();
  const locale = (store.language_config && store.language_config.primary_locale) || LOCALE;
  const [menus, tree, legal, pages] = await Promise.all([
    api('GET', '/menus/mine'),
    api('GET', '/creator-categories'),
    api('GET', '/stores/my/legal-pages'),
    api('GET', '/v2/pages/mine'),
  ]);
  const list = Array.isArray(menus) ? menus : [];

  const headerItems = HEADER_COLLECTIONS.map((c) => {
    const hit = findCollection(tree, c.slug);
    if (!hit) throw new Error(`collection "${c.slug}" not found in the store`);
    if (hit.node.visibility === 'INTERNAL') throw new Error(`collection "${c.slug}" is a tag (no storefront page)`);
    return { kind: 'COLLECTION', resource_id: hit.node.id, label: c.label, url: hit.url, open_in_new_tab: false };
  });
  const legalPages = legal && Array.isArray(legal.pages) ? legal.pages : [];
  const footerItems = FOOTER_LEGAL.map((l) => {
    const page = legalPages.find((p) => p.kind === l.kind);
    if (!page) throw new Error(`legal page ${l.kind} is not offered by GET /stores/my/legal-pages`);
    return {
      kind: 'CUSTOM',
      resource_id: null,
      label: (page.title || '').trim() || l.fallback,
      url: page.storefront_path || `/legal/${page.slug}`,
      open_in_new_tab: false,
      state: page.state,
    };
  });
  footerItems.push({ kind: 'CUSTOM', resource_id: null, label: FOOTER_EXTERNAL.label, url: FOOTER_EXTERNAL.url, open_in_new_tab: true });

  const header = await readChrome(pages, 'HEADER', 'header-bar');
  const footer = await readChrome(pages, 'FOOTER', 'footer-columns');
  const named = header.section && isObj(header.section.settings) ? header.section.settings.menu_key : '';
  // The menu the header already shows wins over a new one with our key.
  const headerMenu = (named && list.find((m) => m.key === named)) || list.find((m) => m.key === HEADER_MENU.key) || null;
  const footerMenu = list.find((m) => m.key === FOOTER_MENU.key) || null;
  const headerKey = headerMenu ? headerMenu.key : HEADER_MENU.key;
  const footerKey = FOOTER_MENU.key;

  const lines = [];
  const menuJobs = [
    { def: HEADER_MENU, menu: headerMenu, items: headerItems },
    { def: FOOTER_MENU, menu: footerMenu, items: footerItems },
  ].map((job) => {
    const ok = job.menu && menuMatches(job.menu, job.items);
    const what = job.items.map((i) => `${i.label} -> ${i.url}`).join(' | ');
    if (ok) lines.push(`menu ${job.menu.key}: already as wanted`);
    else if (job.menu) lines.push(`menu ${job.menu.key}: ${(job.menu.items || []).length} item(s) -> ${job.items.length}: ${what}`);
    else lines.push(`menu ${job.def.key}: CREATE "${job.def.name}" with ${job.items.length} item(s): ${what}`);
    return { ...job, ok };
  });
  for (const it of footerItems) {
    if (it.state && it.state !== 'published') lines.push(`NOTE: ${it.url} shows the default template (own page state: ${it.state})`);
  }

  // Chrome: where the storefront would render the menus.
  const headerWired = Boolean(header.page && header.page.published_version_id && header.section && named === headerKey);
  const { columns } = footerContent(footer.section, locale);
  const footerWired = Boolean(
    footer.page && footer.page.published_version_id && footer.section && columns.some((c) => isObj(c) && c.menu_key === footerKey),
  );
  const describe = (name, c, wired, key) => {
    if (wired) return `${name}: published builder ${name} shows menu "${key}"`;
    if (!c.page) return `${name}: no builder ${name} page; the built-in ${name} is used and shows NO menu`;
    if (!c.page.published_version_id) return `${name}: builder ${name} page exists but is not published; the built-in ${name} is used and shows NO menu`;
    if (!c.section) return `${name}: published builder ${name} has no ${name === 'header' ? 'header-bar' : 'footer-columns'} section`;
    return `${name}: published builder ${name} does not name menu "${key}"`;
  };
  lines.push(describe('header', header, headerWired, headerKey));
  lines.push(describe('footer', footer, footerWired, footerKey));
  const chromeTodo = PUBLISH_CHROME && (!headerWired || !footerWired);
  if (!headerWired || !footerWired) {
    lines.push(
      PUBLISH_CHROME
        ? '--publish-chrome: the HEADER / FOOTER builder pages are provisioned if missing, pointed at the menus and PUBLISHED ' +
            '(the store then uses the builder header / footer instead of the built-in ones; any unpublished draft edits of those pages go live too)'
        : 'NOTE: the menus are saved but not rendered until the header / footer name them: pick them in the builder ' +
            '(Header / Footer -> Menu) and publish, or re-run with --publish-chrome',
    );
  }

  const menuTodo = menuJobs.some((j) => !j.ok);
  if (!menuTodo && !chromeTodo) return { change: false, summary: 'menus already as wanted', lines };

  return {
    change: true,
    summary: [menuTodo ? 'menus to save' : '', chromeTodo ? 'header / footer to publish' : ''].filter(Boolean).join(' + '),
    lines,
    before: {
      menus: clone([headerMenu, footerMenu].filter(Boolean)),
      chrome: {
        header: { page: clone(header.page), section: clone(header.section) },
        footer: { page: clone(footer.page), section: clone(footer.section) },
      },
    },
    async apply() {
      const done = [];
      for (const job of menuJobs) {
        if (job.ok) continue;
        let menu = job.menu;
        if (!menu) {
          menu = await api('POST', '/menus', { body: { key: job.def.key, name: job.def.name } });
          if (!menu || !menu.id) throw new Error(`menu ${job.def.key} was not created`);
        }
        const saved = await api('PUT', `/menus/${menu.id}/items`, { body: menuPayload(menu, job.items) });
        if (!saved || !menuMatches(saved, job.items)) throw new Error(`menu ${menu.key} does not hold the wanted items after the save`);
        done.push(`menu ${menu.key} saved (${job.items.length} items)`);
      }
      if (chromeTodo) {
        if (!headerWired) done.push(await wireHeader(headerKey));
        if (!footerWired) done.push(await wireFooter(footerKey, locale));
      }
      return done.join('; ');
    },
  };
}

async function publishPage(pageId) {
  await api('POST', `/v2/pages/${pageId}/publish`, { body: { label: CHROME_PUBLISH_LABEL } });
}

async function wireHeader(menuKey) {
  let { page, section } = await readChrome(await api('GET', '/v2/pages/mine'), 'HEADER', 'header-bar');
  if (!page) {
    page = await api('POST', '/v2/pages/mine/header/ensure', { body: {} });
    ({ section } = await readChrome([page], 'HEADER', 'header-bar'));
  }
  if (!section) throw new Error('the HEADER page has no visible header-bar section; add one in the builder');
  const settings = isObj(section.settings) ? section.settings : {};
  if (settings.menu_key !== menuKey) {
    await api('PUT', `/v2/pages/sections/${section.id}`, { body: { settings: { ...settings, menu_key: menuKey } } });
  }
  await publishPage(page.id);
  return `header published with menu "${menuKey}"`;
}

async function wireFooter(menuKey, locale) {
  let { page, section } = await readChrome(await api('GET', '/v2/pages/mine'), 'FOOTER', 'footer-columns');
  if (!page) {
    page = await api('POST', '/v2/pages/mine/footer/ensure', { body: {} });
    ({ section } = await readChrome([page], 'FOOTER', 'footer-columns'));
  }
  if (!section) throw new Error('the FOOTER page has no visible footer-columns section; add one in the builder');
  const { content, columns } = footerContent(section, locale);
  if (!columns.some((c) => isObj(c) && c.menu_key === menuKey)) {
    const next = { ...content, columns: [...columns, { heading: FOOTER_COLUMN_HEADING, menu_key: menuKey, links: [] }] };
    await api('PUT', `/v2/pages/sections/${section.id}`, { body: { translations: [{ locale, content: next }] } });
  }
  await publishPage(page.id);
  return `footer published with menu "${menuKey}"`;
}

// ── Step: email ─────────────────────────────────────────────────

const placeholders = (text) => new Set(String(text).match(/\{\{\s*[a-z0-9_]+\s*\}\}/gi) || []);

/** Adds the paragraph after the opening paragraph of the HTML body. */
function emailHtml(html) {
  const anchor = html.indexOf('{{items_html}}');
  if (anchor < 0) throw new Error('the sv HTML body has no {{items_html}} block (template changed); edit it in the dashboard');
  const pEnd = html.lastIndexOf('</p>', anchor);
  const pStart = pEnd < 0 ? -1 : html.lastIndexOf('<p', pEnd);
  if (pStart < 0) throw new Error('the sv HTML body has no opening paragraph before {{items_html}}; edit it in the dashboard');
  const openTag = html.slice(pStart, html.indexOf('>', pStart) + 1);
  const cut = pEnd + '</p>'.length;
  const gap = /^\s*/.exec(html.slice(cut))[0] || '\n';
  return `${html.slice(0, cut)}${gap}${openTag}${EMAIL_PARAGRAPH}</p>${html.slice(cut)}`;
}

/** Adds the paragraph before the item list of the plain-text body. */
function emailText(text) {
  const anchor = text.indexOf('{{items_text}}');
  if (anchor < 0) throw new Error('the sv text body has no {{items_text}} block (template changed); edit it in the dashboard');
  return `${text.slice(0, anchor).replace(/\s+$/, '')}\n\n${EMAIL_PARAGRAPH}\n${text.slice(anchor)}`;
}

async function planEmail() {
  const route = `/notification-templates/store/${EMAIL_EVENT}`;
  const tpl = await api('GET', route);
  if (tpl && tpl.overridden) {
    return {
      change: false,
      summary: 'the store already has its own order_confirmation template; not touched',
      lines: [`(to start over: DELETE ${route}, then run again)`],
    };
  }
  const maps = {};
  for (const key of ['subject', 'body_html', 'body_text']) {
    const map = tpl && isObj(tpl[key]) ? tpl[key] : {};
    if (typeof map[LOCALE] !== 'string' || !map[LOCALE].trim()) {
      throw new Error(`the platform default has no "${LOCALE}" ${key}; nothing to start from`);
    }
    maps[key] = map;
  }
  const html = maps.body_html[LOCALE];
  const text = maps.body_text[LOCALE];
  if (html.includes(EMAIL_PARAGRAPH) && text.includes(EMAIL_PARAGRAPH)) {
    return { change: false, summary: 'the platform default already carries the paragraph', lines: [] };
  }
  const nextHtml = emailHtml(html);
  const nextText = emailText(text);
  for (const [before, after, name] of [
    [html, nextHtml, 'body_html'],
    [text, nextText, 'body_text'],
  ]) {
    for (const p of placeholders(before)) {
      if (!after.includes(p)) throw new Error(`placeholder ${p} would be lost in ${name}`);
    }
  }
  const body = {
    subject: maps.subject,
    body_html: { ...maps.body_html, [LOCALE]: nextHtml },
    body_text: { ...maps.body_text, [LOCALE]: nextText },
    enabled: true,
  };
  const locales = Object.keys(maps.body_html);
  return {
    change: true,
    summary: `store override of ${EMAIL_EVENT} from the platform default (${locales.join(', ')}); only "${LOCALE}" gets the new paragraph`,
    lines: [
      `subject.${LOCALE} (unchanged): ${maps.subject[LOCALE]}`,
      `placeholders kept: ${[...new Set([...placeholders(html), ...placeholders(text)])].join(' ')}`,
      `body_html.${LOCALE}: ${html.length} -> ${nextHtml.length} characters; body_text.${LOCALE} becomes:`,
      ...nextText.split('\n').map((l) => `    | ${l}`),
    ],
    before: { overridden: false, undo: `DELETE ${route}`, platform_default: clone(tpl) },
    async apply() {
      const saved = await api('PUT', route, { body });
      const got = saved && isObj(saved.body_html) ? saved.body_html[LOCALE] : '';
      if (typeof got !== 'string' || !got.includes(EMAIL_PARAGRAPH)) throw new Error('the saved template does not carry the paragraph');
      return `override saved (${locales.length} locale(s))`;
    },
  };
}

// ── Checkout settings (steps settings + return) ─────────────────

function labels(raw) {
  const out = {};
  if (isObj(raw)) {
    for (const [locale, label] of Object.entries(raw)) {
      if (typeof label === 'string' && label.trim()) out[locale] = label.trim();
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The `checkout_settings` body the dashboard card sends (toCheckoutBody in
 * multi-stores-dashboard/src/lib/checkoutSettings.ts): every known key from
 * the stored value, so no key is lost, plus `patch`.
 */
function checkoutBody(stored, patch) {
  const s = isObj(stored) ? stored : {};
  const params = Array.isArray(s.coupon_param) ? s.coupon_param.filter((k) => typeof k === 'string' && k.trim()) : [];
  const body = {
    after_add_to_cart: AFTER_ADD_TO_CART.includes(s.after_add_to_cart) ? s.after_add_to_cart : 'stay',
    phone_required: typeof s.phone_required === 'boolean' ? s.phone_required : false,
    pay_button_label: labels(s.pay_button_label),
    coupon_param: params.length ? params : ['coupon'],
    coupon_autoapply: typeof s.coupon_autoapply === 'boolean' ? s.coupon_autoapply : false,
  };
  const site = typeof s.external_site_url === 'string' ? s.external_site_url.trim() : '';
  if (site) {
    body.external_site_url = site;
    body.return_url = typeof s.return_url === 'string' && s.return_url.trim() ? s.return_url.trim() : null;
    body.return_mode = s.return_mode === 'auto' ? 'auto' : 'button';
    body.back_label = labels(s.back_label);
  }
  return { ...body, ...patch };
}

// ── Step: settings ──────────────────────────────────────────────

function settingsDiff(store) {
  const body = {};
  const lines = [];
  if (store.cache_enabled !== false) {
    body.cache_enabled = false;
    lines.push(`cache_enabled: ${show(store.cache_enabled)} -> false`);
  }
  if (store.consent_required !== true) {
    body.consent_required = true;
    lines.push(`consent_required: ${show(store.consent_required)} -> true`);
  }
  const current = checkoutBody(store.checkout_settings, {}).after_add_to_cart;
  if (current !== 'checkout') {
    body.checkout_settings = checkoutBody(store.checkout_settings, { after_add_to_cart: 'checkout' });
    lines.push(`checkout_settings.after_add_to_cart: ${current} -> checkout (other checkout keys re-sent unchanged)`);
  }
  return { body, lines };
}

async function planSettings() {
  const store = await ctx.store();
  const { body, lines } = settingsDiff(store);
  if (!lines.length) return { change: false, summary: 'already as wanted', lines: [] };
  return {
    change: true,
    summary: `${lines.length} setting(s) to change`,
    lines,
    before: {
      cache_enabled: store.cache_enabled ?? null,
      consent_required: store.consent_required ?? null,
      checkout_settings: store.checkout_settings ?? null,
    },
    async apply() {
      const fresh = settingsDiff(await ctx.store(true));
      if (!Object.keys(fresh.body).length) return 'already as wanted';
      const saved = await api('PUT', '/stores/my/store', { body: fresh.body });
      ctx._store = null;
      const left = settingsDiff(saved || {});
      if (left.lines.length) throw new Error(`not saved: ${left.lines.join('; ')}`);
      return `saved: ${Object.keys(fresh.body).join(', ')}`;
    },
  };
}

// ── Step: return (external website) ─────────────────────────────

function parseSiteUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('--site-url is not a URL');
  }
  if (url.protocol !== 'https:') throw new Error('--site-url must be https');
  if (url.username || url.password || url.port) throw new Error('--site-url must not carry a user, password or port');
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('--site-url must be an origin only (https://host), no path');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(url.hostname)) throw new Error('--site-url needs a DNS host name');
  // The API stores the WHATWG form of the URL (trailing slash on an origin).
  return { site: url.href, returnUrl: `${url.origin}${RETURN_PATH}` };
}

function normalizedSite(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    return new URL(raw.trim()).href;
  } catch {
    return raw.trim();
  }
}

function returnDiff(store, want) {
  const s = isObj(store.checkout_settings) ? store.checkout_settings : {};
  const lines = [];
  const siteChanged = normalizedSite(s.external_site_url) !== want.site;
  if (siteChanged) lines.push(`external_site_url: ${show(s.external_site_url)} -> ${want.site}`);
  if ((s.return_url || '') !== want.returnUrl) lines.push(`return_url: ${show(s.return_url)} -> ${want.returnUrl}`);
  const mode = s.external_site_url ? (s.return_mode === 'auto' ? 'auto' : 'button') : '';
  if (mode !== RETURN_MODE) lines.push(`return_mode: ${show(mode)} -> ${RETURN_MODE}`);
  if (!same(labels(s.back_label), BACK_LABEL)) lines.push(`back_label: ${JSON.stringify(labels(s.back_label))} -> ${JSON.stringify(BACK_LABEL)}`);
  return { lines, siteChanged };
}

async function planReturn() {
  if (!SITE_URL) {
    return { change: false, summary: 'skipped: no --site-url=<https origin> given', lines: [] };
  }
  const want = parseSiteUrl(SITE_URL);
  const store = await ctx.store();
  const { lines, siteChanged } = returnDiff(store, want);
  if (!lines.length) return { change: false, summary: 'already as wanted', lines: [] };
  if (siteChanged) {
    lines.push(
      `re-authentication: the owner password from the password file is sent in this request only (never printed)${TOTP_CODE ? ', with the 2FA code' : ''}`,
    );
  }
  return {
    change: true,
    summary: `${lines.length - (siteChanged ? 1 : 0)} checkout key(s) to change`,
    lines,
    before: { checkout_settings: store.checkout_settings ?? null },
    async apply() {
      const fresh = await ctx.store(true);
      const now = returnDiff(fresh, want);
      if (!now.lines.length) return 'already as wanted';
      const body = {
        checkout_settings: checkoutBody(fresh.checkout_settings, {
          external_site_url: want.site,
          return_url: want.returnUrl,
          return_mode: RETURN_MODE,
          back_label: BACK_LABEL,
        }),
      };
      if (now.siteChanged) {
        body.current_password = ctx.password;
        if (TOTP_CODE) body.totp_code = TOTP_CODE;
      }
      const saved = await api('PUT', '/stores/my/store', { body });
      ctx._store = null;
      const left = returnDiff(saved || {}, want);
      if (left.lines.length) throw new Error(`not saved: ${left.lines.join('; ')}`);
      return `external website saved${now.siteChanged ? ' (re-authenticated)' : ''}`;
    },
  };
}

// ── Step: images ────────────────────────────────────────────────

async function ownProducts() {
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const res = await api('GET', `/products/mine?limit=100&page=${page}`);
    const rows = Array.isArray(res) ? res : res && Array.isArray(res.data) ? res.data : [];
    all.push(...rows);
    const totalPages = res && res.meta && Number(res.meta.totalPages);
    if (!rows.length || !totalPages || page >= totalPages) break;
  }
  return all;
}

function productFile(dir, manifest, slug) {
  if (!dir) return null;
  const entry = manifest && isObj(manifest.products) ? manifest.products[slug] : null;
  const named = isObj(entry) ? entry.file : typeof entry === 'string' ? entry : '';
  // A manifest name stays inside the folder.
  if (named && path.basename(named) === named) {
    const file = path.join(dir, named);
    if (fs.existsSync(file)) return file;
  }
  return firstExisting(dir, PRODUCT_EXTS.map((ext) => `${slug}${ext}`));
}

async function planImages() {
  const products = await ownProducts();
  const dir = ASSETS_DIR ? path.join(ASSETS_DIR, 'products') : null;
  let manifest = null;
  if (dir && fs.existsSync(path.join(dir, 'manifest.json'))) {
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    } catch {
      throw new Error(`${path.join(dir, 'manifest.json')} is not valid JSON`);
    }
  }
  const lines = [];
  const todo = [];
  let have = 0;
  let missing = 0;
  for (const p of products) {
    const trs = Array.isArray(p.translations) ? p.translations : [];
    const tr = trs.find((t) => t.locale === LOCALE) || trs.find((t) => t.slug) || {};
    const slug = tr.slug || p.slug || p.id;
    if (Array.isArray(p.images) && p.images.length > 0) {
      have += 1;
      continue;
    }
    const file = productFile(dir, manifest, slug);
    if (!file) {
      missing += 1;
      lines.push(`${slug} (${p.status}): NO FILE, left without an image`);
      continue;
    }
    const info = fileInfo(file);
    lines.push(`${APPLY ? 'upload' : 'would upload'} ${path.basename(file)} (${kb(info.size)}) -> ${slug} (${p.status})`);
    todo.push({ id: p.id, slug, title: (tr.title || '').trim() || slug, file });
  }
  const counts = `${products.length} product(s): ${have} with an image, ${todo.length} to upload, ${missing} without a file`;
  if (!dir) lines.unshift('no --assets=<dir> given: no product file can be found');
  if (!todo.length) return { change: false, summary: counts, lines };
  return {
    change: true,
    summary: counts,
    lines,
    before: { products_without_image: todo.map((t) => ({ id: t.id, slug: t.slug, images: [] })) },
    async apply() {
      let done = 0;
      try {
        for (const t of todo) {
          // Re-checked right before the write: a product that got an image meanwhile is left alone.
          const current = await api('GET', `/products/${t.id}/images`);
          if (Array.isArray(current) && current.length > 0) continue;
          const url = await upload(t.file, 'products');
          await api('PUT', `/products/${t.id}`, { body: { images: [{ url, alt_text: t.title, is_featured: true }] } });
          done += 1;
        }
      } catch (err) {
        throw new Error(`${done} of ${todo.length} image(s) attached before the failure; ${err.message}`);
      }
      return `${done} image(s) attached${missing ? `, ${missing} product(s) still without an image (no file)` : ''}`;
    },
  };
}

// ── Main ────────────────────────────────────────────────────────

const STEPS = {
  theme: planTheme,
  logo: planLogo,
  menus: planMenus,
  email: planEmail,
  settings: planSettings,
  return: planReturn,
  images: planImages,
};

function selectedSteps() {
  const only = arg('only');
  if (only === undefined) return STEP_NAMES;
  const names = only.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !STEP_NAMES.includes(n));
  if (unknown.length || !names.length) {
    throw new Error(`--only: unknown step(s) ${unknown.join(', ') || '(empty)'}; known: ${STEP_NAMES.join(', ')}`);
  }
  return STEP_NAMES.filter((n) => names.includes(n));
}

(async () => {
  const applied = [];
  let pending = [];
  try {
    const steps = selectedSteps();
    if (SITE_URL) parseSiteUrl(SITE_URL);
    if (ASSETS_DIR && !fs.existsSync(ASSETS_DIR)) throw new Error(`--assets: ${ASSETS_DIR} does not exist`);
    const creds = readCredentials(PASSWORD_FILE);
    secrets.add(creds.password);
    if (TOTP_CODE) secrets.add(TOTP_CODE);
    ctx.password = creds.password;
    const email = (arg('email') || creds.email || 'mollstrands@shopsdoor.com').trim().toLowerCase();

    console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: ${API_BASE} as ${email}; steps: ${steps.join(', ')}`);
    await login(email, creds.password);
    const store = await ctx.store();
    console.log(`Store ${show(store.slug)} "${show(store.name)}" (${show(store.status)}, ${show(store.store_type)})`);
    if (store.slug !== STORE_SLUG) {
      const msg = `this account owns store "${store.slug}", not "${STORE_SLUG}"`;
      if (APPLY) throw new Error(`${msg}; nothing written.`);
      console.log(`WARNING: ${msg}; --apply would refuse.`);
    }

    // Plan every step first (reads only): a problem found here stops the run
    // before anything is written.
    const plans = [];
    for (const name of steps) {
      let plan;
      try {
        plan = await STEPS[name]();
      } catch (err) {
        throw new Error(`step ${name} cannot be planned: ${err.message}`);
      }
      plans.push({ name, ...plan });
      console.log(`[${name}] ${plan.change ? 'CHANGE' : 'skip'}: ${plan.summary}`);
      for (const line of plan.lines || []) console.log(`    ${line}`);
    }

    const todo = plans.filter((p) => p.change);
    if (!APPLY) {
      console.log(`Dry run: nothing written (${http.requests} request(s), ${http.writes} non-GET = the sign-in). Re-run with --apply to write.`);
      return;
    }
    if (!todo.length) {
      console.log('Nothing to change; no write, no backup file.');
      return;
    }

    const backupFile = path.join(BACKUP_DIR, `mollstrands-store-setup-before-${STAMP}.json`);
    const backup = {
      created_at: new Date().toISOString(),
      api: API_BASE,
      store: { id: store.id ?? null, slug: store.slug ?? null },
      note: 'Values before the run, per step that was about to change. No secret is stored here.',
      before: Object.fromEntries(todo.map((p) => [p.name, p.before ?? null])),
    };
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.writeFileSync(backupFile, redact(JSON.stringify(backup, null, 2)), { mode: 0o600, flag: 'wx' });
    console.log(`Before-values written: ${backupFile} (mode 0600)`);

    pending = todo.map((p) => p.name);
    for (const plan of todo) {
      let result;
      try {
        result = await plan.apply();
      } catch (err) {
        throw new Error(`step ${plan.name} failed: ${err.message}`);
      }
      applied.push(plan.name);
      pending = pending.filter((n) => n !== plan.name);
      console.log(`[${plan.name}] OK: ${result}`);
    }
    console.log(`Done: ${applied.join(', ')}.`);
  } catch (err) {
    console.error(`ERROR: ${redact(err && err.message ? err.message : err)}`);
    if (APPLY) {
      console.error(`Steps already applied: ${applied.join(', ') || 'none'}. Not completed: ${pending.join(', ') || 'none'}.`);
    }
    process.exitCode = 1;
  }
})();

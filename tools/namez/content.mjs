#!/usr/bin/env node
/**
 * Namez go-live Phase 2 — content parity with the WordPress site, through the
 * normal creator API (no SQL). Run on the server as the store owner:
 *
 *   TOKEN=<creator jwt> node tools/namez/content.mjs <command> [--apply]
 *
 * Commands (each idempotent; without --apply nothing is written):
 *   pages              the 6 WP static pages (om-namez, kontakta-oss, nojd-kundgaranti,
 *                      om-cookies, material-pla-…; frakt-och-returvillkor is a redirect)
 *   redirects          /about → /om-namez, /contact → /kontakta-oss,
 *                      /frakt-och-returvillkor → /shipping-policy, 2 old product slugs
 *   menus              Swedish header menu (WP structure, mega groups) + footer menu
 *   footer-fix         footer column 1 → footer menu, tel: typo
 *   languages          Swedish only (no secondary locales, no auto-translate)
 *   empty-collections  the 24 empty WP-noindex collections → INTERNAL
 *   header-mega        header-bar submenu_style = mega (after the web deploy)
 *   all                everything above, in this order
 *
 * Env: API_BASE (default https://ms-api.iwings-digital.com/api), TOKEN (required),
 *      WP_BASE (default https://namez.se).
 */

import { pathToFileURL } from 'node:url';

const API_BASE = process.env.API_BASE ?? 'https://ms-api.iwings-digital.com/api';
const WP_BASE = process.env.WP_BASE ?? 'https://namez.se';
const TOKEN = process.env.TOKEN;
const APPLY = process.argv.includes('--apply');
const LOCALE = 'sv';
const UA = 'Mozilla/5.0 (namez-content-migration)';


// ── API helpers ────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json).slice(0, 400)}`);
  }
  return json && typeof json === 'object' && 'data' in json ? json.data : json;
}

/** Writes are skipped without --apply; the call is logged instead. */
async function write(method, path, body, label) {
  console.log(`  ${APPLY ? 'WRITE' : 'would'} ${method} ${path}${label ? `  — ${label}` : ''}`);
  if (!APPLY) return null;
  return api(method, path, body);
}

async function upload(buffer, filename, contentType) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentType }), filename);
  const res = await fetch(`${API_BASE}/uploads?folder=pages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: form,
  });
  if (!res.ok) throw new Error(`upload ${filename} → ${res.status}`);
  const json = await res.json();
  const url = (json.data ?? json).url;
  // /uploads/* is served by the API process, not the storefront host.
  return url.startsWith('http') ? url : `${API_BASE.replace(/\/api$/, '')}${url}`;
}

async function wp(path) {
  const res = await fetch(`${WP_BASE}${path}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`WP ${path} → ${res.status}`);
  return res;
}

// ── HTML sanitising (allowlist, same spirit as the importer's cleanHtml) ────

const ALLOWED = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'h2', 'h3', 'h4',
  'h5', 'h6', 'blockquote', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
]);

export function sanitizeHtml(html) {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|form|svg|video|button|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi, '');
  s = s.replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, (m, tag, attrs) => {
    const t = tag.toLowerCase();
    const closing = m.startsWith('</');
    if (!ALLOWED.has(t)) return '';
    if (closing) return `</${t}>`;
    if (t === 'a') {
      const href = /href="([^"]*)"/i.exec(attrs)?.[1] ?? '';
      if (!href || /^\s*(javascript|data|vbscript):/i.test(decodeEntities(href)))
        return '<a>';
      const internal = href.startsWith('/') || href.startsWith(WP_BASE);
      const rel = internal ? '' : ' rel="noopener"';
      const target = internal ? '' : ' target="_blank"';
      return `<a href="${href.replace(WP_BASE, '')}"${rel}${target}>`;
    }
    if (t === 'img') {
      const src = /src="([^"]*)"/i.exec(attrs)?.[1] ?? '';
      const alt = /alt="([^"]*)"/i.exec(attrs)?.[1] ?? '';
      return src ? `<img src="${src}" alt="${alt}">` : '';
    }
    if (t === 'br') return '<br>';
    return `<${t}>`;
  });
  // Empty paragraphs and runs of blank lines.
  s = s.replace(/<p>\s*(<br>)?\s*<\/p>/g, '').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

async function rehostImages(html) {
  const srcs = [...new Set([...html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]))];
  let out = html;
  for (const src of srcs) {
    if (!src.includes('/wp-content/')) continue;
    const abs = src.startsWith('http') ? src : `${WP_BASE}${src}`;
    const res = await fetch(abs, { headers: { 'User-Agent': UA } });
    if (!res.ok) {
      console.log(`  image ${abs} → ${res.status}, dropped`);
      out = out.replace(new RegExp(`<img src="${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`, 'g'), '');
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const name = abs.split('/').pop().split('?')[0];
    const drop = () => {
      out = out.replace(new RegExp(`<img src="${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`, 'g'), '');
    };
    if (!/\.(png|jpe?g|webp|svg)$/i.test(name)) {
      console.log(`  image ${name}: unsupported type, dropped`);
      drop();
      continue;
    }
    if (!APPLY) {
      console.log(`  would upload ${name} (${buf.length} bytes)`);
      continue;
    }
    try {
      const url = await upload(buf, name, res.headers.get('content-type') ?? 'image/jpeg');
      out = out.split(src).join(url);
      console.log(`  uploaded ${name} → ${url}`);
    } catch (err) {
      console.log(`  image ${name}: upload failed (${err.message}), dropped`);
      drop();
    }
  }
  return out;
}

export function htmlToText(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, '’')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

export async function fetchWpPage(slug) {
  const rows = await (await wp(`/wp-json/wp/v2/pages?slug=${slug}&_fields=title.rendered,content.rendered`)).json();
  if (!rows.length) throw new Error(`WP page ${slug} not found`);
  const html = await (await wp(`/${slug}/`)).text();
  const title = decodeEntities(/<title>(.*?)<\/title>/s.exec(html)?.[1]?.trim() ?? rows[0].title.rendered)
    .replace(/\s+[-–|]\s*namez\s*$/i, '');
  const meta = decodeEntities(/<meta name="description" content="([^"]*)"/i.exec(html)?.[1] ?? '');
  const h1 = decodeEntities(rows[0].title.rendered);
  // Source of the body: the REST `content.rendered` when it is plain post
  // content; the rendered <main> when WP leaks the page-builder layout JSON
  // into the content (om-namez: 4 MB of escaped YOOtheme JSON).
  const rest = rows[0].content.rendered;
  const leaked = rest.length > 100_000 || /&#8221;type&#8221;:&#8221;section&#8221;/.test(rest);
  let content;
  if (!leaked) {
    content = sanitizeHtml(rest);
  } else {
    const main = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? '';
    content = sanitizeHtml(main.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, ''));
    console.log(`  ${slug}: REST content is builder JSON → used the rendered page (${htmlToText(content).split(' ').length} words)`);
  }
  return { slug, h1, title, meta, content };
}

// ── Pages ──────────────────────────────────────────────────────────────────

const WP_PAGES = [
  { slug: 'om-namez', mode: 'about' },
  { slug: 'kontakta-oss', mode: 'contact' },
  { slug: 'nojd-kundgaranti', mode: 'landing' },
  { slug: 'om-cookies', mode: 'landing' },
  { slug: 'material-pla-miljovanligt-och-hallbart-val', mode: 'landing' },
];

function heroSection(heading) {
  return {
    section_key: 'hero-banner',
    settings: { layout: 'centered', height: 'sm', overlay_opacity: 0.35, alignment: 'center' },
    translations: [{ locale: LOCALE, content: { heading } }],
  };
}

function richTextSection(html) {
  return {
    section_key: 'rich-text',
    settings: { width: 'normal', alignment: 'left', padding: 'medium', surface: false },
    translations: [{ locale: LOCALE, content: { html } }],
  };
}

async function listPages() {
  return api('GET', '/v2/pages/mine');
}

async function replaceSections(pageId, sections, keep = () => false) {
  const existing = await api('GET', `/v2/pages/${pageId}/sections`);
  for (const s of existing) {
    if (keep(s)) continue;
    await write('DELETE', `/v2/pages/sections/${s.id}`, undefined, `drop ${s.section_key}`);
  }
  const created = [];
  for (const [i, s] of sections.entries()) {
    const row = await write('POST', `/v2/pages/${pageId}/sections`, { ...s, sort_order: i }, s.section_key);
    if (row) created.push(row.id);
  }
  const kept = existing.filter(keep).map((s) => s.id);
  if (APPLY && kept.length) {
    await write('PUT', `/v2/pages/${pageId}/sections/sort`, { section_ids: [...created, ...kept] }, 'order');
  }
}

async function cmdPages() {
  console.log('\n== pages');
  const pages = await listPages();
  const bySlug = new Map(pages.filter((p) => p.slug).map((p) => [p.slug, p]));
  const byKind = new Map(pages.filter((p) => p.type === 'STATIC' && p.static_kind).map((p) => [p.static_kind, p]));
  for (const def of WP_PAGES) {
    const src = await fetchWpPage(def.slug);
    const content = await rehostImages(src.content);
    const translations = [
      { locale: LOCALE, title: src.h1, meta_title: src.title, meta_description: src.meta || htmlToText(content).slice(0, 160) },
    ];
    console.log(`- ${def.slug}: "${src.h1}" | meta ${src.meta.length} chars | html ${content.length} chars | ${htmlToText(content).split(' ').length} words`);
    let page = bySlug.get(def.slug);
    if (!page && def.mode === 'about') page = byKind.get('ABOUT');
    if (!page && def.mode === 'contact') page = byKind.get('CONTACT');
    if (page) {
      await write('PUT', `/v2/pages/${page.id}`, { slug: def.slug, translations }, `update ${page.type}/${page.static_kind ?? ''} ${page.slug} → ${def.slug}`);
      if (def.mode === 'contact') {
        // Keep the map / embed blocks of the template contact page; the WP
        // text goes right under the hero.
        await replaceSections(page.id, [heroSection(src.h1), richTextSection(content)], (s) =>
          ['map', 'embed-code'].includes(s.section_key),
        );
      } else {
        await replaceSections(page.id, [heroSection(src.h1), richTextSection(content)]);
      }
    } else {
      page = await write('POST', '/v2/pages', { type: 'LANDING', slug: def.slug, translations }, `create LANDING ${def.slug}`);
      for (const [i, s] of [heroSection(src.h1), richTextSection(content)].entries()) {
        if (page) await write('POST', `/v2/pages/${page.id}/sections`, { ...s, sort_order: i }, s.section_key);
        else console.log(`  would POST /v2/pages/<new>/sections  — ${s.section_key}`);
      }
    }
    if (page) await write('POST', `/v2/pages/${page.id}/publish`, { label: 'wp-content-migration' }, 'publish');
  }
}

// ── Redirects ──────────────────────────────────────────────────────────────

const REDIRECTS = [
  ['/about', '/om-namez'],
  ['/contact', '/kontakta-oss'],
  ['/frakt-och-returvillkor', '/shipping-policy'],
  ['/produkt/personliga-presenter-med-namn-test', '/products/personliga-presenter-med-namn'],
  ['/produkt/personlig-3d-staende-', '/products/personlig-3d-staende-namnskylt'],
];

async function cmdRedirects() {
  console.log('\n== redirects');
  for (const [from, to] of REDIRECTS) {
    const test = await api('POST', '/redirects/my/test', { path: from }).catch((err) => {
      if (String(err.message).includes('→ 403')) throw new Error('redirects need the importer app enabled for this store (403)');
      return null;
    });
    if (test?.match?.to_path === to) {
      console.log(`  ok ${from} → ${to} (exists)`);
      continue;
    }
    if (test?.match) {
      console.log(`  SKIP ${from}: already → ${test.match.to_path} (${test.match.source})`);
      continue;
    }
    await write('POST', '/redirects/my', { from_path: from, to_path: to, status_code: 301 }, `${from} → ${to}`);
  }
}

// ── Menus ──────────────────────────────────────────────────────────────────

/** WP header mega groups (crawl 2026-10-28), slug → label; pages exist after M7. */
const GROUPS = [
  ['För honom', [
    ['present-till-pappa', 'Present till pappa'], ['present-till-honom', 'Present till honom'],
    ['present-till-kille', 'Present till kille'], ['present-till-pojkvan', 'Present till pojkvän'],
    ['present-till-bror', 'Present till bror'], ['present-till-pojke', 'Present till pojke'],
    ['present-till-farfar', 'Present till farfar'], ['present-till-morfar', 'Present till morfar'],
    ['present-till-svarfar', 'Present till svärfar'], ['fars-dag-present', 'Fars dag present'],
    ['alla-hjartans-dag-present-till-pojkvan', 'Alla hjärtans dag present till pojkvän'],
  ]],
  ['För henne', [
    ['present-till-mamma', 'Present till mamma'], ['present-till-henne', 'Present till henne'],
    ['present-till-kvinna', 'Present till kvinna'], ['present-till-tjej', 'Present till tjej'],
    ['present-till-flickvan', 'Present till flickvän'], ['present-till-fru', 'Present till fru'],
    ['present-till-syster', 'Present till syster'], ['present-till-flicka', 'Present till flicka'],
    ['present-till-tjejkompis', 'Present till tjejkompis'], ['present-till-farmor', 'Present till farmor'],
    ['present-till-mormor', 'Present till mormor'], ['present-till-svarmor', 'Present till svärmor'],
    ['mors-dag-present', 'Mors dag present'],
    ['alla-hjartans-dag-present-flickvan', 'Alla hjärtans dag present flickvän'],
  ]],
  ['För företag', [
    ['present-till-chef', 'Present till chef'], ['present-till-kollega', 'Present till kollega'],
    ['present-till-personal', 'Present till personal'], ['present-till-foretag', 'Present till företag'],
    ['present-till-larare', 'Present till lärare'], ['present-till-pedagoger', 'Present till pedagoger'],
  ]],
  ['För barn', [
    ['present-till-barn', 'Present till barn'], ['present-till-nyfodd', 'Present till nyfödd'],
  ]],
  ['För alla', [
    ['studentpresent', 'Studentpresent'], ['present-till-foraldrar', 'Present till föräldrar'],
    ['present-till-par', 'Present till par'], ['present-till-sambo', 'Present till sambo'],
    ['present-till-basta-van', 'Present till bästa vän'], ['present-till-husdjur', 'Present till husdjur'],
    ['roliga-presenter', 'Roliga presenter'], ['present-till-storfiskaren', 'Present till storfiskaren'],
    ['inflyttningspresent', 'Inflyttningspresent'], ['ga-bort-present', 'Gå bort present'],
  ]],
];

function item(label, url, extra = {}) {
  return { kind: 'CUSTOM', label, label_i18n: { sv: label }, url, open_in_new_tab: false, ...extra };
}

async function cmdMenus() {
  console.log('\n== menus');
  const pages = await listPages();
  const pageBySlug = new Map(pages.filter((p) => p.slug && p.published_version_id).map((p) => [p.slug, p]));
  const cats = await api('GET', '/creator-categories');
  const flat = [];
  const walk = (nodes) => nodes.forEach((n) => { flat.push(n); walk(n.children ?? []); });
  walk(cats);
  const catBySlug = new Map(flat.map((c) => [c.slug, c]));
  const pageItem = (slug, label) => {
    const p = pageBySlug.get(slug);
    if (!p) {
      console.log(`  ! page /${slug} missing (not published?) — linked as CUSTOM`);
      return item(label, `/${slug}`);
    }
    return item(label, `/${slug}`, { kind: 'PAGE', resource_id: p.id });
  };
  const collectionItem = (slug, label) => {
    const c = catBySlug.get(slug);
    if (!c || c.visibility === 'INTERNAL') {
      console.log(`  ! collection ${slug} missing or internal — skipped`);
      return null;
    }
    return item(label, `/collections/${slug}`, { kind: 'COLLECTION', resource_id: c.id });
  };
  const header = [
    item('Hem', '/'),
    {
      ...collectionItem('presenter-till-vem', 'Presenter till vem') ?? item('Presenter till vem', '/collections/presenter-till-vem'),
      children: GROUPS.map(([heading, links]) => ({
        ...item(heading, '#'),
        children: links.map(([slug, label]) => pageItem(slug, label)),
      })),
    },
    collectionItem('namnskyltar', 'Namnskyltar'),
    collectionItem('studentskyltar', 'Studentskyltar'),
    collectionItem('3d_presenter', '3D-presenter'),
    collectionItem('svensk-present', 'Svensk present'),
    pageItem('om-namez', 'Om oss'),
  ].filter(Boolean);
  const footer = [
    pageItem('kontakta-oss', 'Kontakta oss'),
    pageItem('om-namez', 'Om oss'),
    item('Frakt & leverans', '/shipping-policy'),
    pageItem('nojd-kundgaranti', 'Nöjd-kundgaranti'),
    pageItem('om-cookies', 'Om cookies'),
    pageItem('material-pla-miljovanligt-och-hallbart-val', 'Material: PLA'),
  ];
  const menus = await api('GET', '/menus/mine');
  const ensureMenu = async (key, name) => {
    const found = menus.find((m) => m.key === key);
    if (found) return found;
    return write('POST', '/menus', { key, name }, `create menu ${key}`);
  };
  const h = await ensureMenu('header', 'Header');
  console.log(`  header: ${header.length} top items, ${GROUPS.reduce((n, [, l]) => n + l.length, 0)} mega links`);
  if (h) await write('PUT', `/menus/${h.id}/items`, { items: header }, 'header items');
  const f = await ensureMenu('footer', 'Footer');
  console.log(`  footer: ${footer.length} items`);
  if (f) await write('PUT', `/menus/${f.id}/items`, { items: footer }, 'footer items');
}

// ── Footer fix ─────────────────────────────────────────────────────────────

async function chromePage(type) {
  const pages = await listPages();
  const page = pages.find((p) => p.type === type);
  if (!page) throw new Error(`${type} page not found`);
  return api('GET', `/v2/pages/${page.id}`);
}

async function cmdFooterFix() {
  console.log('\n== footer-fix');
  const page = await chromePage('FOOTER');
  const section = page.sections.find((s) => s.section_key === 'footer-columns');
  if (!section) throw new Error('footer-columns section not found');
  const translations = section.translations.map((t) => {
    const content = structuredClone(t.content ?? {});
    const columns = Array.isArray(content.columns) ? content.columns : [];
    if (columns[0]) {
      columns[0].menu_key = 'footer';
      columns[0].heading = t.locale === 'sv' ? 'Snabblänkar' : columns[0].heading;
    }
    for (const col of columns)
      for (const link of col.links ?? [])
        if (typeof link.url === 'string') link.url = link.url.replace(/^tell:/i, 'tel:');
    content.columns = columns;
    return { locale: t.locale, content };
  });
  console.log(`  ${translations.length} locales; column 1 → menu "footer"; tel: typo fixed`);
  await write('PUT', `/v2/pages/sections/${section.id}`, { translations }, 'footer-columns');
  await write('POST', `/v2/pages/${page.id}/publish`, { label: 'footer-fix' }, 'publish FOOTER');
}

// ── Languages ──────────────────────────────────────────────────────────────

async function cmdLanguages() {
  console.log('\n== languages');
  await write('PUT', '/stores/my/languages', { primary_locale: 'sv', secondary_locales: [], auto_translate: false }, 'sv only');
}

// ── Empty collections → INTERNAL ───────────────────────────────────────────

const EMPTY_ROOTS = ['halsband', 'nyckelringar', 'personliga-presenter', 'sma-presenter', 'presenter-efter-alder'];

async function cmdEmptyCollections() {
  console.log('\n== empty-collections');
  const cats = await api('GET', '/creator-categories');
  const flat = [];
  const walk = (nodes, depth = 0) => nodes.forEach((n) => { flat.push({ ...n, depth }); walk(n.children ?? [], depth + 1); });
  walk(cats);
  const byId = new Map(flat.map((c) => [c.id, c]));
  const underEmptyRoot = (c) => {
    for (let p = c; p; p = p.parent_id ? byId.get(p.parent_id) : null)
      if (EMPTY_ROOTS.includes(p.slug)) return true;
    return false;
  };
  const targets = flat.filter(underEmptyRoot);
  // Deepest first: a parent can only become INTERNAL once its children are.
  targets.sort((a, b) => b.depth - a.depth);
  for (const c of targets) {
    const products = (c._count?.products ?? 0) + (c._count?.custom_products ?? 0);
    if (products > 0) {
      console.log(`  SKIP ${c.slug}: ${products} products`);
      continue;
    }
    if (c.visibility === 'INTERNAL') {
      console.log(`  ok ${c.slug} already INTERNAL`);
      continue;
    }
    await write('PATCH', `/creator-categories/${c.id}`, { visibility: 'INTERNAL', parent_id: null }, `${c.slug} → INTERNAL`);
  }
  console.log(`  ${targets.length} collections considered`);
}

// ── Header mega ────────────────────────────────────────────────────────────

async function cmdHeaderMega() {
  console.log('\n== header-mega');
  const page = await chromePage('HEADER');
  const section = page.sections.find((s) => s.section_key === 'header-bar');
  if (!section) throw new Error('header-bar section not found');
  const settings = { ...(section.settings ?? {}), submenu_style: 'mega', menu_key: section.settings?.menu_key ?? 'header' };
  await write('PUT', `/v2/pages/sections/${section.id}`, { settings }, 'header-bar submenu_style=mega');
  await write('POST', `/v2/pages/${page.id}/publish`, { label: 'header-mega' }, 'publish HEADER');
}

// ── Main ───────────────────────────────────────────────────────────────────

const COMMANDS = {
  pages: cmdPages,
  redirects: cmdRedirects,
  menus: cmdMenus,
  'footer-fix': cmdFooterFix,
  languages: cmdLanguages,
  'empty-collections': cmdEmptyCollections,
  'header-mega': cmdHeaderMega,
};

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const cmd = process.argv[2];
  const run = cmd === 'all' ? Object.keys(COMMANDS) : [cmd];
  if (!cmd || run.some((c) => !COMMANDS[c])) {
    console.error(`usage: TOKEN=<creator jwt> node tools/namez/content.mjs <${Object.keys(COMMANDS).join('|')}|all> [--apply]`);
    process.exit(2);
  }
  if (!TOKEN) {
    console.error('TOKEN (creator JWT) is required');
    process.exit(2);
  }
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} against ${API_BASE}`);
  for (const c of run) await COMMANDS[c]();
  console.log('done');
}

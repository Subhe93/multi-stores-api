/**
 * One-off content fix (M86): make Namez's site FOOTER and the /kontakta-oss
 * page match the old WordPress site (review copy captured 2026-11-13, see
 * "C:\Projects\servers vps\docs\namez-review-ref\README.md").
 *
 * - Uploads the old footer images (30-day badge, "Följ oss på Instagram" title
 *   image, 6 Instagram photos, 5 payment logos) to public media `pages/`.
 * - FOOTER page: hides the current visible sections and adds, top to bottom:
 *   USP row (4 icons + titles + texts), 30-day badge, Instagram title image +
 *   6-photo strip, main row (logo + about + company + payment logos |
 *   SNABBLÄNKAR | KUNDSERVICE + social icons), dark legal bar.
 * - /kontakta-oss: hides the M85 sections and adds the same content with the
 *   old measurements (paddings, colours, type sizes, normal-colour map,
 *   uppercase Instagram heading, edge-to-edge 5-photo strip without gaps).
 *
 * Non-destructive: replaced sections are only HIDDEN; a JSON backup of both
 * pages is written first; each page gets a new published version, the
 * previous one stays in the builder's Versions list. Refuses to run twice.
 *
 *   node scripts/ops/namez-footer-contact-match.js --images <dir>            (dry run)
 *   node scripts/ops/namez-footer-contact-match.js --images <dir> --apply    (upload + write + publish)
 *
 * <dir> holds the files of namez-review-ref/images (names as listed in IMAGES).
 * Run from the API directory with the production environment loaded and the
 * API built (dist/ is used for the storage adapter). No secret is printed.
 */
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { PrismaClient } = require('@prisma/client');

const STORE_SLUG = 'namez-se';
const CONTACT_SLUG = 'kontakta-oss';
const VERSION_LABEL = 'M86 match old WordPress';
const APPLY = process.argv.includes('--apply');
const imagesArg = process.argv.indexOf('--images');
const IMAGES_DIR = imagesArg > 0 ? process.argv[imagesArg + 1] : null;

const IG_CONTACT = 'https://www.instagram.com/3dnamez.se/';
const IG_BRAND = 'https://www.instagram.com/namez.se/';
const FB_BRAND = 'https://www.facebook.com/namez.se/';
const TT_BRAND = 'https://www.tiktok.com/@namez.se';

// Old theme colours.
const TEXT = '#6C6D74';
const HEAD = '#2D2E33';

const IMAGES = {
  badge: '59858036-260f-4138-932e-e17174501779.oppet_kop-b4b95747.avif',
  igTitle: 'Folj-oss-pa-Instagram-3af9ddda.webp',
  ig: [
    'AQN22NQfTCbm71H9_cgK8PXmtMI3Hnw7kZygChQbBfWm8d9Zmeu3nfinopr0Kl0asDTXx5nenE8lBSSaMYGrXL1L-25619caa.webp',
    'AQOpNjCEkyQMheQZZMio4EQOE2_H0gvYi27fS2NdRL-yU7UjcS5OCwHs-hCT4ew2NNvghVHKIe7YQcmQja09gzOH-0c531227.webp',
    '656621125_1000106449340375_625170441165488315_n-e68fae4a.webp',
    '583828516_1648594963212803_2436562413322923217_n-9e574387.webp',
    '643208592_925669643275322_1292461677154943241_n-3dde7b07.webp',
    '652798511_1228745402806018_8556874087281182826_n-7c47b067.webp',
  ],
  pay: [
    ['Apple Pay', 'apple-pay-svgrepo-com.svg'],
    ['Google Pay', 'google-pay-svgrepo-com.svg'],
    ['Visa', 'visa-classic-svgrepo-com.svg'],
    ['Mastercard', 'mastercard-svgrepo-com.svg'],
    ['Klarna', 'klarna-svgrepo-com.svg'],
  ],
};

const prisma = new PrismaClient();

// ── Styling helpers ─────────────────────────────────────────────

const BODY = `font-size:16px;line-height:26px;color:${TEXT};margin:0`;
const SMALL_HEAD =
  `font-size:11px;font-weight:500;letter-spacing:2px;text-transform:uppercase;color:${HEAD};margin:0 0 20px`;
const USP_HEAD =
  `font-size:20px;line-height:1.4;font-weight:500;letter-spacing:2px;text-transform:uppercase;color:${HEAD};margin:16px 0 20px`;

/** Responsive 4-sided padding for `_style`. */
function pad(desktop, mobile) {
  return { desktop, mobile: mobile ?? desktop };
}
/** Contained section with the old 15 px phone gutter. */
function contained(extra = {}) {
  return {
    width: 'container',
    padding: pad({ left: 0, right: 0, ...extra.desktop }, { left: 16, right: 16, ...extra.mobile }),
    ...(extra.margin ? { margin: extra.margin } : {}),
  };
}

function cols(cells, settings = {}, style) {
  return {
    section_key: 'layout-columns',
    settings: {
      mode: 'grid',
      columns: 2,
      columns_tablet: 2,
      columns_mobile: 1,
      direction: 'row',
      wrap: true,
      gap_px: 40,
      align: 'start',
      justify: 'start',
      ...settings,
      ...(style ? { _style: style } : {}),
    },
    content: { cells },
  };
}
const cell = (raw_html, extra = {}) => ({
  col_span: 1,
  align: 'stretch',
  blocks: [{ type: 'html', raw_html, align: 'start' }],
  ...extra,
});

// Line icons (24 px, 1.2 stroke) in the spirit of the old UIkit icons.
const svg = (inner, size = 24, stroke = TEXT) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" ` +
  `stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:inline-block">${inner}</svg>`;
const ICONS = {
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>',
  future:
    '<path d="M3 12a9 9 0 1 0 2.6-6.4"/><path d="M3 4v4h4"/><path d="M12 7v5l3 2"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="1"/><path d="M2.5 10h19"/>',
  users:
    '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5"/>' +
    '<path d="M15.5 4.7a3.5 3.5 0 0 1 0 6.6"/><path d="M18 13.8c2.1.9 3.5 3 3.5 5.7"/>',
  instagram:
    '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".6"/>',
  facebook: '<path d="M14 8h3V4h-3a4 4 0 0 0-4 4v3H7v4h3v7h4v-7h3l1-4h-4V8Z"/>',
  tiktok: '<path d="M14 3v11.5a3.5 3.5 0 1 1-3.5-3.5"/><path d="M14 3c.4 2.6 2.3 4.5 5 4.8"/>',
};

// ── Sections ────────────────────────────────────────────────────

function footerSections(img, logoUrl) {
  const usp = (icon, title, textHtml) =>
    cell(
      `<div style="text-align:center">${svg(ICONS[icon])}` +
        `<h4 style="${USP_HEAD}">${title}</h4>` +
        `<p style="${BODY}">${textHtml}</p></div>`,
    );
  const payBox = (alt, src) =>
    `<span style="display:inline-flex;align-items:center;justify-content:center;width:50px;height:34px;` +
    `border:1px solid #e5e5e5;border-radius:3px;background:#fff">` +
    `<img src="${src}" alt="${alt}" width="40" height="26" loading="lazy" style="width:40px;height:26px;object-fit:contain"></span>`;
  const social = (icon, href, label) =>
    `<a href="${href}" target="_blank" rel="noopener noreferrer" aria-label="${label}" ` +
    `style="display:inline-flex;color:#999">${svg(ICONS[icon], 20, '#999')}</a>`;
  const link = (href, text) =>
    `<li style="margin:0 0 10px"><a href="${href}" style="${BODY};text-decoration:none">${text}</a></li>`;

  return [
    // 1. USP row: 4 columns, 2 on tablet and phone.
    cols(
      [
        usp('bolt', 'Snabb leverans', 'Leverans inom 3–5 arbetsdagar i Sverige'),
        usp(
          'future',
          '30 dagars öppet köp',
          'Handla tryggt – om du inte är nöjd kan du returnera inom 30 dagar. Vi ersätter även produkten utan kostnad om den skadas under frakten.',
        ),
        usp('card', 'Säker utcheckning', 'Betala tryggt med Klarna och andra säkra betalmetoder.'),
        usp(
          'users',
          'Kundtjänst',
          'Vänlig och snabb support redo att hjälpa dig <a href="/kontakta-oss" style="text-decoration:none">➡️</a>',
        ),
      ],
      { columns: 4, columns_tablet: 2, columns_mobile: 2, gap_px: 30 },
      contained({ desktop: { top: 8, bottom: 0 }, mobile: { top: 8, bottom: 0 } }),
    ),
    // 2. 30-day badge in the left half.
    cols(
      [
        cell(
          `<img src="${img.badge}" alt="Öppet köp 30 dagar" width="125" height="125" loading="lazy" ` +
            `style="display:block;margin:0 auto;width:125px;height:125px">`,
        ),
      ],
      { columns: 2, columns_tablet: 2, columns_mobile: 1 },
      contained({ desktop: { top: 0, bottom: 0 } }),
    ),
    // 3. Instagram title image + photo strip.
    cols(
      [
        cell(
          `<div style="text-align:center"><a href="${IG_BRAND}" target="_blank" rel="noopener noreferrer">` +
            `<img src="${img.igTitle}" alt="Följ oss på Instagram" width="250" height="34" loading="lazy" ` +
            `style="display:inline-block;width:250px;height:auto"></a></div>`,
        ),
      ],
      { columns: 1, columns_tablet: 1, columns_mobile: 1, gap_px: 0 },
      contained({ desktop: { top: 8, bottom: 0 } }),
    ),
    {
      section_key: 'gallery-slider',
      settings: {
        slides_per_view: 5,
        slides_per_view_tablet: 4,
        slides_per_view_mobile: 3,
        gap_px: 0,
        aspect: 'square',
        show_caption: false,
        rounded: false,
        autoplay_ms: 0,
        // Arrows (desktop only) so mouse users can reach the 6th photo.
        show_arrows: true,
        show_dots: false,
        loop: false,
        _style: contained({ desktop: { top: 0, bottom: 0 }, margin: pad({ top: -24 }) }),
      },
      content: {
        items: img.ig.map((url, i) => ({
          url,
          alt: `namez på Instagram ${i + 1}`,
          caption: '',
          href: IG_BRAND,
        })),
      },
    },
    // 4. Main row: 1/2 + 1/4 + 1/4 (phone: full, then two halves).
    cols(
      [
        cell(
          `<a href="/" aria-label="namez" style="display:inline-block;margin:0 0 20px">` +
            `<img src="${logoUrl}" alt="namez" width="200" loading="lazy" style="display:block;width:200px;height:auto"></a>` +
            `<p style="${BODY};margin-bottom:20px">3D NameZ – Din destination för unika, personligt anpassade 3D-presenter. ` +
            'Vi erbjuder högkvalitativa, skräddarsydda 3D-modeller för alla tillfällen. Tillverkade i Sverige, ' +
            'skapa minnesvärda gåvor som varar livet ut.</p>' +
            `<p style="${BODY};margin-bottom:24px">namez AB<br>Org.nr: 5592951007</p>` +
            `<div style="display:flex;flex-wrap:wrap;gap:10px;justify-content:center">` +
            img.pay.map(([alt, src]) => payBox(alt, src)).join('') +
            '</div>',
          { col_span: 2 },
        ),
        cell(
          `<h2 style="${SMALL_HEAD}">Snabblänkar</h2><ul style="list-style:none;margin:0;padding:0">` +
            link('/om-namez', 'Om oss') +
            link('/nojd-kundgaranti', 'Nöjd-kundgaranti') +
            link('/kontakta-oss', 'Kundtjänst och kontakt') +
            link('/shipping-policy', 'Frakt &amp; leverans') +
            link('/om-cookies', 'Cookies') +
            '</ul>',
        ),
        cell(
          `<h2 style="${SMALL_HEAD}">Kundservice</h2>` +
            `<p style="${BODY};margin-bottom:20px"><strong>Måndag - Fredag:</strong> 9:30 - 17:00<br>` +
            '<strong>Lördag - Söndag:</strong> 9:30 - 13:00</p>' +
            `<p style="${BODY};margin-bottom:20px"><strong>Telefon</strong>: ` +
            `<a href="tel:0243333243" style="color:${HEAD};text-decoration:none">0243-33 32 43</a></p>` +
            `<p style="${BODY};margin-bottom:20px"><strong>Email:</strong> ` +
            `<a href="mailto:info@namez.se" style="color:${TEXT};text-decoration:none">info@namez.se</a></p>` +
            `<p style="${BODY};margin-bottom:20px"><strong>Besök oss:</strong><br>Hagavägen 36<br>784 40 Borlänge<br>Dalarna, Sverige</p>` +
            `<div style="display:flex;gap:12px">` +
            social('instagram', IG_BRAND, 'Instagram') +
            social('facebook', FB_BRAND, 'Facebook') +
            social('tiktok', TT_BRAND, 'TikTok') +
            '</div>',
        ),
      ],
      { columns: 4, columns_tablet: 4, columns_mobile: 2, gap_px: 40 },
      contained({ desktop: { top: 40, bottom: 8 } }),
    ),
    // 5. Dark legal bar.
    {
      section_key: 'copyright-bar',
      settings: {
        alignment: 'center',
        show_payment_icons: false,
        bg_color: '#242427',
        text_color: 'rgba(255,255,255,0.4)',
        border_color: '#242427',
        // The padding sits on the wrapper, so it carries the bar colour too.
        _style: {
          padding: pad({ top: 24, bottom: 24 }),
          background: 'custom',
          background_color: '#242427',
        },
      },
      content: { text: '© {year}  NAMEZ AB. ALL RIGHTS RESERVED.' },
    },
  ];
}

function contactSections(igImages) {
  const h1 =
    `<h1 style="margin:0 0 20px;font-size:28px;line-height:1.4;font-weight:400;color:${HEAD}">Kontakta oss</h1>`;
  return [
    cols(
      [
        cell(
          h1 +
            `<p style="${BODY};margin-bottom:20px"><strong style="color:${HEAD}">Hur kan vi hjälpa dig?</strong></p>` +
            `<p style="${BODY};margin-bottom:20px">Har du frågor eller behöver hjälp med din beställning? ` +
            'Tveka inte att kontakta vårt team! Vi finns här för att hjälpa dig skapa den perfekta personliga gåvan.</p>' +
            `<p style="${BODY}"><em style="color:${HEAD}">Varma hälsningar</em></p>`,
        ),
        cell(
          `<p style="${BODY};margin-bottom:20px">namez AB<br>Org.nr: 559295-1007<br><br>` +
            `<strong style="color:${HEAD}">Adress:</strong><br>Hagavägen 36<br>784 40 Borlänge<br>Dalarna, Sverige</p>` +
            `<p style="${BODY};margin-bottom:10px"><strong style="color:${HEAD}">Öppettider:</strong></p>` +
            `<p style="${BODY};margin-bottom:20px">Måndag – Fredag: 9:30 – 17:00</p>` +
            `<p style="${BODY}"><strong style="color:${HEAD}">Telefon:</strong> 0243-33 32 43<br>` +
            `<strong style="color:${HEAD}">E-post:</strong> <a href="mailto:info@namez.se" style="color:${TEXT};text-decoration:none">info@namez.se</a></p>`,
        ),
      ],
      { columns: 2, columns_tablet: 2, columns_mobile: 1, gap_px: 40 },
      // Old section padding 140 / 70 minus the section's own 32 px.
      { padding: pad({ top: 108, bottom: 0 }, { top: 38, bottom: 0 }) },
    ),
    {
      section_key: 'map',
      settings: {
        layout: 'full',
        map_style: 'standard',
        card_style: 'solid',
        zoom: 14,
        height: 500,
        rounded: false,
        show_directions: false,
        _style: { margin: pad({ top: 62 }, { top: 10 }) },
      },
      content: { locations: [{ name: '3D NameZ', lat: '60.4863298', lng: '15.4292531' }] },
    },
    cols(
      [
        cell(
          `<h2 style="margin:0;text-align:center;font-size:16px;font-weight:500;letter-spacing:2px;` +
            `text-transform:uppercase;line-height:1.4"><a href="${IG_CONTACT}" target="_blank" rel="noopener noreferrer" ` +
            `style="color:${HEAD};text-decoration:none">Följ oss på Instagram</a></h2>`,
        ),
      ],
      { columns: 1, columns_tablet: 1, columns_mobile: 1, gap_px: 0, justify: 'center' },
      { padding: pad({ top: 90, bottom: 0 }, { top: 0, bottom: 0 }) },
    ),
    {
      section_key: 'gallery-slider',
      settings: {
        slides_per_view: 5,
        slides_per_view_tablet: 4,
        slides_per_view_mobile: 3,
        gap_px: 0,
        aspect: 'landscape',
        show_caption: false,
        rounded: false,
        autoplay_ms: 0,
        show_arrows: false,
        show_dots: false,
        loop: false,
        // Edge to edge, as the old full-viewport slider.
        _style: { width: 'full', margin: pad({ top: -36, bottom: -40 }, { top: -36, bottom: -40 }) },
      },
      content: {
        items: igImages.map((url, i) => ({
          url,
          alt: `namez på Instagram ${i + 1}`,
          caption: '',
          href: IG_CONTACT,
        })),
      },
    },
  ];
}

// ── Data helpers ────────────────────────────────────────────────

const pageInclude = {
  translations: true,
  sections: { include: { translations: true }, orderBy: { sort_order: 'asc' } },
};

// Same shape as buildPublishSnapshot in pages-v2.service.ts.
function buildSnapshot(page) {
  return {
    page: {
      type: page.type,
      static_kind: page.static_kind,
      slug: page.slug,
      seo: page.seo,
      translations: page.translations,
    },
    sections: page.sections
      .filter((s) => !s.is_hidden)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((s) => ({
        id: s.id,
        section_key: s.section_key,
        settings: s.settings,
        sort_order: s.sort_order,
        translations: s.translations.map((t) => ({ locale: t.locale, content: t.content })),
      })),
  };
}

function describe(page, name) {
  console.log(`${name}: page ${page.id} (${page.type}, ${page.status})`);
  for (const s of page.sections) {
    console.log(
      `  #${s.sort_order} ${s.section_key}${s.is_hidden ? ' (hidden)' : ''}` +
        ` locales=[${s.translations.map((t) => t.locale).join(',')}]`,
    );
  }
}

/** The 5 contact-page photos already on the platform (M85 gallery-slider). */
function contactImages(page) {
  const slider = page.sections.find((s) => !s.is_hidden && s.section_key === 'gallery-slider');
  const items = slider?.translations?.[0]?.content?.items;
  return Array.isArray(items) && items.length === 5 ? items.map((i) => i.url) : null;
}

function loadStorage() {
  for (const base of ['dist/src/modules/storage', 'dist/modules/storage']) {
    const dir = path.resolve(base);
    if (!fs.existsSync(path.join(dir, 'public-storage.js'))) continue;
    const { parseStorageConfig } = require(path.join(dir, 'storage.config.js'));
    const { buildObjectStorages } = require(path.join(dir, 'storage.module.js'));
    const { PublicStorage } = require(path.join(dir, 'public-storage.js'));
    const cfg = parseStorageConfig();
    return new PublicStorage(buildObjectStorages(cfg).media, cfg);
  }
  throw new Error('API build (dist/) not found: run from the API directory after a build.');
}

/**
 * Absolute media URL for raw HTML blocks: they are inserted as-is (no
 * resolveMediaUrl), and the store's own domain does not serve /uploads.
 */
function absolute(storage, url) {
  const out = storage.absoluteUrl(url);
  if (!/^https:\/\//.test(out) || out.includes('/api/uploads')) {
    throw new Error(`Media URL is not an absolute media-host URL: ${out}`);
  }
  return out;
}

async function upload(storage, file) {
  const ext = path.extname(file).toLowerCase();
  const res = await storage.put('pages', `${randomUUID()}${ext}`, fs.readFileSync(path.join(IMAGES_DIR, file)));
  return res.url;
}

// Footer sections that are not part of the old design and stay visible.
const KEEP_KEYS = new Set(['mobile-bottom-nav', 'embed-code']);

const toHide = (page) => page.sections.filter((s) => !s.is_hidden && !KEEP_KEYS.has(s.section_key));

async function replaceSections(tx, page, plan, locales) {
  const visible = toHide(page);
  await tx.pageSection.updateMany({
    where: { id: { in: visible.map((s) => s.id) } },
    data: { is_hidden: true },
  });
  let sort = page.sections.reduce((m, s) => Math.max(m, s.sort_order), 0);
  for (const s of plan) {
    sort += 1;
    await tx.pageSection.create({
      data: {
        page_id: page.id,
        section_key: s.section_key,
        settings: s.settings,
        sort_order: sort,
        translations: { create: [...locales].map((locale) => ({ locale, content: s.content })) },
      },
    });
  }
  const fresh = await tx.page.findUniqueOrThrow({ where: { id: page.id }, include: pageInclude });
  const version = await tx.pageVersion.create({
    data: {
      page_id: page.id,
      label: VERSION_LABEL,
      snapshot: buildSnapshot(fresh),
      published_at: new Date(),
    },
  });
  await tx.page.update({
    where: { id: page.id },
    data: { status: 'PUBLISHED', published_version_id: version.id },
  });
  return version.id;
}

function localesOf(page, primary) {
  const set = new Set([primary]);
  for (const s of page.sections) if (!s.is_hidden) for (const t of s.translations) set.add(t.locale);
  return set;
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

// ── Main ────────────────────────────────────────────────────────

(async () => {
  try {
    if (!IMAGES_DIR) throw new Error('Pass --images <dir>.');
    const files = [IMAGES.badge, IMAGES.igTitle, ...IMAGES.ig, ...IMAGES.pay.map((p) => p[1])];
    const missing = files.filter((f) => !fs.existsSync(path.join(IMAGES_DIR, f)));
    if (missing.length) throw new Error(`Missing images in ${IMAGES_DIR}: ${missing.join(', ')}`);
    console.log(`Images: ${files.length} found in ${IMAGES_DIR}`);

    const store = await prisma.store.findUnique({
      where: { slug: STORE_SLUG },
      select: { id: true, slug: true, logo_url: true },
    });
    if (!store) throw new Error(`Store ${STORE_SLUG} not found`);
    const lang = await prisma.storeLanguageConfig.findFirst({
      where: { store_id: store.id },
      select: { primary_locale: true },
    });
    const primary = lang?.primary_locale || 'en';

    const footer = await prisma.page.findFirst({
      where: { store_id: store.id, type: 'FOOTER' },
      include: pageInclude,
    });
    const contact = await prisma.page.findFirst({
      where: { store_id: store.id, slug: CONTACT_SLUG, type: { in: ['STATIC', 'LANDING'] } },
      include: pageInclude,
    });
    if (!footer) throw new Error('FOOTER page not found');
    if (!contact) throw new Error(`Page ${CONTACT_SLUG} not found`);
    describe(footer, 'FOOTER');
    describe(contact, CONTACT_SLUG);

    const done = await prisma.pageVersion.findFirst({
      where: { page_id: { in: [footer.id, contact.id] }, label: VERSION_LABEL },
      select: { id: true },
    });
    if (done) throw new Error('Already applied by this script; nothing to do.');

    // Footer logo = the header logo (section override first, then the store logo).
    const header = await prisma.page.findFirst({
      where: { store_id: store.id, type: 'HEADER' },
      include: { published_version: true },
    });
    const headerBar = header?.published_version?.snapshot?.sections?.find(
      (s) => s.section_key === 'header-bar',
    );
    const storage = loadStorage();
    const rawLogo = headerBar?.settings?.logo_url || store.logo_url;
    if (!rawLogo) throw new Error('No store logo found for the footer.');
    const logoUrl = absolute(storage, rawLogo);
    console.log(`Footer logo: ${logoUrl}`);

    const igContact = contactImages(contact);
    if (!igContact) throw new Error('Could not find the 5 contact-page photos (M85 gallery-slider).');

    const footerLocales = localesOf(footer, primary);
    const contactLocales = localesOf(contact, primary);
    console.log(
      `FOOTER: hide ${toHide(footer).map((s) => s.section_key).join(', ')}; add 7 for [${[...footerLocales]}]`,
    );
    console.log(
      `${CONTACT_SLUG}: hide ${toHide(contact).map((s) => s.section_key).join(', ')}; add 4 for [${[...contactLocales]}]`,
    );

    if (!APPLY) {
      // Build the plans with placeholder URLs so a dry run validates them too.
      const fake = { badge: 'x', igTitle: 'x', ig: IMAGES.ig.map(() => 'x'), pay: IMAGES.pay.map(([a]) => [a, 'x']) };
      footerSections(fake, logoUrl);
      contactSections(igContact);
      console.log('Dry run. Re-run with --apply to upload, write and publish.');
      return;
    }

    const backupFile = path.resolve(`footer-kontakta-backup-${new Date().toISOString().replace(/[:.]/g, '')}.json`);
    fs.writeFileSync(backupFile, JSON.stringify({ footer, contact }, null, 2));
    console.log(`Backup written: ${backupFile}`);

    console.log(`Uploading ${files.length} images (driver ${storage.driver})…`);
    // Raw-HTML images get absolute URLs; slider items stay relative (the
    // gallery resolves them, and relative is the normal stored form).
    const img = {
      badge: absolute(storage, await upload(storage, IMAGES.badge)),
      igTitle: absolute(storage, await upload(storage, IMAGES.igTitle)),
      ig: [],
      pay: [],
    };
    for (const f of IMAGES.ig) img.ig.push(await upload(storage, f));
    for (const [alt, f] of IMAGES.pay) img.pay.push([alt, absolute(storage, await upload(storage, f))]);
    console.log('Uploaded:', JSON.stringify(img));

    await prisma.$transaction(
      async (tx) => {
        const fv = await replaceSections(tx, footer, footerSections(img, logoUrl), footerLocales);
        const cv = await replaceSections(tx, contact, contactSections(igContact), contactLocales);
        console.log(`Published FOOTER version ${fv}, ${CONTACT_SLUG} version ${cv}`);
      },
      { timeout: 30000 },
    );

    await revalidate(store.slug);
    console.log('Done.');
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();

/**
 * One-off content fix (M88): make Namez's FOOTER and /kontakta-oss editable
 * in the builder. M86/M87 wrote much of their content as "Custom HTML" blocks,
 * which show as code in the builder. This rewrites them with the Columns
 * section's regular blocks (needs web + dashboard with the new block types):
 *
 * - heading blocks (H1 page title, theme headings, "label" style for the
 *   footer column titles, optional link);
 * - text blocks edited with the rich-text editor (tone "muted" in the footer);
 * - image blocks (logo with link and width, 30-day badge);
 * - an "images" row for the 5 payment logos (trimmed copies, see below);
 * - a "social" block for Instagram / Facebook / TikTok.
 *
 * Payment logos: each SVG is a 58×40 card inside a square 0 -9 58 58 viewBox,
 * so the brand mark looked tiny. Trimmed copies (viewBox 0 0 58 40) are
 * uploaded and used instead.
 *
 * Layout settings and the other sections are unchanged. Edits the sections in
 * place, publishes one new version per page (the M87 versions stay in
 * Versions), JSON backup first, refuses to run twice.
 *
 *   node scripts/ops/namez-footer-contact-editable.js            (dry run)
 *   node scripts/ops/namez-footer-contact-editable.js --apply    (upload + write + publish)
 *
 * Run from the API directory (built dist/ is used for the storage adapter)
 * with the production environment loaded. No secret is printed.
 */
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { PrismaClient } = require('@prisma/client');

const STORE_SLUG = 'namez-se';
const CONTACT_SLUG = 'kontakta-oss';
const PREV_LABEL = 'M87 theme typography';
const VERSION_LABEL = 'M88 editable blocks';
const APPLY = process.argv.includes('--apply');

const IG_CONTACT = 'https://www.instagram.com/3dnamez.se/';
const IG_BRAND = 'https://www.instagram.com/namez.se/';
const PAY_NAMES = ['Apple Pay', 'Google Pay', 'Visa', 'Mastercard', 'Klarna'];

const prisma = new PrismaClient();

// ── New content ─────────────────────────────────────────────────

const heading = (text, level, extra = {}) => ({ type: 'heading', text, level, align: 'left', ...extra });
const text = (html, extra = {}) => ({ type: 'text', html, align: 'left', ...extra });
const cell = (blocks, extra = {}) => ({ col_span: 1, align: 'stretch', blocks, ...extra });

function footerBadgeCells(badgeUrl) {
  return [
    cell(
      [{ type: 'image', image: badgeUrl, alt: 'Öppet köp 30 dagar', aspect: 'auto', rounded: false, width_px: 125 }],
      { align: 'center' },
    ),
  ];
}

const footerInstaCells = () => [
  cell([heading('Följ oss på Instagram', 'h2', { align: 'center', link: IG_BRAND })]),
];

function footerMainCells(logoUrl, paymentUrls) {
  return [
    cell(
      [
        { type: 'image', image: logoUrl, alt: 'namez', aspect: 'auto', rounded: false, width_px: 200, link: '/' },
        text(
          '<p>3D NameZ – Din destination för unika, personligt anpassade 3D-presenter. Vi erbjuder högkvalitativa, ' +
            'skräddarsydda 3D-modeller för alla tillfällen. Tillverkade i Sverige, skapa minnesvärda gåvor som varar livet ut.</p>' +
            '<p>namez AB<br>Org.nr: 5592951007</p>',
          { tone: 'muted' },
        ),
        {
          type: 'images',
          align: 'left',
          item_height_px: 40,
          images: paymentUrls.map(([alt, image]) => ({ image, alt, link: '' })),
        },
      ],
      { col_span: 2 },
    ),
    cell([
      heading('Snabblänkar', 'h3', { heading_style: 'label' }),
      text(
        '<p><a href="/om-namez">Om oss</a></p>' +
          '<p><a href="/nojd-kundgaranti">Nöjd-kundgaranti</a></p>' +
          '<p><a href="/kontakta-oss">Kundtjänst och kontakt</a></p>' +
          '<p><a href="/shipping-policy">Frakt &amp; leverans</a></p>' +
          '<p><a href="/om-cookies">Cookies</a></p>',
        { tone: 'muted' },
      ),
    ]),
    cell([
      heading('Kundservice', 'h3', { heading_style: 'label' }),
      text(
        '<p><strong>Måndag - Fredag:</strong> 9:30 - 17:00<br><strong>Lördag - Söndag:</strong> 9:30 - 13:00</p>' +
          '<p><strong>Telefon:</strong> <a href="tel:0243333243">0243-33 32 43</a></p>' +
          '<p><strong>Email:</strong> <a href="mailto:info@namez.se">info@namez.se</a></p>' +
          '<p><strong>Besök oss:</strong><br>Hagavägen 36<br>784 40 Borlänge<br>Dalarna, Sverige</p>',
        { tone: 'muted' },
      ),
      {
        type: 'social',
        align: 'left',
        tone: 'muted',
        icon_size_px: 20,
        icon_color: 'theme',
        socials: [
          { platform: 'instagram', url: IG_BRAND },
          { platform: 'facebook', url: 'https://www.facebook.com/namez.se/' },
          { platform: 'tiktok', url: 'https://www.tiktok.com/@namez.se' },
        ],
      },
    ]),
  ];
}

const contactColumnsCells = () => [
  cell([
    heading('Kontakta oss', 'h1'),
    text(
      '<p><strong>Hur kan vi hjälpa dig?</strong></p>' +
        '<p>Har du frågor eller behöver hjälp med din beställning? Tveka inte att kontakta vårt team! ' +
        'Vi finns här för att hjälpa dig skapa den perfekta personliga gåvan.</p>' +
        '<p><em>Varma hälsningar</em></p>',
    ),
  ]),
  cell([
    text(
      '<p>namez AB<br>Org.nr: 559295-1007</p>' +
        '<p><strong>Adress:</strong><br>Hagavägen 36<br>784 40 Borlänge<br>Dalarna, Sverige</p>' +
        '<p><strong>Öppettider:</strong><br>Måndag – Fredag: 9:30 – 17:00</p>' +
        '<p><strong>Telefon:</strong> <a href="tel:0243333243">0243-33 32 43</a><br>' +
        '<strong>E-post:</strong> <a href="mailto:info@namez.se">info@namez.se</a></p>',
    ),
  ]),
];

const contactInstaCells = () => [
  cell([heading('Följ oss på Instagram', 'h2', { align: 'center', link: IG_CONTACT })]),
];

// ── Helpers ─────────────────────────────────────────────────────

const pageInclude = {
  translations: true,
  sections: { include: { translations: true }, orderBy: { sort_order: 'asc' } },
};
const KEEP_KEYS = new Set(['mobile-bottom-nav', 'embed-code']);

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

function current(page, expected, name) {
  const list = page.sections.filter((s) => !s.is_hidden && !KEEP_KEYS.has(s.section_key));
  const keys = list.map((s) => s.section_key);
  console.log(`${name}: visible ${keys.join(', ')}`);
  if (keys.join() !== expected.join()) throw new Error(`${name} changed since M87; stopping.`);
  return list;
}

/** [alt, src] of every <img src alt> in a section's (JSON-escaped) content. */
function images(section) {
  const json = JSON.stringify(section.translations[0]?.content || {});
  return [...json.matchAll(/<img src=\\"([^"\\]+)\\" alt=\\"([^"\\]*)\\"/g)].map((m) => [m[2], m[1]]);
}

/** The svgrepo card SVG trimmed to its 58×40 card (no empty square bands). */
function trimCard(svgText, name) {
  const from = /width="800px" height="800px" viewBox="0 -9 58 58"/;
  if (!from.test(svgText)) throw new Error(`${name}: unexpected SVG header, not trimming.`);
  return svgText.replace(from, 'width="58" height="40" viewBox="0 0 58 40"');
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

async function updateCells(tx, section, cells) {
  await tx.pageSectionTranslation.updateMany({ where: { section_id: section.id }, data: { content: { cells } } });
}

async function publish(tx, pageId) {
  const fresh = await tx.page.findUniqueOrThrow({ where: { id: pageId }, include: pageInclude });
  const version = await tx.pageVersion.create({
    data: { page_id: pageId, label: VERSION_LABEL, snapshot: buildSnapshot(fresh), published_at: new Date() },
  });
  await tx.page.update({ where: { id: pageId }, data: { status: 'PUBLISHED', published_version_id: version.id } });
  return version.id;
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
    const store = await prisma.store.findUnique({ where: { slug: STORE_SLUG }, select: { id: true, slug: true } });
    if (!store) throw new Error(`Store ${STORE_SLUG} not found`);
    const footer = await prisma.page.findFirst({ where: { store_id: store.id, type: 'FOOTER' }, include: pageInclude });
    const contact = await prisma.page.findFirst({
      where: { store_id: store.id, slug: CONTACT_SLUG, type: { in: ['STATIC', 'LANDING'] } },
      include: pageInclude,
    });
    if (!footer || !contact) throw new Error('FOOTER or kontakta-oss page not found');

    for (const p of [footer, contact]) {
      const labels = (
        await prisma.pageVersion.findMany({
          where: { page_id: p.id, label: { in: [PREV_LABEL, VERSION_LABEL] } },
          select: { label: true },
        })
      ).map((l) => l.label);
      if (labels.includes(VERSION_LABEL)) throw new Error('Already applied; nothing to do.');
      if (!labels.includes(PREV_LABEL)) throw new Error('M87 not applied on this page; stopping.');
    }

    const [, badgeRow, igTitle, , mainRow] = current(
      footer,
      ['trust-badges', 'layout-columns', 'layout-columns', 'gallery-slider', 'layout-columns', 'copyright-bar'],
      'FOOTER',
    );
    const [contactCols, , contactInsta] = current(
      contact,
      ['layout-columns', 'map', 'layout-columns', 'gallery-slider'],
      CONTACT_SLUG,
    );

    const badge = images(badgeRow).find(([alt]) => alt === 'Öppet köp 30 dagar');
    const mainImgs = images(mainRow);
    const logo = mainImgs.find(([alt]) => alt === 'namez');
    const payments = PAY_NAMES.map((n) => mainImgs.find(([alt]) => alt === n)).filter(Boolean);
    if (!badge || !logo || payments.length !== 5) throw new Error('Badge, logo or the 5 payment images not found.');
    console.log(`Badge ${badge[1]}\nLogo ${logo[1]}`);

    // Fetch and trim the payment SVGs now, so a dry run proves it works.
    const trimmed = [];
    for (const [alt, url] of payments) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${alt}: HTTP ${res.status} for ${url}`);
      trimmed.push([alt, trimCard(await res.text(), alt)]);
    }
    console.log(`Payments fetched and trimmed: ${trimmed.map(([a]) => a).join(', ')}`);
    console.log('Will rewrite as builder blocks: FOOTER badge row, Instagram title, main row; kontakta-oss columns + Instagram heading.');

    if (!APPLY) {
      // Build every plan once so a dry run validates them too.
      footerBadgeCells(badge[1]);
      footerMainCells(logo[1], payments);
      contactColumnsCells();
      console.log('Dry run. Re-run with --apply to upload, write and publish.');
      return;
    }

    const backupFile = path.resolve(`footer-kontakta-m88-backup-${new Date().toISOString().replace(/[:.]/g, '')}.json`);
    fs.writeFileSync(backupFile, JSON.stringify({ footer, contact }, null, 2));
    console.log(`Backup written: ${backupFile}`);

    const storage = loadStorage();
    const paymentUrls = [];
    for (const [alt, svg] of trimmed) {
      const res = await storage.put('pages', `${randomUUID()}.svg`, Buffer.from(svg, 'utf8'));
      paymentUrls.push([alt, res.url]);
    }
    console.log('Uploaded trimmed payments:', JSON.stringify(paymentUrls));

    await prisma.$transaction(
      async (tx) => {
        await updateCells(tx, badgeRow, footerBadgeCells(badge[1]));
        await updateCells(tx, igTitle, footerInstaCells());
        await updateCells(tx, mainRow, footerMainCells(logo[1], paymentUrls));
        await updateCells(tx, contactCols, contactColumnsCells());
        await updateCells(tx, contactInsta, contactInstaCells());
        const fv = await publish(tx, footer.id);
        const cv = await publish(tx, contact.id);
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

/**
 * One-off content fix (M87, Alaa's review of M86): keep the old WordPress
 * layout of Namez's FOOTER and /kontakta-oss, but use the store's own theme
 * typography everywhere (no fixed px sizes, uppercase or letter-spacing
 * copied from WordPress), make the payment logos clearly visible, and render
 * the 4-point USP row with the theme's own "trust-badges" section, styled
 * like the one on the home page.
 *
 * Edits the M86 sections in place (same ids), then publishes one new version
 * per page; the M86 versions stay in the builder's Versions list. A JSON
 * backup of both pages is written first. Refuses to run twice.
 *
 *   node scripts/ops/namez-footer-contact-theme-type.js            (dry run)
 *   node scripts/ops/namez-footer-contact-theme-type.js --apply    (write + publish)
 *
 * Run from the API directory with the production environment loaded.
 * No secret is printed.
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const STORE_SLUG = 'namez-se';
const CONTACT_SLUG = 'kontakta-oss';
const PREV_LABEL = 'M86 match old WordPress';
const VERSION_LABEL = 'M87 theme typography';
const APPLY = process.argv.includes('--apply');

const IG_CONTACT = 'https://www.instagram.com/3dnamez.se/';
const IG_BRAND = 'https://www.instagram.com/namez.se/';
const FB_BRAND = 'https://www.facebook.com/namez.se/';
const TT_BRAND = 'https://www.tiktok.com/@namez.se';

const prisma = new PrismaClient();

// Theme-token styles. Class names are the ones the storefront's own footer
// (chrome/FooterColumns.tsx) uses, so the compiled CSS already has them.
const TEXT = 'color:var(--theme-colors-text)';
const MUTED = 'color:var(--theme-colors-muted)';
const COL_HEAD = `<h3 class="text-sm font-semibold uppercase tracking-wider" style="${TEXT};margin:0">`;
const H1_STYLE =
  'margin:0;font-family:var(--theme-font-heading);font-size:var(--theme-scale-h3);' +
  'font-weight:var(--theme-weight-heading);line-height:var(--theme-line-heading);color:var(--theme-colors-text)';
const H2_STYLE =
  'margin:0;text-align:center;font-family:var(--theme-font-heading);font-size:var(--theme-scale-h4);' +
  'font-weight:var(--theme-weight-heading);line-height:var(--theme-line-heading)';

const svg = (inner) =>
  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:inline-block">${inner}</svg>`;
const SOCIAL = {
  instagram:
    '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".6"/>',
  facebook: '<path d="M14 8h3V4h-3a4 4 0 0 0-4 4v3H7v4h3v7h4v-7h3l1-4h-4V8Z"/>',
  tiktok: '<path d="M14 3v11.5a3.5 3.5 0 1 1-3.5-3.5"/><path d="M14 3c.4 2.6 2.3 4.5 5 4.8"/>',
};

// ── New content ─────────────────────────────────────────────────

function trustBadges(homeSettings, oldStyle) {
  const { _style: _ignored, ...look } = homeSettings || {};
  return {
    section_key: 'trust-badges',
    settings: { layout: 'cards', padding: 'comfortable', ...look, _style: oldStyle },
    content: {
      items: [
        { icon: 'truck', label: 'Snabb leverans', description: 'Leverans inom 3–5 arbetsdagar i Sverige' },
        {
          icon: 'refresh',
          label: '30 dagars öppet köp',
          description:
            'Handla tryggt – om du inte är nöjd kan du returnera inom 30 dagar. Vi ersätter även produkten utan kostnad om den skadas under frakten.',
        },
        { icon: 'card', label: 'Säker utcheckning', description: 'Betala tryggt med Klarna och andra säkra betalmetoder.' },
        { icon: 'headphones', label: 'Kundtjänst', description: 'Vänlig och snabb support redo att hjälpa dig.' },
      ],
    },
  };
}

function footerMainCells(logoUrl, payments) {
  const payBox = ([alt, src]) =>
    `<span style="display:inline-flex;align-items:center;justify-content:center;width:64px;height:42px;padding:3px;` +
    `border:1px solid var(--theme-colors-border);border-radius:var(--theme-radius-sm);background:#fff">` +
    `<img src="${src}" alt="${alt}" width="58" height="36" loading="lazy" style="width:100%;height:100%;object-fit:contain"></span>`;
  const link = (href, text) =>
    `<li><a href="${href}" class="text-sm hover:opacity-70 transition-opacity" style="${MUTED};text-decoration:none">${text}</a></li>`;
  const social = (icon, href, label) =>
    `<a href="${href}" target="_blank" rel="noopener noreferrer" aria-label="${label}" ` +
    `class="hover:opacity-70 transition-opacity" style="display:inline-flex;${MUTED}">${svg(SOCIAL[icon])}</a>`;
  const block = (raw_html) => ({ type: 'html', raw_html, align: 'start' });

  return [
    {
      col_span: 2,
      align: 'stretch',
      blocks: [
        block(
          `<div class="space-y-3"><a href="/" aria-label="namez" style="display:inline-block">` +
            `<img src="${logoUrl}" alt="namez" width="200" loading="lazy" style="display:block;width:200px;height:auto"></a>` +
            `<p class="text-sm" style="${MUTED};margin:0">3D NameZ – Din destination för unika, personligt anpassade 3D-presenter. ` +
            'Vi erbjuder högkvalitativa, skräddarsydda 3D-modeller för alla tillfällen. Tillverkade i Sverige, ' +
            'skapa minnesvärda gåvor som varar livet ut.</p>' +
            `<p class="text-sm" style="${MUTED};margin:0">namez AB<br>Org.nr: 5592951007</p>` +
            `<div style="display:flex;flex-wrap:wrap;gap:8px;padding-top:4px;justify-content:center">${payments.map(payBox).join('')}</div></div>`,
        ),
      ],
    },
    {
      col_span: 1,
      align: 'stretch',
      blocks: [
        block(
          `<div class="space-y-3">${COL_HEAD}Snabblänkar</h3><ul class="space-y-2" style="list-style:none;margin:0;padding:0">` +
            link('/om-namez', 'Om oss') +
            link('/nojd-kundgaranti', 'Nöjd-kundgaranti') +
            link('/kontakta-oss', 'Kundtjänst och kontakt') +
            link('/shipping-policy', 'Frakt &amp; leverans') +
            link('/om-cookies', 'Cookies') +
            '</ul></div>',
        ),
      ],
    },
    {
      col_span: 1,
      align: 'stretch',
      blocks: [
        block(
          `<div class="space-y-3">${COL_HEAD}Kundservice</h3>` +
            `<p class="text-sm" style="${MUTED};margin:0"><strong style="${TEXT}">Måndag - Fredag:</strong> 9:30 - 17:00<br>` +
            `<strong style="${TEXT}">Lördag - Söndag:</strong> 9:30 - 13:00</p>` +
            `<p class="text-sm" style="${MUTED};margin:0"><strong style="${TEXT}">Telefon:</strong> ` +
            `<a href="tel:0243333243" class="hover:opacity-70 transition-opacity" style="${MUTED};text-decoration:none">0243-33 32 43</a></p>` +
            `<p class="text-sm" style="${MUTED};margin:0"><strong style="${TEXT}">Email:</strong> ` +
            `<a href="mailto:info@namez.se" class="hover:opacity-70 transition-opacity" style="${MUTED};text-decoration:none">info@namez.se</a></p>` +
            `<p class="text-sm" style="${MUTED};margin:0"><strong style="${TEXT}">Besök oss:</strong><br>Hagavägen 36<br>784 40 Borlänge<br>Dalarna, Sverige</p>` +
            `<div style="display:flex;gap:14px">` +
            social('instagram', IG_BRAND, 'Instagram') +
            social('facebook', FB_BRAND, 'Facebook') +
            social('tiktok', TT_BRAND, 'TikTok') +
            '</div></div>',
        ),
      ],
    },
  ];
}

function contactColumnsCells() {
  return [
    {
      col_span: 1,
      align: 'stretch',
      blocks: [
        { type: 'html', raw_html: `<h1 style="${H1_STYLE}">Kontakta oss</h1>`, align: 'start' },
        {
          type: 'text',
          align: 'start',
          html:
            '<p><strong>Hur kan vi hjälpa dig?</strong></p>' +
            '<p>Har du frågor eller behöver hjälp med din beställning? Tveka inte att kontakta vårt team! ' +
            'Vi finns här för att hjälpa dig skapa den perfekta personliga gåvan.</p>' +
            '<p><em>Varma hälsningar</em></p>',
        },
      ],
    },
    {
      col_span: 1,
      align: 'stretch',
      blocks: [
        {
          type: 'text',
          align: 'start',
          html:
            '<p>namez AB<br>Org.nr: 559295-1007<br><br><strong>Adress:</strong><br>' +
            'Hagavägen 36<br>784 40 Borlänge<br>Dalarna, Sverige</p>',
        },
        { type: 'text', align: 'start', html: '<p><strong>Öppettider:</strong></p><p>Måndag – Fredag: 9:30 – 17:00</p>' },
        {
          type: 'text',
          align: 'start',
          html:
            '<p><strong>Telefon</strong>: 0243-33 32 43<br>' +
            '<strong>E-post:</strong> <a href="mailto:info@namez.se">info@namez.se</a></p>',
        },
      ],
    },
  ];
}

// Footer "Följ oss på Instagram": theme heading text instead of the
// WordPress title image (its lettering was the old site's font).
const footerInstaCells = () => [
  {
    col_span: 1,
    align: 'stretch',
    blocks: [
      {
        type: 'html',
        align: 'center',
        raw_html:
          `<h2 style="${H2_STYLE}"><a href="${IG_BRAND}" target="_blank" rel="noopener noreferrer" ` +
          'style="color:var(--theme-colors-text);text-decoration:none">Följ oss på Instagram</a></h2>',
      },
    ],
  },
];

const contactInstaCells = () => [
  {
    col_span: 1,
    align: 'stretch',
    blocks: [
      {
        type: 'html',
        align: 'center',
        raw_html:
          `<h2 style="${H2_STYLE}"><a href="${IG_CONTACT}" target="_blank" rel="noopener noreferrer" ` +
          'style="color:var(--theme-colors-text);text-decoration:none">Följ oss på Instagram</a></h2>',
      },
    ],
  },
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

/** The M86 sections of a page, in order, checked against the expected keys. */
function m86Sections(page, expected, name) {
  const list = page.sections.filter((s) => !s.is_hidden && !KEEP_KEYS.has(s.section_key));
  const keys = list.map((s) => s.section_key);
  console.log(`${name}: visible ${keys.join(', ')}`);
  if (keys.join() !== expected.join()) {
    throw new Error(`${name}: expected ${expected.join(', ')} — page changed since M86, stopping.`);
  }
  return list;
}

const htmlOf = (section) => JSON.stringify(section.translations[0]?.content || {});

async function updateSection(tx, section, sectionKey, settings, content) {
  await tx.pageSection.update({
    where: { id: section.id },
    data: { section_key: sectionKey, settings },
  });
  await tx.pageSectionTranslation.updateMany({
    where: { section_id: section.id },
    data: { content },
  });
}

async function publish(tx, pageId) {
  const fresh = await tx.page.findUniqueOrThrow({ where: { id: pageId }, include: pageInclude });
  const version = await tx.pageVersion.create({
    data: { page_id: pageId, label: VERSION_LABEL, snapshot: buildSnapshot(fresh), published_at: new Date() },
  });
  await tx.page.update({
    where: { id: pageId },
    data: { status: 'PUBLISHED', published_version_id: version.id },
  });
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
    const home = await prisma.page.findFirst({
      where: { store_id: store.id, type: 'HOME' },
      include: { published_version: true },
    });
    if (!footer || !contact) throw new Error('FOOTER or kontakta-oss page not found');

    for (const p of [footer, contact]) {
      const labels = await prisma.pageVersion.findMany({
        where: { page_id: p.id, label: { in: [PREV_LABEL, VERSION_LABEL] } },
        select: { label: true },
      });
      if (labels.some((l) => l.label === VERSION_LABEL)) throw new Error('Already applied; nothing to do.');
      if (!labels.some((l) => l.label === PREV_LABEL)) throw new Error('M86 not applied on this page; stopping.');
    }

    const [usp, , igTitle, , mainRow] = m86Sections(
      footer,
      ['layout-columns', 'layout-columns', 'layout-columns', 'gallery-slider', 'layout-columns', 'copyright-bar'],
      'FOOTER',
    );
    const [contactCols, , contactInsta] = m86Sections(
      contact,
      ['layout-columns', 'map', 'layout-columns', 'gallery-slider'],
      CONTACT_SLUG,
    );

    // Reuse the M86 image URLs (already absolute media-host URLs).
    const mainHtml = htmlOf(mainRow);
    const imgs = [...mainHtml.matchAll(/<img src=\\"([^"\\]+)\\" alt=\\"([^"\\]*)\\"/g)].map((m) => [m[2], m[1]]);
    const logo = imgs.find(([alt]) => alt === 'namez');
    const payments = imgs.filter(([alt]) => ['Apple Pay', 'Google Pay', 'Visa', 'Mastercard', 'Klarna'].includes(alt));
    if (!logo || payments.length !== 5) throw new Error('Could not find the logo and 5 payment images in the M86 footer.');
    console.log(`Logo ${logo[1]}`);
    console.log(`Payments: ${payments.map(([a]) => a).join(', ')}`);

    const homeBadges = home?.published_version?.snapshot?.sections?.find((s) => s.section_key === 'trust-badges');
    console.log(
      `Home trust-badges look: ${homeBadges ? JSON.stringify({ ...homeBadges.settings, _style: undefined }) : 'none (defaults)'}`,
    );

    const plan = {
      usp: trustBadges(homeBadges?.settings, usp.settings._style),
      mainCells: footerMainCells(logo[1], payments),
      contactCells: contactColumnsCells(),
      instaCells: contactInstaCells(),
    };
    console.log('Will: FOOTER USP row → trust-badges (theme cards), Instagram title image → theme heading, main row → theme type + larger payment logos;');
    console.log(`      ${CONTACT_SLUG} columns + Instagram heading → theme type. Layout settings unchanged.`);

    if (!APPLY) {
      console.log('Dry run. Re-run with --apply to write and publish.');
      return;
    }

    const backupFile = path.resolve(`footer-kontakta-m87-backup-${new Date().toISOString().replace(/[:.]/g, '')}.json`);
    fs.writeFileSync(backupFile, JSON.stringify({ footer, contact }, null, 2));
    console.log(`Backup written: ${backupFile}`);

    await prisma.$transaction(
      async (tx) => {
        await updateSection(tx, usp, 'trust-badges', plan.usp.settings, plan.usp.content);
        await updateSection(tx, igTitle, 'layout-columns', igTitle.settings, { cells: footerInstaCells() });
        await updateSection(tx, mainRow, 'layout-columns', mainRow.settings, { cells: plan.mainCells });
        await updateSection(tx, contactCols, 'layout-columns', contactCols.settings, { cells: plan.contactCells });
        await updateSection(tx, contactInsta, 'layout-columns', contactInsta.settings, { cells: plan.instaCells });
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

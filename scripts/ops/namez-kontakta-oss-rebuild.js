/**
 * One-off content fix (M85): rebuild Namez's v2 page /kontakta-oss so it
 * matches the old WordPress page (YOOtheme layout exported 2026-11-12, see
 * "C:\Projects\servers vps\docs\namez-old-kontakta-oss-export.md").
 *
 * Old page, top to bottom:
 *   1. two halves: left = H1 "Kontakta oss" + intro text, right = company,
 *      address, weekday opening hours, phone, e-mail;
 *   2. full-width grey Google map, height 500, zoom 14, one marker;
 *   3. centered "Följ oss på Instagram" heading linking to Instagram;
 *   4. image slider (5 images, each linking to Instagram, titles hidden).
 *
 * Non-destructive: the current visible sections are only HIDDEN (they stay in
 * the builder draft and can be shown again), the new sections are added
 * after them, then the page is published through the same snapshot helpers
 * the builder uses. The previous published version stays in the page's
 * version history ("Versions" in the builder) for a one-click restore.
 *
 *   node scripts/ops/namez-kontakta-oss-rebuild.js            (dry run)
 *   node scripts/ops/namez-kontakta-oss-rebuild.js --apply    (write + publish)
 *
 * Must run from the API directory with the production environment loaded
 * (DATABASE_URL; STOREFRONT_URL + REVALIDATE_SECRET for the cache refresh).
 * No secret is ever printed.
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const STORE_SLUG = 'namez-se';
const PAGE_SLUG = 'kontakta-oss';
const INSTAGRAM = 'https://www.instagram.com/3dnamez.se/';
const VERSION_LABEL = 'M85 match old WordPress page';
const APPLY = process.argv.includes('--apply');
const META_DESCRIPTION =
  'Kontakta namez AB i Borlänge: frågor om din beställning eller personliga gåvor. ' +
  'Telefon 0243-33 32 43, e-post info@namez.se. Öppet måndag–fredag 9:30–17:00.';

const prisma = new PrismaClient();

// Theme-token styled headings so they follow the store's fonts and colors.
const H1_STYLE =
  'margin:0;font-family:var(--theme-font-heading);font-size:var(--theme-scale-h3);' +
  'font-weight:var(--theme-weight-heading);line-height:var(--theme-line-heading);' +
  'color:var(--theme-colors-text)';
const INSTA_STYLE =
  'margin:0;text-align:center;font-family:var(--theme-font-heading);' +
  'font-size:var(--theme-scale-h4);font-weight:var(--theme-weight-heading);' +
  'line-height:var(--theme-line-heading)';

const INTRO_HTML =
  '<p><strong>Hur kan vi hjälpa dig?</strong></p>' +
  '<p>Har du frågor eller behöver hjälp med din beställning? Tveka inte att kontakta vårt team! ' +
  'Vi finns här för att hjälpa dig skapa den perfekta personliga gåvan.</p>' +
  '<p><em>Varma hälsningar</em></p>';

const COMPANY_HTML =
  '<p>namez AB<br>Org.nr: 559295-1007<br><br><strong>Adress:</strong><br>' +
  'Hagavägen 36<br>784 40 Borlänge<br>Dalarna, Sverige</p>';
const HOURS_HTML = '<p><strong>Öppettider:</strong></p><p>Måndag – Fredag: 9:30 – 17:00</p>';
const CONTACT_HTML =
  '<p><strong>Telefon</strong>: 0243-33 32 43<br>' +
  '<strong>E-post:</strong> <a href="mailto:info@namez.se">info@namez.se</a></p>';

function newSections(images) {
  return [
    {
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
      },
      content: {
        cells: [
          {
            col_span: 1,
            align: 'stretch',
            blocks: [
              { type: 'html', raw_html: `<h1 style="${H1_STYLE}">Kontakta oss</h1>`, align: 'start' },
              { type: 'text', html: INTRO_HTML, align: 'start' },
            ],
          },
          {
            col_span: 1,
            align: 'stretch',
            blocks: [
              { type: 'text', html: COMPANY_HTML, align: 'start' },
              { type: 'text', html: HOURS_HTML, align: 'start' },
              { type: 'text', html: CONTACT_HTML, align: 'start' },
            ],
          },
        ],
      },
    },
    {
      section_key: 'map',
      settings: {
        layout: 'full',
        map_style: 'grayscale',
        card_style: 'solid',
        zoom: 14,
        height: 500,
        rounded: false,
        show_directions: false,
      },
      // Name + coordinates only: the full layout then shows just the map,
      // as the old page did (the address lived in the marker popup).
      content: {
        locations: [{ name: '3D NameZ', lat: '60.4863298', lng: '15.4292531' }],
      },
    },
    {
      section_key: 'layout-columns',
      settings: {
        mode: 'grid',
        columns: 1,
        columns_tablet: 1,
        columns_mobile: 1,
        direction: 'row',
        wrap: true,
        gap_px: 0,
        align: 'stretch',
        justify: 'center',
      },
      content: {
        cells: [
          {
            col_span: 1,
            align: 'stretch',
            blocks: [
              {
                type: 'html',
                raw_html:
                  `<h2 style="${INSTA_STYLE}"><a href="${INSTAGRAM}" target="_blank" ` +
                  `rel="noopener noreferrer" style="color:var(--theme-colors-text)">Följ oss på Instagram</a></h2>`,
                align: 'center',
              },
            ],
          },
        ],
      },
    },
    {
      section_key: 'gallery-slider',
      settings: {
        slides_per_view: 5,
        slides_per_view_tablet: 4,
        slides_per_view_mobile: 3,
        gap_px: 16,
        aspect: 'square',
        show_caption: false,
        rounded: false,
        autoplay_ms: 0,
        show_arrows: true,
        show_dots: true,
        loop: false,
      },
      content: {
        items: images.map((url, i) => ({
          url,
          alt: `namez på Instagram ${i + 1}`,
          caption: '',
          href: INSTAGRAM,
        })),
      },
    },
  ];
}

/** Image URLs of the old Instagram slider, in order, from the imported rich text. */
function sliderImages(sections) {
  for (const s of sections) {
    if (s.section_key !== 'rich-text') continue;
    for (const t of s.translations) {
      const html = JSON.stringify(t.content || {});
      // `src=` not preceded by `-` / a word char, so `data-src=` is skipped.
      const found = [...html.matchAll(/<img[^>]*?(?<![-\w])src=\\?"([^"\\]+)\\?"/g)]
        .map((m) => m[1])
        .filter((u) => !u.startsWith('data:'));
      if (found.length === 5) return found;
    }
  }
  return null;
}

// Same snapshot shape as buildPublishSnapshot in pages-v2.service.ts.
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

async function loadPage(storeId) {
  return prisma.page.findFirst({
    where: { store_id: storeId, slug: PAGE_SLUG, type: { in: ['STATIC', 'LANDING'] } },
    include: {
      translations: true,
      sections: { include: { translations: true }, orderBy: { sort_order: 'asc' } },
    },
  });
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

(async () => {
  try {
    const store = await prisma.store.findUnique({
      where: { slug: STORE_SLUG },
      select: { id: true, slug: true },
    });
    if (!store) throw new Error(`Store ${STORE_SLUG} not found`);
    const lang = await prisma.storeLanguageConfig.findFirst({
      where: { store_id: store.id },
      select: { primary_locale: true },
    });
    const primary = lang?.primary_locale || 'en';

    const page = await loadPage(store.id);
    if (!page) throw new Error(`Page ${PAGE_SLUG} not found`);

    console.log(`Store ${store.slug}, page ${page.id} (${page.type}, ${page.status}), primary locale ${primary}`);
    console.log('Current sections:');
    for (const s of page.sections) {
      console.log(
        `  #${s.sort_order} ${s.section_key}${s.is_hidden ? ' (hidden)' : ''}` +
          ` locales=[${s.translations.map((t) => t.locale).join(',')}] id=${s.id}`,
      );
    }

    const done = await prisma.pageVersion.findFirst({
      where: { page_id: page.id, label: VERSION_LABEL },
      select: { id: true },
    });
    if (done) throw new Error('Page already rebuilt by this script; nothing to do.');

    const images = sliderImages(page.sections);
    if (!images) throw new Error('Could not find the 5 slider images in the imported rich text.');
    console.log('Slider images:', images.join(' '));

    const visible = page.sections.filter((s) => !s.is_hidden);
    // Locales the page content exists in today; the new content is Swedish
    // in every one of them, as the imported page was.
    const locales = new Set([primary]);
    for (const s of visible) for (const t of s.translations) locales.add(t.locale);
    const maxSort = page.sections.reduce((m, s) => Math.max(m, s.sort_order), 0);
    const plan = newSections(images);

    console.log(`Will hide ${visible.length} section(s): ${visible.map((s) => s.section_key).join(', ')}`);
    console.log(`Will add ${plan.length} section(s) for locales [${[...locales].join(',')}]: ${plan.map((s) => s.section_key).join(', ')}`);

    if (!APPLY) {
      console.log('Dry run. Re-run with --apply to write and publish.');
      return;
    }

    // Backup of the current rows next to the script output.
    const backupFile = path.resolve(`kontakta-oss-backup-${new Date().toISOString().replace(/[:.]/g, '')}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(page, null, 2));
    console.log(`Backup written: ${backupFile}`);

    await prisma.$transaction(async (tx) => {
      await tx.pageSection.updateMany({
        where: { id: { in: visible.map((s) => s.id) } },
        data: { is_hidden: true },
      });
      let sort = maxSort;
      for (const s of plan) {
        sort += 1;
        await tx.pageSection.create({
          data: {
            page_id: page.id,
            section_key: s.section_key,
            settings: s.settings,
            sort_order: sort,
            translations: {
              create: [...locales].map((locale) => ({ locale, content: s.content })),
            },
          },
        });
      }
      // The new sections keep their text in nested fields, which the automatic
      // page description does not read: fill empty meta descriptions.
      await tx.pageTranslation.updateMany({
        where: { page_id: page.id, OR: [{ meta_description: null }, { meta_description: '' }] },
        data: { meta_description: META_DESCRIPTION },
      });
      const fresh = await tx.page.findUniqueOrThrow({
        where: { id: page.id },
        include: { translations: true, sections: { include: { translations: true } } },
      });
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
      console.log(`Published version ${version.id}`);
    }, { timeout: 30000 });

    await revalidate(store.slug);
    console.log('Done.');
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();

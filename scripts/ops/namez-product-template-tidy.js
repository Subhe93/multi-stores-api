/**
 * One-off layout fix (Namez, 2026-11): tidy the blocks product template of
 * store `namez-se` (its PRODUCT_TEMPLATE v2 page, converted to blocks).
 *
 * README
 * ------
 * Run on the server from the API directory, after a build (dist/ provides the
 * publish helpers), with the production environment loaded:
 *
 *   cd <api dir>; set -a; . ./.env; set +a
 *   node scripts/ops/namez-product-template-tidy.js                      (dry run)
 *   node scripts/ops/namez-product-template-tidy.js --apply              (write + publish)
 *
 * Options:
 *   --backup-dir=<dir>         where the JSON backup goes (default
 *                              $MS_OPS_BACKUP_DIR, else /var/lib/multistores/backups,
 *                              writable by the API user `multistores`; created if
 *                              missing). The dry run already stops when it cannot
 *                              be written (scripts/ops/backup-dir.js).
 *   --publish-draft-changes    allow --apply when the working draft already
 *                              differs from the published version (those
 *                              unpublished builder edits go live as well)
 *
 * The script never prints DATABASE_URL, STOREFRONT_URL or REVALIDATE_SECRET.
 * Rollback: restore the previous published version from the builder's
 * "Versions" list (the backup file holds the rows as they were).
 *
 * What it changes
 * ---------------
 * Published root order today: product-breadcrumb, layout-row, rich-text,
 * embed-code, product-tabs, product-slider.
 *
 *   1. The root `product-tabs` section moves to directly after the root
 *      `layout-row`. Every root section (hidden ones included) is renumbered
 *      0..n in the canonical read order (SECTION_READ_ORDER: sort_order,
 *      created_at, id; src/modules/pages-v2/page-snapshot.ts).
 *   2. Inside the info column (the second visible `layout-column` child of
 *      the row, the one holding product-title / product-price / ...), a
 *      `spacer` with settings equal to CLASSIC_DIVIDER_SETTINGS
 *      (src/modules/pages-v2/product-blocks-convert.ts) is added directly
 *      after `product-bundles` and one directly before `product-buy`. A
 *      spacer is skipped when the neighbouring visible section at that spot
 *      already is such a divider (idempotent). The column's children are
 *      renumbered 0..n.
 *   3. All writes run in one transaction, then the page is published with the
 *      API's own buildPublishSnapshot + publishPageTx (dist/) under the label
 *      below, and the storefront cache is refreshed.
 *
 * Guards: a page that already has a version with this label is left alone;
 * --apply refuses when the draft differs from the published version (unless
 * --publish-draft-changes); the plan is re-computed inside the transaction
 * and the run aborts if the rows changed since the dry-run part.
 */
const fs = require('fs');
const path = require('path');
const { resolveBackupDir, checkBackupDir } = require('./backup-dir');

const STORE_SLUG = 'namez-se';
const VERSION_LABEL = 'Namez product template tidy 2026-11 (tabs under row, dividers)';
const EXPECTED_ROOTS_BEFORE = [
  'product-breadcrumb',
  'layout-row',
  'rich-text',
  'embed-code',
  'product-tabs',
  'product-slider',
];

// ── Arguments ───────────────────────────────────────────────────

function parseArgs(argv, env = process.env) {
  return {
    apply: argv.includes('--apply'),
    publishDraftChanges: argv.includes('--publish-draft-changes'),
    backupDir: resolveBackupDir({ argv, env }),
  };
}

// ── API modules from dist/ ──────────────────────────────────────

/** buildPublishSnapshot / publishPageTx / SECTION_READ_ORDER / CLASSIC_DIVIDER_SETTINGS from the build. */
function loadApiModules(apiDir = process.cwd()) {
  for (const base of ['dist/src/modules/pages-v2', 'dist/modules/pages-v2']) {
    const dir = path.resolve(apiDir, base);
    if (!fs.existsSync(path.join(dir, 'pages-v2.service.js'))) continue;
    const service = require(path.join(dir, 'pages-v2.service.js'));
    const snapshot = require(path.join(dir, 'page-snapshot.js'));
    const convert = require(path.join(dir, 'product-blocks-convert.js'));
    const mods = {
      buildPublishSnapshot: service.buildPublishSnapshot,
      publishPageTx: service.publishPageTx,
      SECTION_READ_ORDER: snapshot.SECTION_READ_ORDER,
      CLASSIC_DIVIDER_SETTINGS: convert.CLASSIC_DIVIDER_SETTINGS,
    };
    const missing = Object.entries(mods)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length) throw new Error(`dist/ is missing ${missing.join(', ')}: rebuild the API.`);
    return mods;
  }
  throw new Error('API build (dist/) not found: run from the API directory after a build.');
}

// ── Helpers ─────────────────────────────────────────────────────

/** JSON with object keys sorted at every level (jsonb does not keep key order). */
function stableStringify(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

const byLocale = (a, b) => (a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0);

/**
 * Children of `parentId` in canonical read order. `sections` must come from a
 * query ordered by SECTION_READ_ORDER; filtering keeps that order, so ties on
 * sort_order resolve exactly as in the builder and the publish snapshot.
 */
function childrenOf(sections, parentId) {
  return sections.filter((s) => (s.parent_id || null) === parentId);
}

const isDivider = (s, dividerSettings) =>
  s.section_key === 'spacer' && !s.is_hidden && stableStringify(s.settings) === stableStringify(dividerSettings);

const label = (s) => `${s.section_key}${s.is_hidden ? ' (hidden)' : ''}${s.id ? ` ${s.id}` : ' (new)'}`;

function onlyOne(list, what) {
  if (list.length !== 1) throw new Error(`Expected exactly one visible ${what}, found ${list.length}.`);
  return list[0];
}

// ── Plan (pure; no database) ────────────────────────────────────

/**
 * The changes to make on the page's working draft.
 *
 * @param page     page with `sections` (each with `translations`) in
 *                 SECTION_READ_ORDER
 * @param opts     { dividerSettings, primaryLocale }
 * @returns {{ rootsBefore, rootsAfter, columnBefore, columnAfter, rootUpdates,
 *             columnUpdates, creates, columnId, warnings, changed }}
 */
function planTidy(page, { dividerSettings, primaryLocale }) {
  const sections = page.sections;
  const warnings = [];

  // 1. Roots: tabs directly after the row.
  const roots = childrenOf(sections, null);
  const visibleRootKeys = roots.filter((s) => !s.is_hidden).map((s) => s.section_key);
  if (stableStringify(visibleRootKeys) !== stableStringify(EXPECTED_ROOTS_BEFORE)) {
    warnings.push(
      `visible root order is [${visibleRootKeys.join(', ')}], not the expected [${EXPECTED_ROOTS_BEFORE.join(', ')}]`,
    );
  }
  const row = onlyOne(
    roots.filter((s) => !s.is_hidden && s.section_key === 'layout-row'),
    'root layout-row',
  );
  const tabs = onlyOne(
    roots.filter((s) => !s.is_hidden && s.section_key === 'product-tabs'),
    'root product-tabs',
  );
  const rootsAfter = roots.filter((s) => s.id !== tabs.id);
  rootsAfter.splice(rootsAfter.indexOf(row) + 1, 0, tabs);
  const rootUpdates = rootsAfter
    .map((s, i) => ({ id: s.id, section_key: s.section_key, from: s.sort_order, to: i }))
    .filter((u) => u.from !== u.to);

  // 2. Info column: the second visible layout-column of the row.
  const columns = childrenOf(sections, row.id).filter((s) => !s.is_hidden && s.section_key === 'layout-column');
  if (columns.length < 2) throw new Error(`The layout-row has ${columns.length} visible layout-column(s), expected 2.`);
  const infoCol = columns[1];
  const colChildren = childrenOf(sections, infoCol.id);
  const colKeys = new Set(colChildren.filter((s) => !s.is_hidden).map((s) => s.section_key));
  if (!colKeys.has('product-title') && !colKeys.has('product-price')) {
    throw new Error('The second layout-column holds neither product-title nor product-price: not the info column.');
  }
  const bundles = onlyOne(
    colChildren.filter((s) => !s.is_hidden && s.section_key === 'product-bundles'),
    'product-bundles in the info column',
  );
  const buy = onlyOne(
    colChildren.filter((s) => !s.is_hidden && s.section_key === 'product-buy'),
    'product-buy in the info column',
  );
  if (colChildren.indexOf(bundles) > colChildren.indexOf(buy)) {
    warnings.push('product-bundles sits below product-buy in the info column');
  }

  // Locales of the new spacers: those the column's sections already use.
  const locales = [...new Set(colChildren.flatMap((s) => (s.translations || []).map((t) => t.locale)))].sort();
  if (!locales.length) locales.push(primaryLocale || 'en');

  const columnAfter = colChildren.slice();
  const nextVisible = (from) => columnAfter.slice(from + 1).find((s) => !s.is_hidden);
  const prevVisible = (from) =>
    columnAfter
      .slice(0, from)
      .reverse()
      .find((s) => !s.is_hidden);
  const newSpacer = (ref) => ({
    ref,
    id: null,
    parent_id: infoCol.id,
    section_key: 'spacer',
    settings: { ...dividerSettings },
    is_hidden: false,
    translations: locales.map((locale) => ({ locale, content: {} })),
  });
  const skipped = [];

  // Divider directly after product-bundles.
  const bIdx = columnAfter.indexOf(bundles);
  const afterBundles = nextVisible(bIdx);
  if (afterBundles && isDivider(afterBundles, dividerSettings)) skipped.push('after product-bundles (already there)');
  else columnAfter.splice(bIdx + 1, 0, newSpacer('divider-after-bundles'));

  // Divider directly before product-buy (sees the one just planned, so two
  // dividers never end up next to each other).
  const yIdx = columnAfter.indexOf(buy);
  const beforeBuy = prevVisible(yIdx);
  if (beforeBuy && isDivider(beforeBuy, dividerSettings)) skipped.push('before product-buy (already there)');
  else columnAfter.splice(yIdx, 0, newSpacer('divider-before-buy'));

  const creates = [];
  const columnUpdates = [];
  columnAfter.forEach((s, i) => {
    if (!s.id) creates.push({ ...s, sort_order: i });
    else if (s.sort_order !== i) columnUpdates.push({ id: s.id, section_key: s.section_key, from: s.sort_order, to: i });
  });

  return {
    rowId: row.id,
    columnId: infoCol.id,
    locales,
    rootsBefore: roots,
    rootsAfter,
    columnBefore: colChildren,
    columnAfter,
    rootUpdates,
    columnUpdates,
    creates,
    skipped,
    warnings,
    changed: rootUpdates.length > 0 || columnUpdates.length > 0 || creates.length > 0,
  };
}

/** Stable fingerprint of a plan (to detect rows that changed between reads). */
function planSignature(plan) {
  return stableStringify({
    rootUpdates: plan.rootUpdates,
    columnUpdates: plan.columnUpdates,
    creates: plan.creates.map((c) => ({ ref: c.ref, sort_order: c.sort_order, locales: c.translations.map((t) => t.locale) })),
    columnId: plan.columnId,
  });
}

// ── Draft vs published ──────────────────────────────────────────

/** Snapshot reduced to what the storefront renders. */
function comparable(snapshot) {
  const page = snapshot.page || {};
  return {
    page: {
      slug: page.slug ?? null,
      seo: page.seo ?? null,
      translations: (page.translations || [])
        // eslint-disable-next-line no-unused-vars
        .map(({ id, page_id, created_at, updated_at, ...rest }) => rest)
        .sort(byLocale),
    },
    sections: new Map(
      (snapshot.sections || []).map((s) => [
        s.id,
        {
          parent_id: s.parent_id || null,
          section_key: s.section_key,
          settings: s.settings ?? null,
          sort_order: s.sort_order,
          translations: (s.translations || []).map((t) => ({ locale: t.locale, content: t.content })).sort(byLocale),
        },
      ]),
    ),
  };
}

/** Differences between the draft (as it would be published) and the published version. */
function draftDiff(page, buildPublishSnapshot) {
  const draft = comparable(buildPublishSnapshot(page));
  if (!page.published_version) return ['the page was never published: publishing makes its whole draft live'];
  const live = comparable(page.published_version.snapshot || {});
  const out = [];
  for (const key of ['slug', 'seo', 'translations']) {
    if (stableStringify(draft.page[key]) !== stableStringify(live.page[key])) out.push(`page ${key} differs`);
  }
  for (const [id, s] of draft.sections) {
    const l = live.sections.get(id);
    if (!l) {
      out.push(`section ${s.section_key} ${id} is visible in the draft but not published`);
      continue;
    }
    const changed = ['parent_id', 'section_key', 'settings', 'sort_order', 'translations'].filter(
      (k) => stableStringify(s[k]) !== stableStringify(l[k]),
    );
    if (changed.length) out.push(`section ${s.section_key} ${id}: ${changed.join(', ')} differ`);
  }
  for (const [id, l] of live.sections) {
    if (!draft.sections.has(id)) out.push(`section ${l.section_key} ${id} is published but hidden or deleted in the draft`);
  }
  return out;
}

// ── Output ──────────────────────────────────────────────────────

/** One line per section; on an AFTER list, `sort_order old -> new`. */
function printList(title, list, after = false) {
  console.log(title);
  list.forEach((s, i) => {
    let sort = `sort_order ${s.sort_order}`;
    if (!s.id) sort = `sort_order ${i}`;
    else if (after && s.sort_order !== i) sort = `sort_order ${s.sort_order} -> ${i}`;
    console.log(`    ${i}. ${label(s)} (${sort})`);
  });
}

function printPlan(plan, publishedSnapshot) {
  if (publishedSnapshot) {
    const liveRoots = (publishedSnapshot.sections || []).filter((s) => !s.parent_id).map((s) => s.section_key);
    console.log(`  Published root order: ${liveRoots.join(', ')}`);
  }
  printList('  Draft roots BEFORE (read order):', plan.rootsBefore);
  printList('  Draft roots AFTER:', plan.rootsAfter, true);
  printList(`  Info column ${plan.columnId} children BEFORE:`, plan.columnBefore);
  printList('  Info column children AFTER:', plan.columnAfter, true);
  for (const w of plan.warnings) console.log(`  WARNING: ${w}`);
  for (const s of plan.skipped) console.log(`  Divider skipped: ${s}`);
  console.log(
    `  Writes: ${plan.rootUpdates.length} root sort_order update(s), ` +
      `${plan.columnUpdates.length} column sort_order update(s), ` +
      `${plan.creates.length} new spacer(s) (locales [${plan.locales.join(',')}])`,
  );
}

// ── Database ────────────────────────────────────────────────────

function pageInclude(SECTION_READ_ORDER) {
  return {
    translations: true,
    sections: { include: { translations: true }, orderBy: SECTION_READ_ORDER },
    published_version: { select: { id: true, label: true, snapshot: true } },
  };
}

async function revalidate(slug, env) {
  const base = env.STOREFRONT_URL;
  const secret = env.REVALIDATE_SECRET;
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

/**
 * Whole run. `prisma` and `mods` are injected so the planning and the write
 * sequence can be exercised against a mock without a database.
 * Returns an exit code.
 */
async function run({ prisma, mods, argv = process.argv, env = process.env }) {
  const opts = parseArgs(argv, env);
  // Dry run included: a backup that cannot be written stops the run here.
  const backupCheck = checkBackupDir(opts.backupDir);
  if (!backupCheck.ok) {
    console.error(`ERROR: ${backupCheck.error}`);
    return 1;
  }
  if (backupCheck.warning) console.warn(`WARNING: ${backupCheck.warning}`);
  console.log(`Backup dir: ${opts.backupDir} (writable)`);
  const { buildPublishSnapshot, publishPageTx, SECTION_READ_ORDER, CLASSIC_DIVIDER_SETTINGS } = mods;
  const include = pageInclude(SECTION_READ_ORDER);

  const store = await prisma.store.findUnique({ where: { slug: STORE_SLUG }, select: { id: true, slug: true } });
  if (!store) throw new Error(`Store ${STORE_SLUG} not found`);
  const lang = await prisma.storeLanguageConfig.findFirst({
    where: { store_id: store.id },
    select: { primary_locale: true },
  });
  const primaryLocale = lang?.primary_locale || 'en';

  const page = await prisma.page.findFirst({ where: { store_id: store.id, type: 'PRODUCT_TEMPLATE' }, include });
  if (!page) throw new Error(`Store ${STORE_SLUG} has no PRODUCT_TEMPLATE page`);
  console.log(`Store ${store.slug} (${store.id}), PRODUCT_TEMPLATE page ${page.id} (${page.status})`);
  console.log(`  Published version: ${page.published_version ? `${page.published_version.id} "${page.published_version.label || ''}"` : 'none'}`);

  const done = await prisma.pageVersion.findFirst({
    where: { page_id: page.id, label: VERSION_LABEL },
    select: { id: true },
  });
  if (done) {
    console.log(`Already done by this script (version ${done.id} "${VERSION_LABEL}"). Nothing to do.`);
    return 0;
  }

  const plan = planTidy(page, { dividerSettings: CLASSIC_DIVIDER_SETTINGS, primaryLocale });
  printPlan(plan, page.published_version?.snapshot);

  const diff = draftDiff(page, buildPublishSnapshot);
  if (diff.length) {
    console.log('  WARNING: unpublished builder edits (they would be published too):');
    for (const d of diff) console.log(`    - ${d}`);
  } else {
    console.log('  Draft matches the published version.');
  }

  if (!plan.changed) {
    console.log('\nThe draft already has this layout; nothing to write.');
    return 0;
  }
  if (diff.length) {
    console.log(
      opts.publishDraftChanges
        ? '\n--publish-draft-changes: the unpublished edits above will be published together with this tidy.'
        : '\nSTOP: the template has unpublished builder edits (see WARNING above). Publish or discard them in ' +
            'the builder first, or re-run with --publish-draft-changes to publish them together.',
    );
  }
  if (!opts.apply) {
    console.log(`\nDry run. Re-run with --apply to write and publish "${VERSION_LABEL}".`);
    return 0;
  }
  if (diff.length && !opts.publishDraftChanges) return 1;

  // Backup of the affected rows (page, translations, every section with its
  // translations, the published version) before anything is written.
  const stamp = new Date().toISOString().replace(/[:.]/g, '');
  const backupFile = path.join(opts.backupDir, `namez-product-template-tidy-${stamp}.json`);
  fs.writeFileSync(backupFile, JSON.stringify({ label: VERSION_LABEL, store, page }, null, 2), { mode: 0o600 });
  console.log(`\nBackup written: ${backupFile}`);

  const signature = planSignature(plan);
  const versionId = await prisma.$transaction(
    async (tx) => {
      // Re-read and re-plan inside the transaction: abort if anything moved.
      const again = await tx.pageVersion.findFirst({ where: { page_id: page.id, label: VERSION_LABEL }, select: { id: true } });
      if (again) throw new Error('Another run published this label meanwhile; nothing written.');
      const current = await tx.page.findUniqueOrThrow({ where: { id: page.id }, include });
      const txPlan = planTidy(current, { dividerSettings: CLASSIC_DIVIDER_SETTINGS, primaryLocale });
      if (planSignature(txPlan) !== signature) {
        throw new Error('The template changed while the script ran; nothing written. Run the dry run again.');
      }

      for (const u of [...txPlan.rootUpdates, ...txPlan.columnUpdates]) {
        await tx.pageSection.update({ where: { id: u.id }, data: { sort_order: u.to } });
      }
      for (const c of txPlan.creates) {
        const created = await tx.pageSection.create({
          data: {
            page_id: page.id,
            parent_id: c.parent_id,
            section_key: c.section_key,
            settings: c.settings,
            sort_order: c.sort_order,
            translations: { create: c.translations },
          },
          select: { id: true },
        });
        console.log(`  Created spacer ${created.id} (${c.ref}) at sort_order ${c.sort_order}`);
      }

      const fresh = await tx.page.findUniqueOrThrow({
        where: { id: page.id },
        include: { translations: true, sections: { include: { translations: true }, orderBy: SECTION_READ_ORDER } },
      });
      const snapshot = buildPublishSnapshot(fresh);
      const liveRoots = snapshot.sections.filter((s) => !s.parent_id).map((s) => s.section_key);
      console.log(`  New published root order: ${liveRoots.join(', ')}`);
      const version = await publishPageTx(tx, page.id, snapshot, VERSION_LABEL);
      return version.id;
    },
    { timeout: 30000 },
  );
  console.log(`Published version ${versionId} "${VERSION_LABEL}"`);

  await revalidate(store.slug, env);
  console.log('Done. Check a product page on https://namez.se');
  return 0;
}

module.exports = { planTidy, planSignature, draftDiff, stableStringify, run, loadApiModules, VERSION_LABEL };

if (require.main === module) {
  (async () => {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient({ errorFormat: 'minimal' });
    try {
      process.exitCode = await run({ prisma, mods: loadApiModules() });
    } catch (err) {
      console.error(`ERROR: ${err.message}`);
      process.exitCode = 1;
    } finally {
      await prisma.$disconnect();
    }
  })();
}

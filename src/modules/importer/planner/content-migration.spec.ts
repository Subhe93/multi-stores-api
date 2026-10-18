/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- in-memory Prisma fake rows are untyped in tests */
import { join } from 'path';
import {
  makeHarness,
  NAMEZ_OPTIONS,
  STORE_ID,
  USER_ID,
} from '../__fixtures__/harness';
import {
  resolveContentTarget,
  SYSTEM_REDIRECTS,
} from '../mapping/map-redirects';
import { defaultRunOptions, normalizeRunOptions } from '../runs/run-options';

/**
 * M5 B17 content migration (W2-B): WP pages / posts → redirects per
 * `content_redirects`, the WordPress system paths, and `scopes.pages`
 * creating draft builder pages — through the whole importer on the
 * in-memory Prisma fake, with the bundle v1 fixture (2 pages, 1 post).
 */
const V1_DIR = join(
  __dirname,
  '..',
  'adapters',
  'wp-bundle',
  '__fixtures__',
  'wp-export-v1',
);
// Refs are built from the source host of the harness (namez.se), not the bundle.
const OM = 'woo:namez.se:page:600';
const KONTAKT = 'woo:namez.se:page:601';
const NYHETER = 'woo:namez.se:post:700';

/** System rows that are real redirects (`/cart/` → `/cart` is the same key: no row). */
const SYSTEM_ROWS = SYSTEM_REDIRECTS.filter(
  (r) => r.from.replace(/\/$/, '') !== r.to,
).length;

type Item = { entity_type: string; external_ref: string; action: string };
const keys = (items: Item[]) =>
  new Set(items.map((i) => `${i.entity_type}|${i.external_ref}|${i.action}`));
const redirectsOf = (h: any) =>
  Object.fromEntries(
    h.db.storeRedirect.rows.map((r: any) => [
      r.from_path,
      [r.to_path, r.status_code],
    ]),
  ) as Record<string, [string, number]>;

describe('run options: content_redirects and scopes.pages', () => {
  it('defaults to map mode with no targets and the pages scope off', () => {
    const o = defaultRunOptions();
    expect(o.content_redirects).toEqual({ mode: 'map', targets: {} });
    expect(o.scopes.pages).toBe(false);
    expect(normalizeRunOptions({}).options.content_redirects).toEqual({
      mode: 'map',
      targets: {},
    });
  });

  it('accepts paths and keywords, rejects everything else', () => {
    const { options, errors } = normalizeRunOptions({
      scopes: { pages: true },
      content_redirects: {
        mode: 'home',
        targets: {
          [OM]: '/about',
          [KONTAKT]: 'import',
          [NYHETER]: 'skip',
          '/shop/': '/collections/alla',
        },
      },
    });
    expect(errors).toEqual([]);
    expect(options.scopes.pages).toBe(true);
    expect(options.content_redirects).toEqual({
      mode: 'home',
      targets: {
        [OM]: '/about',
        [KONTAKT]: 'import',
        [NYHETER]: 'skip',
        '/shop/': '/collections/alla',
      },
    });
    const bad = normalizeRunOptions({
      content_redirects: {
        mode: 'all',
        targets: {
          [OM]: 'https://evil.example/x',
          [KONTAKT]: '//evil.example',
          [NYHETER]: 'about',
        },
      },
    });
    expect(bad.errors).toEqual([
      'content_redirects.mode must be one of: map, home, skip',
      `content_redirects.targets.${OM} must be a path starting with / or one of: home, skip, import`,
      `content_redirects.targets.${KONTAKT} must be a path starting with / or one of: home, skip, import`,
      `content_redirects.targets.${NYHETER} must be a path starting with / or one of: home, skip, import`,
    ]);
    expect(normalizeRunOptions({ content_redirects: 'x' }).errors).toEqual([
      'content_redirects must be an object',
    ]);
  });

  it('resolves a target: explicit, else the mode', () => {
    const t = { [OM]: '/about', [KONTAKT]: 'home', [NYHETER]: 'skip' };
    expect(resolveContentTarget(OM, { mode: 'map', targets: t })).toEqual({
      kind: 'path',
      to: '/about',
    });
    expect(resolveContentTarget(KONTAKT, { mode: 'map', targets: t })).toEqual({
      kind: 'path',
      to: '/',
    });
    expect(resolveContentTarget(NYHETER, { mode: 'map', targets: t })).toEqual({
      kind: 'skip',
    });
    expect(resolveContentTarget('x', { mode: 'map', targets: t })).toEqual({
      kind: 'unmapped',
    });
    expect(resolveContentTarget('x', { mode: 'home', targets: t })).toEqual({
      kind: 'path',
      to: '/',
    });
    expect(resolveContentTarget('x', { mode: 'skip', targets: t })).toEqual({
      kind: 'skip',
    });
    expect(
      resolveContentTarget('x', { mode: 'map', targets: { x: 'import' } }),
    ).toEqual({ kind: 'import' });
  });
});

describe('content migration through the importer (bundle v1 fixture)', () => {
  it('default run: system paths redirected, pages / posts listed as unmapped, no page rows', async () => {
    const h = await makeHarness();
    const run = await h.dryRun(NAMEZ_OPTIONS, V1_DIR);
    expect(run.status).toBe('PLANNED');
    const s = run.summary as any;
    expect(s.content).toMatchObject({
      pages: 2,
      posts: 1,
      mapped: 0,
      unmapped: 3,
      imported: 0,
    });
    expect(
      s.content.items.map((r: any) => [r.ref, r.kind, r.path, r.target]),
    ).toEqual([
      [OM, 'page', '/om-oss/', null],
      [KONTAKT, 'page', '/om-oss/kontakt/', null],
      [NYHETER, 'post', '/nyheter-varen/', null],
    ]);
    expect(s.content_unmapped.map((r: any) => r.title)).toEqual([
      'Om oss',
      'Kontakt',
      'Nyheter våren',
    ]);
    expect(s.warnings.W_CONTENT_UNMAPPED.count).toBe(3);
    expect(s.redirects.by_rule.system).toBe(SYSTEM_ROWS);
    expect(SYSTEM_ROWS).toBe(SYSTEM_REDIRECTS.length - 2);
    expect(s.redirects.by_rule.page).toBeUndefined();
    expect(s.redirects.by_rule.post).toBeUndefined();
    expect(s.counts.PAGE).toBeUndefined();

    const done = await h.apply(run.id);
    expect(['COMPLETED', 'COMPLETED_WITH_WARNINGS']).toContain(done.status);
    expect(keys(h.itemsOf(run.id, 'APPLY'))).toEqual(
      keys(h.itemsOf(run.id, 'PLAN')),
    );
    const red = redirectsOf(h);
    expect(red['/shop']).toEqual(['/products', 301]);
    // `/cart/` and `/checkout/` already are the platform paths: no self-redirect.
    expect(red['/cart']).toBeUndefined();
    expect(red['/checkout']).toBeUndefined();
    expect(red['/my-account']).toEqual(['/account', 301]);
    expect(red['/wp-login.php']).toEqual(['/account', 302]);
    expect(red['/feed']).toEqual(['/', 301]);
    expect(red['/comments/feed']).toEqual(['/', 301]);
    expect(red['/product-sitemap.xml']).toEqual(['/sitemap.xml', 301]);
    expect(red['/sitemap_index.xml']).toEqual(['/sitemap.xml', 301]);
    expect(red['/om-oss']).toBeUndefined();
    expect(red['/nyheter-varen']).toBeUndefined();
    expect(h.db.page.rows).toHaveLength(0);
  });

  it('mapped targets: paths, home, import (pages scope), skip and a system override; PLAN == APPLY; idempotent; rollback', async () => {
    const h = await makeHarness();
    const options = {
      ...NAMEZ_OPTIONS,
      scopes: { ...defaultRunOptions().scopes, pages: true },
      redirect_shortlinks: true,
      content_redirects: {
        mode: 'map',
        targets: {
          [OM]: '/collections/muggar',
          [KONTAKT]: 'import',
          [NYHETER]: 'home',
          '/shop/': 'skip',
          '/my-account/': '/konto',
        },
      },
    };
    const run = await h.dryRun(options, V1_DIR);
    expect(run.status).toBe('PLANNED');
    const s = run.summary as any;
    expect(s.content).toMatchObject({ mapped: 3, unmapped: 0, imported: 1 });
    expect(s.content_unmapped).toEqual([]);
    expect(s.warnings.W_CONTENT_UNMAPPED).toBeUndefined();
    expect(s.counts.PAGE).toEqual({ CREATE: 1 });
    expect(s.redirects.by_rule).toMatchObject({
      page: 2,
      post: 1,
      system: SYSTEM_ROWS - 1,
    });
    const plan = h.itemsOf(run.id, 'PLAN');
    expect(
      plan
        .filter((i: any) => i.entity_type === 'PAGE')
        .map((i: any) => [i.external_ref, i.action]),
    ).toEqual([[KONTAKT, 'CREATE']]);

    const done = await h.apply(run.id);
    expect(['COMPLETED', 'COMPLETED_WITH_WARNINGS']).toContain(done.status);
    expect(keys(h.itemsOf(run.id, 'APPLY'))).toEqual(keys(plan));
    const red = redirectsOf(h);
    expect(red['/om-oss']).toEqual(['/collections/muggar', 301]);
    // `import`: the page is re-created at `/<slug>` and the nested old URL points there.
    expect(red['/om-oss/kontakt']).toEqual(['/kontakt', 301]);
    expect(red['/nyheter-varen']).toEqual(['/', 301]);
    // Shortlinks of pages / posts follow the same targets.
    expect(red['/?p=600']).toEqual(['/collections/muggar', 301]);
    expect(red['/?p=601']).toEqual(['/kontakt', 301]);
    expect(red['/?p=700']).toEqual(['/', 301]);
    // System overrides: skipped and re-pointed.
    expect(red['/shop']).toBeUndefined();
    expect(red['/my-account']).toEqual(['/konto', 301]);
    expect(red['/wp-login.php']).toEqual(['/account', 302]);

    // The imported page: draft LANDING page, primary-locale title / SEO,
    // one rich-text section with the sanitized HTML, noindex from Rank Math.
    expect(h.db.page.rows).toHaveLength(1);
    const page = h.db.page.rows[0];
    expect(page).toMatchObject({
      store_id: STORE_ID,
      type: 'LANDING',
      slug: 'kontakt',
      status: 'DRAFT',
      seo: { robots: 'noindex' },
    });
    expect(h.db.pageTranslation.rows).toEqual([
      expect.objectContaining({
        page_id: page.id,
        locale: 'sv',
        title: 'Kontakt',
        meta_title: null,
        meta_description: 'Mejla oss.',
      }),
    ]);
    const section = h.db.pageSection.rows[0];
    expect(section).toMatchObject({
      page_id: page.id,
      section_key: 'rich-text',
      sort_order: 0,
    });
    expect(h.db.pageSectionTranslation.rows).toEqual([
      expect.objectContaining({
        section_id: section.id,
        locale: 'sv',
        content: { html: '<p>Mejla oss.</p>' },
      }),
    ]);
    const ledger = h.db.importEntity.rows.find(
      (e: any) => e.entity_type === 'PAGE',
    );
    expect(ledger).toMatchObject({
      external_ref: KONTAKT,
      target_id: page.id,
      status: 'ACTIVE',
      created_by_import: true,
      first_run_id: run.id,
    });

    // Second run: everything UNCHANGED, the page is not created twice.
    const second = await h.dryRun(options, V1_DIR);
    expect((second.summary as any).counts.PAGE).toEqual({ UNCHANGED: 1 });
    await h.apply(second.id);
    expect(h.db.page.rows).toHaveLength(1);

    // Rollback (latest run first, as the service requires): the first run's
    // rollback deletes the draft page and its redirects.
    await h.runs.rollback(STORE_ID, USER_ID, second.id);
    await h.worker.tick();
    expect((await h.runs.detail(STORE_ID, second.id)).status).toBe(
      'ROLLED_BACK',
    );
    expect(h.db.page.rows).toHaveLength(1);
    await h.runs.rollback(STORE_ID, USER_ID, run.id);
    await h.worker.tick();
    const rolled = await h.runs.detail(STORE_ID, run.id);
    expect(rolled.status).toBe('ROLLED_BACK');
    expect((rolled.summary as any).rollback).toMatchObject({
      pages_deleted: 1,
      pages_kept: 0,
    });
    expect(h.db.page.rows).toHaveLength(0);
    expect(h.db.pageSection.rows).toHaveLength(0);
    expect(h.db.storeRedirect.rows).toHaveLength(0);
    expect(
      h.db.importEntity.rows.find((e: any) => e.entity_type === 'PAGE').status,
    ).toBe('ROLLED_BACK');
    // A third run plans the page again.
    const third = await h.dryRun(options, V1_DIR);
    expect((third.summary as any).counts.PAGE).toEqual({ CREATE: 1 });
  });

  it('rollback keeps an imported page the merchant published; an existing slug is an ERROR, not a crash', async () => {
    const h = await makeHarness();
    const options = {
      ...NAMEZ_OPTIONS,
      scopes: { pages: true },
      content_redirects: {
        mode: 'home',
        targets: { [OM]: 'import', [KONTAKT]: 'import' },
      },
    };
    // A page of the store already uses the `om-oss` slug.
    h.db.page.rows.push({
      id: 'page-own',
      store_id: STORE_ID,
      type: 'LANDING',
      slug: 'om-oss',
      status: 'PUBLISHED',
      published_version_id: null,
      seo: {},
    });
    const run = await h.dryRun(options, V1_DIR);
    const s = run.summary as any;
    expect(s.counts.PAGE).toEqual({ CREATE: 2 });
    // `home` mode: the unmapped post goes to `/`; `import` pages need no row
    // when the old path equals the new one (`/om-oss/` → `/om-oss`).
    expect(s.content).toMatchObject({ mapped: 3, unmapped: 0, imported: 2 });
    const done = await h.apply(run.id);
    expect(['COMPLETED', 'COMPLETED_WITH_WARNINGS']).toContain(done.status);
    const applied = h
      .itemsOf(run.id, 'APPLY')
      .filter((i: any) => i.entity_type === 'PAGE');
    expect(applied.map((i: any) => [i.external_ref, i.action])).toEqual([
      [OM, 'ERROR'],
      [KONTAKT, 'CREATE'],
    ]);
    expect(applied[0].message).toContain('om-oss');
    const red = redirectsOf(h);
    expect(red['/om-oss']).toBeUndefined();
    expect(red['/om-oss/kontakt']).toEqual(['/kontakt', 301]);
    expect(red['/nyheter-varen']).toEqual(['/', 301]);
    expect(h.db.page.rows.map((p: any) => p.slug).sort()).toEqual([
      'kontakt',
      'om-oss',
    ]);

    // The merchant publishes the imported page before the rollback: kept.
    const kontakt = h.db.page.rows.find((p: any) => p.slug === 'kontakt');
    kontakt.status = 'PUBLISHED';
    await h.runs.rollback(STORE_ID, USER_ID, run.id);
    await h.worker.tick();
    const rolled = await h.runs.detail(STORE_ID, run.id);
    expect(rolled.status).toBe('ROLLED_BACK');
    expect((rolled.summary as any).rollback).toMatchObject({
      pages_deleted: 0,
      pages_kept: 1,
      skipped_edited: [
        expect.objectContaining({ entity_type: 'PAGE', external_ref: KONTAKT }),
      ],
    });
    expect(h.db.page.rows.map((p: any) => p.slug).sort()).toEqual([
      'kontakt',
      'om-oss',
    ]);
  });

  it('skip mode: no content rows, nothing unmapped; a page update only touches drafts', async () => {
    const h = await makeHarness();
    const options = {
      ...NAMEZ_OPTIONS,
      scopes: { pages: true },
      content_redirects: { mode: 'skip', targets: { [KONTAKT]: 'import' } },
    };
    const run = await h.dryRun(options, V1_DIR);
    const s = run.summary as any;
    expect(s.content).toMatchObject({ mapped: 3, unmapped: 0, imported: 1 });
    expect(s.content.items.map((r: any) => r.target)).toEqual([
      'skip',
      'import',
      'skip',
    ]);
    // Only the imported page gets a row (its old nested URL → `/kontakt`).
    expect(s.redirects.by_rule.page).toBe(1);
    expect(s.redirects.by_rule.post).toBeUndefined();
    await h.apply(run.id);
    const page = h.db.page.rows[0];
    expect(page.slug).toBe('kontakt');

    // The ledger hash changes (a different sanitizer output would do the same):
    // the page is still a draft → UPDATE rewrites the section.
    const ledger = h.db.importEntity.rows.find(
      (e: any) => e.entity_type === 'PAGE',
    );
    ledger.source_hash = 'stale';
    const second = await h.dryRun(options, V1_DIR);
    expect((second.summary as any).counts.PAGE).toEqual({ UPDATE: 1 });
    await h.apply(second.id);
    expect(h.db.page.rows).toHaveLength(1);
    expect(h.db.pageSection.rows).toHaveLength(1);
    expect(
      h.itemsOf(second.id, 'APPLY').find((i: any) => i.entity_type === 'PAGE')
        .action,
    ).toBe('UPDATE');

    // Published since: the next UPDATE is SKIPped (never overwrites a live page).
    // (The fake replaces row objects on update: re-read them.)
    h.db.page.rows[0].status = 'PUBLISHED';
    h.db.importEntity.rows.find(
      (e: any) => e.entity_type === 'PAGE',
    ).source_hash = 'stale-again';
    const third = await h.dryRun(options, V1_DIR);
    await h.apply(third.id);
    expect(
      h.itemsOf(third.id, 'APPLY').find((i: any) => i.entity_type === 'PAGE'),
    ).toMatchObject({
      action: 'SKIP',
      message: 'W_TARGET_MODIFIED_SKIPPED',
    });
  });
});

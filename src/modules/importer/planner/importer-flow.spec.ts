/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- in-memory Prisma fake rows are untyped in tests */
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveVariantImage } from '../../../common/catalog/variant-image.util';
import { SLICE_DIR } from '../adapters/wp-bundle/__fixtures__/fixtures';
import {
  filesOf,
  makeHarness,
  NAMEZ_OPTIONS,
  STORE_ID,
  USER_ID,
  CREATOR_ID,
} from '../__fixtures__/harness';

/**
 * End-to-end importer flow on the Namez slice fixture and the in-memory
 * Prisma fake: dry run → confirm → apply (worker) → re-run → rollback
 * (M4.4 §11 items 5–9).
 */

type Item = { entity_type: string; external_ref: string; action: string };
const key = (i: Item) => `${i.entity_type}|${i.external_ref}|${i.action}`;
const set = (items: Item[]) => new Set(items.map(key));

/** Copy of the slice with posts.tsv edited. */
function sliceCopy(editPosts: (text: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), 'importer-slice-'));
  for (const f of readdirSync(SLICE_DIR))
    copyFileSync(join(SLICE_DIR, f), join(dir, f));
  const posts = readFileSync(join(dir, 'posts.tsv'), 'utf8');
  writeFileSync(join(dir, 'posts.tsv'), editPosts(posts));
  return dir;
}

/** Renames product 4256 in the source (post_title is column 6). */
function renamed4256(title: string): string {
  return sliceCopy((text) =>
    text
      .split('\n')
      .map((line) => {
        const cols = line.split('\t');
        if (cols[0] === '4256' && cols[20] === 'product') cols[5] = title;
        return cols.join('\t');
      })
      .join('\n'),
  );
}

const productByRef = (db: any, id: number) =>
  db.product.rows.find(
    (p: any) => p.external_ref === `woo:namez.se:product:${id}`,
  );

describe('importer flow (Namez slice)', () => {
  it('dry run: PLAN items and report, no target writes, sanitizer fallback warning', async () => {
    const h = await makeHarness();
    const run = await h.dryRun();
    expect(run.status).toBe('PLANNED');
    expect(run.plan_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const s = run.summary as any;
    expect(s.counts.PRODUCT).toEqual({ CREATE: 7, SKIP: 1 });
    expect(s.counts.CATEGORY).toEqual({ CREATE: 56 });
    expect(s.counts.VARIANT).toEqual({ CREATE: 127 });
    expect(s.counts.PERSONALIZATION).toEqual({ CREATE: 7, SKIP: 1 });
    expect(s.counts.FALLBACK_FIELD).toEqual({ CREATE: 1 });
    expect(s.counts.DESIGN_TEMPLATE).toEqual({ STAGE: 2 });
    // 117 catalog rows + the 13 WordPress system paths (M5 B17 W2-B;
    // `/cart/` and `/checkout/` are self-redirects and get no row).
    expect(s.redirects.by_rule.system).toBe(13);
    expect(s.counts.REDIRECT).toEqual({ CREATE: 117 + 13 });
    expect(s.plan).toMatchObject({
      blockers: [],
      sanitizer: 'plain_text_fallback',
    });
    expect(s.warnings.W_HTML_SANITIZER_FALLBACK.count).toBe(1);
    expect(s.skipped.map((x: any) => x.external_ref)).toEqual([
      'woo:namez.se:product:4326',
    ]);
    expect(h.db.product.rows).toHaveLength(0);
    expect(h.db.creatorCategory.rows).toHaveLength(0);
    expect(h.db.storeRedirect.rows).toHaveLength(0);
    // Items carry a title for the report.
    const items = await h.runs.items(STORE_ID, run.id, {
      phase: 'PLAN',
      entity_type: 'PRODUCT',
      limit: 200,
    });
    expect(
      items.items.find((i: any) => i.external_ref.endsWith(':2229'))?.title,
    ).toBe('Personlig 3D Namnpresent');
  });

  it('apply: PLAN == APPLY, prices (D19), U4 skip, option config, presets, fallback fields, redirects', async () => {
    const h = await makeHarness();
    const run = await h.dryRun();
    const done = await h.apply(run.id);
    expect(done.status).toBe('COMPLETED_WITH_WARNINGS');
    expect(set(h.itemsOf(run.id, 'APPLY'))).toEqual(
      set(h.itemsOf(run.id, 'PLAN')),
    );

    // 2229: base 350 with +200 / +600; 4414: 275 with 490 struck through; 4275 simple 399/600.
    const p2229 = productByRef(h.db, 2229);
    expect(p2229.base_price).toBe('350.00');
    const adj = new Set(
      h.db.productVariant.rows
        .filter((v: any) => v.product_id === p2229.id)
        .map((v: any) => v.price_adjustment),
    );
    expect(adj).toEqual(new Set(['0.00', '200.00', '600.00']));
    const p4414 = productByRef(h.db, 4414);
    expect([p4414.base_price, p4414.compare_at_price]).toEqual([
      '275.00',
      '490.00',
    ]);
    expect(
      h.db.productVariant.rows
        .filter((v: any) => v.product_id === p4414.id)
        .every((v: any) => v.compare_at_price === '490.00'),
    ).toBe(true);
    const p4275 = productByRef(h.db, 4275);
    expect([p4275.base_price, p4275.compare_at_price]).toEqual([
      '399.00',
      '600.00',
    ]);
    expect(productByRef(h.db, 4326)).toBeUndefined();
    // D21: 2826 keeps 48 concrete variations, the 12 "any" rows are dropped.
    const p2826 = productByRef(h.db, 2826);
    expect(
      h.db.productVariant.rows.filter((v: any) => v.product_id === p2826.id),
    ).toHaveLength(48);
    // D14: no option writes an imageMap, so a swatch never replaces the product photo.
    for (const v of h.db.productVariant.rows) {
      const prod = h.db.product.rows.find((p: any) => p.id === v.product_id);
      expect(
        resolveVariantImage({
          optionConfig: prod.variant_option_config,
          variantOptions: v.options,
        }),
      ).toBeNull();
    }
    const colour = p2826.variant_option_config.find(
      (o: any) => o.name === 'Färg',
    );
    expect(colour).toMatchObject({
      style: 'color',
      colorMap: { 'Blank Silver': '#d8d8d8' },
    });
    // Every product is in the platform category, statuses mapped (3484 is a draft).
    expect(
      h.db.product.rows.every(
        (p: any) => p.category_id === NAMEZ_OPTIONS.platform_category_id,
      ),
    ).toBe(true);
    expect(productByRef(h.db, 3484).status).toBe('DRAFT');
    // Presets went through the port with the importer's source refs (C25).
    expect(
      h.presetCalls.flatMap((c) => c.reqs.map((r) => r.key)).sort(),
    ).toEqual(
      [
        'checkbox_group',
        'engravings',
        'name_color_per_item',
        'names_equal_length',
        'single_name',
        'single_name',
        'single_name',
      ].sort(),
    );
    expect(
      h.presetCalls.every((c) =>
        c.reqs.every((r) => r.mode === 'skip_if_exists'),
      ),
    ).toBe(true);
    // D28 fallback fields on the NPP product (4275), tagged npp_fallback.
    const fallback = h.db.productCustomField.rows.filter(
      (f: any) => f.preset_key === 'npp_fallback',
    );
    expect(fallback.map((f: any) => f.name).sort()).toEqual([
      'npp_foto',
      'npp_klass',
      'npp_namn',
    ]);
    expect(
      fallback.every((f: any) => f.product_id === p4275.id && f.is_required),
    ).toBe(true);
    // Templates staged for M4.2 (C26).
    const staged = h.db.importEntity.rows.filter(
      (e: any) => e.entity_type === 'DESIGN_TEMPLATE',
    );
    expect(staged.map((e: any) => e.status)).toEqual(['STAGED', 'STAGED']);
    // Redirects (§6.1), skipped 4326 → its first collection, revalidated once.
    const red = new Map<string, any>(
      h.db.storeRedirect.rows.map((r: any) => [r.from_path, r]),
    );
    expect(red.get('/produkt/personlig-3d-namnpresent')).toMatchObject({
      to_path: '/products/personlig-3d-namnpresent',
      source: 'IMPORT',
      import_run_id: run.id,
    });
    expect(red.get('/produkt/studentskylt-med-gulddetaljer')?.to_path).toMatch(
      /^\/collections\//,
    );
    expect(h.revalidation.revalidateStoreById).toHaveBeenCalledTimes(1);
    // Media went through the public pipeline, one upload per distinct image.
    expect(h.uploads.storeBuffer).toHaveBeenCalled();
    expect(
      h.uploads.storeBuffer.mock.calls.every((c: any[]) => c[2] === 'imports'),
    ).toBe(true);
    // Collections: all of them, active, in catalog order with SEO.
    expect(h.db.creatorCategory.rows).toHaveLength(56);
    expect(h.db.creatorCategory.rows.every((c: any) => c.is_active)).toBe(true);
  });

  it('re-run: every entity UNCHANGED and zero target writes (D6)', async () => {
    const h = await makeHarness();
    const first = await h.dryRun();
    await h.apply(first.id);
    h.db.resetWriteCounts();
    const second = await h.dryRun();
    const counts = (second.summary as any).counts;
    for (const [type, actions] of Object.entries(counts)) {
      for (const a of Object.keys(actions as object)) {
        if (type === 'PRODUCT' || type === 'PERSONALIZATION')
          expect(['UNCHANGED', 'SKIP']).toContain(a);
        else expect(a).toBe('UNCHANGED');
      }
    }
    const done = await h.apply(second.id);
    expect(['COMPLETED', 'COMPLETED_WITH_WARNINGS']).toContain(done.status);
    const target = [
      'product',
      'productTranslation',
      'productVariant',
      'productImage',
      'productTag',
      'productFaq',
      'productCreatorCategory',
      'creatorCategory',
      'creatorCategoryTranslation',
      'storeRedirect',
      'productCustomField',
      'importMedia',
    ];
    expect(h.db.writeCount(target)).toBe(0);
    expect(set(h.itemsOf(second.id, 'APPLY'))).toEqual(
      set(h.itemsOf(second.id, 'PLAN')),
    );
  });

  it('source change → UPDATE of only that product; merchant edit → SKIP, OVERWRITE → UPDATE', async () => {
    const h = await makeHarness();
    await h.apply((await h.dryRun()).id);

    const changed = await h.dryRun(
      NAMEZ_OPTIONS,
      renamed4256('Dalahäst ny titel'),
    );
    const products = h
      .itemsOf(changed.id, 'PLAN')
      .filter((i: any) => i.entity_type === 'PRODUCT');
    expect(
      products
        .filter((i: any) => i.action === 'UPDATE')
        .map((i: any) => i.external_ref),
    ).toEqual(['woo:namez.se:product:4256']);
    await h.apply(changed.id);
    const p4256 = productByRef(h.db, 4256);
    expect(
      h.db.productTranslation.rows.find((t: any) => t.product_id === p4256.id)
        .title,
    ).toBe('Dalahäst ny titel');

    // The merchant edits the product, then the source changes again.
    h.db.productTranslation.rows.find(
      (t: any) => t.product_id === p4256.id,
    ).title = 'Merchant title';
    const again = await h.dryRun(NAMEZ_OPTIONS, renamed4256('Dalahäst tredje'));
    const item = h
      .itemsOf(again.id, 'PLAN')
      .find((i: any) => i.external_ref === 'woo:namez.se:product:4256');
    expect(item.action).toBe('SKIP');
    expect(
      (again.summary as any).warnings.W_TARGET_MODIFIED_SKIPPED.count,
    ).toBeGreaterThan(0);
    await h.runs.cancel(STORE_ID, again.id);

    const overwrite = await h.dryRun(
      { ...NAMEZ_OPTIONS, conflict_policy: 'OVERWRITE' },
      renamed4256('Dalahäst tredje'),
    );
    expect(
      h
        .itemsOf(overwrite.id, 'PLAN')
        .find((i: any) => i.external_ref === 'woo:namez.se:product:4256')
        .action,
    ).toBe('UPDATE');
    await h.apply(overwrite.id);
    expect(
      h.db.productTranslation.rows.find((t: any) => t.product_id === p4256.id)
        .title,
    ).toBe('Dalahäst tredje');
  });

  it('slug conflict with a merchant product → suffix and redirect to the final slug (D25)', async () => {
    const h = await makeHarness();
    h.db.product.rows.push({
      id: 'merchant-1',
      creator_id: CREATOR_ID,
      status: 'PUBLISHED',
      external_ref: null,
    });
    h.db.productTranslation.rows.push({
      id: 't1',
      product_id: 'merchant-1',
      locale: 'sv',
      slug: 'personlig-3d-namnpresent',
      title: 'x',
      description: '',
    });
    const run = await h.dryRun();
    expect((run.summary as any).warnings.W_SLUG_CONFLICT_SUFFIXED.count).toBe(
      1,
    );
    await h.apply(run.id);
    const p = productByRef(h.db, 2229);
    expect(
      h.db.productTranslation.rows.find((t: any) => t.product_id === p.id).slug,
    ).toBe('personlig-3d-namnpresent-2');
    expect(
      h.db.storeRedirect.rows.find(
        (r: any) => r.from_path === '/produkt/personlig-3d-namnpresent',
      ).to_path,
    ).toBe('/products/personlig-3d-namnpresent-2');
  });

  it('category adoption by slug; MANUAL redirect never overwritten (CONFLICT in plan and apply)', async () => {
    const h = await makeHarness();
    h.db.creatorCategory.rows.push({
      id: 'cat-own',
      creator_id: CREATOR_ID,
      slug: 'halsband',
      external_ref: null,
      is_active: true,
      parent_id: null,
      sort_order: 9,
      thumbnail_url: null,
      noindex_when_empty: false,
    });
    h.db.storeRedirect.rows.push({
      id: 'manual-1',
      store_id: STORE_ID,
      from_path: '/produkt/personlig-3d-namnpresent',
      to_path: '/pages/about',
      status_code: 301,
      source: 'MANUAL',
      is_active: true,
      import_run_id: null,
      updated_at: new Date(),
    });
    const run = await h.dryRun();
    const plan = h.itemsOf(run.id, 'PLAN');
    expect(
      plan.find((i: any) => i.external_ref === 'woo:namez.se:product_cat:147'),
    ).toMatchObject({
      action: 'UPDATE',
      target_id: 'cat-own',
      message: 'adopted',
    });
    expect(
      plan.find(
        (i: any) =>
          i.entity_type === 'REDIRECT' &&
          i.external_ref === '/produkt/personlig-3d-namnpresent',
      ).action,
    ).toBe('CONFLICT');
    await h.apply(run.id);
    expect(set(h.itemsOf(run.id, 'APPLY'))).toEqual(set(plan));
    expect(
      h.db.creatorCategory.rows.find((c: any) => c.id === 'cat-own')
        .external_ref,
    ).toBe('woo:namez.se:product_cat:147');
    expect(
      h.db.storeRedirect.rows.find((r: any) => r.id === 'manual-1'),
    ).toMatchObject({ to_path: '/pages/about', source: 'MANUAL' });
    expect(
      h.db.importEntity.rows.find((e: any) => e.target_id === 'cat-own')
        .created_by_import,
    ).toBe(false);
  });

  it('rollback: created products deleted, ordered ones archived, adopted collection kept; a re-run creates again', async () => {
    const h = await makeHarness();
    h.db.creatorCategory.rows.push({
      id: 'cat-own',
      creator_id: CREATOR_ID,
      slug: 'halsband',
      external_ref: null,
      is_active: true,
      parent_id: null,
      sort_order: 9,
      thumbnail_url: null,
      noindex_when_empty: false,
    });
    const run = await h.dryRun();
    await h.apply(run.id);
    const p2229 = productByRef(h.db, 2229);
    h.db.orderItem.rows.push({
      id: 'oi-1',
      product_id: p2229.id,
      variant_id: null,
    });

    const queued = await h.runs.rollback(STORE_ID, USER_ID, run.id);
    expect(queued.status).toBe('ROLLBACK_QUEUED');
    await h.worker.tick();
    const rolled = await h.runs.detail(STORE_ID, run.id);
    expect(rolled.status).toBe('ROLLED_BACK');

    expect(h.db.product.rows.map((p: any) => p.id)).toEqual([p2229.id]);
    expect(
      p2229.status === 'ARCHIVED' ||
        productByRef(h.db, 2229).status === 'ARCHIVED',
    ).toBe(true);
    expect(h.db.storeRedirect.rows).toHaveLength(0);
    // Preset/fallback fields of the run are gone (M4.0 SetNull keeps order history).
    expect(
      h.db.productCustomField.rows.filter((f: any) => f.preset_ref),
    ).toHaveLength(0);
    // Created collections deleted; the adopted one stays (D7).
    expect(h.db.creatorCategory.rows.map((c: any) => c.id)).toContain(
      'cat-own',
    );
    expect(
      h.db.creatorCategory.rows.filter((c: any) => c.id !== 'cat-own'),
    ).toHaveLength(0);
    expect(
      h.itemsOf(run.id, 'ROLLBACK').some((i: any) => i.action === 'ARCHIVE'),
    ).toBe(true);
    expect(
      h.db.importEntity.rows
        .filter((e: any) => e.first_run_id === run.id && e.created_by_import)
        .every((e: any) => e.status === 'ROLLED_BACK'),
    ).toBe(true);
    // Unreferenced media files of the run were removed.
    expect(h.uploads.deleteFile).toHaveBeenCalled();

    const rerun = await h.dryRun();
    const counts = (rerun.summary as any).counts;
    expect(counts.PRODUCT.CREATE).toBe(6);
    // Fix 12: the archived 2229 is not republished without OVERWRITE.
    expect(counts.PRODUCT.SKIP).toBe(2);
    expect(
      h
        .itemsOf(rerun.id, 'PLAN')
        .find((i: any) => i.external_ref === 'woo:namez.se:product:2229'),
    ).toMatchObject({ action: 'SKIP', message: 'W_PRODUCT_ARCHIVED_SKIPPED' });
  });

  it('personalization app off → presets STAGED; a later run applies them', async () => {
    const h = await makeHarness({ personalization: false });
    const run = await h.dryRun();
    expect((run.summary as any).counts.PERSONALIZATION).toEqual({
      STAGE: 7,
      SKIP: 1,
    });
    await h.apply(run.id);
    expect(h.presetCalls).toHaveLength(0);
    expect(
      h.db.importEntity.rows.filter(
        (e: any) =>
          e.entity_type === 'PERSONALIZATION' && e.status === 'STAGED',
      ),
    ).toHaveLength(7);
    (h.personalization.isAvailable as jest.Mock).mockResolvedValue(true);
    const later = await h.dryRun();
    expect((later.summary as any).counts.PERSONALIZATION).toEqual({
      CREATE: 7,
      SKIP: 1,
    });
    await h.apply(later.id);
    expect(h.presetCalls.flatMap((c) => c.reqs)).toHaveLength(7);
  });

  it('a failed image never fails the run (W_MEDIA_FETCH_FAILED, product kept without it)', async () => {
    const h = await makeHarness({ failMedia: () => true });
    const run = await h.dryRun();
    const done = await h.apply(run.id);
    expect(done.status).toBe('COMPLETED_WITH_WARNINGS');
    expect(h.db.product.rows).toHaveLength(7);
    expect(h.db.productImage.rows).toHaveLength(0);
    expect(
      h.db.importRunLog.rows.some(
        (l: any) => l.code === 'W_MEDIA_FETCH_FAILED',
      ),
    ).toBe(true);
  });
});

describe('run lifecycle guards', () => {
  it('confirm with a moved fingerprint → 409 IMPORT_PLAN_STALE; wrong fingerprint too', async () => {
    const h = await makeHarness();
    const run = await h.dryRun();
    await expect(
      h.runs.confirm(STORE_ID, USER_ID, run.id, 'f'.repeat(64)),
    ).rejects.toMatchObject({ response: { code: 'IMPORT_PLAN_STALE' } });
    h.db.product.rows.push({
      id: 'merchant-1',
      creator_id: CREATOR_ID,
      status: 'PUBLISHED',
      external_ref: null,
    });
    h.db.productTranslation.rows.push({
      id: 't1',
      product_id: 'merchant-1',
      locale: 'sv',
      slug: 'personlig-3d-namnpresent',
      title: 'x',
      description: '',
    });
    await expect(
      h.runs.confirm(STORE_ID, USER_ID, run.id, run.plan_fingerprint!),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'IMPORT_PLAN_STALE' },
    });
  });

  it('missing platform category blocks confirm (IMPORT_PLATFORM_CATEGORY_REQUIRED)', async () => {
    const h = await makeHarness();
    const run = await h.dryRun({
      ...NAMEZ_OPTIONS,
      platform_category_id: null,
    });
    expect((run.summary as any).plan.blockers[0].code).toBe(
      'IMPORT_PLATFORM_CATEGORY_REQUIRED',
    );
    await expect(
      h.runs.confirm(STORE_ID, USER_ID, run.id, run.plan_fingerprint!),
    ).rejects.toMatchObject({
      response: { code: 'IMPORT_PLATFORM_CATEGORY_REQUIRED' },
    });
  });

  it('currency mismatch blocks the run (IMPORT_CURRENCY_MISMATCH)', async () => {
    const h = await makeHarness();
    h.db.market.rows[0].currency = 'EUR';
    const run = await h.dryRun();
    expect(
      (run.summary as any).plan.blockers.map((b: any) => b.code),
    ).toContain('IMPORT_CURRENCY_MISMATCH');
  });

  it('one active run per store: API pre-check and the partial-index race both answer IMPORT_RUN_BUSY', async () => {
    const h = await makeHarness();
    const a = await h.dryRun();
    const b = await h.dryRun();
    await h.runs.confirm(STORE_ID, USER_ID, a.id, a.plan_fingerprint!);
    await expect(
      h.runs.confirm(STORE_ID, USER_ID, b.id, b.plan_fingerprint!),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'IMPORT_RUN_BUSY' },
    });
    // Race: the pre-check passes (count 0) but the unique index rejects the update.
    jest.spyOn(h.db.importRun, 'count').mockResolvedValue(0);
    await expect(
      h.runs.confirm(STORE_ID, USER_ID, b.id, b.plan_fingerprint!),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'IMPORT_RUN_BUSY' },
    });
  });

  it('worker claim race: two workers, one claim', async () => {
    const h = await makeHarness();
    const run = await h.runs.create(
      STORE_ID,
      USER_ID,
      h.source.id,
      NAMEZ_OPTIONS,
      filesOf(SLICE_DIR),
    );
    const other = new (h.worker.constructor as any)(h.db, h.engine);
    const [x, y] = await Promise.all([h.worker.claimNext(), other.claimNext()]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    expect(h.db.importRun.rows.find((r: any) => r.id === run.id).status).toBe(
      'PLANNING',
    );
  });

  it('stale heartbeat → requeued with attempt + 1, FAILED (IMPORT_RUN_INTERRUPTED) at the third attempt', async () => {
    const h = await makeHarness();
    const run = await h.dryRun();
    await h.runs.confirm(STORE_ID, USER_ID, run.id, run.plan_fingerprint!);
    const row = h.db.importRun.rows.find((r: any) => r.id === run.id);
    Object.assign(row, {
      status: 'RUNNING',
      heartbeat_at: new Date(Date.now() - 10 * 60_000),
      attempt: 0,
    });
    expect(await h.worker.requeueStale()).toBe(1);
    expect(h.db.importRun.rows.find((r: any) => r.id === run.id)).toMatchObject(
      { status: 'QUEUED', attempt: 1 },
    );
    Object.assign(
      h.db.importRun.rows.find((r: any) => r.id === run.id),
      { status: 'RUNNING', heartbeat_at: new Date(0), attempt: 2 },
    );
    await h.worker.requeueStale();
    const failed = h.db.importRun.rows.find((r: any) => r.id === run.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toMatch(/^IMPORT_RUN_INTERRUPTED/);
  });

  it('cancel between batches → CANCELLED, work so far can be rolled back', async () => {
    const h = await makeHarness();
    const run = await h.dryRun();
    await h.runs.confirm(STORE_ID, USER_ID, run.id, run.plan_fingerprint!);
    h.db.importRun.rows.find((r: any) => r.id === run.id).cancel_requested_at =
      new Date();
    await h.worker.tick();
    const r = await h.runs.detail(STORE_ID, run.id);
    expect(r.status).toBe('CANCELLED');
    await expect(
      h.runs.rollback(STORE_ID, USER_ID, run.id),
    ).resolves.toMatchObject({ status: 'ROLLBACK_QUEUED' });
  });

  it('resume from the cursor after a crash: no duplicate APPLY items', async () => {
    const h = await makeHarness();
    const run = await h.dryRun();
    await h.runs.confirm(STORE_ID, USER_ID, run.id, run.plan_fingerprint!);
    const update = h.db.importRun.updateMany.bind(h.db.importRun);
    let crashed = false;
    jest.spyOn(h.db.importRun, 'updateMany').mockImplementation((args: any) => {
      if (!crashed && args?.data?.progress?.phase === 'templates') {
        crashed = true;
        return Promise.reject(new Error('process killed'));
      }
      return update(args);
    });
    await h.worker.tick();
    expect((await h.runs.detail(STORE_ID, run.id)).status).toBe('FAILED');
    // What the stale requeue would do after a real crash.
    Object.assign(
      h.db.importRun.rows.find((r: any) => r.id === run.id),
      { status: 'QUEUED', attempt: 1, error: null },
    );
    await h.worker.tick();
    expect(['COMPLETED', 'COMPLETED_WITH_WARNINGS']).toContain(
      (await h.runs.detail(STORE_ID, run.id)).status,
    );
    const apply = h.itemsOf(run.id, 'APPLY').map(key);
    expect(new Set(apply).size).toBe(apply.length);
    expect(set(h.itemsOf(run.id, 'APPLY'))).toEqual(
      set(h.itemsOf(run.id, 'PLAN')),
    );
  });

  it('runs and sources are scoped to the caller store (404)', async () => {
    const h = await makeHarness();
    const run = await h.dryRun();
    await expect(
      h.runs.detail('99999999-9999-4999-8999-999999999999', run.id),
    ).rejects.toMatchObject({ response: { code: 'IMPORT_RUN_NOT_FOUND' } });
    await expect(
      h.sources.get('99999999-9999-4999-8999-999999999999', h.source.id),
    ).rejects.toMatchObject({ response: { code: 'IMPORT_SOURCE_NOT_FOUND' } });
  });

  it('upload checks: archives refused (IMPORT_BUNDLE_INVALID_ARCHIVE), unknown files refused', async () => {
    const h = await makeHarness();
    const zip = {
      originalname: 'namez-export.tgz',
      buffer: Buffer.from('x'),
      size: 1,
    };
    await expect(
      h.runs.create(STORE_ID, USER_ID, h.source.id, NAMEZ_OPTIONS, [zip]),
    ).rejects.toMatchObject({
      response: { code: 'IMPORT_BUNDLE_INVALID_ARCHIVE' },
    });
    const evil = {
      originalname: 'evil.sh',
      buffer: Buffer.from('rm'),
      size: 2,
    };
    await expect(
      h.runs.create(STORE_ID, USER_ID, h.source.id, NAMEZ_OPTIONS, [evil]),
    ).rejects.toMatchObject({
      response: { code: 'IMPORT_BUNDLE_UNEXPECTED_FILE' },
    });
    await expect(
      h.runs.create(STORE_ID, USER_ID, h.source.id, { bogus: 1 }, []),
    ).rejects.toMatchObject({
      response: { code: 'IMPORT_RUN_OPTIONS_INVALID' },
    });
  });
});

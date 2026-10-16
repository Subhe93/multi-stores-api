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
import { SLICE_DIR } from '../adapters/wp-bundle/__fixtures__/fixtures';
import {
  CREATOR_ID,
  filesOf,
  makeHarness,
  NAMEZ_OPTIONS,
  STORE_ID,
  USER_ID,
} from '../__fixtures__/harness';
import { ImportWorkerService } from '../runs/import-worker.service';

/**
 * M4.4 fixer A (engine) regressions on the Namez slice: re-runs repair
 * partial failures, media scope off, category UPDATE slugs, rollback
 * restores and merchant edits, worker caps, cancel, presets on SKIP, help
 * images, stock, redirects targets, run outcome, list view.
 */

type Item = { entity_type: string; external_ref: string; action: string };
const key = (i: Item) => `${i.entity_type}|${i.external_ref}|${i.action}`;

/** Copy of the slice with one file edited by column (`cols` → new cols). */
function sliceEdit(
  file: string,
  edit: (cols: string[]) => string[] | void,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'importer-fix-'));
  for (const f of readdirSync(SLICE_DIR))
    copyFileSync(join(SLICE_DIR, f), join(dir, f));
  const text = readFileSync(join(dir, file), 'utf8');
  writeFileSync(
    join(dir, file),
    text
      .split('\n')
      .map((line) => {
        const cols = line.split('\t');
        return (edit(cols) ?? cols).join('\t');
      })
      .join('\n'),
  );
  return dir;
}

const productPost = (id: string, col: number, value: string) =>
  sliceEdit('posts.tsv', (c) => {
    if (c[0] === id && c[20] === 'product') c[col] = value;
  });
const categorySlug = (termId: string, slug: string) =>
  sliceEdit('terms.tsv', (c) => {
    if (c[0] === termId) c[2] = slug;
  });

const REF = (id: number) => `woo:namez.se:product:${id}`;
const CAT147 = 'woo:namez.se:product_cat:147';
const productByRef = (db: any, id: number) =>
  db.product.rows.find((p: any) => p.external_ref === REF(id));
const trOf = (db: any, productId: string) =>
  db.productTranslation.rows.find((t: any) => t.product_id === productId);
const planItem = (h: any, runId: string, ref: string, type = 'PRODUCT') =>
  h
    .itemsOf(runId, 'PLAN')
    .find((i: any) => i.external_ref === ref && i.entity_type === type);

describe('fix 1 — a re-run repairs partial failures', () => {
  it('images that failed are fetched and attached on the next run, then UNCHANGED', async () => {
    let failing = true;
    const h = await makeHarness({ failMedia: () => failing });
    const first = await h.apply((await h.dryRun()).id);
    expect(first.status).toBe('COMPLETED_WITH_WARNINGS');
    expect(h.db.productImage.rows).toHaveLength(0);
    const ledger = h.db.importEntity.rows.find(
      (e: any) => e.entity_type === 'PRODUCT' && e.external_ref === REF(2229),
    );
    expect(ledger.payload.incomplete.media.length).toBeGreaterThan(0);

    failing = false;
    const second = await h.dryRun();
    expect(planItem(h, second.id, REF(2229)).action).toBe('UPDATE');
    await h.apply(second.id);
    expect(h.db.productImage.rows.length).toBeGreaterThan(0);
    expect(
      h.db.importEntity.rows.find(
        (e: any) => e.entity_type === 'PRODUCT' && e.external_ref === REF(2229),
      ).payload,
    ).toBeNull();

    const third = await h.dryRun();
    const counts = (third.summary as any).counts;
    expect(Object.keys(counts.PRODUCT)).toEqual(
      expect.arrayContaining(['UNCHANGED']),
    );
    expect(counts.PRODUCT.UPDATE).toBeUndefined();
  });

  it('a missing collection link makes the product UPDATE, even under OVERWRITE', async () => {
    const h = await makeHarness();
    await h.apply((await h.dryRun()).id);
    const p = productByRef(h.db, 2229);
    h.db.productCreatorCategory.rows = h.db.productCreatorCategory.rows.filter(
      (l: any) => l.product_id !== p.id,
    );
    const run = await h.dryRun({
      ...NAMEZ_OPTIONS,
      conflict_policy: 'OVERWRITE',
    });
    expect(planItem(h, run.id, REF(2229)).action).toBe('UPDATE');
    await h.apply(run.id);
    expect(
      h.db.productCreatorCategory.rows.some((l: any) => l.product_id === p.id),
    ).toBe(true);
  });
});

describe('fix 2 — media scope off never wipes media', () => {
  it('an UPDATE without the media scope keeps images and collection thumbnails', async () => {
    const h = await makeHarness();
    await h.apply((await h.dryRun()).id);
    const p = productByRef(h.db, 4256);
    const imagesBefore = h.db.productImage.rows
      .filter((i: any) => i.product_id === p.id)
      .map((i: any) => i.url);
    expect(imagesBefore.length).toBeGreaterThan(0);
    const thumbs = h.db.creatorCategory.rows
      .filter((c: any) => c.thumbnail_url)
      .map((c: any) => [c.id, c.thumbnail_url]);
    const run = await h.dryRun(
      { ...NAMEZ_OPTIONS, scopes: { ...allScopes(), media: false } },
      productPost('4256', 5, 'Dalahäst utan media'),
    );
    expect(planItem(h, run.id, REF(4256)).action).toBe('UPDATE');
    await h.apply(run.id);
    expect(trOf(h.db, p.id).title).toBe('Dalahäst utan media');
    expect(
      h.db.productImage.rows
        .filter((i: any) => i.product_id === p.id)
        .map((i: any) => i.url),
    ).toEqual(imagesBefore);
    for (const [id, url] of thumbs)
      expect(
        h.db.creatorCategory.rows.find((c: any) => c.id === id).thumbnail_url,
      ).toBe(url);
  });
});

function allScopes() {
  return {
    categories: true,
    products: true,
    media: true,
    shipping: true,
    personalization: true,
    templates: true,
    redirects: true,
  };
}

describe('fix 3 — category UPDATE', () => {
  it('a renamed slug is written and redirects point at it', async () => {
    const h = await makeHarness();
    await h.apply((await h.dryRun()).id);
    const run = await h.dryRun(
      NAMEZ_OPTIONS,
      categorySlug('147', 'halsband-ny'),
    );
    expect(planItem(h, run.id, CAT147, 'CATEGORY').action).toBe('UPDATE');
    await h.apply(run.id);
    const cat = h.db.creatorCategory.rows.find(
      (c: any) => c.external_ref === CAT147,
    );
    expect(cat.slug).toBe('halsband-ny');
    expect(
      h.db.storeRedirect.rows.some(
        (r: any) => r.to_path === '/collections/halsband-ny',
      ),
    ).toBe(true);
    // The old collection page redirects; older rows were re-pointed.
    expect(
      h.db.storeRedirect.rows.find(
        (r: any) => r.from_path === '/collections/halsband',
      )?.to_path,
    ).toBe('/collections/halsband-ny');
    expect(
      h.db.storeRedirect.rows.some(
        (r: any) => r.to_path === '/collections/halsband',
      ),
    ).toBe(false);
  });

  it('a renamed slug that is taken → CONFLICT, the live slug stays the redirect target', async () => {
    const h = await makeHarness();
    await h.apply((await h.dryRun()).id);
    h.db.creatorCategory.rows.push({
      id: 'merchant-cat',
      creator_id: CREATOR_ID,
      slug: 'egen',
      external_ref: null,
      is_active: true,
      parent_id: null,
      sort_order: 0,
      thumbnail_url: null,
      noindex_when_empty: false,
    });
    const run = await h.dryRun(NAMEZ_OPTIONS, categorySlug('147', 'egen'));
    expect(planItem(h, run.id, CAT147, 'CATEGORY').action).toBe('CONFLICT');
    expect((run.summary as any).warnings.W_CATEGORY_SLUG_CONFLICT.count).toBe(
      1,
    );
    await h.apply(run.id);
    expect(
      h.db.creatorCategory.rows.find((c: any) => c.external_ref === CAT147)
        .slug,
    ).toBe('halsband');
  });

  it('one failing collection is the only ERROR of its batch; category errors fail the run (fix 19)', async () => {
    const h = await makeHarness();
    const run = await h.dryRun();
    const create = h.db.creatorCategory.create.bind(h.db.creatorCategory);
    jest
      .spyOn(h.db.creatorCategory, 'create')
      .mockImplementation((args: any) =>
        args.data.external_ref === CAT147
          ? Promise.reject(new Error('boom'))
          : create(args),
      );
    const done = await h.apply(run.id);
    const errs = h
      .itemsOf(run.id, 'APPLY')
      .filter((i: any) => i.entity_type === 'CATEGORY' && i.action === 'ERROR');
    expect(errs.map((i: any) => i.external_ref)).toEqual([CAT147]);
    expect(h.db.creatorCategory.rows).toHaveLength(55);
    expect(done.status).toBe('FAILED');
    expect(done.error).toMatch(/^IMPORT_RUN_ERRORS: IMPORT_CATEGORY_ERRORS:1/);
    expect((done.summary as any).apply.outcome.failed).toBe(true);
  });
});

describe('fix 5/6 — rollback restores what the run updated', () => {
  it('rolling back a re-run restores the product, its redirects and keeps the first run rows', async () => {
    const h = await makeHarness();
    const first = await h.dryRun();
    await h.apply(first.id);
    const p = productByRef(h.db, 4256);
    const oldTitle = trOf(h.db, p.id).title;
    const oldFrom = '/produkt/dalahast-svenska-presenter-sverige';
    const oldTarget = h.db.storeRedirect.rows.find(
      (r: any) => r.from_path === oldFrom,
    ).to_path;

    const dir = sliceEdit('posts.tsv', (c) => {
      if (c[0] === '4256' && c[20] === 'product') {
        c[5] = 'Ny dalahäst';
        c[11] = 'ny-dalahast';
      }
    });
    const second = await h.dryRun(NAMEZ_OPTIONS, dir);
    await h.apply(second.id);
    expect(trOf(h.db, p.id).slug).toBe('ny-dalahast');
    const updated = h.db.storeRedirect.rows.find(
      (r: any) => r.from_path === oldFrom,
    );
    expect(updated.to_path).toBe('/products/ny-dalahast');
    expect(updated.import_run_id).toBe(first.id); // kept (fix 5)

    await h.runs.rollback(STORE_ID, USER_ID, second.id);
    await h.worker.tick();
    const rolled = await h.runs.detail(STORE_ID, second.id);
    expect(rolled.status).toBe('ROLLED_BACK');
    expect(trOf(h.db, p.id)).toMatchObject({
      title: oldTitle,
      slug: 'dalahast-svenska-presenter-sverige',
    });
    expect(
      h.db.storeRedirect.rows.find((r: any) => r.from_path === oldFrom).to_path,
    ).toBe(oldTarget);
    expect(
      h.db.storeRedirect.rows.some(
        (r: any) => r.from_path === '/produkt/ny-dalahast',
      ),
    ).toBe(false);
    expect((rolled.summary as any).rollback.products_restored).toBe(1);
    // Ledger back to the first run: the same source re-plans UNCHANGED.
    const again = await h.dryRun();
    expect(planItem(h, again.id, REF(4256)).action).toBe('UNCHANGED');
  });

  it('merchant-edited entities: created product archived, created collection kept, both reported', async () => {
    const h = await makeHarness();
    const run = await h.dryRun();
    await h.apply(run.id);
    const p = productByRef(h.db, 4256);
    trOf(h.db, p.id).title = 'Merchant title';
    const cat = h.db.creatorCategory.rows.find(
      (c: any) => c.external_ref === CAT147,
    );
    cat.sort_order = 99;
    await h.runs.rollback(STORE_ID, USER_ID, run.id);
    await h.worker.tick();
    const rolled = await h.runs.detail(STORE_ID, run.id);
    const rb = (rolled.summary as any).rollback;
    expect(productByRef(h.db, 4256).status).toBe('ARCHIVED');
    expect(rb.archived_edited).toEqual([
      expect.objectContaining({
        entity_type: 'PRODUCT',
        external_ref: REF(4256),
        title: expect.any(String),
      }),
    ]);
    expect(h.db.creatorCategory.rows.map((c: any) => c.id)).toContain(cat.id);
    expect(rb.skipped_edited.map((x: any) => x.external_ref)).toContain(CAT147);
  });

  it('an adopted collection gets its prior fields back', async () => {
    const h = await makeHarness();
    h.db.creatorCategory.rows.push({
      id: 'cat-own',
      creator_id: CREATOR_ID,
      slug: 'halsband',
      external_ref: null,
      is_active: false,
      parent_id: null,
      sort_order: 9,
      thumbnail_url: '/uploads/mine.webp',
      noindex_when_empty: false,
    });
    h.db.creatorCategoryTranslation.rows.push({
      id: 'cat-own-tr',
      creator_category_id: 'cat-own',
      locale: 'sv',
      name: 'Mina halsband',
      description: 'egen text',
      meta_title: null,
      meta_desc: null,
    });
    const run = await h.dryRun();
    await h.apply(run.id);
    const adopted = h.db.creatorCategory.rows.find(
      (c: any) => c.id === 'cat-own',
    );
    expect(adopted.external_ref).toBe(CAT147);
    const item = h
      .itemsOf(run.id, 'APPLY')
      .find((i: any) => i.external_ref === CAT147);
    expect(item.before.category.sort_order).toBe(9);
    await h.runs.rollback(STORE_ID, USER_ID, run.id);
    await h.worker.tick();
    expect(
      h.db.creatorCategory.rows.find((c: any) => c.id === 'cat-own'),
    ).toMatchObject({
      external_ref: null,
      sort_order: 9,
      is_active: false,
      thumbnail_url: '/uploads/mine.webp',
    });
    expect(
      h.db.creatorCategoryTranslation.rows.find(
        (t: any) => t.creator_category_id === 'cat-own',
      ),
    ).toMatchObject({ name: 'Mina halsband', description: 'egen text' });
  });
});

describe('fix 7/8 — worker caps, app disabled, cancel', () => {
  it('stale PLANNING / ROLLING_BACK runs are capped (PLAN_FAILED / ROLLBACK_FAILED)', async () => {
    const h = await makeHarness();
    const run = await h.dryRun();
    const row = h.db.importRun.rows.find((r: any) => r.id === run.id);
    Object.assign(row, {
      status: 'PLANNING',
      heartbeat_at: new Date(0),
      attempt: 0,
    });
    await h.worker.requeueStale();
    expect(
      row.status === 'UPLOADED' ||
        h.db.importRun.rows.find((r: any) => r.id === run.id).status ===
          'UPLOADED',
    ).toBe(true);
    const r1 = h.db.importRun.rows.find((r: any) => r.id === run.id);
    expect(r1.attempt).toBe(1);
    Object.assign(r1, {
      status: 'PLANNING',
      heartbeat_at: new Date(0),
      attempt: 2,
    });
    await h.worker.requeueStale();
    expect(h.db.importRun.rows.find((r: any) => r.id === run.id).status).toBe(
      'PLAN_FAILED',
    );
    Object.assign(
      h.db.importRun.rows.find((r: any) => r.id === run.id),
      {
        status: 'ROLLING_BACK',
        heartbeat_at: new Date(0),
        attempt: 2,
      },
    );
    await h.worker.requeueStale();
    expect(h.db.importRun.rows.find((r: any) => r.id === run.id).status).toBe(
      'ROLLBACK_FAILED',
    );
  });

  it('a run claimed while the importer app is off is cancelled (IMPORT_APP_DISABLED)', async () => {
    const h = await makeHarness();
    const run = await h.dryRun();
    await h.runs.confirm(STORE_ID, USER_ID, run.id, run.plan_fingerprint!);
    const worker = new ImportWorkerService(h.db, h.engine, {
      isEnabled: jest.fn(() => Promise.resolve(false)),
    } as never);
    await worker.tick();
    const r = await h.runs.detail(STORE_ID, run.id);
    expect(r.status).toBe('CANCELLED');
    expect(r.error).toMatch(/^IMPORT_APP_DISABLED/);
    expect(h.db.product.rows).toHaveLength(0);
  });

  it('confirm clears a stale cancel request; the media cursor is saved before the first batch', async () => {
    const h = await makeHarness();
    const run = await h.dryRun();
    h.db.importRun.rows.find((r: any) => r.id === run.id).cancel_requested_at =
      new Date();
    await h.runs.confirm(STORE_ID, USER_ID, run.id, run.plan_fingerprint!);
    expect(
      h.db.importRun.rows.find((r: any) => r.id === run.id).cancel_requested_at,
    ).toBeNull();
    const seen: string[] = [];
    const update = h.db.importRun.update.bind(h.db.importRun);
    jest.spyOn(h.db.importRun, 'update').mockImplementation((args: any) => {
      const c = args?.data?.progress?.cursor;
      if (c) seen.push(`${c.phase}:${c.index}`);
      return update(args);
    });
    await h.worker.tick();
    expect(seen[0]).toBe('media:0');
    expect((await h.runs.detail(STORE_ID, run.id)).status).toMatch(
      /^COMPLETED/,
    );
    const media = h
      .itemsOf(run.id, 'APPLY')
      .filter((i: any) => i.entity_type === 'MEDIA')
      .map(key);
    expect(new Set(media).size).toBe(media.length);
  });

  it('PLANNED is only written by the claiming worker', async () => {
    const h = await makeHarness();
    const created = await h.runs.create(
      STORE_ID,
      USER_ID,
      h.source.id,
      NAMEZ_OPTIONS,
      filesOf(SLICE_DIR),
    );
    const claimed = await h.worker.claimNext();
    expect(claimed?.id).toBe(created.id);
    await expect(
      h.engine.executePlanning(created.id, {
        checkpoint: () => Promise.resolve(),
        workerId: 'someone-else',
      }),
    ).rejects.toMatchObject({ code: 'IMPORT_RUN_INTERRUPTED' });
    expect(
      h.db.importRun.rows.find((r: any) => r.id === created.id).status,
    ).toBe('PLANNING');
  });
});

describe('fix 9/10 — presets', () => {
  it('a staged preset that only adds its own fields is applied to a merchant-edited (SKIP) product', async () => {
    const h = await makeHarness({ personalization: false });
    await h.apply((await h.dryRun()).id);
    const staged = h.db.importEntity.rows.filter(
      (e: any) => e.entity_type === 'PERSONALIZATION' && e.status === 'STAGED',
    );
    // Every product with a preset is edited by the merchant.
    for (const e of staged) {
      const productId = productByRef(
        h.db,
        Number(e.external_ref.split(':')[3].split('#')[0]),
      ).id;
      trOf(h.db, productId).title = `edited ${productId}`;
    }
    (h.personalization.isAvailable as jest.Mock).mockResolvedValue(true);
    // The source changes too, so the edits decide (SKIP_MODIFIED).
    const changed = sliceEdit('posts.tsv', (c) => {
      if (c[20] === 'product') c[5] = `${c[5]} 2`;
    });
    const run = await h.dryRun(NAMEZ_OPTIONS, changed);
    const presets = h
      .itemsOf(run.id, 'PLAN')
      .filter((i: any) => i.entity_type === 'PERSONALIZATION');
    expect(planItem(h, run.id, REF(2229)).action).toBe('SKIP');
    expect(
      presets.find((i: any) => i.external_ref === `${REF(2229)}#two_names`)
        .action,
    ).toBe('CREATE');
    // Presets that read option names stay SKIP on an edited product.
    const dependent = presets.filter((i: any) =>
      /#(name_color_per_item|engraving_lines)$/.test(i.external_ref),
    );
    expect(dependent.length).toBeGreaterThan(0);
    expect(dependent.every((i: any) => i.action === 'SKIP')).toBe(true);
    await h.apply(run.id);
    expect(h.presetCalls.flatMap((c) => c.reqs.map((r) => r.key))).toContain(
      'names_equal_length',
    );
  });

  it('help images are downloaded and passed as help_images (C25/X15)', async () => {
    const h = await makeHarness();
    const run = await h.dryRun({
      ...NAMEZ_OPTIONS,
      preset_help_images: {
        names_equal_length: {
          name_1:
            'https://3dnamez.se/wp-content/uploads/2024/09/left-3dnamez.jpg',
          name_2:
            'https://namez.se/wp-content/uploads/2024/09/right-3dnamez.jpg',
          model_text: 'https://evil.example/x.jpg',
        },
      },
    });
    expect((run.summary as any).warnings.W_HELP_IMAGE_REJECTED.count).toBe(1);
    await h.apply(run.id);
    const req = h.presetCalls
      .flatMap((c) => c.reqs)
      .find((r) => r.key === 'names_equal_length')!;
    const help = req.params.help_images as Record<string, string>;
    expect(Object.keys(help).sort()).toEqual(['name_1', 'name_2']);
    expect(help.name_1).toMatch(/^\/uploads\/imports\//);
    expect(h.fetched).toContain(
      'https://namez.se/wp-content/uploads/2024/09/left-3dnamez.jpg',
    );
  });
});

describe('fix 13/14/15/17/18', () => {
  it('redirects to a product that failed are dropped (REDIRECT SKIP)', async () => {
    const h = await makeHarness();
    const run = await h.dryRun();
    const create = h.db.productTranslation.create.bind(h.db.productTranslation);
    jest
      .spyOn(h.db.productTranslation, 'create')
      .mockImplementation((args: any) =>
        args.data.slug === 'personlig-3d-namnpresent'
          ? Promise.reject(new Error('boom'))
          : create(args),
      );
    await h.apply(run.id);
    expect(
      h.db.storeRedirect.rows.some(
        (r: any) => r.to_path === '/products/personlig-3d-namnpresent',
      ),
    ).toBe(false);
    expect(
      h
        .itemsOf(run.id, 'APPLY')
        .some(
          (i: any) =>
            i.entity_type === 'REDIRECT' &&
            i.action === 'SKIP' &&
            i.external_ref === '/produkt/personlig-3d-namnpresent',
        ),
    ).toBe(true);
  });

  it('without the categories scope, never-created collections get no redirects', async () => {
    const h = await makeHarness();
    const run = await h.dryRun({
      ...NAMEZ_OPTIONS,
      scopes: { ...allScopes(), categories: false },
    });
    const red = h
      .itemsOf(run.id, 'PLAN')
      .filter((i: any) => i.entity_type === 'REDIRECT');
    expect(
      red.some((i: any) => i.external_ref.startsWith('/product-category/')),
    ).toBe(false);
  });

  it('rollback keeps a media file that a merchant description still embeds', async () => {
    const h = await makeHarness();
    const run = await h.dryRun();
    await h.apply(run.id);
    const media = h.db.importMedia.rows.find((m: any) => m.public_url);
    h.db.product.rows.push({
      id: 'm1',
      creator_id: CREATOR_ID,
      status: 'PUBLISHED',
      external_ref: null,
    });
    h.db.productTranslation.rows.push({
      id: 'm1-tr',
      product_id: 'm1',
      locale: 'sv',
      slug: 'egen',
      title: 'Egen',
      description: `<p><img src="${media.public_url}"></p>`,
    });
    await h.runs.rollback(STORE_ID, USER_ID, run.id);
    await h.worker.tick();
    expect(h.uploads.deleteFile).not.toHaveBeenCalledWith(media.public_url);
    expect(h.db.importMedia.rows.some((m: any) => m.id === media.id)).toBe(
      true,
    );
  });

  it('existing fallback fields are not claimed by the run (fix 15)', async () => {
    const h = await makeHarness();
    await h.apply(
      (await h.dryRun({ ...NAMEZ_OPTIONS, designer_fallback_fields: false }))
        .id,
    );
    const p = productByRef(h.db, 4275);
    h.db.productCustomField.rows.push({
      id: 'own-fallback',
      product_id: p.id,
      name: 'npp_namn',
      type: 'TEXT',
      preset_key: 'npp_fallback',
      preset_ref: null,
      parent_id: null,
      sort_order: 0,
    });
    const run = await h.dryRun();
    await h.apply(run.id);
    const ledger = h.db.importEntity.rows.find(
      (e: any) => e.entity_type === 'FALLBACK_FIELD',
    );
    expect(ledger.created_by_import).toBe(false);
    await h.runs.rollback(STORE_ID, USER_ID, run.id);
    await h.worker.tick();
    expect(
      h.db.productCustomField.rows.some((f: any) => f.id === 'own-fallback'),
    ).toBe(true);
  });

  it('platform stock is kept on UPDATE unless stock_on_update = overwrite (fix 17)', async () => {
    const h = await makeHarness();
    await h.apply((await h.dryRun()).id);
    const p = productByRef(h.db, 4256);
    p.stock_quantity = 7;
    await h.apply(
      (await h.dryRun(NAMEZ_OPTIONS, productPost('4256', 5, 'Ny titel'))).id,
    );
    expect(productByRef(h.db, 4256).stock_quantity).toBe(7);
    await h.apply(
      (
        await h.dryRun(
          { ...NAMEZ_OPTIONS, stock_on_update: 'overwrite' },
          productPost('4256', 5, 'Tredje titel'),
        )
      ).id,
    );
    expect(productByRef(h.db, 4256).stock_quantity).not.toBe(7);
  });

  it('children of a CONFLICT collection and products losing that link are reported (fix 18)', async () => {
    const h = await makeHarness();
    h.db.creatorCategory.rows.push({
      id: 'foreign',
      creator_id: CREATOR_ID,
      slug: 'presenter-till-vem',
      external_ref: 'other:ref',
      is_active: true,
      parent_id: null,
      sort_order: 0,
      thumbnail_url: null,
      noindex_when_empty: false,
    });
    const run = await h.dryRun();
    const w = (run.summary as any).warnings;
    expect(w.W_CATEGORY_PARENT_CONFLICT.count).toBeGreaterThan(0);
    expect(w.W_PRODUCT_CATEGORY_CONFLICT.count).toBeGreaterThan(0);
  });
});

describe('fix 23/24 — runs list', () => {
  it('counts per run; created_by_role ADMIN for a non-owner without the email', async () => {
    const h = await makeHarness();
    h.db.user.rows.push({ id: 'admin-1', email: 'admin@platform.test' });
    const mine = await h.dryRun();
    const theirs = await h.runs.create(
      STORE_ID,
      'admin-1',
      h.source.id,
      NAMEZ_OPTIONS,
      filesOf(SLICE_DIR),
    );
    const list = await h.runs.list(STORE_ID, {} as never);
    const a = list.items.find((r) => r.id === mine.id)!;
    const b = list.items.find((r) => r.id === theirs.id)!;
    expect(a).toMatchObject({
      created_by_role: 'OWNER',
      created_by_name: 'owner@example.com',
      counts_phase: 'PLAN',
    });
    expect(a.counts?.PRODUCT).toEqual({ CREATE: 7, SKIP: 1 });
    expect(b).toMatchObject({
      created_by_role: 'ADMIN',
      created_by_name: null,
    });
    expect(JSON.stringify(list)).not.toContain('admin@platform.test');
  });
});

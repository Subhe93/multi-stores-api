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
  makeHarness,
  NAMEZ_OPTIONS,
  STORE_ID,
  USER_ID,
} from '../__fixtures__/harness';

/**
 * Launch-critical repair cases on the Namez slice: the template thumbnail
 * of a designer product without images is imported on a re-run (and a
 * merchant-added image is respected), and a reverted rename never leaves a
 * redirect that shadows the live page (restored by rollback).
 */

type Item = { entity_type: string; external_ref: string; action: string };
const key = (i: Item) => `${i.entity_type}|${i.external_ref}|${i.action}`;
const keys = (items: Item[]) => new Set(items.map(key));

/** Copy of the slice with one file edited by column (`cols` → new cols). */
function sliceEdit(
  file: string,
  edit: (cols: string[]) => string[] | void,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'importer-repair-'));
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

const REF = (id: number) => `woo:namez.se:product:${id}`;
const TEMPLATE_THUMB =
  'https://namez.se/wp-content/uploads/npp-thumbnails/poster-0IBMp6sF5Zgb.jpg';
const planItem = (h: any, runId: string, ref: string, type = 'PRODUCT') =>
  h
    .itemsOf(runId, 'PLAN')
    .find((i: any) => i.external_ref === ref && i.entity_type === type);
const productByRef = (db: any, id: number) =>
  db.product.rows.find((p: any) => p.external_ref === REF(id));

describe('template thumbnail as the image of a designer product without images', () => {
  // 4326 (NPP template 4273, no `_thumbnail_id`) is on the Namez skip list;
  // it is imported here to cover the 15 production products of that shape.
  const OPTIONS = { ...NAMEZ_OPTIONS, skip_ext_ids: [] };
  /** The slice as production imported it: template 4273 without a thumbnail URL. */
  const beforeFix = () =>
    sliceEdit('postmeta.tsv', (c) => {
      if (c[1] === '4273' && c[2] === '_npp_thumbnail_url') c[3] = '';
    });

  it('the thumbnail is the single public image; an imported product without images is repaired on the re-run, then UNCHANGED', async () => {
    const h = await makeHarness();
    const first = await h.apply((await h.dryRun(OPTIONS, beforeFix())).id);
    expect(first.status).toBe('COMPLETED_WITH_WARNINGS');
    const p = productByRef(h.db, 4326);
    expect(
      h.db.productImage.rows.filter((i: any) => i.product_id === p.id),
    ).toHaveLength(0);

    const second = await h.dryRun(OPTIONS);
    const c = (second.summary as any).counts;
    expect(c.PRODUCT).toEqual({ UPDATE: 1, UNCHANGED: 7 });
    expect(planItem(h, second.id, REF(4326)).action).toBe('UPDATE');
    expect(
      (second.summary as any).warnings.W_IMAGE_FROM_TEMPLATE,
    ).toMatchObject({ count: 1, samples: [{ external_ref: REF(4326) }] });
    // One public media need for the thumbnail, through the normal pipeline.
    expect(
      h
        .itemsOf(second.id, 'PLAN')
        .filter(
          (i: any) =>
            i.entity_type === 'MEDIA' &&
            i.external_ref === `public:${TEMPLATE_THUMB}`,
        ),
    ).toHaveLength(1);

    const done = await h.apply(second.id);
    expect([done.status, done.error]).toEqual([
      'COMPLETED_WITH_WARNINGS',
      null,
    ]);
    expect(keys(h.itemsOf(second.id, 'APPLY'))).toEqual(
      keys(h.itemsOf(second.id, 'PLAN')),
    );
    const images = h.db.productImage.rows.filter(
      (i: any) => i.product_id === p.id,
    );
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ is_featured: true, sort_order: 0 });
    expect(h.stored).toContain(images[0].url);
    const media = h.db.importMedia.rows.find(
      (m: any) => m.source_url === TEMPLATE_THUMB,
    );
    expect(media.public_url).toBe(images[0].url);
    // The template's own copy (private, staged) and the public one share
    // the ledger row; the thumbnail was fetched at most once per target.
    expect(
      h.fetched.filter((u) => u === TEMPLATE_THUMB).length,
    ).toBeLessThanOrEqual(2);

    const third = await h.dryRun(OPTIONS);
    expect((third.summary as any).counts.PRODUCT).toEqual({ UNCHANGED: 8 });
  });

  it('a product the merchant already gave images to is SKIP (merchant edit), not overwritten', async () => {
    const h = await makeHarness();
    await h.apply((await h.dryRun(OPTIONS, beforeFix())).id);
    const p = productByRef(h.db, 4326);
    h.db.productImage.rows.push({
      id: 'merchant-image',
      product_id: p.id,
      variant_id: null,
      url: '/uploads/general/merchant.webp',
      alt_text: null,
      sort_order: 0,
      is_featured: true,
    });

    const run = await h.dryRun(OPTIONS);
    expect(planItem(h, run.id, REF(4326))).toMatchObject({
      action: 'SKIP',
      message: 'W_TARGET_MODIFIED_SKIPPED',
    });
    await h.apply(run.id);
    expect(
      h.db.productImage.rows.filter((i: any) => i.product_id === p.id),
    ).toEqual([expect.objectContaining({ id: 'merchant-image' })]);
  });
});

describe('redirects never shadow a live page (rename, then revert)', () => {
  const OLD = 'dalahast-svenska-presenter-sverige';
  const NEW = 'ny-dalahast';
  const renamed = () =>
    sliceEdit('posts.tsv', (c) => {
      if (c[0] === '4256' && c[20] === 'product') c[11] = NEW;
    });
  const redirectRow = (h: any, from: string) =>
    h.db.storeRedirect.rows.find((r: any) => r.from_path === from);

  it('run 3 (b→a) deactivates run 2’s a→b row, creates b→a, and rollback restores it', async () => {
    const h = await makeHarness();
    const first = await h.dryRun();
    await h.apply(first.id);

    const second = await h.dryRun(NAMEZ_OPTIONS, renamed());
    await h.apply(second.id);
    expect(redirectRow(h, `/products/${OLD}`)).toMatchObject({
      to_path: `/products/${NEW}`,
      is_active: true,
    });

    const third = await h.dryRun();
    expect(third.status).toBe('PLANNED');
    const planned = h
      .itemsOf(third.id, 'PLAN')
      .filter((i: any) => i.entity_type === 'REDIRECT');
    expect(planned.filter((i: any) => i.action === 'CONFLICT')).toEqual([]);
    expect(
      planned.find((i: any) => i.external_ref === `/products/${OLD}`),
    ).toMatchObject({ action: 'UPDATE', message: 'deactivated (live path)' });
    expect(
      planned.find((i: any) => i.external_ref === `/products/${NEW}`),
    ).toMatchObject({ action: 'CREATE' });
    expect((third.summary as any).warnings.W_REDIRECT_CONFLICT).toBeUndefined();

    await h.apply(third.id);
    expect(keys(h.itemsOf(third.id, 'APPLY'))).toEqual(
      keys(h.itemsOf(third.id, 'PLAN')),
    );
    const active = h.db.storeRedirect.rows.filter((r: any) => r.is_active);
    const livePaths = new Set(
      h.db.productTranslation.rows.map((t: any) => `/products/${t.slug}`),
    );
    expect(livePaths.has(`/products/${OLD}`)).toBe(true);
    expect(active.filter((r: any) => livePaths.has(r.from_path))).toEqual([]);
    expect(redirectRow(h, `/products/${OLD}`)).toMatchObject({
      to_path: `/products/${NEW}`,
      is_active: false,
    });
    expect(redirectRow(h, `/products/${NEW}`)).toMatchObject({
      to_path: `/products/${OLD}`,
      is_active: true,
    });
    expect(redirectRow(h, `/produkt/${OLD}`).to_path).toBe(`/products/${OLD}`);
    // No active row points at another active row's source (flattened).
    const sources = new Set(active.map((r: any) => r.from_path));
    expect(active.filter((r: any) => sources.has(r.to_path))).toEqual([]);

    await h.runs.rollback(STORE_ID, USER_ID, third.id);
    await h.worker.tick();
    expect((await h.runs.detail(STORE_ID, third.id)).status).toBe(
      'ROLLED_BACK',
    );
    expect(redirectRow(h, `/products/${OLD}`)).toMatchObject({
      to_path: `/products/${NEW}`,
      is_active: true,
    });
    expect(redirectRow(h, `/products/${NEW}`)).toBeUndefined();
    expect(
      h.db.productTranslation.rows.find(
        (t: any) => t.product_id === productByRef(h.db, 4256).id,
      ).slug,
    ).toBe(NEW);
  });
});

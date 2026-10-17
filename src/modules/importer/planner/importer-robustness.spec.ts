/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- in-memory Prisma fake rows are untyped in tests */
import { randomUUID } from 'crypto';
import {
  CREATOR_ID,
  makeHarness,
  STORE_ID,
  USER_ID,
} from '../__fixtures__/harness';
import { applyRedirects } from '../apply/apply-redirects';
import { ImportWorkerService } from '../runs/import-worker.service';
import { REPORT_CSV_PAGE } from '../runs/import-runs.service';
import { SNAPSHOT_PAGE } from './state-loader';

/**
 * M5 W1-B robustness items on the Namez slice and the in-memory Prisma fake:
 * B10 (claim re-check per product), B11 (rollback goes on past a RESTRICT),
 * B12 (no rollback under a later applied run), B14 (paged state loader,
 * plan reuse between confirm and apply, streamed CSV report) and the B22
 * redirect minors (resume marker for conflict-only plans, redirects of
 * failed collections dropped).
 */

const productRefs = (db: any): string[] =>
  db.product.rows.map((p: any) => p.external_ref).sort();

describe('B10 — worker claim re-checked before every product', () => {
  it('a taken-over worker stops before the next product transaction and writes nothing; the new worker finishes', async () => {
    const h = await makeHarness();
    const run = await h.dryRun();
    await h.runs.confirm(STORE_ID, USER_ID, run.id, run.plan_fingerprint!);
    const workerA = h.worker;
    const workerB = new ImportWorkerService(h.db as never, h.engine);
    const row = () => h.db.importRun.rows.find((r: any) => r.id === run.id);

    // Heartbeat-only run writes come from `assertClaim` (products phase):
    // product 1 → before the tx, inside the tx; the 3rd is the pre-check of
    // product 2 — that is when the claim is lost (stale heartbeat, taken).
    let claimChecks = 0;
    let stolen = false;
    const engine: any = h.engine;
    const writeRun = engine.writeRun.bind(engine);
    jest
      .spyOn(engine, 'writeRun')
      .mockImplementation((db: any, id: string, worker: any, data: any) => {
        if (data?.heartbeat_at && !data.progress && !data.summary) {
          claimChecks++;
          if (claimChecks === 3 && !stolen) {
            stolen = true;
            Object.assign(row(), {
              worker_id: 'importer-other',
              heartbeat_at: new Date(Date.now() - 60 * 60 * 1000),
            });
          }
        }
        return writeRun(db, id, worker, data);
      });
    const updateMany = h.db.importRun.updateMany.bind(h.db.importRun);
    const aAfterLoss: number[] = [];
    jest
      .spyOn(h.db.importRun, 'updateMany')
      .mockImplementation(async (args: any) => {
        const res = await updateMany(args);
        if (stolen && args?.where?.worker_id === workerA.workerId)
          aAfterLoss.push(res.count);
        return res;
      });

    await workerA.tick();
    // One product committed, the second never started; the run row is
    // untouched by the loser (still RUNNING, owned by the other worker).
    expect(h.db.product.rows).toHaveLength(1);
    expect(row().status).toBe('RUNNING');
    expect(row().worker_id).toBe('importer-other');
    expect(aAfterLoss.length).toBeGreaterThan(0);
    expect(aAfterLoss.every((n) => n === 0)).toBe(true);
    expect(
      h.db.importRunLog.rows.some(
        (l: any) => l.run_id === run.id && l.code === 'IMPORT_RUN_INTERRUPTED',
      ),
    ).toBe(true);

    // The stale run is re-queued and claimed by the second worker, which
    // resumes after the committed product (no duplicate).
    await workerB.tick();
    const done = await h.runs.detail(STORE_ID, run.id);
    expect(done.status).toBe('COMPLETED_WITH_WARNINGS');
    expect(h.db.product.rows).toHaveLength(7);
    expect(new Set(productRefs(h.db)).size).toBe(7);
    expect(
      h
        .itemsOf(run.id, 'APPLY')
        .filter((i: any) => i.entity_type === 'PRODUCT'),
    ).toHaveLength(8);
  });
});

describe('B11 — rollback continues past a product that cannot be deleted', () => {
  it('a RESTRICT relation becomes an ERROR item; the other products are rolled back and the run ends ROLLED_BACK', async () => {
    const h = await makeHarness();
    const run = await h.dryRun();
    await h.apply(run.id);
    const stuck = h.db.product.rows.find(
      (p: any) => p.external_ref === 'woo:namez.se:product:2229',
    );
    const del = h.db.product.delete.bind(h.db.product);
    jest.spyOn(h.db.product, 'delete').mockImplementation((args: any) => {
      if (args?.where?.id === stuck.id) {
        const err = Object.assign(
          new Error(
            'Foreign key constraint failed on the field: `CartItem_product_id_fkey`',
          ),
          { code: 'P2003' },
        );
        return Promise.reject(err);
      }
      return del(args);
    });
    const createMany = h.db.importRunItem.createMany.bind(h.db.importRunItem);
    let rollbackBatches = 0;
    jest
      .spyOn(h.db.importRunItem, 'createMany')
      .mockImplementation((args: any) => {
        if (args?.data?.some((d: any) => d.phase === 'ROLLBACK'))
          rollbackBatches++;
        return createMany(args);
      });

    await h.runs.rollback(STORE_ID, USER_ID, run.id);
    await h.worker.tick();
    const rolled = await h.runs.detail(STORE_ID, run.id);
    expect(rolled.status).toBe('ROLLED_BACK');
    expect((rolled.summary as any).rollback.errors).toBe(1);
    expect((rolled.summary as any).rollback.products_deleted).toBe(6);
    expect(h.db.product.rows.map((p: any) => p.id)).toEqual([stuck.id]);
    const items = h.itemsOf(run.id, 'ROLLBACK');
    expect(
      items.find(
        (i: any) => i.entity_type === 'PRODUCT' && i.target_id === stuck.id,
      ),
    ).toMatchObject({ action: 'ERROR' });
    expect(
      items.filter(
        (i: any) => i.entity_type === 'PRODUCT' && i.action === 'DELETE',
      ),
    ).toHaveLength(6);
    // The stuck product keeps its ACTIVE ledger row (a retry sees it again).
    expect(
      h.db.importEntity.rows.find(
        (e: any) => e.entity_type === 'PRODUCT' && e.target_id === stuck.id,
      ).status,
    ).toBe('ACTIVE');
    // Items were recorded step by step, not in one final write.
    expect(rollbackBatches).toBeGreaterThan(1);
  });
});

describe('B12 — no rollback under a later applied run', () => {
  it('refuses while a later COMPLETED* run exists, allows it once that run is rolled back', async () => {
    const h = await makeHarness();
    const first = await h.dryRun();
    await h.apply(first.id);
    const second = await h.dryRun();
    const applied = await h.apply(second.id);
    expect(applied.status).toMatch(/^COMPLETED/);

    await expect(
      h.runs.rollback(STORE_ID, USER_ID, first.id),
    ).rejects.toMatchObject({
      response: { code: 'IMPORT_RUN_INVALID_STATE', later_run_id: second.id },
    });
    expect(
      h.db.importRun.rows.find((r: any) => r.id === first.id).status,
    ).toMatch(/^COMPLETED/);

    await h.runs.rollback(STORE_ID, USER_ID, second.id);
    await h.worker.tick();
    expect((await h.runs.detail(STORE_ID, second.id)).status).toBe(
      'ROLLED_BACK',
    );
    const queued = await h.runs.rollback(STORE_ID, USER_ID, first.id);
    expect(queued.status).toBe('ROLLBACK_QUEUED');
  });
});

describe('B14 — scale', () => {
  it('state loader pages the creator products (500 per query) instead of one findMany', async () => {
    const h = await makeHarness();
    for (let i = 0; i < 1200; i++) {
      const id = randomUUID();
      h.db.product.rows.push({
        id,
        creator_id: CREATOR_ID,
        status: 'PUBLISHED',
        external_ref: null,
        updated_at: new Date(),
      });
      h.db.productTranslation.rows.push({
        id: `${id}-sv`,
        product_id: id,
        locale: 'sv',
        slug: `own-${i}`,
        title: `Own ${i}`,
      });
    }
    const spy = jest.spyOn(h.db.product, 'findMany');
    const run = await h.dryRun();
    expect(run.status).toBe('PLANNED');
    const pages = spy.mock.calls
      .map((c: any[]) => c[0])
      .filter((a: any) => a?.where?.creator_id === CREATOR_ID);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages.every((a: any) => a.take === SNAPSHOT_PAGE)).toBe(true);
    expect(pages.every((a: any) => a.select && !a.include)).toBe(true);
    // The plan still sees the merchant's own slugs (no collision with them).
    expect((run.summary as any).counts.PRODUCT).toEqual({ CREATE: 7, SKIP: 1 });
  });

  it('the plan built for the confirm check is reused by the apply step; a store change replans', async () => {
    const h = await makeHarness();
    const build = jest.spyOn(h.engine as any, 'buildPlan');
    const run = await h.dryRun();
    expect(build).toHaveBeenCalledTimes(1);
    await h.runs.confirm(STORE_ID, USER_ID, run.id, run.plan_fingerprint!);
    expect(build).toHaveBeenCalledTimes(2);
    await h.worker.tick();
    expect((await h.runs.detail(STORE_ID, run.id)).status).toBe(
      'COMPLETED_WITH_WARNINGS',
    );
    expect(build).toHaveBeenCalledTimes(2);

    // Second run: a product appears between confirm and apply → replan.
    const rerun = await h.dryRun();
    await h.runs.confirm(STORE_ID, USER_ID, rerun.id, rerun.plan_fingerprint!);
    const calls = build.mock.calls.length;
    h.db.product.rows.push({
      id: randomUUID(),
      creator_id: CREATOR_ID,
      status: 'DRAFT',
      external_ref: null,
      updated_at: new Date(Date.now() + 1000),
    });
    await h.worker.tick();
    expect((await h.runs.detail(STORE_ID, rerun.id)).status).toMatch(
      /^COMPLETED/,
    );
    expect(build).toHaveBeenCalledTimes(calls + 1);
  });

  it('the CSV report is streamed page by page with a BOM first', async () => {
    const h = await makeHarness();
    const run = await h.dryRun();
    h.db.importRunItem.rows = h.db.importRunItem.rows.filter(
      (i: any) => i.run_id !== run.id,
    );
    const total = REPORT_CSV_PAGE * 2 + 500;
    for (let i = 0; i < total; i++)
      h.db.importRunItem.rows.push({
        id: randomUUID(),
        run_id: run.id,
        phase: 'PLAN',
        entity_type: 'PRODUCT',
        external_ref: `ref-${i}`,
        action: 'CREATE',
        target_id: null,
        message: i % 2 ? 'a "quoted", cell' : null,
        created_at: new Date(i),
      });
    const spy = jest.spyOn(h.db.importRunItem, 'findMany');
    const stream = await h.runs.reportCsvStream(STORE_ID, run.id, 'PLAN');
    const chunks: string[] = [];
    for await (const c of stream) chunks.push(String(c));
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0].startsWith('﻿')).toBe(true);
    const text = chunks.join('');
    expect(text.split('\n').filter(Boolean)).toHaveLength(total + 1);
    const pages = spy.mock.calls
      .map((c: any[]) => c[0])
      .filter((a: any) => a?.where?.run_id === run.id);
    expect(pages).toHaveLength(3);
    expect(pages.every((a: any) => a.take === REPORT_CSV_PAGE)).toBe(true);
    // The string form (tests) strips the BOM and matches the stream.
    const whole = await h.runs.reportCsv(STORE_ID, run.id, 'PLAN');
    expect(whole).toBe(text.slice(1));
  });
});

describe('B22 — redirect phase minors', () => {
  function redirectCtx(h: any, runId: string) {
    return {
      prisma: h.db,
      storeId: STORE_ID,
      creatorId: CREATOR_ID,
      runId,
      redirects: h.redirects,
      checkpoint: jest.fn(() => Promise.resolve()),
      assertClaim: jest.fn(() => Promise.resolve()),
      log: jest.fn(() => Promise.resolve()),
    } as any;
  }

  it('a plan that only has conflicts still leaves a resume marker (the phase does not run twice)', async () => {
    const h = await makeHarness();
    const runId = randomUUID();
    h.db.storeRedirect.rows.push({
      id: 'manual-1',
      store_id: STORE_ID,
      from_path: '/old',
      to_path: '/somewhere',
      status_code: 301,
      source: 'MANUAL',
      import_run_id: null,
      is_active: true,
      created_at: new Date(0),
      updated_at: new Date(0),
    });
    const ctx = redirectCtx(h, runId);
    const upsert = jest.spyOn(h.redirects, 'bulkUpsertFromImport');
    const work: any = {
      incoming: [{ from_path: '/old', to_path: '/products/new' }],
      incoming_refs: ['p1'],
      plan: { items: [], repoints: [], conflicts: [] },
      live_conflicts: [],
      deactivate: [],
      live_paths: [],
    };
    const first = await applyRedirects(ctx, work);
    expect(first.conflicts).toBe(1);
    expect(first.created).toBe(0);
    const items = h.db.importRunItem.rows.filter(
      (i: any) => i.run_id === runId && i.entity_type === 'REDIRECT',
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ action: 'CONFLICT' });

    const again = await applyRedirects(ctx, work);
    expect(again.conflicts).toBe(0);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(
      h.db.importRunItem.rows.filter(
        (i: any) => i.run_id === runId && i.entity_type === 'REDIRECT',
      ),
    ).toHaveLength(1);
  });

  it('redirects of a collection whose apply failed are dropped (SKIP), like those of a failed product', async () => {
    const h = await makeHarness();
    const runId = randomUUID();
    h.db.importRunItem.rows.push({
      id: randomUUID(),
      run_id: runId,
      phase: 'APPLY',
      entity_type: 'CATEGORY',
      external_ref: 'cat:9',
      action: 'ERROR',
      target_id: null,
      created_at: new Date(),
    });
    const ctx = redirectCtx(h, runId);
    const res = await applyRedirects(ctx, {
      incoming: [
        { from_path: '/product-category/broken', to_path: '/collections/x' },
        { from_path: '/produkt/fine', to_path: '/products/fine' },
      ],
      incoming_refs: ['cat:9', 'p:1'],
      plan: { items: [], repoints: [], conflicts: [] },
      live_conflicts: [],
      deactivate: [],
      live_paths: [],
    } as any);
    expect(res).toMatchObject({ created: 1, dropped: 1 });
    expect(h.db.storeRedirect.rows.map((r: any) => r.from_path)).toEqual([
      '/produkt/fine',
    ]);
    expect(
      h.db.importRunItem.rows.find(
        (i: any) =>
          i.run_id === runId && i.external_ref === '/product-category/broken',
      ),
    ).toMatchObject({
      action: 'SKIP',
      message: 'source entity failed in this run',
    });
  });
});

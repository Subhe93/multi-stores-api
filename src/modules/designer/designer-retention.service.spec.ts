import { DesignAssetKind, Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PrivateStorage } from '../../common/storage/private-file-storage';
import type { RetentionService } from '../retention/retention.service';
import type { DesignerAssetsService } from './designer-assets.service';
import type { DesignerPrintQueueService } from './designer-print-queue.service';
import {
  DESIGNER_CLOSED_ORDER_STATUSES,
  DESIGNER_RETENTION_TASKS,
  DesignerRetentionService,
  originalsPurgeAt,
  snapshotPhotoIds,
  type OrderDesignRetentionRow,
} from './designer-retention.service';

// WP6 (M4.2 §9): R1–R4 as tasks of the generic retention job, R5 on demand.
// Prisma is mocked; the SQL conditions themselves are exercised by the
// claim statements (asserted by their text) and the live 0-day test.

const NOW = new Date('2026-10-16T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

/** Full SQL text of a tagged `$queryRaw` / `$executeRaw` call (nested fragments included). */
function sqlText(call: unknown[]): string {
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  return Prisma.sql(strings, ...values).sql;
}

function photo(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    store_id: 's1',
    kind: DesignAssetKind.CUSTOMER_PHOTO,
    design_id: 'd1',
    private_key: `designer/s1/2026/photo/${id}.jpg`,
    preview_key: `designer/s1/2026/photo-preview/${id}.webp`,
    public_url: null,
    mime: 'image/jpeg',
    width: 2000,
    height: 3000,
    bytes: 1000,
    sha256: 'x',
    meta: null,
    created_at: new Date(NOW.getTime() - 40 * DAY),
    purged_at: null,
    ...extra,
  };
}

function oid(
  extra: Partial<OrderDesignRetentionRow & { order_created_at: Date }> = {},
): OrderDesignRetentionRow & { order_created_at: Date } {
  return {
    id: 'oid1',
    store_id: 's1',
    order_id: 'o1',
    design_id: 'd1',
    assets: [
      { asset_id: 'p1', role: 'photo', element_id: 'slot' },
      { asset_id: 'bg1', role: 'background' },
    ],
    print_files: [{ surface: 'front', key: 'designer/s1/2026/print/oid1.png' }],
    proof_key: 'designer/s1/2026/proof/oid1.webp',
    print_status: 'READY',
    print_requested_at: new Date(NOW.getTime() - 70 * DAY),
    print_next_attempt_at: null,
    terminal_at: null,
    originals_purged_at: null,
    order_status: 'DELIVERED',
    order_created_at: new Date(NOW.getTime() - 70 * DAY),
    ...extra,
  };
}

function build(settings: Record<string, unknown> | null = null) {
  const prisma = {
    storeApp: {
      findUnique: jest.fn(() =>
        Promise.resolve(settings ? { settings } : null),
      ),
    },
    design: {
      groupBy: jest.fn(() => Promise.resolve([{ store_id: 's1' }])),
      count: jest.fn(() => Promise.resolve(0)),
      findUnique: jest.fn(
        (): Promise<Record<string, unknown> | null> => Promise.resolve(null),
      ),
      update: jest.fn(() => Promise.resolve({})),
    },
    orderItemDesign: {
      groupBy: jest.fn(() => Promise.resolve([{ store_id: 's1' }])),
      count: jest.fn(() => Promise.resolve(0)),
      findMany: jest.fn(() => Promise.resolve([] as unknown[])),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      findUnique: jest.fn(() =>
        Promise.resolve({ originals_purged_at: NOW, files_purged_at: NOW }),
      ),
    },
    designAsset: {
      findMany: jest.fn(() => Promise.resolve([] as unknown[])),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      delete: jest.fn(() => Promise.resolve({})),
    },
    cartItem: {
      deleteMany: jest.fn(() => Promise.resolve({ count: 2 })),
    },
    $queryRaw: jest.fn((..._args: unknown[]) =>
      Promise.resolve([] as unknown[]),
    ),
    $executeRaw: jest.fn((..._args: unknown[]) => Promise.resolve(1)),
  };
  // Interactive transactions run against the same mock.
  const withTx = Object.assign(prisma, {
    $transaction: jest.fn((fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma),
    ),
  });
  const assets = {
    purgeAssetFiles: jest.fn((..._args: unknown[]) => Promise.resolve()),
  };
  const storage = {
    delete: jest.fn((..._args: unknown[]) => Promise.resolve(true)),
  };
  const queue = { enqueueOrder: jest.fn(() => Promise.resolve(1)) };
  const registry = { registerTask: jest.fn() };
  const service = new DesignerRetentionService(
    withTx as unknown as PrismaService,
    assets as unknown as DesignerAssetsService,
    storage as unknown as PrivateStorage,
    queue as unknown as DesignerPrintQueueService,
    registry as unknown as RetentionService,
  );
  return { prisma: withTx, assets, storage, queue, registry, service };
}

describe('DesignerRetentionService', () => {
  it('registers the four C22 tasks', () => {
    const { service, registry } = build();
    service.onModuleInit();
    const keys = registry.registerTask.mock.calls.map(
      (c: unknown[]) => (c[0] as { key: string }).key,
    );
    expect(keys.sort()).toEqual(Object.values(DESIGNER_RETENTION_TASKS).sort());
  });

  it('reads the last saved settings whether the app is on or off', async () => {
    const off = build({ retention_days: 90, draft_retention_days: 10 });
    const s = await off.service.settingsOf('s1');
    expect(off.prisma.storeApp.findUnique).toHaveBeenCalledWith({
      where: { store_id_app_key: { store_id: 's1', app_key: 'designer' } },
      select: { settings: true },
    });
    expect(s.retention_days).toBe(90);
    expect(s.draft_retention_days).toBe(10);
    const none = await build(null).service.settingsOf('s1');
    expect(none.retention_days).toBe(60);
    expect(none.print_keep_days_after_shipped).toBe(30);
  });

  it('snapshotPhotoIds takes only photo roles', () => {
    expect(snapshotPhotoIds(oid().assets)).toEqual(['p1']);
    expect(snapshotPhotoIds(null)).toEqual([]);
  });

  describe('R1 drafts', () => {
    it('dry run counts without touching anything', async () => {
      const t = build();
      t.prisma.$queryRaw.mockResolvedValueOnce([
        { id: 'd1', store_id: 's1', proof_key: 'k' },
      ]);
      const r = await t.service.runDrafts(NOW, { dryRun: true });
      expect(r.purged).toBe(1);
      expect(t.prisma.$executeRaw).not.toHaveBeenCalled();
      expect(t.storage.delete).not.toHaveBeenCalled();
    });

    it('claims by a guarded delete, then removes proof, photos and cart lines', async () => {
      const t = build();
      t.prisma.$queryRaw.mockResolvedValueOnce([
        { id: 'd1', store_id: 's1', proof_key: 'designer/s1/proof/d1.webp' },
      ]);
      t.prisma.designAsset.findMany.mockResolvedValueOnce([photo('p1')]);
      const r = await t.service.runDrafts(NOW, { dryRun: false });
      expect(r).toMatchObject({ purged: 1, errors: 0 });
      const claim = sqlText(t.prisma.$executeRaw.mock.calls[0]);
      expect(claim).toContain('DELETE FROM "Design"');
      expect(claim).toContain('"OrderItemDesign"');
      expect(claim).toContain('"KustomCheckoutSession"');
      expect(t.prisma.cartItem.deleteMany).toHaveBeenCalledWith({
        where: { design_id: 'd1' },
      });
      expect(t.storage.delete).toHaveBeenCalledWith(
        'designer/s1/proof/d1.webp',
      );
      expect(t.assets.purgeAssetFiles).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'p1', purged_at: NOW }),
        NOW,
        { strict: true },
      );
      expect(t.prisma.designAsset.delete).toHaveBeenCalledWith({
        where: { id: 'p1' },
      });
      expect(r.details).toMatchObject({ cartLines: 2, photos: 1 });
    });

    it('leaves a design edited or ordered meanwhile alone', async () => {
      const t = build();
      t.prisma.$queryRaw.mockResolvedValueOnce([
        { id: 'd1', store_id: 's1', proof_key: 'k' },
      ]);
      t.prisma.$executeRaw.mockResolvedValueOnce(0);
      const r = await t.service.runDrafts(NOW, { dryRun: false });
      expect(r).toMatchObject({ purged: 0, skipped: 1 });
      expect(t.prisma.cartItem.deleteMany).not.toHaveBeenCalled();
      expect(t.storage.delete).not.toHaveBeenCalled();
    });

    it('a photo that cannot be deleted is reverted (R2 retries it)', async () => {
      const t = build();
      t.prisma.$queryRaw.mockResolvedValueOnce([
        { id: 'd1', store_id: 's1', proof_key: null },
      ]);
      t.prisma.designAsset.findMany.mockResolvedValueOnce([photo('p1')]);
      t.assets.purgeAssetFiles.mockRejectedValueOnce(new Error('EBUSY'));
      const r = await t.service.runDrafts(NOW, { dryRun: false });
      expect(r.errors).toBe(1);
      expect(t.prisma.designAsset.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'p1', purged_at: NOW },
        data: { purged_at: null },
      });
      expect(t.prisma.designAsset.delete).not.toHaveBeenCalled();
    });
  });

  describe('R2 orphans', () => {
    it('claims, deletes files and row; skips a raced claim', async () => {
      const t = build();
      t.prisma.$queryRaw.mockResolvedValueOnce([
        photo('p1', { design_id: null }),
        photo('p2', { design_id: null }),
      ]);
      t.prisma.$executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
      const r = await t.service.runOrphans(NOW, { dryRun: false });
      expect(r).toMatchObject({ purged: 1, skipped: 1, errors: 0 });
      const select = sqlText(t.prisma.$queryRaw.mock.calls[0]);
      expect(select).toContain('"DesignAsset"');
      expect(t.assets.purgeAssetFiles).toHaveBeenCalledTimes(1);
      expect(t.prisma.designAsset.delete).toHaveBeenCalledWith({
        where: { id: 'p1' },
      });
    });

    it('reverts the claim when a file cannot be deleted', async () => {
      const t = build();
      t.prisma.$queryRaw.mockResolvedValueOnce([
        photo('p1', { design_id: null }),
      ]);
      t.assets.purgeAssetFiles.mockRejectedValueOnce(new Error('EIO'));
      const r = await t.service.runOrphans(NOW, { dryRun: false });
      expect(r.errors).toBe(1);
      expect(t.prisma.designAsset.updateMany).toHaveBeenCalledWith({
        where: { id: 'p1', purged_at: NOW },
        data: { purged_at: null },
      });
    });
  });

  describe('R3 originals', () => {
    it('purges an OPEN order (PROCESSING) once its print is READY: no closed-order gate in R3 (U12)', async () => {
      const t = build();
      t.prisma.$queryRaw.mockResolvedValueOnce([
        oid({ order_status: 'PROCESSING' }),
      ]);
      t.prisma.designAsset.findMany.mockResolvedValueOnce([photo('p1')]);
      const r = await t.service.runOriginals(NOW, { dryRun: false });
      expect(r).toMatchObject({ purged: 1, skipped: 0 });
      expect(r.details).not.toHaveProperty('skippedOpenOrders');
      const claim = sqlText(t.prisma.$executeRaw.mock.calls[0]);
      // The claim re-checks the eligibility, never the closed statuses.
      expect(claim).toContain(`d."print_status"::text = 'READY'`);
      for (const st of DESIGNER_CLOSED_ORDER_STATUSES) {
        if (st === 'CANCELLED' || st === 'REFUNDED') continue;
        expect(claim).not.toContain(`'${st}'`);
      }
    });

    it('an OPEN order without a READY print waits for the print (inside the grace), then goes after it', async () => {
      const t = build();
      t.prisma.$queryRaw.mockResolvedValueOnce([
        oid({
          print_status: 'PENDING',
          order_status: 'PROCESSING',
          order_created_at: new Date(NOW.getTime() - 62 * DAY),
        }),
      ]);
      const r = await t.service.runOriginals(NOW, { dryRun: false });
      expect(r.details).toMatchObject({ waitingPrint: 1 });
      expect(t.queue.enqueueOrder).toHaveBeenCalledWith('o1', NOW);
      const late = build();
      late.prisma.$queryRaw.mockResolvedValueOnce([
        oid({
          print_status: 'PENDING',
          order_status: 'PROCESSING',
          order_created_at: new Date(NOW.getTime() - 68 * DAY),
        }),
      ]);
      late.prisma.designAsset.findMany.mockResolvedValueOnce([photo('p1')]);
      expect(
        (await late.service.runOriginals(NOW, { dryRun: false })).purged,
      ).toBe(1);
    });

    it('originalsPurgeAt: retention_days when READY / terminal, + 7 days grace otherwise (same rule as the creator order view)', () => {
      const created = new Date('2026-10-01T00:00:00Z');
      const base = { terminal_at: null, order_status: 'PROCESSING' };
      const at = (over: Partial<Parameters<typeof originalsPurgeAt>[2]>) =>
        originalsPurgeAt(created, 60, {
          ...base,
          print_status: 'FAILED',
          ...over,
        });
      expect(at({ print_status: 'READY' })).toEqual(
        new Date('2026-11-30T00:00:00Z'),
      );
      expect(at({ print_status: 'PENDING' })).toEqual(
        new Date('2026-12-07T00:00:00Z'),
      );
      expect(at({ terminal_at: NOW })).toEqual(
        new Date('2026-11-30T00:00:00Z'),
      );
      expect(at({ order_status: 'CANCELLED' })).toEqual(
        new Date('2026-11-30T00:00:00Z'),
      );
    });

    it('requests a print first when none is ready (inside the grace)', async () => {
      const t = build();
      t.prisma.$queryRaw.mockResolvedValueOnce([
        oid({
          print_status: 'FAILED',
          order_status: 'SHIPPED',
          order_created_at: new Date(NOW.getTime() - 62 * DAY),
        }),
      ]);
      const r = await t.service.runOriginals(NOW, { dryRun: false });
      expect(r.details).toMatchObject({ waitingPrint: 1 });
      expect(t.queue.enqueueOrder).toHaveBeenCalledWith('o1', NOW);
      expect(t.prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('purges after the 7-day grace even without a print', async () => {
      const t = build();
      t.prisma.$queryRaw.mockResolvedValueOnce([
        oid({
          print_status: 'FAILED',
          order_status: 'SHIPPED',
          order_created_at: new Date(NOW.getTime() - 68 * DAY),
        }),
      ]);
      t.prisma.designAsset.findMany.mockResolvedValueOnce([photo('p1')]);
      const r = await t.service.runOriginals(NOW, { dryRun: false });
      expect(r.purged).toBe(1);
      expect(t.queue.enqueueOrder).not.toHaveBeenCalled();
    });

    it('claims, purges the photos strictly and reverts on failure', async () => {
      const t = build();
      t.prisma.$queryRaw.mockResolvedValueOnce([oid()]);
      t.prisma.designAsset.findMany.mockResolvedValueOnce([photo('p1')]);
      t.assets.purgeAssetFiles.mockRejectedValueOnce(new Error('EIO'));
      const r = await t.service.runOriginals(NOW, { dryRun: false });
      expect(r.errors).toBe(1);
      const claim = sqlText(t.prisma.$executeRaw.mock.calls[0]);
      expect(claim).toContain('"originals_purged_at" =');
      expect(claim).toContain("<> 'RENDERING'");
      expect(t.assets.purgeAssetFiles).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'p1' }),
        NOW,
        { strict: true },
      );
      expect(t.prisma.orderItemDesign.updateMany).toHaveBeenCalledWith({
        where: { id: 'oid1', originals_purged_at: NOW },
        data: { originals_purged_at: null },
      });
    });

    it('keeps a photo another live order design still uses', async () => {
      const t = build();
      t.prisma.$queryRaw.mockResolvedValueOnce([oid()]);
      t.prisma.designAsset.findMany.mockResolvedValueOnce([photo('p1')]);
      t.prisma.orderItemDesign.findMany.mockResolvedValueOnce([
        { order_item_id: 'i2' },
      ]);
      const r = await t.service.runOriginals(NOW, { dryRun: false });
      expect(r.purged).toBe(1);
      expect(t.assets.purgeAssetFiles).not.toHaveBeenCalled();
      // Only LIVE order designs keep a shared photo.
      expect(t.prisma.orderItemDesign.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          where: expect.objectContaining({
            terminal_at: null,
            originals_purged_at: null,
            order_item: { order: { payment_status: { not: 'failed' } } },
          }),
        }),
      );
    });

    it('a terminal row (payment failed / cancelled) is purged whatever the order status, and the ordered design stripped', async () => {
      const t = build();
      t.prisma.$queryRaw.mockResolvedValueOnce([
        oid({
          order_status: 'PENDING',
          print_status: 'PENDING',
          terminal_at: NOW,
        }),
      ]);
      t.prisma.designAsset.findMany.mockResolvedValueOnce([photo('p1')]);
      t.prisma.design.findUnique.mockResolvedValueOnce({
        id: 'd1',
        status: 'ORDERED',
        proof_key: null,
      });
      const r = await t.service.runOriginals(NOW, { dryRun: false });
      expect(r.purged).toBe(1);
      const claim = sqlText(t.prisma.$executeRaw.mock.calls[0]);
      expect(claim).toContain('d."terminal_at" IS NOT NULL');
      expect(t.prisma.design.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: { state: { v: 1, texts: {}, photos: {} } },
      });
    });

    it('M5.6: the strip empties the texts / photos of an other back too (mode + template kept)', async () => {
      const t = build();
      t.prisma.$queryRaw.mockResolvedValueOnce([
        oid({
          order_status: 'PENDING',
          print_status: 'PENDING',
          terminal_at: NOW,
        }),
      ]);
      t.prisma.designAsset.findMany.mockResolvedValueOnce([photo('p1')]);
      t.prisma.design.findUnique.mockResolvedValueOnce({
        id: 'd1',
        status: 'ORDERED',
        proof_key: null,
        proof_back_key: null,
        back: {
          mode: 'other',
          template_id: '44444444-4444-4444-8444-444444444444',
          template_version_id: '55555555-5555-4555-8555-555555555555',
          state: {
            v: 1,
            texts: { greeting: 'Hej' },
            photos: { slot: { asset_id: 'p9', width: 1, height: 1 } },
          },
        },
      });
      await t.service.runOriginals(NOW, { dryRun: false });
      expect(t.prisma.design.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: {
          state: { v: 1, texts: {}, photos: {} },
          back: {
            mode: 'other',
            template_id: '44444444-4444-4444-8444-444444444444',
            template_version_id: '55555555-5555-4555-8555-555555555555',
            state: { v: 1, texts: {}, photos: {} },
          },
        },
      });
    });

    it('honours limit and deadline', async () => {
      const t = build();
      t.prisma.$queryRaw.mockResolvedValueOnce([
        oid({ id: 'a' }),
        oid({ id: 'b' }),
        oid({ id: 'c' }),
      ]);
      const r = await t.service.runOriginals(NOW, { dryRun: true, limit: 2 });
      expect(r.purged).toBe(2);
      const late = await t.service.runOriginals(NOW, {
        dryRun: true,
        deadline: Date.now() - 1,
      });
      expect(late.purged).toBe(0);
    });
  });

  describe('R4 files', () => {
    it('skips open orders and rows being rendered', async () => {
      const t = build();
      t.prisma.$queryRaw.mockResolvedValueOnce([
        oid({ order_status: 'CONFIRMED' }),
        oid({ id: 'oid2', print_status: 'RENDERING' }),
      ]);
      const r = await t.service.runFiles(NOW, { dryRun: false });
      expect(r).toMatchObject({ purged: 0, skipped: 2 });
      expect(t.prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('purges print files, proof and remaining originals (PURGED)', async () => {
      const t = build();
      t.prisma.$queryRaw.mockResolvedValueOnce([oid()]);
      t.prisma.designAsset.findMany.mockResolvedValueOnce([photo('p1')]);
      const r = await t.service.runFiles(NOW, { dryRun: false });
      expect(r.purged).toBe(1);
      const claim = sqlText(t.prisma.$executeRaw.mock.calls[0]);
      expect(claim).toContain(`'PURGED'::"DesignPrintStatus"`);
      expect(claim).toContain('COALESCE(d."originals_purged_at"');
      expect(t.storage.delete).toHaveBeenCalledWith(
        'designer/s1/2026/print/oid1.png',
      );
      expect(t.storage.delete).toHaveBeenCalledWith(
        'designer/s1/2026/proof/oid1.webp',
      );
      expect(t.assets.purgeAssetFiles).toHaveBeenCalledTimes(1);
    });

    it('purges the print PDF together with the PNG', async () => {
      const t = build();
      const files = [
        {
          surface: 'front',
          format: 'png',
          key: 'designer/s1/2026/print/oid1-front.png',
        },
        {
          surface: 'front',
          format: 'pdf',
          key: 'designer/s1/2026/print/oid1-front.pdf',
        },
      ];
      t.prisma.$queryRaw.mockResolvedValueOnce([oid({ print_files: files })]);
      t.prisma.designAsset.findMany.mockResolvedValueOnce([photo('p1')]);
      const r = await t.service.runFiles(NOW, { dryRun: false });
      expect(r.purged).toBe(1);
      expect(t.storage.delete).toHaveBeenCalledWith(
        'designer/s1/2026/print/oid1-front.png',
      );
      expect(t.storage.delete).toHaveBeenCalledWith(
        'designer/s1/2026/print/oid1-front.pdf',
      );
    });

    it('deletes the ordered design proof and clears its proof fields', async () => {
      const t = build();
      t.prisma.$queryRaw.mockResolvedValueOnce([oid()]);
      t.prisma.design.findUnique.mockResolvedValueOnce({
        id: 'd1',
        status: 'ORDERED',
        proof_key: 'designer/s1/2026/proof/d1.webp',
      });
      const r = await t.service.runFiles(NOW, { dryRun: false });
      expect(r.purged).toBe(1);
      expect(t.storage.delete).toHaveBeenCalledWith(
        'designer/s1/2026/proof/d1.webp',
      );
      expect(t.prisma.design.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        // M5.6: the back proof columns are cleared with the front ones.
        data: {
          proof_key: null,
          proof_state_sha: null,
          proof_back_key: null,
          proof_back_sha: null,
        },
      });
    });

    it('the 365-day hard cap applies to an open order; a terminal row is not "open"', async () => {
      const t = build();
      t.prisma.$queryRaw.mockResolvedValueOnce([
        oid({
          order_status: 'PROCESSING',
          order_created_at: new Date(NOW.getTime() - 366 * DAY),
        }),
        oid({ id: 'oid2', order_status: 'PENDING', terminal_at: NOW }),
      ]);
      const r = await t.service.runFiles(NOW, { dryRun: true });
      expect(r.purged).toBe(2);
    });

    it('restores the previous columns when a file cannot be deleted', async () => {
      const t = build();
      const row = oid({ originals_purged_at: null, print_status: 'READY' });
      t.prisma.$queryRaw.mockResolvedValueOnce([row]);
      t.storage.delete.mockRejectedValueOnce(new Error('EIO'));
      const r = await t.service.runFiles(NOW, { dryRun: false });
      expect(r.errors).toBe(1);
      expect(t.prisma.orderItemDesign.updateMany).toHaveBeenCalledWith({
        where: { id: 'oid1', files_purged_at: NOW },
        data: {
          files_purged_at: null,
          print_status: 'READY',
          originals_purged_at: null,
          print_requested_at: row.print_requested_at,
          print_next_attempt_at: null,
        },
      });
    });
  });

  it('M5.6: purges the back print files and the back proof with the front ones', async () => {
    const t = build();
    const files = [
      {
        surface: 'front',
        format: 'png',
        key: 'designer/s1/2026/print/oid1-front.png',
      },
      {
        surface: 'front',
        format: 'png',
        side: 'back',
        key: 'designer/s1/2026/print/oid1-back.png',
      },
      {
        surface: 'front',
        format: 'pdf',
        side: 'back',
        key: 'designer/s1/2026/print/oid1-back.pdf',
      },
    ];
    t.prisma.$queryRaw.mockResolvedValueOnce([
      oid({
        print_files: files,
        proof_back_key: 'designer/s1/2026/proof/oid1-back.webp',
      }),
    ]);
    t.prisma.designAsset.findMany.mockResolvedValueOnce([photo('p1')]);
    const r = await t.service.runFiles(NOW, { dryRun: false });
    expect(r.purged).toBe(1);
    for (const key of [
      'designer/s1/2026/print/oid1-front.png',
      'designer/s1/2026/print/oid1-back.png',
      'designer/s1/2026/print/oid1-back.pdf',
      'designer/s1/2026/proof/oid1.webp',
      'designer/s1/2026/proof/oid1-back.webp',
    ]) {
      expect(t.storage.delete).toHaveBeenCalledWith(key);
    }
  });

  describe('R5 erasure', () => {
    it('refuses while a print render runs', async () => {
      const t = build();
      t.prisma.$queryRaw.mockResolvedValueOnce([
        { ...oid({ print_status: 'RENDERING' }), files_purged_at: null },
      ]);
      await expect(
        t.service.eraseOrderItem('s1', 'o1', 'i1', NOW),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('erases at once for an open order, and is idempotent', async () => {
      const t = build();
      t.prisma.$queryRaw.mockResolvedValueOnce([
        { ...oid({ order_status: 'PROCESSING' }), files_purged_at: null },
      ]);
      const r = await t.service.eraseOrderItem('s1', 'o1', 'i1', NOW);
      expect(r.erased).toBe(true);
      expect(t.storage.delete).toHaveBeenCalled();
      t.prisma.$queryRaw.mockResolvedValueOnce([
        { ...oid(), files_purged_at: NOW },
      ]);
      const again = await t.service.eraseOrderItem('s1', 'o1', 'i1', NOW);
      expect(again.erased).toBe(false);
      expect(again.kept).toEqual([]);
    });

    it('erasure deletes the print PDF too', async () => {
      const t = build();
      const pdfKey = 'designer/s1/2026/print/oid1-front.pdf';
      t.prisma.$queryRaw.mockResolvedValueOnce([
        {
          ...oid({
            print_files: [
              {
                surface: 'front',
                format: 'png',
                key: 'designer/s1/2026/print/oid1-front.png',
              },
              { surface: 'front', format: 'pdf', key: pdfKey },
            ],
          }),
          files_purged_at: null,
        },
      ]);
      const r = await t.service.eraseOrderItem('s1', 'o1', 'i1', NOW);
      expect(r.erased).toBe(true);
      expect(t.storage.delete).toHaveBeenCalledWith(pdfKey);
    });

    it('reports photos it had to keep for another live order', async () => {
      const t = build();
      t.prisma.$queryRaw.mockResolvedValueOnce([
        { ...oid({ originals_purged_at: NOW }), files_purged_at: null },
      ]);
      t.prisma.designAsset.findMany.mockResolvedValueOnce([photo('p1')]);
      t.prisma.orderItemDesign.findMany.mockResolvedValueOnce([
        { order_item_id: 'i2' },
      ]);
      const r = await t.service.eraseOrderItem('s1', 'o1', 'i1', NOW);
      // R5 retries the originals even though R3 already ran.
      expect(t.prisma.designAsset.findMany).toHaveBeenCalled();
      expect(r.kept).toEqual([
        {
          asset_id: 'p1',
          reason: 'shared_with_live_order',
          order_item_ids: ['i2'],
        },
      ]);
    });

    it('404 for an item without a design', async () => {
      const t = build();
      await expect(
        t.service.eraseOrderItem('s1', 'o1', 'i1', NOW),
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});

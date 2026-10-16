import { Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { ImportRunStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  PRIVATE_STORAGE,
  type PrivateStorage,
} from '../../../common/storage/private-file-storage';
import { RetentionService } from '../../retention/retention.service';
import type {
  RetentionRunOptions,
  RetentionTaskResult,
} from '../../retention/retention.types';
import { deleteBundle } from './bundle-store';
import { ACTIVE_RUN_STATUSES } from './run-state';

export const IMPORTER_RETENTION_TASK = 'importer.bundles';
export const BUNDLE_RETENTION_DAYS = 30;
export const RUN_RETENTION_DAYS = 180;
const DAY = 24 * 60 * 60 * 1000;

/**
 * Retention of importer files and runs (M4.4 §9.3, C22) on M4.0's scheduler:
 * bundles and catalog snapshots are deleted 30 days after a run finished (or
 * was last touched, for runs that never ran); run rows with their items and
 * logs after 180 days. The ledger, `ImportMedia` and redirects are kept —
 * except for stores that no longer exist: `ImportEntity` / `ImportMedia`
 * have no foreign key to `Store` (fix 22), so their orphans (and the media's
 * private files) are removed here. Public `/uploads/imports/` files of a
 * deleted store are left to the store deletion / uploads cleanup.
 */
@Injectable()
export class ImporterRetentionTask implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PRIVATE_STORAGE) private readonly storage: PrivateStorage,
    @Optional() private readonly retention?: RetentionService,
  ) {}

  onModuleInit(): void {
    this.retention?.registerTask({
      key: IMPORTER_RETENTION_TASK,
      run: (now, opts) => this.run(now, opts),
    });
  }

  async run(
    now: Date,
    opts: RetentionRunOptions,
  ): Promise<RetentionTaskResult> {
    const inactive = { notIn: [...ACTIVE_RUN_STATUSES] as ImportRunStatus[] };
    const bundleCutoff = new Date(now.getTime() - BUNDLE_RETENTION_DAYS * DAY);
    const runCutoff = new Date(now.getTime() - RUN_RETENTION_DAYS * DAY);
    let purged = 0;
    let errors = 0;
    let files = 0;

    const withFiles = await this.prisma.importRun.findMany({
      where: {
        status: inactive,
        OR: [{ bundle_key: { not: null } }, { snapshot_key: { not: null } }],
        AND: [
          {
            OR: [
              { finished_at: { lt: bundleCutoff } },
              { finished_at: null, updated_at: { lt: bundleCutoff } },
            ],
          },
        ],
      },
      select: { id: true, bundle_key: true, snapshot_key: true },
      orderBy: { updated_at: 'asc' },
      take: opts.limit,
    });
    for (const r of withFiles) {
      if (opts.deadline && Date.now() > opts.deadline) break;
      if (opts.dryRun) {
        purged++;
        continue;
      }
      try {
        if (r.bundle_key)
          files += await deleteBundle(this.storage, r.bundle_key);
        if (r.snapshot_key && (await this.storage.delete(r.snapshot_key)))
          files++;
        await this.prisma.importRun.update({
          where: { id: r.id },
          data: { bundle_key: null, snapshot_key: null },
        });
        purged++;
      } catch {
        errors++;
      }
    }

    const oldRuns = await this.prisma.importRun.findMany({
      where: {
        status: inactive,
        OR: [
          { finished_at: { lt: runCutoff } },
          { finished_at: null, updated_at: { lt: runCutoff } },
        ],
        bundle_key: null,
        snapshot_key: null,
      },
      select: { id: true },
      take: opts.limit,
    });
    let runs = 0;
    if (oldRuns.length && !opts.dryRun) {
      const res = await this.prisma.importRun.deleteMany({
        where: { id: { in: oldRuns.map((r) => r.id) } },
      });
      runs = res.count;
    } else runs = oldRuns.length;

    // Ledger / media rows of deleted stores (no FK cascade).
    let orphans = 0;
    const storeIds = new Set<string>();
    for (const g of await this.prisma.importEntity.groupBy({
      by: ['store_id'],
    }))
      storeIds.add(g.store_id);
    for (const g of await this.prisma.importMedia.groupBy({ by: ['store_id'] }))
      storeIds.add(g.store_id);
    if (storeIds.size) {
      const live = new Set(
        (
          await this.prisma.store.findMany({
            where: { id: { in: [...storeIds] } },
            select: { id: true },
          })
        ).map((s) => s.id),
      );
      for (const storeId of storeIds) {
        if (live.has(storeId)) continue;
        if (opts.deadline && Date.now() > opts.deadline) break;
        if (opts.dryRun) {
          orphans++;
          continue;
        }
        try {
          const media = await this.prisma.importMedia.findMany({
            where: { store_id: storeId, private_key: { not: null } },
            select: { private_key: true },
          });
          for (const m of media)
            if (m.private_key && (await this.storage.delete(m.private_key)))
              files++;
          const a = await this.prisma.importMedia.deleteMany({
            where: { store_id: storeId },
          });
          const b = await this.prisma.importEntity.deleteMany({
            where: { store_id: storeId },
          });
          orphans += a.count + b.count;
        } catch {
          errors++;
        }
      }
    }

    return {
      purged: purged + runs + orphans,
      skipped: 0,
      errors,
      details: { bundles: purged, files, runs, orphans },
    };
  }
}

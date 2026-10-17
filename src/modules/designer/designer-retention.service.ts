/**
 * Retention of the designer app (M4.2 §9, U12; M4.5 C22/C23, WP6).
 *
 * Four tasks registered in the generic `RetentionService` (no own scheduler):
 *
 *   designer.drafts     R1  unordered drafts (DRAFT / IN_CART) not touched for
 *                           `draft_retention_days`: proof, photos, cart lines
 *                           and the design row are deleted. Skips designs an
 *                           order snapshot references or an open, unexpired
 *                           Kustom session carries (§14.7).
 *   designer.orphans    R2  customer photos without a design, older than 24 h
 *                           and not referenced by any order snapshot.
 *   designer.originals  R3  photo originals + previews of ordered designs,
 *                           `retention_days` after the order was created, once
 *                           the print is READY, the order is terminal, or a
 *                           further 7-day grace has passed (otherwise a print
 *                           render is requested first: `retention_waiting_print`).
 *                           Whatever the order status (U12): a READY print is
 *                           all production needs, so originals of an order
 *                           still in production go on schedule.
 *   designer.files      R4  print files + order proof (and originals, if R3
 *                           has not run) `print_keep_days_after_shipped` after
 *                           shipping, 14 days after cancel/refund, or 365 days
 *                           after the order (hard cap); `print_status=PURGED`.
 *
 * R5 (`eraseOrderItem`) runs R3 + R4 at once for a merchant "Erase now"
 * and reports what it had to keep (photos another live order still uses).
 *
 * Rules shared by the tasks:
 * - Print files of OPEN orders are not purged: R4 requires the order to be
 *   SHIPPED, DELIVERED, CANCELLED, REFUNDED or RETURNED, or the row to be
 *   terminal (`terminal_at`: cancelled / refunded / payment failed, whatever
 *   the order status says); other rows are only counted
 *   (`skippedOpenOrders`). The 365-day hard cap of R4 applies whatever the
 *   status. R3 has no such gate (see above). A row whose print is RENDERING
 *   is always skipped.
 * - A photo shared with another order design of the same design is kept
 *   while that one is live (not terminal, originals not purged, its order
 *   not failed).
 * - Ordered designs lose their personal data with the order: R3 strips the
 *   design's texts / photo refs, R4 / R5 delete its proof (unless a live
 *   order design shares the file) and clear its proof fields.
 * - Claim, then delete: one conditional UPDATE / DELETE claims the row (all
 *   conditions re-checked in SQL), then the files go. A storage failure
 *   reverts the claim so the next run retries.
 * - Settings are read per store and live (a change applies retroactively)
 *   straight from `StoreApp.settings`, whether the app is on or off: personal
 *   data keeps expiring on the schedule of the last saved settings after the
 *   app is switched off (defaults when nothing was ever saved).
 * - `dryRun` counts without changing anything; `limit` caps purges per task;
 *   `deadline` stops early (the next run continues).
 */
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleInit,
} from '@nestjs/common';
import {
  DesignAssetKind,
  DesignPrintStatus,
  DesignStatus,
  Prisma,
  type DesignAsset,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PRIVATE_STORAGE,
  type PrivateStorage,
} from '../../common/storage/private-file-storage';
import { RetentionService } from '../retention/retention.service';
import type {
  RetentionRunOptions,
  RetentionTaskResult,
} from '../retention/retention.types';
import { DesignerAssetsService } from './designer-assets.service';
import { designerErrors } from './designer-errors';
import { DesignerPrintQueueService } from './designer-print-queue.service';
import { releaseProofKey } from './designer-proof-keys';
import {
  normalizeDesignerSettings,
  type DesignerSettings,
} from './designer-settings';

export const DESIGNER_RETENTION_TASKS = {
  drafts: 'designer.drafts',
  orphans: 'designer.orphans',
  originals: 'designer.originals',
  files: 'designer.files',
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows read per page (§9: batches of 200 per store). */
export const DESIGNER_RETENTION_PAGE = 200;
/** R2: a photo without a design is an orphan after this long. */
export const DESIGNER_ORPHAN_AGE_MS = DAY_MS;
/** R3: originals go even without a print this many days after retention. */
export const DESIGNER_PRINT_GRACE_DAYS = 7;
/** R4: files of a cancelled / refunded order go this many days later. */
export const DESIGNER_TERMINAL_KEEP_DAYS = 14;
/** R4: hard cap after the order was created. */
export const DESIGNER_HARD_CAP_DAYS = 365;
const DEFAULT_LIMIT = 500;
/** Tasks stop this long before the caller's deadline. */
const DEADLINE_MARGIN_MS = 5_000;

/** Order statuses whose design files may be purged (never an open order). */
export const DESIGNER_CLOSED_ORDER_STATUSES = [
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'REFUNDED',
  'RETURNED',
] as const;
/** Order statuses that count as terminal for R3 (with `terminal_at`). */
export const DESIGNER_TERMINAL_ORDER_STATUSES = [
  'CANCELLED',
  'REFUNDED',
] as const;
const TERMINAL_ORDER_STATUSES = new Set<string>(
  DESIGNER_TERMINAL_ORDER_STATUSES,
);
const CLOSED = new Set<string>(DESIGNER_CLOSED_ORDER_STATUSES);

/**
 * R3 eligibility of an order design's originals (pure, shared with the
 * creator order view): purgeable `retention_days` after the order when the
 * print is READY or the order is terminal, else `retention_days` + the
 * print grace. Returns the date the originals are (or were) due.
 */
export function originalsPurgeAt(
  orderCreatedAt: Date,
  retentionDays: number,
  row: {
    print_status: string;
    terminal_at: Date | null;
    order_status: string;
  },
): Date {
  const eligible =
    row.print_status === DesignPrintStatus.READY ||
    row.terminal_at !== null ||
    TERMINAL_ORDER_STATUSES.has(row.order_status);
  const days = retentionDays + (eligible ? 0 : DESIGNER_PRINT_GRACE_DAYS);
  return new Date(orderCreatedAt.getTime() + days * DAY_MS);
}
/** The state an ordered design keeps once its personal data is gone. */
const STRIPPED_STATE = { v: 1, texts: {}, photos: {} };

/** A photo R3 / R4 / R5 kept because another live order design uses it. */
export interface KeptPhoto {
  asset_id: string;
  reason: 'shared_with_live_order';
  order_item_ids: string[];
}
/** Kustom sessions that may still create an order from their snapshot. */
const LIVE_KUSTOM_STATUSES = ['open', 'ordering'];

interface Run {
  now: Date;
  dryRun: boolean;
  limit: number;
  outOfTime: () => boolean;
  settings: (storeId: string) => Promise<DesignerSettings>;
}

interface DraftRow {
  id: string;
  store_id: string;
  proof_key: string | null;
}

/** The OrderItemDesign columns R3 / R4 read (raw SQL, joined with Order). */
export interface OrderDesignRetentionRow {
  id: string;
  store_id: string;
  order_id: string;
  design_id: string | null;
  assets: unknown;
  print_files: unknown;
  proof_key: string | null;
  print_status: string;
  print_requested_at: Date | null;
  print_next_attempt_at: Date | null;
  terminal_at: Date | null;
  originals_purged_at: Date | null;
  order_status: string;
}

type Outcome = 'purged' | 'raced' | 'error';

function iso(d: Date): Prisma.Sql {
  // Prisma stores timestamp(3) in UTC: compare as UTC, whatever the session TZ.
  return Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

function emptyResult(): RetentionTaskResult & {
  details: Record<string, number>;
} {
  return { purged: 0, skipped: 0, errors: 0, details: {} };
}

function bump(r: { details: Record<string, number> }, key: string, n = 1) {
  r.details[key] = (r.details[key] ?? 0) + n;
}

/** Photo asset ids of an order snapshot's `assets` JSON. */
export function snapshotPhotoIds(assets: unknown): string[] {
  if (!Array.isArray(assets)) return [];
  const ids = new Set<string>();
  for (const a of assets) {
    if (
      a &&
      typeof a === 'object' &&
      (a as { role?: unknown }).role === 'photo' &&
      typeof (a as { asset_id?: unknown }).asset_id === 'string'
    ) {
      ids.add((a as { asset_id: string }).asset_id);
    }
  }
  return [...ids];
}

/** Storage keys of the `print_files` JSON. */
function printFileKeys(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  return files
    .map((f) =>
      f && typeof f === 'object' ? (f as { key?: unknown }).key : null,
    )
    .filter((k): k is string => typeof k === 'string' && k.length > 0);
}

@Injectable()
export class DesignerRetentionService implements OnModuleInit {
  private readonly logger = new Logger(DesignerRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly assets: DesignerAssetsService,
    @Inject(PRIVATE_STORAGE) private readonly storage: PrivateStorage,
    @Optional() private readonly printQueue?: DesignerPrintQueueService,
    @Optional() private readonly retention?: RetentionService,
  ) {}

  onModuleInit(): void {
    if (!this.retention) return;
    const tasks: [
      string,
      (now: Date, o: RetentionRunOptions) => Promise<RetentionTaskResult>,
    ][] = [
      [DESIGNER_RETENTION_TASKS.drafts, (n, o) => this.runDrafts(n, o)],
      [DESIGNER_RETENTION_TASKS.orphans, (n, o) => this.runOrphans(n, o)],
      [DESIGNER_RETENTION_TASKS.originals, (n, o) => this.runOriginals(n, o)],
      [DESIGNER_RETENTION_TASKS.files, (n, o) => this.runFiles(n, o)],
    ];
    for (const [key, run] of tasks) {
      this.retention.registerTask({ key, run });
    }
  }

  // ── Run context ───────────────────────────────────────────────────────────

  private context(now: Date, opts: Partial<RetentionRunOptions>): Run {
    const cache = new Map<string, Promise<DesignerSettings>>();
    return {
      now,
      dryRun: opts.dryRun === true,
      limit:
        opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_LIMIT,
      outOfTime: () =>
        opts.deadline !== undefined &&
        Date.now() >= opts.deadline - DEADLINE_MARGIN_MS,
      settings: (storeId) => {
        let p = cache.get(storeId);
        if (!p) {
          p = this.settingsOf(storeId);
          cache.set(storeId, p);
        }
        return p;
      },
    };
  }

  /**
   * The store's designer settings, read from the row whether the app is on
   * or off (the last saved values keep applying; defaults when none). A DB
   * error propagates: retention never falls back to shorter defaults on a
   * hiccup.
   */
  async settingsOf(storeId: string): Promise<DesignerSettings> {
    const row = await this.prisma.storeApp.findUnique({
      where: { store_id_app_key: { store_id: storeId, app_key: 'designer' } },
      select: { settings: true },
    });
    return normalizeDesignerSettings(row?.settings ?? null);
  }

  // ── R1 drafts ─────────────────────────────────────────────────────────────

  async runDrafts(
    now: Date = new Date(),
    opts: Partial<RetentionRunOptions> = {},
  ): Promise<RetentionTaskResult> {
    const run = this.context(now, opts);
    const result = emptyResult();
    const stores = await this.prisma.design.groupBy({
      by: ['store_id'],
      where: { status: { in: [DesignStatus.DRAFT, DesignStatus.IN_CART] } },
    });
    for (const { store_id } of stores) {
      if (result.purged >= run.limit || run.outOfTime()) break;
      const s = await run.settings(store_id);
      const cutoff = daysBefore(now, s.draft_retention_days);
      let cursor = '';
      while (result.purged < run.limit && !run.outOfTime()) {
        const page = await this.prisma.$queryRaw<DraftRow[]>`
          SELECT d."id", d."store_id", d."proof_key"
          FROM "Design" d
          WHERE d."store_id" = ${store_id}
            AND d."id" > ${cursor}
            AND ${this.draftExpiredSql(cutoff, now)}
          ORDER BY d."id"
          LIMIT ${DESIGNER_RETENTION_PAGE}`;
        if (page.length === 0) break;
        cursor = page[page.length - 1].id;
        for (const d of page) {
          if (result.purged >= run.limit || run.outOfTime()) break;
          if (run.dryRun) {
            result.purged++;
            continue;
          }
          const outcome = await this.purgeDraft(d, cutoff, now, result);
          if (outcome === 'purged') result.purged++;
          else if (outcome === 'raced') result.skipped++;
          else result.errors++;
        }
        if (page.length < DESIGNER_RETENTION_PAGE) break;
      }
    }
    return result;
  }

  /** WHERE part of an expired draft `d` (shared by the select and the claim). */
  private draftExpiredSql(cutoff: Date, now: Date): Prisma.Sql {
    return Prisma.sql`d."status"::text IN ('DRAFT', 'IN_CART')
      AND d."updated_at" < ${iso(cutoff)}
      AND NOT EXISTS (
        SELECT 1 FROM "OrderItemDesign" o
        WHERE o."design_id" = d."id" AND o."terminal_at" IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM "KustomCheckoutSession" k
        WHERE k."store_id" = d."store_id"
          AND k."status" IN (${Prisma.join(LIVE_KUSTOM_STATUSES)})
          AND k."expires_at" > ${iso(now)}
          AND strpos(k."items"::text, d."id") > 0
      )`;
  }

  /**
   * Claims a draft by deleting it (and its cart lines) in one transaction,
   * with every condition re-checked; a design edited, ordered or put into a
   * Kustom session meanwhile is left alone ('raced'). Then the proof and the
   * photos go. A photo whose files cannot be deleted keeps its row (now
   * without a design), so R2 retries it as an orphan.
   */
  private async purgeDraft(
    d: DraftRow,
    cutoff: Date,
    now: Date,
    result: { details: Record<string, number> },
  ): Promise<Outcome> {
    const photos = await this.prisma.designAsset.findMany({
      where: { design_id: d.id },
    });
    const claimed = await this.prisma.$transaction(async (tx) => {
      const n = await tx.$executeRaw`
        DELETE FROM "Design" d
        WHERE d."id" = ${d.id} AND ${this.draftExpiredSql(cutoff, now)}`;
      if (n > 0) {
        const lines = await tx.cartItem.deleteMany({
          where: { design_id: d.id },
        });
        bump(result, 'cartLines', lines.count);
      }
      return n;
    });
    if (claimed === 0) return 'raced';
    let ok = true;
    if (d.proof_key) {
      try {
        // A terminal order design may still share the file (R4 frees it).
        await releaseProofKey(this.prisma, this.storage, d.proof_key, {
          strict: true,
        });
      } catch (err) {
        ok = false;
        this.logger.error(
          `Designer draft ${d.id}: proof ${d.proof_key} not deleted: ${String(err)}`,
        );
      }
    }
    for (const p of photos) {
      const r = await this.purgeLoosePhoto({ ...p, design_id: null }, now);
      if (r === 'purged') bump(result, 'photos');
      else if (r === 'error') ok = false;
    }
    return ok ? 'purged' : 'error';
  }

  // ── R2 orphans ────────────────────────────────────────────────────────────

  async runOrphans(
    now: Date = new Date(),
    opts: Partial<RetentionRunOptions> = {},
  ): Promise<RetentionTaskResult> {
    const run = this.context(now, opts);
    const result = emptyResult();
    const cutoff = new Date(now.getTime() - DESIGNER_ORPHAN_AGE_MS);
    if (run.outOfTime()) return result;
    const rows = await this.prisma.$queryRaw<DesignAsset[]>`
      SELECT a.* FROM "DesignAsset" a
      WHERE ${this.orphanSql(cutoff)}
      ORDER BY a."created_at"
      LIMIT ${run.limit}`;
    for (const a of rows) {
      if (run.outOfTime()) break;
      if (run.dryRun) {
        result.purged++;
        continue;
      }
      const claimed = await this.prisma.$executeRaw`
        UPDATE "DesignAsset" a SET "purged_at" = ${iso(now)}
        WHERE a."id" = ${a.id} AND ${this.orphanSql(cutoff)}`;
      if (claimed === 0) {
        result.skipped++;
        continue;
      }
      const r = await this.deleteClaimedPhoto(a, now);
      if (r === 'purged') result.purged++;
      else result.errors++;
    }
    return result;
  }

  private orphanSql(cutoff: Date): Prisma.Sql {
    return Prisma.sql`a."kind"::text = ${DesignAssetKind.CUSTOMER_PHOTO}
      AND a."design_id" IS NULL
      AND a."purged_at" IS NULL
      AND a."created_at" < ${iso(cutoff)}
      AND NOT EXISTS (
        SELECT 1 FROM "OrderItemDesign" o
        WHERE o."store_id" = a."store_id"
          AND o."assets" @> jsonb_build_array(jsonb_build_object('asset_id', a."id"))
      )`;
  }

  /**
   * Claims a photo that belongs to no order (R1 after its design is gone)
   * and deletes files and row; reverts the claim on failure.
   */
  private async purgeLoosePhoto(a: DesignAsset, now: Date): Promise<Outcome> {
    const claimed = await this.prisma.designAsset.updateMany({
      where: { id: a.id, purged_at: null },
      data: { purged_at: now },
    });
    if (claimed.count === 0) return 'raced';
    return this.deleteClaimedPhoto(a, now);
  }

  /** Files, then the row, of a claimed loose photo; reverts on failure. */
  private async deleteClaimedPhoto(
    a: DesignAsset,
    now: Date,
  ): Promise<Outcome> {
    try {
      await this.assets.purgeAssetFiles({ ...a, purged_at: now }, now, {
        strict: true,
      });
    } catch (err) {
      this.logger.error(
        `Designer photo ${a.id}: purge failed, claim reverted: ${String(err)}`,
      );
      await this.prisma.designAsset
        .updateMany({
          where: { id: a.id, purged_at: now },
          data: { purged_at: null },
        })
        .catch(() => undefined);
      return 'error';
    }
    await this.prisma.designAsset
      .delete({ where: { id: a.id } })
      .catch(() => undefined);
    return 'purged';
  }

  // ── R3 originals ──────────────────────────────────────────────────────────

  async runOriginals(
    now: Date = new Date(),
    opts: Partial<RetentionRunOptions> = {},
  ): Promise<RetentionTaskResult> {
    const run = this.context(now, opts);
    const result = emptyResult();
    const stores = await this.prisma.orderItemDesign.groupBy({
      by: ['store_id'],
      where: { originals_purged_at: null, files_purged_at: null },
    });
    for (const { store_id } of stores) {
      if (result.purged >= run.limit || run.outOfTime()) break;
      const s = await run.settings(store_id);
      const cutoff = daysBefore(now, s.retention_days);
      const grace = daysBefore(
        now,
        s.retention_days + DESIGNER_PRINT_GRACE_DAYS,
      );
      const waitingOrders = new Set<string>();
      let cursor = '';
      while (result.purged < run.limit && !run.outOfTime()) {
        const page = await this.orderRows(
          store_id,
          cursor,
          Prisma.sql`d."originals_purged_at" IS NULL
            AND d."files_purged_at" IS NULL
            AND o."created_at" <= ${iso(cutoff)}`,
        );
        if (page.length === 0) break;
        cursor = page[page.length - 1].id;
        for (const row of page) {
          if (result.purged >= run.limit || run.outOfTime()) break;
          if (row.print_status === DesignPrintStatus.RENDERING) {
            result.skipped++;
            bump(result, 'skippedRendering');
            continue;
          }
          // No open-order gate here (unlike R4): a READY print is all
          // production needs, and the 7-day grace bounds the wait.
          const eligible =
            originalsPurgeAt(
              row.order_created_at,
              s.retention_days,
              row,
            ).getTime() <= now.getTime();
          if (!eligible) {
            result.skipped++;
            bump(result, 'waitingPrint');
            if (!run.dryRun && !waitingOrders.has(row.order_id)) {
              waitingOrders.add(row.order_id);
              this.logger.debug(
                `retention_waiting_print: order ${row.order_id} (design ${row.id})`,
              );
              await this.printQueue
                ?.enqueueOrder(row.order_id, now)
                .catch(() => 0);
            }
            continue;
          }
          if (run.dryRun) {
            result.purged++;
            continue;
          }
          const outcome = await this.purgeOriginals(row, now, cutoff, grace);
          if (outcome === 'purged') result.purged++;
          else if (outcome === 'raced') result.skipped++;
          else result.errors++;
        }
        if (page.length < DESIGNER_RETENTION_PAGE) break;
      }
    }
    return result;
  }

  /** A page of the store's order design rows joined with their order. */
  private orderRows(
    storeId: string,
    cursor: string,
    where: Prisma.Sql,
  ): Promise<(OrderDesignRetentionRow & { order_created_at: Date })[]> {
    return this.prisma.$queryRaw`
      SELECT d."id", d."store_id", d."order_id", d."design_id", d."assets",
             d."print_files", d."proof_key", d."print_status"::text AS "print_status",
             d."print_requested_at", d."print_next_attempt_at", d."terminal_at",
             d."originals_purged_at", o."status"::text AS "order_status",
             o."created_at" AS "order_created_at"
      FROM "OrderItemDesign" d
      JOIN "Order" o ON o."id" = d."order_id"
      WHERE d."store_id" = ${storeId}
        AND d."id" > ${cursor}
        AND ${where}
      ORDER BY d."id"
      LIMIT ${DESIGNER_RETENTION_PAGE}`;
  }

  private closedSql(): Prisma.Sql {
    return Prisma.sql`o."status"::text IN (${Prisma.join([...DESIGNER_CLOSED_ORDER_STATUSES])})`;
  }

  /** R3 claim + delete; the claim is reverted when a file cannot be deleted. */
  private async purgeOriginals(
    row: OrderDesignRetentionRow,
    now: Date,
    cutoff: Date,
    grace: Date,
  ): Promise<Outcome> {
    const claimed = await this.prisma.$executeRaw`
      UPDATE "OrderItemDesign" d
      SET "originals_purged_at" = ${iso(now)}, "updated_at" = ${iso(now)}
      FROM "Order" o
      WHERE d."id" = ${row.id}
        AND o."id" = d."order_id"
        AND d."originals_purged_at" IS NULL
        AND d."files_purged_at" IS NULL
        AND d."print_status"::text <> 'RENDERING'
        AND o."created_at" <= ${iso(cutoff)}
        AND (
          d."print_status"::text = 'READY'
          OR d."terminal_at" IS NOT NULL
          OR o."status"::text IN (${Prisma.join([...DESIGNER_TERMINAL_ORDER_STATUSES])})
          OR o."created_at" <= ${iso(grace)}
        )`;
    if (claimed === 0) return 'raced';
    try {
      await this.deleteOriginals(row, now);
      await this.cleanupDesign(row, { strip: true, proof: false });
      return 'purged';
    } catch (err) {
      this.logger.error(
        `Designer order design ${row.id}: originals purge failed, claim reverted: ${String(err)}`,
      );
      await this.prisma.orderItemDesign
        .updateMany({
          where: { id: row.id, originals_purged_at: now },
          data: { originals_purged_at: null },
        })
        .catch(() => undefined);
      return 'error';
    }
  }

  /**
   * Deletes the photo originals + previews of an order design (rows stay,
   * `purged_at` set). A photo another not-yet-purged order design of the
   * same design still uses is kept for that one. Throws on storage errors.
   */
  private async deleteOriginals(
    row: Pick<OrderDesignRetentionRow, 'id' | 'store_id' | 'assets'>,
    now: Date,
  ): Promise<KeptPhoto[]> {
    const kept: KeptPhoto[] = [];
    const ids = snapshotPhotoIds(row.assets);
    if (!ids.length) return kept;
    const photos = await this.prisma.designAsset.findMany({
      where: {
        id: { in: ids },
        store_id: row.store_id,
        kind: DesignAssetKind.CUSTOMER_PHOTO,
        purged_at: null,
      },
    });
    for (const p of photos) {
      if (p.design_id) {
        // Only a LIVE order design keeps a shared photo: not terminal
        // (cancelled / refunded / payment failed), originals not purged,
        // its order not failed.
        const shared = await this.prisma.orderItemDesign.findMany({
          where: {
            design_id: p.design_id,
            id: { not: row.id },
            originals_purged_at: null,
            terminal_at: null,
            order_item: { order: { payment_status: { not: 'failed' } } },
          },
          select: { order_item_id: true },
        });
        if (shared.length > 0) {
          kept.push({
            asset_id: p.id,
            reason: 'shared_with_live_order',
            order_item_ids: shared.map((x) => x.order_item_id),
          });
          continue;
        }
      }
      await this.assets.purgeAssetFiles(p, now, { strict: true });
    }
    return kept;
  }

  /**
   * Personal data an ORDERED design still holds once its order design is
   * purged: `strip` empties its texts / photo refs (R3; only when no other
   * live order design of it keeps originals), `proof` deletes its proof
   * file unless a live order design shares it, and clears its proof fields
   * (R4 / R5). Designs that are drafts again (released after a failed
   * payment) are left alone. Throws on storage errors (claim reverted).
   */
  private async cleanupDesign(
    row: Pick<OrderDesignRetentionRow, 'id' | 'design_id'>,
    opts: { strip: boolean; proof: boolean },
  ): Promise<void> {
    if (!row.design_id) return;
    const d = await this.prisma.design.findUnique({
      where: { id: row.design_id },
      select: { id: true, status: true, proof_key: true },
    });
    if (!d || d.status !== DesignStatus.ORDERED) return;
    if (opts.strip) {
      const others = await this.prisma.orderItemDesign.count({
        where: {
          design_id: d.id,
          id: { not: row.id },
          originals_purged_at: null,
          terminal_at: null,
        },
      });
      if (others === 0) {
        await this.prisma.design.update({
          where: { id: d.id },
          data: { state: STRIPPED_STATE as Prisma.InputJsonValue },
        });
      }
    }
    if (opts.proof && d.proof_key) {
      await releaseProofKey(this.prisma, this.storage, d.proof_key, {
        exceptDesignId: d.id,
        exceptOrderDesignId: row.id,
        strict: true,
      });
      await this.prisma.design.update({
        where: { id: d.id },
        data: { proof_key: null, proof_state_sha: null },
      });
    }
  }

  // ── R4 files ──────────────────────────────────────────────────────────────

  async runFiles(
    now: Date = new Date(),
    opts: Partial<RetentionRunOptions> = {},
  ): Promise<RetentionTaskResult> {
    const run = this.context(now, opts);
    const result = emptyResult();
    const stores = await this.prisma.orderItemDesign.groupBy({
      by: ['store_id'],
      where: { files_purged_at: null },
    });
    for (const { store_id } of stores) {
      if (result.purged >= run.limit || run.outOfTime()) break;
      const s = await run.settings(store_id);
      const due = this.filesDueSql(now, s);
      const hard = daysBefore(now, DESIGNER_HARD_CAP_DAYS);
      let cursor = '';
      while (result.purged < run.limit && !run.outOfTime()) {
        const page = await this.orderRows(
          store_id,
          cursor,
          Prisma.sql`d."files_purged_at" IS NULL AND ${due}`,
        );
        if (page.length === 0) break;
        cursor = page[page.length - 1].id;
        for (const row of page) {
          if (result.purged >= run.limit || run.outOfTime()) break;
          if (
            !CLOSED.has(row.order_status) &&
            !row.terminal_at &&
            row.order_created_at.getTime() > hard.getTime()
          ) {
            result.skipped++;
            bump(result, 'skippedOpenOrders');
            continue;
          }
          if (row.print_status === DesignPrintStatus.RENDERING) {
            result.skipped++;
            bump(result, 'skippedRendering');
            continue;
          }
          if (run.dryRun) {
            result.purged++;
            continue;
          }
          const outcome = await this.purgeFiles(
            row,
            now,
            Prisma.sql`(${this.closedSql()}
              OR d."terminal_at" IS NOT NULL
              OR o."created_at" <= ${iso(hard)}) AND ${due}`,
          );
          if (outcome === 'purged') result.purged++;
          else if (outcome === 'raced') result.skipped++;
          else result.errors++;
        }
        if (page.length < DESIGNER_RETENTION_PAGE) break;
      }
    }
    return result;
  }

  /** R4 window: shipped + keep days, terminal + 14 days, or created + 365 days. */
  private filesDueSql(now: Date, s: DesignerSettings): Prisma.Sql {
    const shipped = daysBefore(now, s.print_keep_days_after_shipped);
    const terminal = daysBefore(now, DESIGNER_TERMINAL_KEEP_DAYS);
    const hard = daysBefore(now, DESIGNER_HARD_CAP_DAYS);
    return Prisma.sql`(
      d."shipped_at" <= ${iso(shipped)}
      OR d."terminal_at" <= ${iso(terminal)}
      OR o."created_at" <= ${iso(hard)}
    )`;
  }

  /**
   * R4 / R5 claim + delete: `files_purged_at`, PURGED and (if still unset)
   * `originals_purged_at` in one conditional UPDATE, then the print files,
   * the order proof and the originals. On a storage failure the previous
   * column values are restored so the next run retries.
   */
  private async purgeFiles(
    row: OrderDesignRetentionRow,
    now: Date,
    extra: Prisma.Sql,
    kept: KeptPhoto[] = [],
    /** R5: retry the originals even when R3 already ran. */
    forceOriginals = false,
  ): Promise<Outcome> {
    const claimed = await this.prisma.$executeRaw`
      UPDATE "OrderItemDesign" d
      SET "files_purged_at" = ${iso(now)},
          "print_status" = 'PURGED'::"DesignPrintStatus",
          "originals_purged_at" = COALESCE(d."originals_purged_at", ${iso(now)}),
          "print_requested_at" = NULL,
          "print_next_attempt_at" = NULL,
          "updated_at" = ${iso(now)}
      FROM "Order" o
      WHERE d."id" = ${row.id}
        AND o."id" = d."order_id"
        AND d."files_purged_at" IS NULL
        AND d."print_status"::text <> 'RENDERING'
        AND ${extra}`;
    if (claimed === 0) return 'raced';
    try {
      for (const key of printFileKeys(row.print_files)) {
        await this.storage.delete(key);
      }
      // The ordered design's own proof (often the same file) goes too.
      await this.cleanupDesign(row, { strip: true, proof: true });
      // A proof key shared with another live order design (or a design
      // that is a draft again) stays for it.
      await releaseProofKey(this.prisma, this.storage, row.proof_key, {
        exceptOrderDesignId: row.id,
        strict: true,
      });
      if (!row.originals_purged_at || forceOriginals) {
        kept.push(...(await this.deleteOriginals(row, now)));
      }
      return 'purged';
    } catch (err) {
      this.logger.error(
        `Designer order design ${row.id}: files purge failed, claim reverted: ${String(err)}`,
      );
      await this.prisma.orderItemDesign
        .updateMany({
          where: { id: row.id, files_purged_at: now },
          data: {
            files_purged_at: null,
            print_status: row.print_status as DesignPrintStatus,
            originals_purged_at: row.originals_purged_at,
            print_requested_at: row.print_requested_at,
            print_next_attempt_at: row.print_next_attempt_at,
          },
        })
        .catch(() => undefined);
      return 'error';
    }
  }

  // ── R5 erasure ────────────────────────────────────────────────────────────

  /**
   * Merchant "Erase personal images now" (R5 = R3 + R4 at once): photo
   * originals, previews, print files and the proof of one order item,
   * whatever the order status. 409 DESIGNER_PRINT_NOT_READY while a print
   * render is running (retry in a minute); idempotent once erased.
   */
  async eraseOrderItem(
    storeId: string,
    orderId: string,
    itemId: string,
    now: Date = new Date(),
  ): Promise<{
    erased: boolean;
    originals_purged_at: Date | null;
    files_purged_at: Date | null;
    /** Photos kept because another live order design still uses them. */
    kept: KeptPhoto[];
  }> {
    const rows = await this.prisma.$queryRaw<OrderDesignRetentionRow[]>`
      SELECT d."id", d."store_id", d."order_id", d."design_id", d."assets",
             d."print_files", d."proof_key", d."print_status"::text AS "print_status",
             d."print_requested_at", d."print_next_attempt_at", d."terminal_at",
             d."originals_purged_at", o."status"::text AS "order_status",
             d."files_purged_at"
      FROM "OrderItemDesign" d
      JOIN "Order" o ON o."id" = d."order_id"
      WHERE d."store_id" = ${storeId}
        AND d."order_id" = ${orderId}
        AND d."order_item_id" = ${itemId}
      LIMIT 1`;
    const row = rows[0] as
      | (OrderDesignRetentionRow & { files_purged_at: Date | null })
      | undefined;
    if (!row) {
      throw designerErrors.notFound(
        'DESIGNER_DESIGN_NOT_FOUND',
        'This order item has no design.',
      );
    }
    if (row.files_purged_at) {
      // Already purged by R4 / an earlier R5: finish what may be left (a
      // photo kept back then whose other order is gone, the design's
      // proof / texts) and report what still has to stay.
      const kept = await this.deleteOriginals(row, now);
      await this.cleanupDesign(row, { strip: true, proof: true });
      return {
        erased: false,
        originals_purged_at: row.originals_purged_at,
        files_purged_at: row.files_purged_at,
        kept,
      };
    }
    if (row.print_status === DesignPrintStatus.RENDERING) {
      throw designerErrors.conflict(
        'DESIGNER_PRINT_NOT_READY',
        'A print render is running; try again in a minute.',
        { print_status: row.print_status },
      );
    }
    const kept: KeptPhoto[] = [];
    // R5 runs R3 even when an earlier R3 already ran (originals kept for a
    // then-live shared order are retried).
    const outcome = await this.purgeFiles(
      row,
      now,
      Prisma.sql`TRUE`,
      kept,
      true,
    );
    if (outcome === 'error') {
      throw new Error('The design files could not be deleted; try again.');
    }
    this.logger.log(
      `Designer R5 erasure of order design ${row.id}${kept.length ? ` (${kept.length} shared photo(s) kept)` : ''}`,
    );
    const after = await this.prisma.orderItemDesign.findUnique({
      where: { id: row.id },
      select: { originals_purged_at: true, files_purged_at: true },
    });
    return {
      erased: outcome === 'purged',
      originals_purged_at: after?.originals_purged_at ?? null,
      files_purged_at: after?.files_purged_at ?? null,
      kept,
    };
  }
}

/**
 * Print-render queue of the designer app (M4.2 §5.3, D10, WP5).
 *
 * DB-backed: the queue IS `OrderItemDesign` (one row per order item, so the
 * queue is idempotent per order item by construction). States
 * (`print_status`):
 *
 *   PENDING   + print_requested_at = null   → waiting for payment / cancelled
 *   PENDING   + print_requested_at set      → queued
 *   RENDERING (print_locked_at)             → claimed by a worker
 *   READY     (print_files, print_rendered_at)
 *   FAILED    + print_next_attempt_at       → retried after a backoff
 *   FAILED    + print_attempts >= MAX       → final; "Regenerate" resets it
 *   PURGED                                  → files deleted by retention (WP6)
 *
 * Worker: a `setInterval` (15 s, `unref`) plus `nudge()` after enqueue.
 * Claims with `FOR UPDATE SKIP LOCKED`, so several API instances share the
 * queue safely; a RENDERING row whose lock is older than 10 minutes (crashed
 * worker) is reclaimed. Only rows of stores where the `designer` app is in
 * effect, and never rows of a terminal order (`terminal_at`), are claimed:
 * with the app off there is no queue work and no browser launch. The
 * bookkeeping (`print_requested_at`, `terminal_at`, `shipped_at`) is kept
 * whether the app is on or off, so switching it on resumes the queue; a
 * periodic backfill also requests the rows of paid / COD orders that were
 * never requested. Each job has a timeout; failures back off 1 min, 10 min
 * (then 1 h if MAX is raised) and stop after MAX attempts; deterministic
 * failures (purged / missing files, invalid spec) and failures of an order
 * cancelled meanwhile fail at once. On shutdown the rows this instance is
 * rendering are handed back (PENDING, attempt not counted).
 *
 * An instance without a browser never burns attempts: every pass probes the
 * render host before its first claim, and a job that fails with
 * DESIGNER_RENDER_UNAVAILABLE (engine off, browser cannot start, lane
 * saturated) hands its row back exactly like a shutdown does (PENDING,
 * attempt not counted, due again in PRINT_RENDER_PAUSE_MS) and pauses this
 * instance's claims for the same window, so another instance can take it.
 *
 * Environment:
 *   DESIGNER_RENDER_QUEUE=off   no worker on this instance (tests, web-only
 *                               instances); enqueue still records requests
 *   DESIGNER_WORKER=off         alias (design §5.3)
 *   DESIGNER_RENDER_ENGINE=off  no browser: the worker does not run either
 *   DESIGNER_RENDER_CONCURRENCY 1 (default) or 2 parallel jobs per instance
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  DesignPrintStatus,
  Prisma,
  type OrderItemDesign,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { withTimeout } from '../../common/chromium/browser-host';
import {
  PRIVATE_STORAGE,
  type PrivateStorage,
} from '../../common/storage/private-file-storage';
import { designerErrors } from './designer-errors';
import {
  classifyRenderError,
  DesignerRenderService,
  printFilesJson,
  type PrintFile,
} from './designer-render.service';
import { isOffFlag } from './render/designer-chromium.host';
import { releaseProofKey } from './designer-proof-keys';

export const PRINT_QUEUE_TICK_MS = 15_000;
/** Total attempts per request (§5.3: `print_attempts < 3`). */
export const PRINT_MAX_ATTEMPTS = 3;
/** Backoff after attempt n (1-based): 1 min, 10 min, 1 h. */
export const PRINT_BACKOFF_MS = [60_000, 10 * 60_000, 60 * 60_000];
/** A RENDERING row older than this is considered abandoned. */
export const PRINT_STALE_LOCK_MINUTES = 10;
/** Whole-job budget (input preparation + canvas + encoding + storage). */
export const PRINT_JOB_TIMEOUT_MS = 3 * 60_000;
/** Jobs one tick processes at most (per worker lane). */
export const PRINT_JOBS_PER_TICK = 20;
/** The backfill of never-requested paid / COD rows runs at most this often. */
export const PRINT_BACKFILL_INTERVAL_MS = 10 * 60_000;
/**
 * Browser-less instance: how long a handed-back row waits before it is due
 * again and how long this instance stops claiming (the browser host's own
 * launch-retry window is shorter, so the next probe gets a fresh launch).
 */
export const PRINT_RENDER_PAUSE_MS = 60_000;
/** Order statuses whose design rows are never requested by the backfill. */
const BACKFILL_SKIP_STATUSES = Prisma.raw(
  `('CANCELLED', 'REFUNDED', 'RETURNED')`,
);
const ERROR_MAX = 500;
const STALE_INTERVAL = Prisma.raw(
  `interval '${PRINT_STALE_LOCK_MINUTES} minutes'`,
);

export function backoffMs(attempt: number): number {
  return PRINT_BACKOFF_MS[
    Math.min(Math.max(attempt, 1), PRINT_BACKOFF_MS.length) - 1
  ];
}

/** Reads the queue flags of this instance. */
export function printQueueConfig(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  reason?: string;
  concurrency: number;
} {
  const concurrency = Number(env.DESIGNER_RENDER_CONCURRENCY) === 2 ? 2 : 1;
  if (isOffFlag(env.DESIGNER_RENDER_QUEUE)) {
    return { enabled: false, reason: 'DESIGNER_RENDER_QUEUE=off', concurrency };
  }
  if (isOffFlag(env.DESIGNER_WORKER)) {
    return { enabled: false, reason: 'DESIGNER_WORKER=off', concurrency };
  }
  if (isOffFlag(env.DESIGNER_RENDER_ENGINE)) {
    return {
      enabled: false,
      reason: 'DESIGNER_RENDER_ENGINE=off',
      concurrency,
    };
  }
  return { enabled: true, concurrency };
}

export type ClaimedRow = Pick<
  OrderItemDesign,
  | 'id'
  | 'store_id'
  | 'order_id'
  | 'template_spec'
  | 'state'
  | 'proof_key'
  | 'files_purged_at'
  | 'originals_purged_at'
  | 'print_attempts'
  | 'print_locked_at'
>;

@Injectable()
export class DesignerPrintQueueService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(DesignerPrintQueueService.name);
  private readonly config = printQueueConfig();
  private timer: NodeJS.Timeout | null = null;
  private nudgeTimer: NodeJS.Timeout | null = null;
  private lanes = 0;
  private stopped = false;
  private lastBackfill = 0;
  /** No claims before this time (ms): the render engine was unavailable. */
  private pauseUntil = 0;
  /** Rows this instance is rendering: id → lock timestamp (shutdown release). */
  private readonly inflight = new Map<string, Date | null>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly render: DesignerRenderService,
    @Inject(PRIVATE_STORAGE) private readonly storage: PrivateStorage,
  ) {}

  /** Whether this instance runs the worker. */
  get workerEnabled(): boolean {
    return this.config.enabled && !this.stopped;
  }

  /** Until when (ms epoch) this instance claims nothing; 0 = not paused. */
  get pausedUntil(): number {
    return this.pauseUntil;
  }

  /** Stops claiming for PRINT_RENDER_PAUSE_MS (the engine is unavailable). */
  pause(reason: string, now: number = Date.now()): void {
    const until = now + PRINT_RENDER_PAUSE_MS;
    if (until <= this.pauseUntil) return;
    this.pauseUntil = until;
    this.logger.warn(
      `Designer print worker paused for ${PRINT_RENDER_PAUSE_MS / 1000} s: ${reason}`,
    );
  }

  onModuleInit(): void {
    if (!this.config.enabled) {
      this.logger.log(`Designer print worker disabled (${this.config.reason})`);
      return;
    }
    this.timer = setInterval(() => void this.tick(), PRINT_QUEUE_TICK_MS);
    // Never keep the event loop alive just for the worker.
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.timer = null;
    this.nudgeTimer = null;
    await this.releaseInflight();
  }

  /**
   * Graceful shutdown: the rows this instance still holds go back to
   * PENDING (the interrupted attempt is not counted), fenced by the lock
   * timestamp so a row another worker reclaimed is left alone. A late
   * result of the interrupted job then misses its fence and is dropped.
   */
  async releaseInflight(): Promise<number> {
    let released = 0;
    for (const [id, lockedAt] of [...this.inflight]) {
      try {
        released += await this.handBack(id, lockedAt, null);
      } catch (e) {
        this.logger.warn(
          `Designer print ${id}: lock not released on shutdown: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      this.inflight.delete(id);
    }
    if (released > 0) {
      this.logger.log(`Designer print worker released ${released} row(s)`);
    }
    return released;
  }

  /**
   * Returns a RENDERING row this instance holds to PENDING without counting
   * the attempt, fenced by its lock timestamp. `nextAttemptAt` delays the
   * next claim (browser-less instance); null makes it due at once.
   */
  private async handBack(
    id: string,
    lockedAt: Date | null,
    nextAttemptAt: Date | null,
  ): Promise<number> {
    const res = await this.prisma.orderItemDesign.updateMany({
      where: {
        id,
        print_status: DesignPrintStatus.RENDERING,
        print_locked_at: lockedAt,
      },
      data: {
        print_status: DesignPrintStatus.PENDING,
        print_locked_at: null,
        print_attempts: { decrement: 1 },
        ...(nextAttemptAt ? { print_next_attempt_at: nextAttemptAt } : {}),
      },
    });
    return res.count;
  }

  /** Runs a tick soon (after an enqueue / regenerate); no-op when disabled. */
  nudge(): void {
    if (!this.workerEnabled || this.nudgeTimer) return;
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      void this.tick();
    }, 50);
    this.nudgeTimer.unref?.();
  }

  // ── Producer side ────────────────────────────────────────────────────────

  /**
   * Requests the print renders of an order (paid / COD). Idempotent: rows
   * already requested, rendered, purged or of a terminal order are left
   * alone, so a replayed webhook never re-renders. Returns the number of
   * rows queued; nudges the worker when > 0.
   */
  async enqueueOrder(orderId: string, now: Date = new Date()): Promise<number> {
    const res = await this.prisma.orderItemDesign.updateMany({
      where: {
        order_id: orderId,
        print_requested_at: null,
        files_purged_at: null,
        terminal_at: null,
        print_status: {
          in: [DesignPrintStatus.PENDING, DesignPrintStatus.FAILED],
        },
      },
      data: {
        print_requested_at: now,
        print_status: DesignPrintStatus.PENDING,
        print_attempts: 0,
        print_next_attempt_at: null,
        print_error: null,
      },
    });
    if (res.count > 0) this.nudge();
    return res.count;
  }

  /**
   * A paid order that was terminal (a Kustom push after the abandoned-order
   * sweep failed it): its rows are live again and the designs it froze are
   * frozen again. Never for a cancelled / refunded / returned order.
   * Returns the number of rows revived.
   */
  async reviveOrder(orderId: string): Promise<number> {
    const rows = await this.prisma.orderItemDesign.findMany({
      where: {
        order_id: orderId,
        terminal_at: { not: null },
        files_purged_at: null,
        order_item: {
          order: { status: { notIn: ['CANCELLED', 'REFUNDED', 'RETURNED'] } },
        },
      },
      select: { id: true, design_id: true },
    });
    if (!rows.length) return 0;
    const res = await this.prisma.orderItemDesign.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { terminal_at: null },
    });
    const designIds = rows
      .map((r) => r.design_id)
      .filter((id): id is string => !!id);
    if (designIds.length) {
      await this.prisma.design.updateMany({
        where: { id: { in: designIds } },
        data: { status: 'ORDERED' },
      });
    }
    return res.count;
  }

  /**
   * The order's payment failed / was abandoned: its rows become terminal
   * (pending requests withdrawn) and every design it froze that no other
   * live order design uses is released (IN_CART: editable and orderable
   * again; the draft retention clock restarts from its `updated_at`).
   */
  async markPaymentFailed(
    orderId: string,
    now: Date = new Date(),
  ): Promise<{ rows: number; released: number }> {
    const rows = await this.cancelOrder(orderId, now);
    const own = await this.prisma.orderItemDesign.findMany({
      where: { order_id: orderId, design_id: { not: null } },
      select: { design_id: true },
    });
    const ids = [
      ...new Set(own.map((r) => r.design_id).filter((x): x is string => !!x)),
    ];
    if (!ids.length) return { rows, released: 0 };
    const busy = await this.prisma.orderItemDesign.findMany({
      where: {
        design_id: { in: ids },
        order_id: { not: orderId },
        terminal_at: null,
      },
      select: { design_id: true },
    });
    const keep = new Set(busy.map((b) => b.design_id));
    const free = ids.filter((id) => !keep.has(id));
    const res = free.length
      ? await this.prisma.design.updateMany({
          where: { id: { in: free }, status: 'ORDERED' },
          data: { status: 'IN_CART', updated_at: now },
        })
      : { count: 0 };
    return { rows, released: res.count };
  }

  /**
   * True when the store has any order design (cheap existence probe for
   * the triggers / email of a store whose app is off).
   */
  async storeHasDesigns(storeId: string): Promise<boolean> {
    const row = await this.prisma.orderItemDesign.findFirst({
      where: { store_id: storeId },
      select: { id: true },
    });
    return !!row;
  }

  /**
   * Withdraws pending requests of an order (CANCELLED / REFUNDED / failed
   * payment) and marks its rows terminal. A render already RENDERING
   * finishes; if it fails it is not retried (terminal rows are never
   * claimed). Returns the number of rows newly marked terminal.
   */
  async cancelOrder(orderId: string, now: Date = new Date()): Promise<number> {
    const terminal = await this.prisma.orderItemDesign.updateMany({
      where: { order_id: orderId, terminal_at: null },
      data: { terminal_at: now },
    });
    await this.prisma.orderItemDesign.updateMany({
      where: {
        order_id: orderId,
        print_status: {
          in: [DesignPrintStatus.PENDING, DesignPrintStatus.FAILED],
        },
        print_requested_at: { not: null },
      },
      data: { print_requested_at: null, print_next_attempt_at: null },
    });
    return terminal.count;
  }

  /** Records the shipping date (retention R4 counts from it). */
  async markShipped(orderId: string, now: Date = new Date()): Promise<number> {
    const res = await this.prisma.orderItemDesign.updateMany({
      where: { order_id: orderId, shipped_at: null },
      data: { shipped_at: now },
    });
    return res.count;
  }

  /**
   * Creator "Regenerate" (and "Retry"): back to PENDING with attempts 0.
   * Allowed until the files are purged. Returns the updated row count.
   */
  async regenerate(
    where: { id: string; store_id: string },
    now: Date = new Date(),
  ): Promise<number> {
    const res = await this.prisma.orderItemDesign.updateMany({
      where: {
        id: where.id,
        store_id: where.store_id,
        files_purged_at: null,
        terminal_at: null,
        print_status: { not: DesignPrintStatus.RENDERING },
      },
      data: {
        print_status: DesignPrintStatus.PENDING,
        print_attempts: 0,
        print_next_attempt_at: null,
        print_error: null,
        print_requested_at: now,
      },
    });
    if (res.count > 0) this.nudge();
    return res.count;
  }

  // ── Creator routes ───────────────────────────────────────────────────────

  /** `GET designer/my/print-queue`: rows of the store, newest request first. */
  async list(
    storeId: string,
    q: { status?: DesignPrintStatus; page?: number; limit?: number } = {},
  ) {
    const limit = Math.min(Math.max(q.limit ?? 25, 1), 100);
    const page = Math.max(q.page ?? 1, 1);
    const where: Prisma.OrderItemDesignWhereInput = {
      store_id: storeId,
      ...(q.status ? { print_status: q.status } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.orderItemDesign.count({ where }),
      this.prisma.orderItemDesign.findMany({
        where,
        orderBy: [{ print_requested_at: 'desc' }, { created_at: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          order_id: true,
          order_item_id: true,
          store_id: true,
          assets: true,
          proof_key: true,
          print_status: true,
          print_attempts: true,
          print_error: true,
          print_files: true,
          print_requested_at: true,
          print_rendered_at: true,
          print_next_attempt_at: true,
          files_purged_at: true,
          created_at: true,
          order_item: {
            select: {
              quantity: true,
              product_id: true,
              product: {
                select: {
                  translations: { select: { locale: true, title: true } },
                },
              },
              order: {
                select: { order_number: true, status: true, locale: true },
              },
            },
          },
        },
      }),
    ]);
    const primary =
      (
        await this.prisma.storeLanguageConfig.findUnique({
          where: { store_id: storeId },
          select: { primary_locale: true },
        })
      )?.primary_locale ?? null;
    return {
      total,
      page,
      limit,
      items: rows.map((r) => ({
        id: r.id,
        order_id: r.order_id,
        order_item_id: r.order_item_id,
        order_number: r.order_item?.order?.order_number ?? null,
        order_status: r.order_item?.order?.status ?? null,
        quantity: r.order_item?.quantity ?? null,
        product_id: r.order_item?.product_id ?? null,
        product_title: pickTitle(
          r.order_item?.product?.translations ?? [],
          primary,
        ),
        print_status: r.print_status,
        print_attempts: r.print_attempts,
        max_attempts: PRINT_MAX_ATTEMPTS,
        print_error: r.print_error,
        print_requested_at: r.print_requested_at,
        print_rendered_at: r.print_rendered_at,
        print_next_attempt_at: r.print_next_attempt_at,
        files_purged_at: r.files_purged_at,
        low_res: hasLowRes(r.assets),
        print_files: (asPrintFiles(r.print_files) ?? []).map((f) => ({
          surface: f.surface,
          format: f.format,
          width_px: f.width_px,
          height_px: f.height_px,
          dpi: f.dpi,
          bytes: f.bytes,
        })),
        proof_url: this.render.orderProofPath(r),
        created_at: r.created_at,
      })),
    };
  }

  /** The store's design row of an order item, or 404. */
  private async ownedRow(storeId: string, orderId: string, itemId: string) {
    const row = await this.prisma.orderItemDesign.findFirst({
      where: { store_id: storeId, order_id: orderId, order_item_id: itemId },
    });
    if (!row) {
      throw designerErrors.notFound(
        'DESIGNER_DESIGN_NOT_FOUND',
        'This order item has no design.',
      );
    }
    return row;
  }

  /** Print PNG bytes + attachment name (409 not ready, 410 purged). */
  async printFile(
    storeId: string,
    orderId: string,
    itemId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const row = await this.ownedRow(storeId, orderId, itemId);
    if (row.files_purged_at || row.print_status === DesignPrintStatus.PURGED) {
      throw designerErrors.gone(
        'DESIGNER_FILES_PURGED',
        'The print file has been deleted.',
      );
    }
    const file = (asPrintFiles(row.print_files) ?? []).find(
      (f) => f.surface === 'front' && f.format === 'png',
    );
    if (row.print_status !== DesignPrintStatus.READY || !file) {
      throw designerErrors.conflict(
        'DESIGNER_PRINT_NOT_READY',
        'The print file is not ready yet.',
        { print_status: row.print_status },
      );
    }
    const buffer = await this.storage.read(file.key);
    if (!buffer) {
      throw designerErrors.notFound(
        'DESIGNER_FILE_NOT_FOUND',
        'The print file is missing.',
      );
    }
    const siblings = await this.prisma.orderItemDesign.findMany({
      where: { order_id: orderId },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        order_item: { select: { order: { select: { order_number: true } } } },
      },
    });
    const index =
      Math.max(
        siblings.findIndex((s) => s.id === row.id),
        0,
      ) + 1;
    const orderNumber =
      siblings[0]?.order_item?.order?.order_number ?? row.order_id.slice(0, 8);
    const safe = orderNumber.replace(/[^A-Za-z0-9_-]/g, '');
    return { buffer, filename: `${safe}-${index}-front.png` };
  }

  /** `POST …/orders/:orderId/items/:itemId/regenerate`. */
  async regenerateItem(storeId: string, orderId: string, itemId: string) {
    const row = await this.ownedRow(storeId, orderId, itemId);
    if (row.files_purged_at) {
      throw designerErrors.gone(
        'DESIGNER_FILES_PURGED',
        'The design files have been deleted.',
      );
    }
    if (row.terminal_at) {
      throw designerErrors.conflict(
        'DESIGNER_ORDER_TERMINAL',
        'The order was cancelled, refunded or never paid; nothing is printed.',
        { terminal_at: row.terminal_at },
      );
    }
    if (row.print_status === DesignPrintStatus.RENDERING) {
      return { queued: false, print_status: row.print_status };
    }
    const n = await this.regenerate({ id: row.id, store_id: storeId });
    return {
      queued: n > 0,
      print_status: n > 0 ? DesignPrintStatus.PENDING : row.print_status,
    };
  }

  /** Retry every final FAILED row of a store. */
  async retryAllFailed(
    storeId: string,
    now: Date = new Date(),
  ): Promise<{ count: number }> {
    const res = await this.prisma.orderItemDesign.updateMany({
      where: {
        store_id: storeId,
        print_status: DesignPrintStatus.FAILED,
        files_purged_at: null,
        terminal_at: null,
      },
      data: {
        print_status: DesignPrintStatus.PENDING,
        print_attempts: 0,
        print_next_attempt_at: null,
        print_error: null,
        print_requested_at: now,
      },
    });
    if (res.count > 0) this.nudge();
    return { count: res.count };
  }

  // ── Worker side ──────────────────────────────────────────────────────────

  /** One worker pass (public for specs): fills up to `concurrency` lanes. */
  async tick(): Promise<void> {
    if (!this.workerEnabled) return;
    if (Date.now() < this.pauseUntil) return;
    const lanes: Promise<void>[] = [];
    while (this.lanes < this.config.concurrency) {
      this.lanes++;
      lanes.push(
        this.runLane().finally(() => {
          this.lanes--;
        }),
      );
    }
    await Promise.all(lanes);
  }

  private async runLane(): Promise<void> {
    try {
      await this.failAbandoned();
      await this.backfillDue();
      // Never claim with a browser that cannot start: probe first (a cheap
      // no-op while the browser is up; a launch otherwise).
      try {
        await this.render.probeEngine();
      } catch (e) {
        const err = classifyRenderError(e);
        if (err.code === 'DESIGNER_RENDER_UNAVAILABLE') {
          this.pause(err.message);
          return;
        }
        throw e;
      }
      for (
        let i = 0;
        i < PRINT_JOBS_PER_TICK &&
        this.workerEnabled &&
        Date.now() >= this.pauseUntil;
        i++
      ) {
        const row = await this.claimNext();
        if (!row) return;
        await this.process(row);
      }
    } catch (e) {
      this.logger.warn(
        `Designer print worker pass failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Claims the next due row (§5.3 claim SQL) of a store with the designer
   * app in effect. Safe across instances (`FOR UPDATE SKIP LOCKED`).
   */
  async claimNext(): Promise<ClaimedRow | null> {
    const rows = await this.prisma.$queryRaw<ClaimedRow[]>(Prisma.sql`
      UPDATE "OrderItemDesign"
         SET print_status = 'RENDERING',
             print_locked_at = now(),
             print_attempts = print_attempts + 1,
             updated_at = now()
       WHERE id = (
         SELECT o.id FROM "OrderItemDesign" o
          WHERE o.print_requested_at IS NOT NULL
            AND o.files_purged_at IS NULL
            AND o.terminal_at IS NULL
            AND (
                 (o.print_status = 'PENDING'
                  AND (o.print_next_attempt_at IS NULL
                       OR o.print_next_attempt_at <= now()))
              OR (o.print_status = 'FAILED'
                  AND o.print_attempts < ${PRINT_MAX_ATTEMPTS}
                  AND o.print_next_attempt_at <= now())
              OR (o.print_status = 'RENDERING'
                  AND o.print_attempts < ${PRINT_MAX_ATTEMPTS}
                  AND o.print_locked_at < now() - ${STALE_INTERVAL})
            )
            AND EXISTS (
              SELECT 1 FROM "StoreApp" sa
               WHERE sa.store_id = o.store_id
                 AND sa.app_key = 'designer'
                 AND sa.available AND sa.enabled
            )
          ORDER BY o.print_requested_at
          LIMIT 1
          FOR UPDATE OF o SKIP LOCKED
       )
      RETURNING id, store_id, order_id, template_spec, state, proof_key,
                files_purged_at, originals_purged_at, print_attempts,
                print_locked_at`);
    return rows[0] ?? null;
  }

  /** Runs `backfillRequested` at most every PRINT_BACKFILL_INTERVAL_MS. */
  private async backfillDue(now: number = Date.now()): Promise<void> {
    if (now - this.lastBackfill < PRINT_BACKFILL_INTERVAL_MS) return;
    this.lastBackfill = now;
    const n = await this.backfillRequested();
    if (n > 0) this.logger.log(`Designer print backfill requested ${n} row(s)`);
  }

  /**
   * Requests the rows of paid (or live COD) orders that were never
   * requested — e.g. paid while a trigger failed, or before the app was
   * switched on — for stores where the app is in effect. Terminal, purged
   * and already requested rows are left alone. Returns the row count.
   */
  async backfillRequested(): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
      UPDATE "OrderItemDesign" d
         SET print_requested_at = now(),
             print_status = 'PENDING',
             print_attempts = 0,
             print_next_attempt_at = NULL,
             print_error = NULL,
             updated_at = now()
        FROM "Order" o
       WHERE o.id = d.order_id
         AND d.print_requested_at IS NULL
         AND d.terminal_at IS NULL
         AND d.files_purged_at IS NULL
         AND d.print_status = 'PENDING'
         AND o.status::text NOT IN ${BACKFILL_SKIP_STATUSES}
         AND (o.payment_status = 'paid' OR o.payment_method::text = 'COD')
         AND EXISTS (
           SELECT 1 FROM "StoreApp" sa
            WHERE sa.store_id = d.store_id
              AND sa.app_key = 'designer'
              AND sa.available AND sa.enabled
         )`);
  }

  /** Abandoned RENDERING rows that used up their attempts become FAILED. */
  private async failAbandoned(): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "OrderItemDesign"
         SET print_status = 'FAILED',
             print_error = 'The render was interrupted (worker lost).',
             print_next_attempt_at = NULL,
             updated_at = now()
       WHERE print_status = 'RENDERING'
         AND print_attempts >= ${PRINT_MAX_ATTEMPTS}
         AND print_locked_at < now() - ${STALE_INTERVAL}`);
  }

  /** Renders one claimed row and records the outcome (fenced by the lock). */
  async process(
    row: ClaimedRow,
    now: () => Date = () => new Date(),
  ): Promise<void> {
    const fence = {
      id: row.id,
      print_status: DesignPrintStatus.RENDERING,
      print_locked_at: row.print_locked_at,
    };
    this.inflight.set(row.id, row.print_locked_at ?? null);
    try {
      const result = await withTimeout(
        this.render.renderPrint(row),
        PRINT_JOB_TIMEOUT_MS,
        'Designer print job',
      );
      const done = now();
      const saved = await this.prisma.orderItemDesign.updateMany({
        where: fence,
        data: {
          print_status: DesignPrintStatus.READY,
          print_files: printFilesJson(result.files),
          print_rendered_at: done,
          print_error: null,
          print_next_attempt_at: null,
          print_locked_at: null,
          ...(result.proof_key ? { proof_key: result.proof_key } : {}),
        },
      });
      if (saved.count === 0) {
        // Lost the fence (released on shutdown / reclaimed): drop the files.
        for (const f of result.files) {
          await this.storage.delete(f.key).catch(() => undefined);
        }
        if (result.proof_key) {
          await releaseProofKey(this.prisma, this.storage, result.proof_key, {
            logger: this.logger,
          });
        }
      }
    } catch (e) {
      const err = classifyRenderError(e);
      const at = now();
      if (err.code === 'DESIGNER_RENDER_UNAVAILABLE') {
        // No browser on this instance: not an attempt of the row. Hand it
        // back (due again after the pause) and stop claiming for a while.
        const back = await this.handBack(
          row.id,
          row.print_locked_at ?? null,
          new Date(at.getTime() + PRINT_RENDER_PAUSE_MS),
        );
        this.pause(err.message, at.getTime());
        this.logger.warn(
          `Designer print ${row.id} (order ${row.order_id}) handed back (${back} row): ${err.message}`,
        );
        return;
      }
      // An order cancelled while rendering: final, never retried.
      const cancelled = await this.prisma.orderItemDesign.updateMany({
        where: { ...fence, terminal_at: { not: null } },
        data: {
          print_status: DesignPrintStatus.FAILED,
          print_error: `${err.code}: ${err.message}`.slice(0, ERROR_MAX),
          print_locked_at: null,
          print_next_attempt_at: null,
          print_requested_at: null,
        },
      });
      if (cancelled.count > 0) return;
      const final = !err.retryable || row.print_attempts >= PRINT_MAX_ATTEMPTS;
      await this.prisma.orderItemDesign.updateMany({
        where: fence,
        data: {
          print_status: DesignPrintStatus.FAILED,
          print_error: `${err.code}: ${err.message}`.slice(0, ERROR_MAX),
          print_locked_at: null,
          print_next_attempt_at: final
            ? null
            : new Date(at.getTime() + backoffMs(row.print_attempts)),
          ...(final && !err.retryable
            ? {
                print_attempts: Math.max(
                  row.print_attempts,
                  PRINT_MAX_ATTEMPTS,
                ),
              }
            : {}),
        },
      });
      this.logger.warn(
        `Designer print ${row.id} (order ${row.order_id}) failed (attempt ${row.print_attempts}${final ? ', final' : ''}): ${err.code} ${err.message}`,
      );
    } finally {
      this.inflight.delete(row.id);
    }
  }
}

/**
 * Product title in the store's primary locale (else the same language,
 * else the first translation); null without a product.
 */
export function pickTitle(
  translations: { locale: string; title: string }[],
  locale: string | null,
): string | null {
  const want = (locale ?? '').toLowerCase();
  const lang = want.split(/[-_]/)[0];
  const t =
    translations.find((x) => x.locale.toLowerCase() === want) ??
    translations.find(
      (x) => x.locale.toLowerCase().split(/[-_]/)[0] === lang,
    ) ??
    translations[0];
  return t?.title ?? null;
}

/** The `print_files` JSON as a typed list (null when absent / malformed). */
export function asPrintFiles(v: unknown): PrintFile[] | null {
  return Array.isArray(v)
    ? (v.filter(
        (f) =>
          !!f &&
          typeof f === 'object' &&
          typeof (f as PrintFile).key === 'string',
      ) as PrintFile[])
    : null;
}

/** True when the snapshot flags any asset as low resolution. */
export function hasLowRes(assets: unknown): boolean {
  return (
    Array.isArray(assets) &&
    assets.some(
      (a) =>
        !!a &&
        typeof a === 'object' &&
        (a as { low_res?: unknown }).low_res === true,
    )
  );
}

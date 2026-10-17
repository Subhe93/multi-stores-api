import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  OrderStatus,
  Prisma,
  ProductionCheckSource,
  type OrderProductionCheck,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { normalizeProductionSettings } from './production-settings';
import {
  SORT_BASE,
  buildLineSources,
  isOwnLine,
  sourceHash,
  variantOptionsOf,
  type ProductionSourceLine,
} from './production-sources';
import { summarize } from './production-state';
import { productionErrors } from './production-errors';
import { PRODUCTION_ACTIVE_STATUSES } from './production-where';
import type {
  ProductionActor,
  ProductionSourceProvider,
  ProductionSummaryView,
  SourceCheck,
} from './production.types';

type Db = Prisma.TransactionClient;

/** Orders whose checklist is kept for audit but can no longer change. */
const CLOSED_STATUSES: OrderStatus[] = [
  OrderStatus.CANCELLED,
  OrderStatus.REFUNDED,
  OrderStatus.RETURNED,
];

export const MAX_CHECKS_PER_LINE = 200;
const SUMMARY_ORDER_LIMIT = 50;
/** Orders one backfill request syncs at most (newest open ones first). */
export const BACKFILL_LIMIT = 500;
/** Orders synced between two yields to the event loop. */
export const BACKFILL_BATCH = 50;
export const EVENTS_LIMIT_MAX = 200;
const EVENTS_LIMIT_DEFAULT = 50;

/** Paging of the audit log (`page` from 1, `limit` <= EVENTS_LIMIT_MAX). */
export interface EventsPage {
  page?: number;
  limit?: number;
}

/** Result of a write that can change the order's progress. */
export interface ProductionWriteResult {
  check: OrderProductionCheck | null;
  summary: ProductionSummaryView;
  /** True once, for the write that moved the order from NOT_STARTED. */
  started: boolean;
  /** True once, for the write that made the checklist complete. */
  completed: boolean;
  /** False when the write was a no-op (already in the requested state). */
  changed: boolean;
}

/** Store context of a creator user (one query). */
export interface ProductionContext {
  storeId: string;
  creatorId: string;
  primaryLocale: string | null;
  actor: ProductionActor;
}

const lineSelect = {
  id: true,
  order_id: true,
  fulfiller_type: true,
  fulfiller_id: true,
  variant_options_snapshot: true,
  // Live options: only the insert-only seed of pre-snapshot lines.
  variant: { select: { options: true } },
  custom_field_values: {
    orderBy: { id: 'asc' as const },
    select: {
      id: true,
      value: true,
      file_url: true,
      field_name: true,
      field_type: true,
      field_label: true,
      display_value: true,
      sort_order: true,
      group_index: true,
      group_label: true,
      source: true,
      meta: true,
      custom_field: {
        select: {
          name: true,
          type: true,
          translations: {
            select: { locale: true, label: true, option_labels: true },
          },
        },
      },
    },
  },
} satisfies Prisma.OrderItemSelect;

/**
 * Production checklist of an order (M4.3 §3.4). Checks are generated from the
 * order-time snapshot rows and synced idempotently (unique
 * `order_item_id + source_key`); every write keeps OrderProductionSummary in
 * step so the orders list can filter by progress. Rows exist only for stores
 * with the production app: every entry point is either gated by
 * RequireAppGuard or by ProductionTriggersService.isEnabled.
 */
@Injectable()
export class ProductionChecklistService {
  private readonly logger = new Logger(ProductionChecklistService.name);
  private readonly providers: ProductionSourceProvider[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly storeApps: StoreAppsService,
  ) {}

  /** Seam for later apps (C27, the designer's print file checks). */
  registerProvider(provider: ProductionSourceProvider): void {
    if (this.providers.some((p) => p.key === provider.key)) return;
    this.providers.push(provider);
  }

  /** Print files of the registered providers (production sheet). */
  async printFiles(
    orderId: string,
  ): Promise<{ order_item_id: string; url: string; label: string }[]> {
    const out: { order_item_id: string; url: string; label: string }[] = [];
    for (const p of this.providers) {
      if (!p.printFiles) continue;
      try {
        out.push(...(await p.printFiles(orderId)));
      } catch (err) {
        this.logger.warn(
          `Production provider ${p.key} printFiles failed for ${orderId}: ${errText(err)}`,
        );
      }
    }
    return out;
  }

  // ── Context and scope ────────────────────────────────────────────────────

  /** The creator's store, creator id, primary locale and display name, or 404. */
  async contextOf(userId: string): Promise<ProductionContext> {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: {
        id: true,
        display_name: true,
        store: {
          select: {
            id: true,
            language_config: { select: { primary_locale: true } },
          },
        },
      },
    });
    if (!creator?.store) throw productionErrors.orderNotFound();
    return {
      storeId: creator.store.id,
      creatorId: creator.id,
      primaryLocale: creator.store.language_config?.primary_locale ?? null,
      actor: { id: userId, name: creator.display_name ?? null },
    };
  }

  /** The order when it belongs to the store, else 404 (never 403: ids stay non-enumerable). */
  async orderOfStore(orderId: string, storeId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, store_id: true, status: true },
    });
    if (!order || order.store_id !== storeId) {
      throw productionErrors.orderNotFound();
    }
    return order;
  }

  private async checkOfStore(checkId: string, storeId: string) {
    const check = await this.prisma.orderProductionCheck.findUnique({
      where: { id: checkId },
    });
    if (!check || check.store_id !== storeId) {
      throw productionErrors.checkNotFound();
    }
    return check;
  }

  private assertOpen(status: OrderStatus): void {
    if (CLOSED_STATUSES.includes(status)) throw productionErrors.orderClosed();
  }

  // ── Generation ───────────────────────────────────────────────────────────

  /**
   * Idempotent sync of an order's checks with its current sources: new
   * sources are inserted (skipDuplicates on the unique key, so concurrent
   * syncs cannot double them), a changed value resets its check
   * (VALUE_CHANGED), a changed label only relabels it, a vanished source
   * goes stale (STALE; custom and insert-only items never do). A second run
   * without changes writes nothing. Closed orders are read-only. When the
   * sync itself completes the checklist (stale flips) it takes the same
   * completion path as a write: one COMPLETED event + timeline row, and the
   * auto-advance is left pending for the next request on the order.
   */
  async syncOrder(orderId: string, storeId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        store_id: true,
        status: true,
        items: { select: lineSelect },
      },
    });
    if (!order || order.store_id !== storeId) {
      throw productionErrors.orderNotFound();
    }
    if (CLOSED_STATUSES.includes(order.status)) return;

    const [store, rawSettings] = await Promise.all([
      this.prisma.store.findUnique({
        where: { id: storeId },
        select: {
          creator_id: true,
          language_config: { select: { primary_locale: true } },
        },
      }),
      this.storeApps.getSettings(storeId, 'production'),
    ]);
    const settings = normalizeProductionSettings(rawSettings);
    const primary = store?.language_config?.primary_locale ?? null;
    const creatorId = store?.creator_id ?? null;

    const sources: SourceCheck[] = [];
    // Lines without a variant snapshot: their VARIANT_OPTION rows are kept
    // as inserted (never reset, never stale), see SourceCheck.insert_only.
    const insertOnlyLines = new Set<string>();
    for (const item of order.items) {
      if (!isOwnLine(item, creatorId)) continue;
      if (!variantOptionsOf(item).snapshot) insertOnlyLines.add(item.id);
      sources.push(
        ...buildLineSources(item as ProductionSourceLine, settings, primary),
      );
      sources.push(...(await this.providerSources(item, order)));
    }

    await this.prisma.$transaction(async (tx) => {
      await lockOrder(tx, orderId);
      const existing = await tx.orderProductionCheck.findMany({
        where: { order_id: orderId },
      });
      const byKey = new Map(
        existing.map((c) => [`${c.order_item_id}\u0000${c.source_key}`, c]),
      );
      const wanted = new Set<string>();
      const inserts: Prisma.OrderProductionCheckCreateManyInput[] = [];
      const events: Prisma.OrderProductionEventCreateManyInput[] = [];

      for (const s of sources) {
        const id = `${s.order_item_id}\u0000${s.source_key}`;
        if (wanted.has(id)) continue;
        wanted.add(id);
        const hash = sourceHash(s.value, s.file_url);
        const row = byKey.get(id);
        if (!row) {
          inserts.push({
            store_id: storeId,
            order_id: orderId,
            order_item_id: s.order_item_id,
            source: s.source,
            source_key: s.source_key,
            source_hash: hash,
            label: s.label,
            value: s.value,
            group_index: s.group_index,
            file_url: s.file_url,
            sort_order: s.sort_order,
          });
          continue;
        }
        if (row.source === ProductionCheckSource.CUSTOM) {
          // A default item keeps whatever the workshop did with it.
          if (row.stale) {
            await tx.orderProductionCheck.update({
              where: { id: row.id },
              data: { stale: false },
            });
          }
          continue;
        }
        // Nothing to compare against: the row stays exactly as it is.
        if (s.insert_only) continue;
        if (row.source_hash !== hash) {
          await tx.orderProductionCheck.update({
            where: { id: row.id },
            data: {
              source_hash: hash,
              label: s.label,
              value: s.value,
              group_index: s.group_index,
              file_url: s.file_url,
              sort_order: s.sort_order,
              stale: false,
              done: false,
              done_at: null,
              done_by: null,
              done_by_name: null,
            },
          });
          events.push({
            order_id: orderId,
            check_id: row.id,
            action: 'VALUE_CHANGED',
            payload: {
              from: { label: row.label, value: row.value },
              to: { label: s.label, value: s.value },
            },
          });
        } else if (
          row.stale ||
          row.label !== s.label ||
          row.group_index !== s.group_index ||
          row.sort_order !== s.sort_order
        ) {
          // Same thing to produce: relabel / reorder without touching done.
          await tx.orderProductionCheck.update({
            where: { id: row.id },
            data: {
              stale: false,
              label: s.label,
              group_index: s.group_index,
              sort_order: s.sort_order,
            },
          });
        }
      }

      for (const row of existing) {
        if (row.stale || row.source === ProductionCheckSource.CUSTOM) continue;
        if (
          row.source === ProductionCheckSource.VARIANT_OPTION &&
          insertOnlyLines.has(row.order_item_id)
        ) {
          continue;
        }
        if (wanted.has(`${row.order_item_id}\u0000${row.source_key}`)) continue;
        await tx.orderProductionCheck.update({
          where: { id: row.id },
          data: { stale: true },
        });
        events.push({
          order_id: orderId,
          check_id: row.id,
          action: 'STALE',
          payload: { label: row.label, value: row.value },
        });
      }

      if (inserts.length) {
        await tx.orderProductionCheck.createMany({
          data: inserts,
          skipDuplicates: true,
        });
      }
      if (events.length) {
        await tx.orderProductionEvent.createMany({ data: events });
      }
      const s = await this.writeSummary(tx, orderId, storeId, {
        onlyIfChanged: true,
      });
      if (s.completed) {
        await this.logCompleted(tx, orderId, null);
        // No OrdersService here (cycle-free core): the automation runs on
        // the next write / workspace read of the order.
        if (
          settings.on_complete === 'auto' &&
          settings.complete_target === 'QUALITY_CHECK'
        ) {
          await tx.orderProductionSummary.updateMany({
            where: { order_id: orderId },
            data: { auto_advance_pending: true },
          });
        }
      }
    });
  }

  private async providerSources(
    item: { id: string; order_id: string },
    order: { id: string; store_id: string | null; status: OrderStatus },
  ): Promise<SourceCheck[]> {
    const out: SourceCheck[] = [];
    for (const p of this.providers) {
      try {
        const list = await p.sources(item, {
          id: order.id,
          store_id: order.store_id ?? '',
          status: order.status,
        });
        list.forEach((s, i) =>
          out.push({
            ...s,
            order_item_id: item.id,
            sort_order: s.sort_order || SORT_BASE.provider + i,
          }),
        );
      } catch (err) {
        this.logger.warn(
          `Production provider ${p.key} failed for line ${item.id}: ${errText(err)}`,
        );
      }
    }
    return out;
  }

  // ── Summary ──────────────────────────────────────────────────────────────

  /**
   * Recompute and store the order's summary. The NOT_STARTED → started and
   * not-READY → READY transitions go through guarded updateMany calls, so
   * under concurrent writes exactly one caller sees `started` / `completed`.
   */
  private async writeSummary(
    db: Db,
    orderId: string,
    storeId: string,
    opts: { onlyIfChanged?: boolean } = {},
  ): Promise<{
    summary: ProductionSummaryView;
    started: boolean;
    completed: boolean;
  }> {
    const checks = await db.orderProductionCheck.findMany({
      where: { order_id: orderId },
      select: { done: true, stale: true },
    });
    const { total, done, state } = summarize(checks);
    const now = new Date();
    const base = { total, done, synced_at: now };
    let started = false;
    let completed = false;

    if (state === 'IN_PROGRESS' || state === 'READY') {
      const r = await db.orderProductionSummary.updateMany({
        where: { order_id: orderId, state: 'NOT_STARTED' },
        data: {
          ...base,
          state,
          completed_at: state === 'READY' ? now : null,
        },
      });
      if (r.count > 0) {
        started = true;
        completed = state === 'READY';
      }
    }
    if (!started && state === 'READY') {
      const r = await db.orderProductionSummary.updateMany({
        where: { order_id: orderId, state: { not: 'READY' } },
        data: { ...base, state, completed_at: now },
      });
      completed = r.count > 0;
    }

    let row = await db.orderProductionSummary.findUnique({
      where: { order_id: orderId },
    });
    if (!started && !completed) {
      const same =
        row && row.total === total && row.done === done && row.state === state;
      if (!row) {
        row = await db.orderProductionSummary.create({
          data: {
            order_id: orderId,
            store_id: storeId,
            ...base,
            state,
            completed_at: state === 'READY' ? now : null,
          },
        });
        // A first summary that is already READY is a completion too.
        completed = state === 'READY';
      } else if (!same || !opts.onlyIfChanged) {
        row = await db.orderProductionSummary.update({
          where: { order_id: orderId },
          data: {
            ...base,
            state,
            ...(state === 'READY' ? {} : { completed_at: null }),
          },
        });
      }
    }
    return {
      summary: toSummaryView(row, { total, done, state }),
      started,
      completed,
    };
  }

  /** The order's checks (line order) and summary, as stored. */
  async orderState(orderId: string): Promise<{
    checks: OrderProductionCheck[];
    summary: ProductionSummaryView;
  }> {
    const [checks, row] = await Promise.all([
      this.prisma.orderProductionCheck.findMany({
        where: { order_id: orderId },
        orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
      }),
      this.prisma.orderProductionSummary.findUnique({
        where: { order_id: orderId },
      }),
    ]);
    return { checks, summary: toSummaryView(row, summarize(checks)) };
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  /**
   * Set one check (set semantics, not a toggle): a request for the state the
   * check already has is a no-op without an event, so double taps and
   * retries are harmless. A stale check is refused the same way bulkSet
   * skips it (`changed: false`, nothing written): it is not counted, so
   * checking it could never complete anything.
   */
  async setDone(
    storeId: string,
    checkId: string,
    done: boolean,
    actor: ProductionActor,
  ): Promise<ProductionWriteResult> {
    const check = await this.checkOfStore(checkId, storeId);
    const order = await this.orderOfStore(check.order_id, storeId);
    this.assertOpen(order.status);

    return this.prisma.$transaction(async (tx) => {
      await lockOrder(tx, check.order_id);
      const now = new Date();
      const r = await tx.orderProductionCheck.updateMany({
        where: { id: checkId, done: !done, stale: false },
        data: done
          ? {
              done: true,
              done_at: now,
              done_by: actor.id,
              done_by_name: actor.name,
            }
          : { done: false, done_at: null, done_by: null, done_by_name: null },
      });
      const current = await tx.orderProductionCheck.findUnique({
        where: { id: checkId },
      });
      if (r.count === 0) {
        const s = await tx.orderProductionSummary.findUnique({
          where: { order_id: check.order_id },
        });
        const all = await tx.orderProductionCheck.findMany({
          where: { order_id: check.order_id },
          select: { done: true, stale: true },
        });
        return {
          check: current,
          summary: toSummaryView(s, summarize(all)),
          started: false,
          completed: false,
          changed: false,
        };
      }
      await tx.orderProductionEvent.create({
        data: {
          order_id: check.order_id,
          check_id: checkId,
          action: done ? 'CHECK' : 'UNCHECK',
          actor_id: actor.id,
          actor_name: actor.name,
          payload: { label: check.label, value: check.value },
        },
      });
      const s = await this.writeSummary(tx, check.order_id, storeId);
      if (s.completed) await this.logCompleted(tx, check.order_id, actor);
      return { check: current, ...s, changed: true };
    });
  }

  /** Check or uncheck every open check of the order, or of one line. */
  async bulkSet(
    storeId: string,
    orderId: string,
    itemId: string | null,
    done: boolean,
    actor: ProductionActor,
  ): Promise<ProductionWriteResult> {
    const order = await this.orderOfStore(orderId, storeId);
    this.assertOpen(order.status);
    if (itemId) await this.ownedLine(orderId, itemId, storeId);

    return this.prisma.$transaction(async (tx) => {
      await lockOrder(tx, orderId);
      const now = new Date();
      const r = await tx.orderProductionCheck.updateMany({
        where: {
          order_id: orderId,
          ...(itemId ? { order_item_id: itemId } : {}),
          stale: false,
          done: !done,
        },
        data: done
          ? {
              done: true,
              done_at: now,
              done_by: actor.id,
              done_by_name: actor.name,
            }
          : { done: false, done_at: null, done_by: null, done_by_name: null },
      });
      if (r.count > 0) {
        await tx.orderProductionEvent.create({
          data: {
            order_id: orderId,
            action: 'BULK',
            actor_id: actor.id,
            actor_name: actor.name,
            payload: { order_item_id: itemId, done, count: r.count },
          },
        });
      }
      const s = await this.writeSummary(tx, orderId, storeId, {
        onlyIfChanged: r.count === 0,
      });
      if (s.completed) await this.logCompleted(tx, orderId, actor);
      return { check: null, ...s, changed: r.count > 0 };
    });
  }

  /** Add a free-text check to one of the creator's own lines. */
  async addCustom(
    storeId: string,
    orderId: string,
    itemId: string,
    label: string,
    actor: ProductionActor,
  ): Promise<OrderProductionCheck> {
    const text = typeof label === 'string' ? label.trim() : '';
    if (!text || text.length > 80) throw productionErrors.labelInvalid();
    const order = await this.orderOfStore(orderId, storeId);
    this.assertOpen(order.status);
    await this.ownedLine(orderId, itemId, storeId);

    return this.prisma.$transaction(async (tx) => {
      await lockOrder(tx, orderId);
      const count = await tx.orderProductionCheck.count({
        where: { order_item_id: itemId },
      });
      if (count >= MAX_CHECKS_PER_LINE) {
        throw productionErrors.tooManyChecks(MAX_CHECKS_PER_LINE);
      }
      const check = await tx.orderProductionCheck.create({
        data: {
          store_id: storeId,
          order_id: orderId,
          order_item_id: itemId,
          source: ProductionCheckSource.CUSTOM,
          source_key: `custom:${randomUUID()}`,
          label: text,
          sort_order: SORT_BASE.custom + count,
          created_by: actor.id,
        },
      });
      await tx.orderProductionEvent.create({
        data: {
          order_id: orderId,
          check_id: check.id,
          action: 'ADD',
          actor_id: actor.id,
          actor_name: actor.name,
          payload: { label: text, order_item_id: itemId },
        },
      });
      await this.writeSummary(tx, orderId, storeId);
      return check;
    });
  }

  /** Remove a custom check (generated checks can only go stale). */
  async removeCustom(
    storeId: string,
    checkId: string,
    actor: ProductionActor,
  ): Promise<void> {
    const check = await this.checkOfStore(checkId, storeId);
    if (check.source !== ProductionCheckSource.CUSTOM) {
      throw productionErrors.customOnly();
    }
    const order = await this.orderOfStore(check.order_id, storeId);
    this.assertOpen(order.status);
    await this.prisma.$transaction(async (tx) => {
      await lockOrder(tx, check.order_id);
      await tx.orderProductionCheck.delete({ where: { id: checkId } });
      await tx.orderProductionEvent.create({
        data: {
          order_id: check.order_id,
          check_id: checkId,
          action: 'REMOVE',
          actor_id: actor.id,
          actor_name: actor.name,
          payload: { label: check.label },
        },
      });
      await this.writeSummary(tx, check.order_id, storeId);
    });
  }

  /** The line when it is in the order and produced by the store's creator. */
  private async ownedLine(orderId: string, itemId: string, storeId: string) {
    const [item, store] = await Promise.all([
      this.prisma.orderItem.findFirst({
        where: { id: itemId, order_id: orderId },
        select: { id: true, fulfiller_type: true, fulfiller_id: true },
      }),
      this.prisma.store.findUnique({
        where: { id: storeId },
        select: { creator_id: true },
      }),
    ]);
    if (!item) throw productionErrors.checkNotFound();
    if (!isOwnLine(item, store?.creator_id ?? null)) {
      throw productionErrors.lineNotOwned();
    }
    return item;
  }

  /**
   * The single completion path (one COMPLETED event + timeline row per
   * completion cycle; `actor` null for a sync-driven completion). Callers
   * only reach it through writeSummary's guarded not-READY -> READY flip.
   */
  private async logCompleted(
    tx: Db,
    orderId: string,
    actor: ProductionActor | null,
  ): Promise<void> {
    await tx.orderProductionEvent.create({
      data: {
        order_id: orderId,
        action: 'COMPLETED',
        actor_id: actor?.id ?? null,
        actor_name: actor?.name ?? null,
      },
    });
    // Internal timeline entry (the customer page reads only STATUS_STEPS).
    await tx.orderTimeline.create({
      data: {
        order_id: orderId,
        status: 'PRODUCTION_COMPLETED',
        note: 'Production checklist completed',
        actor: actor?.id ?? null,
      },
    });
  }

  /** Whether the on-complete auto-advance of the order is still owed. */
  async isAutoAdvancePending(orderId: string): Promise<boolean> {
    const row = await this.prisma.orderProductionSummary.findUnique({
      where: { order_id: orderId },
      select: { auto_advance_pending: true, state: true },
    });
    return !!row && row.auto_advance_pending && row.state === 'READY';
  }

  /** Record (or clear) an owed auto-advance so the next request retries it. */
  async setAutoAdvancePending(
    orderId: string,
    pending: boolean,
  ): Promise<void> {
    await this.prisma.orderProductionSummary.updateMany({
      where: { order_id: orderId, auto_advance_pending: !pending },
      data: { auto_advance_pending: pending },
    });
  }

  /** Append an AUTO_ADVANCE event (automation service). */
  async logAutoAdvance(
    orderId: string,
    actor: ProductionActor,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.orderProductionEvent.create({
      data: {
        order_id: orderId,
        action: 'AUTO_ADVANCE',
        actor_id: actor.id,
        actor_name: actor.name,
        payload: payload as Prisma.InputJsonObject,
      },
    });
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  /** The audit log, newest first, one page at a time. */
  async events(storeId: string, orderId: string, paging: EventsPage = {}) {
    await this.orderOfStore(orderId, storeId);
    const limit = Math.min(
      Math.max(Math.trunc(paging.limit ?? EVENTS_LIMIT_DEFAULT), 1),
      EVENTS_LIMIT_MAX,
    );
    const page = Math.max(Math.trunc(paging.page ?? 1), 1);
    return this.prisma.orderProductionEvent.findMany({
      where: { order_id: orderId },
      orderBy: { created_at: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  /**
   * Progress of up to 50 orders of the store, keyed by order id. Orders of
   * the store without a summary yet (creation hook missed) are synced first;
   * ids of other stores are silently left out.
   */
  async summaries(
    storeId: string,
    orderIds: string[],
  ): Promise<Record<string, { total: number; done: number; state: string }>> {
    const ids = [...new Set(orderIds)].slice(0, SUMMARY_ORDER_LIMIT);
    if (ids.length === 0) return {};
    const read = () =>
      this.prisma.orderProductionSummary.findMany({
        where: { order_id: { in: ids }, store_id: storeId },
        select: { order_id: true, total: true, done: true, state: true },
      });
    let rows = await read();
    const have = new Set(rows.map((r) => r.order_id));
    const missing = ids.filter((id) => !have.has(id));
    if (missing.length) {
      const orders = await this.prisma.order.findMany({
        where: {
          id: { in: missing },
          store_id: storeId,
          status: { notIn: CLOSED_STATUSES },
        },
        select: { id: true },
      });
      for (const o of orders) {
        try {
          await this.syncOrder(o.id, storeId);
        } catch (err) {
          this.logger.warn(
            `Production sync failed for ${o.id}: ${errText(err)}`,
          );
        }
      }
      if (orders.length) rows = await read();
    }
    const out: Record<string, { total: number; done: number; state: string }> =
      {};
    for (const r of rows) {
      out[r.order_id] = { total: r.total, done: r.done, state: r.state };
    }
    return out;
  }

  /**
   * Sync the newest open orders of the store (dashboard "generate" button):
   * at most BACKFILL_LIMIT per request, in batches of BACKFILL_BATCH with a
   * yield to the event loop between batches so one big store cannot hog
   * the process. `remaining` > 0 tells the caller to press again.
   */
  async backfill(
    storeId: string,
  ): Promise<{ synced: number; failed: number; remaining: number }> {
    const where = {
      store_id: storeId,
      status: { in: PRODUCTION_ACTIVE_STATUSES },
    } satisfies Prisma.OrderWhereInput;
    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        select: { id: true },
        orderBy: { created_at: 'desc' },
        take: BACKFILL_LIMIT,
      }),
      this.prisma.order.count({ where }),
    ]);
    let synced = 0;
    let failed = 0;
    for (let i = 0; i < orders.length; i += BACKFILL_BATCH) {
      if (i > 0) await this.yieldBetweenBatches();
      for (const o of orders.slice(i, i + BACKFILL_BATCH)) {
        try {
          await this.syncOrder(o.id, storeId);
          synced++;
        } catch (err) {
          failed++;
          this.logger.warn(
            `Production backfill failed for ${o.id}: ${errText(err)}`,
          );
        }
      }
    }
    return { synced, failed, remaining: Math.max(total - orders.length, 0) };
  }

  /** Let other requests run between two backfill batches. */
  protected yieldBetweenBatches(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }
}

function toSummaryView(
  row: {
    total: number;
    done: number;
    state: string;
    completed_at: Date | null;
  } | null,
  fallback: { total: number; done: number; state: string },
): ProductionSummaryView {
  const src = row ?? { ...fallback, completed_at: null };
  return {
    total: src.total,
    done: src.done,
    state: src.state as ProductionSummaryView['state'],
    completed_at: src.completed_at,
  };
}

/**
 * Serialize the checklist writes of one order. Under READ COMMITTED two
 * concurrent "last check" writes would each count the other's check as open
 * and both store IN_PROGRESS, so READY (and COMPLETED + automation) would be
 * missed; two first syncs would also race on the summary insert. The
 * transaction-scoped advisory lock makes every write see the previous one.
 */
async function lockOrder(tx: Db, orderId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`production:${orderId}`}))`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

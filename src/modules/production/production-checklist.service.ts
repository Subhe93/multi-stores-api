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
const BACKFILL_LIMIT = 1000;
const BACKFILL_BATCH = 50;
const EVENTS_LIMIT = 200;

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
   * syncs cannot double them), a changed source resets its check
   * (VALUE_CHANGED), a vanished one goes stale (STALE; custom items never
   * do). A second run without changes writes nothing. Closed orders are
   * read-only.
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
    for (const item of order.items) {
      if (!isOwnLine(item, creatorId)) continue;
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
        const hash = sourceHash(s.label, s.value, s.file_url);
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
        } else if (row.stale) {
          await tx.orderProductionCheck.update({
            where: { id: row.id },
            data: { stale: false },
          });
        }
      }

      for (const row of existing) {
        if (row.stale || row.source === ProductionCheckSource.CUSTOM) continue;
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
      await this.writeSummary(tx, orderId, storeId, { onlyIfChanged: true });
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
   * retries are harmless.
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
        where: { id: checkId, done: !done },
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

  private async logCompleted(
    tx: Db,
    orderId: string,
    actor: ProductionActor,
  ): Promise<void> {
    await tx.orderProductionEvent.create({
      data: {
        order_id: orderId,
        action: 'COMPLETED',
        actor_id: actor.id,
        actor_name: actor.name,
      },
    });
    // Internal timeline entry (the customer page reads only STATUS_STEPS).
    await tx.orderTimeline.create({
      data: {
        order_id: orderId,
        status: 'PRODUCTION_COMPLETED',
        note: 'Production checklist completed',
        actor: actor.id,
      },
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

  async events(storeId: string, orderId: string) {
    await this.orderOfStore(orderId, storeId);
    return this.prisma.orderProductionEvent.findMany({
      where: { order_id: orderId },
      orderBy: { created_at: 'desc' },
      take: EVENTS_LIMIT,
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

  /** Sync the newest open orders of the store (dashboard "generate" button). */
  async backfill(storeId: string): Promise<{ synced: number }> {
    const orders = await this.prisma.order.findMany({
      where: { store_id: storeId, status: { in: PRODUCTION_ACTIVE_STATUSES } },
      select: { id: true },
      orderBy: { created_at: 'desc' },
      take: BACKFILL_LIMIT,
    });
    let synced = 0;
    for (let i = 0; i < orders.length; i += BACKFILL_BATCH) {
      for (const o of orders.slice(i, i + BACKFILL_BATCH)) {
        try {
          await this.syncOrder(o.id, storeId);
          synced++;
        } catch (err) {
          this.logger.warn(
            `Production backfill failed for ${o.id}: ${errText(err)}`,
          );
        }
      }
    }
    return { synced };
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

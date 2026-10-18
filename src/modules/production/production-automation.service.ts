import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  DesignPrintStatus,
  FulfillerType,
  FulfillmentStatus,
  OrderStatus,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { OrdersService } from '../orders/orders.service';
import {
  normalizeProductionSettings,
  type ProductionCompleteTarget,
  type ProductionSettings,
} from './production-settings';
import { ProductionChecklistService } from './production-checklist.service';
import { ProductionTriggersService } from './production-triggers.service';
import type {
  ProductionActor,
  ProductionSummaryView,
} from './production.types';

/** Order progress ranks (mirror of OrdersService ORDER_STATUS_RANK). */
const ORDER_RANK: Partial<Record<OrderStatus, number>> = {
  PENDING: 0,
  CONFIRMED: 1,
  PROCESSING: 2,
  MANUFACTURING: 3,
  QUALITY_CHECK: 4,
  SHIPPED: 5,
  DELIVERED: 6,
};

const ITEM_RANK: Record<FulfillmentStatus, number> = {
  PENDING: 0,
  PROCESSING: 1,
  MANUFACTURING: 2,
  QUALITY_CHECK: 3,
  SHIPPED: 4,
  DELIVERED: 5,
};

export interface ProductionSuggestion {
  next_status: ProductionCompleteTarget;
  /** SHIPPED only (M5.4 `ship_prompt`): the dashboard asks for tracking. */
  ask_tracking: boolean;
  /** SHIPPED only: the move is refused by the dashboard until it is entered. */
  requires_tracking: boolean;
}

/** AUTO_ADVANCE event payload reason of the print-ready step (M5.4). */
export const PRINT_READY_REASON = 'print_ready';

/** Statuses the print-ready step may leave, per target (forward-only). */
const PRINT_READY_FROM: Record<'PROCESSING' | 'MANUFACTURING', OrderStatus[]> =
  {
    PROCESSING: [OrderStatus.CONFIRMED],
    MANUFACTURING: [OrderStatus.CONFIRMED, OrderStatus.PROCESSING],
  };

export interface ProductionAutomationResult {
  suggestion: ProductionSuggestion | null;
  /** The order header status after the write (and any automation). */
  order_status: OrderStatus | null;
  /** Status the order header moved to through the automation, if any. */
  auto_advanced_to?: OrderStatus;
}

/**
 * What an automation step did: `advanced` (updateStatus ran), `skipped`
 * (nothing to do: the order or a line is already at / past the target),
 * `failed` (updateStatus threw; retried on the next request of the order).
 */
type AdvanceOutcome = 'advanced' | 'skipped' | 'failed';

/**
 * Status automation after checklist writes (M4.3 §3.6). Every status change
 * goes through OrdersService.updateStatus as the creator, so timeline,
 * commission, invoices and emails behave exactly like a manual change; the
 * creator's own lines move and the header follows the slowest line.
 * Forward-only: an uncheck never moves anything back, and SHIPPED is never
 * automatic.
 */
@Injectable()
export class ProductionAutomationService implements OnModuleInit {
  private readonly logger = new Logger(ProductionAutomationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storeApps: StoreAppsService,
    private readonly orders: OrdersService,
    private readonly checklist: ProductionChecklistService,
    private readonly triggers?: ProductionTriggersService,
  ) {}

  /** The print queue reaches this service through the core triggers (M5.4). */
  onModuleInit(): void {
    this.triggers?.registerPrintReadyHandler(async (orderId, storeId) => {
      await this.onPrintReady(orderId, storeId);
    });
  }

  async settingsOf(storeId: string): Promise<ProductionSettings> {
    return normalizeProductionSettings(
      await this.storeApps.getSettings(storeId, 'production'),
    );
  }

  /** "All done — move to X?" when the checklist is complete and the order is behind X. */
  suggestionFor(
    settings: ProductionSettings,
    status: OrderStatus,
    summary: Pick<ProductionSummaryView, 'state'>,
  ): ProductionSuggestion | null {
    if (settings.on_complete === 'none' || summary.state !== 'READY') {
      return null;
    }
    const rank = ORDER_RANK[status];
    const target = ORDER_RANK[settings.complete_target as OrderStatus];
    if (rank === undefined || target === undefined || rank >= target) {
      return null;
    }
    const shipping = settings.complete_target === 'SHIPPED';
    return {
      next_status: settings.complete_target,
      ask_tracking: shipping && settings.ship_prompt !== 'none',
      requires_tracking:
        shipping && settings.ship_prompt === 'tracking_required',
    };
  }

  /**
   * M5.4 `on_print_ready`: the designer rendered a print file of the order.
   * Once every live design of the order is READY, the store's own lines
   * move forward to the configured status, once per order (an AUTO_ADVANCE
   * event with reason `print_ready` is the idempotency mark), never back
   * and never to SHIPPED (the setting cannot name it). Returns the status
   * the order moved to, if it did.
   */
  async onPrintReady(
    orderId: string,
    storeId: string,
  ): Promise<OrderStatus | undefined> {
    const settings = await this.settingsOf(storeId);
    if (settings.on_print_ready === 'none') return undefined;
    const to = OrderStatus[settings.on_print_ready];
    const [designs, already, store] = await Promise.all([
      this.prisma.orderItemDesign.findMany({
        where: { order_id: orderId, terminal_at: null },
        select: { print_status: true },
      }),
      this.prisma.orderProductionEvent.findFirst({
        where: {
          order_id: orderId,
          action: 'AUTO_ADVANCE',
          payload: { path: ['reason'], equals: PRINT_READY_REASON },
        },
        select: { id: true },
      }),
      this.prisma.store.findUnique({
        where: { id: storeId },
        select: {
          creator: {
            select: { id: true, user_id: true, display_name: true },
          },
        },
      }),
    ]);
    if (
      already ||
      !store?.creator ||
      designs.length === 0 ||
      designs.some((d) => d.print_status !== DesignPrintStatus.READY)
    ) {
      return undefined;
    }
    const outcome = await this.advance(
      {
        creatorId: store.creator.id,
        actor: { id: store.creator.user_id, name: store.creator.display_name },
      },
      orderId,
      to,
      PRINT_READY_FROM[settings.on_print_ready],
      { note: 'Print files ready', reason: PRINT_READY_REASON },
    );
    return outcome === 'advanced' ? to : undefined;
  }

  /**
   * Run after setDone / bulkSet. `started` and `completed` are true only for
   * the single write that caused the transition (guarded in the summary).
   * The on-complete auto-advance also runs when an earlier attempt is still
   * owed (`auto_advance_pending`: it failed, or the completion came from a
   * sync), so a READY order is never stuck behind one failed updateStatus.
   */
  async afterWrite(
    ctx: { storeId: string; creatorId: string; actor: ProductionActor },
    orderId: string,
    result: {
      started: boolean;
      completed: boolean;
      summary: ProductionSummaryView;
    },
  ): Promise<ProductionAutomationResult> {
    const settings = await this.settingsOf(ctx.storeId);
    let autoTo: OrderStatus | undefined;

    if (result.started && settings.start_on_first_check) {
      const outcome = await this.advance(
        ctx,
        orderId,
        OrderStatus.MANUFACTURING,
        [OrderStatus.CONFIRMED, OrderStatus.PROCESSING],
      );
      if (outcome === 'advanced') autoTo = OrderStatus.MANUFACTURING;
    }
    if (
      autoQualityCheck(settings) &&
      result.summary.state === 'READY' &&
      (result.completed || (await this.pending(orderId)))
    ) {
      const to = await this.autoAdvance(ctx, orderId);
      if (to) autoTo = to;
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    return {
      suggestion: order
        ? this.suggestionFor(settings, order.status, result.summary)
        : null,
      order_status: order?.status ?? null,
      ...(autoTo ? { auto_advanced_to: autoTo } : {}),
    };
  }

  /**
   * Retry an owed on-complete auto-advance (workspace read, after the lazy
   * sync). Returns the status the order moved to, if it did.
   */
  async retryPending(
    ctx: { storeId: string; creatorId: string; actor: ProductionActor },
    orderId: string,
  ): Promise<OrderStatus | undefined> {
    if (!(await this.pending(orderId))) return undefined;
    const settings = await this.settingsOf(ctx.storeId);
    if (!autoQualityCheck(settings)) {
      // The setting was switched off meanwhile: nothing is owed any more.
      await this.setPending(orderId, false);
      return undefined;
    }
    return this.autoAdvance(ctx, orderId);
  }

  /** The QUALITY_CHECK auto-advance; records a failure for the next retry. */
  private async autoAdvance(
    ctx: { creatorId: string; actor: ProductionActor },
    orderId: string,
  ): Promise<OrderStatus | undefined> {
    const outcome = await this.advance(
      ctx,
      orderId,
      OrderStatus.QUALITY_CHECK,
      [
        OrderStatus.CONFIRMED,
        OrderStatus.PROCESSING,
        OrderStatus.MANUFACTURING,
      ],
    );
    await this.setPending(orderId, outcome === 'failed');
    return outcome === 'advanced' ? OrderStatus.QUALITY_CHECK : undefined;
  }

  private async pending(orderId: string): Promise<boolean> {
    try {
      return await this.checklist.isAutoAdvancePending(orderId);
    } catch (err) {
      this.logger.warn(
        `Production pending-advance read failed for ${orderId}: ${errText(err)}`,
      );
      return false;
    }
  }

  private async setPending(orderId: string, pending: boolean): Promise<void> {
    try {
      await this.checklist.setAutoAdvancePending(orderId, pending);
    } catch (err) {
      this.logger.warn(
        `Production pending-advance write failed for ${orderId}: ${errText(err)}`,
      );
    }
  }

  /**
   * Move the creator's lines to `to` when the order is in one of `from` and
   * none of those lines is already at or past `to` (never regress a line).
   */
  private async advance(
    ctx: { creatorId: string; actor: ProductionActor },
    orderId: string,
    to: OrderStatus,
    from: OrderStatus[],
    detail: { note?: string; reason?: string } = {},
  ): Promise<AdvanceOutcome> {
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: {
          status: true,
          items: {
            where: {
              fulfiller_type: FulfillerType.CREATOR,
              fulfiller_id: ctx.creatorId,
            },
            select: { fulfillment_status: true },
          },
        },
      });
      if (!order || !from.includes(order.status)) return 'skipped';
      const toRank = ITEM_RANK[to as FulfillmentStatus];
      if (
        order.items.length === 0 ||
        order.items.some((i) => ITEM_RANK[i.fulfillment_status] >= toRank)
      ) {
        return 'skipped';
      }
      await this.orders.updateStatus(
        orderId,
        {
          status: to,
          note:
            detail.note ??
            (to === OrderStatus.QUALITY_CHECK
              ? 'Production checklist completed'
              : 'Production started'),
        },
        ctx.actor.id,
        UserRole.CREATOR,
      );
      await this.checklist.logAutoAdvance(orderId, ctx.actor, {
        from: order.status,
        to,
        ...(detail.reason ? { reason: detail.reason } : {}),
      });
      return 'advanced';
    } catch (err) {
      this.logger.warn(
        `Production auto-advance to ${to} failed for ${orderId}: ${errText(err)}`,
      );
      return 'failed';
    }
  }
}

/** Whether the settings ask for the automatic QUALITY_CHECK step. */
function autoQualityCheck(settings: ProductionSettings): boolean {
  return (
    settings.on_complete === 'auto' &&
    settings.complete_target === 'QUALITY_CHECK'
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

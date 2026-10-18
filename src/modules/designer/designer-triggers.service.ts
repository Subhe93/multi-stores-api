/**
 * Order lifecycle hooks of the designer app (M4.2 §5.3, WP5), invoice
 * pattern (`invoice-triggers.service.ts`). Every method:
 *  - returns at once when the order has no store, or the store has never
 *    had a designed order and the app is not in effect (one cached
 *    isEnabled, then a cached existence probe — see `storeHasDesigns`);
 *  - runs its bookkeeping (`print_requested_at`, `terminal_at`,
 *    `shipped_at`, design release) whether the app is on or off, so
 *    retention dates stay right and switching the app on resumes the queue;
 *    only the worker's claims are gated on the app;
 *  - never throws: failures are logged, so checkout / webhooks / status
 *    changes are never blocked by the designer;
 *  - only enqueues (rendering happens in the print queue worker);
 *  - is idempotent (a replayed webhook finds the rows already requested).
 *
 * Call sites: `payments.service.ts` (Stripe succeeded) and
 * `kustom.service.ts` (authorized) call `onOrderPaid` directly; WP4 calls
 * `onCodOrderCreated`, `onStatusChanged` and `onPaymentFailed` from
 * `orders.service.ts` through `DESIGNER_TRIGGERS_PORT`, which
 * `DesignerCoreModule` binds to this service.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
  DesignerTriggerOrder as PortOrder,
  DesignerTriggersPort,
} from '../../common/ports/designer-triggers.port';
import { ProductionTriggersService } from '../production/production-triggers.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { DesignerPrintQueueService } from './designer-print-queue.service';

/** What every trigger needs; callers pass data they already loaded. */
export interface DesignerTriggerOrder extends PortOrder {
  payment_status?: string | null;
}

/** Order statuses that are not "live" (nothing is printed for them). */
const TERMINAL_STATUSES = new Set(['CANCELLED', 'REFUNDED', 'RETURNED']);

/** Paid, or cash on delivery (payable now). */
function isPayable(order: DesignerTriggerOrder): boolean {
  return (
    order.payment_status === 'paid' ||
    String(order.payment_method ?? '').toUpperCase() === 'COD'
  );
}

/** "Has designs" probe cache: a yes is kept long, a no briefly. */
const PRESENCE_YES_TTL_MS = 60 * 60 * 1000;
const PRESENCE_NO_TTL_MS = 5 * 60 * 1000;
const PRESENCE_MAX_ENTRIES = 5_000;

@Injectable()
export class DesignerTriggersService implements DesignerTriggersPort {
  private readonly logger = new Logger(DesignerTriggersService.name);
  private readonly presence = new Map<
    string,
    { value: boolean; expiresAt: number }
  >();

  constructor(
    private readonly storeApps: StoreAppsService,
    private readonly queue: DesignerPrintQueueService,
    // M5.4: the production app's print-ready step (absent in a build
    // without the production core module).
    @Optional() private readonly production?: ProductionTriggersService,
  ) {
    this.queue.onPrintReady?.((row) =>
      this.onPrintReady({ id: row.order_id, store_id: row.store_id }),
    );
  }

  /**
   * A print file of the order reached READY (print queue worker): the
   * production app may move the order forward (`on_print_ready`, M5.4).
   */
  async onPrintReady(order: DesignerTriggerOrder): Promise<void> {
    await this.run(order, 'onPrintReady', async () => {
      await this.production?.onPrintReady(order.id, order.store_id);
    });
  }

  /** Payment confirmed (Stripe succeeded, Kustom authorized): queue the print files. */
  async onOrderPaid(order: DesignerTriggerOrder): Promise<void> {
    await this.run(order, 'onOrderPaid', async () => {
      // A late payment of an order the sweep had failed: live again.
      await this.queue.reviveOrder(order.id);
      await this.queue.enqueueOrder(order.id);
    });
  }

  /** A cash-on-delivery order was created: queue the print files at once. */
  async onCodOrderCreated(order: DesignerTriggerOrder): Promise<void> {
    await this.run(order, 'onCodOrderCreated', async () => {
      await this.queue.enqueueOrder(order.id);
    });
  }

  /**
   * The order status changed. CANCELLED / REFUNDED: terminal, pending
   * renders withdrawn. SHIPPED / DELIVERED: `shipped_at` set when missing
   * (retention counts from it). Un-cancel (from CANCELLED / REFUNDED to a
   * live status): the rows are revived and, when the order is paid or COD,
   * requested again; an un-cancelled order whose payment state is unknown
   * here is picked up by the worker's backfill.
   */
  async onStatusChanged(
    order: DesignerTriggerOrder,
    from: string | null | undefined,
    to: string,
  ): Promise<void> {
    if (from === to) return;
    await this.run(order, 'onStatusChanged', async () => {
      if (to === 'CANCELLED' || to === 'REFUNDED') {
        await this.queue.cancelOrder(order.id);
        return;
      }
      if (
        (from === 'CANCELLED' || from === 'REFUNDED') &&
        !TERMINAL_STATUSES.has(to)
      ) {
        await this.queue.reviveOrder(order.id);
        if (isPayable(order)) await this.queue.enqueueOrder(order.id);
      }
      if (to === 'SHIPPED' || to === 'DELIVERED') {
        await this.queue.markShipped(order.id);
      }
    });
  }

  /**
   * The payment failed / was abandoned: the rows become terminal (retention
   * purges them 14 days later) and the frozen designs are released.
   */
  async onPaymentFailed(order: DesignerTriggerOrder): Promise<void> {
    await this.run(order, 'onPaymentFailed', async () => {
      await this.queue.markPaymentFailed(order.id);
    });
  }

  /** The order was shipped (OrdersService shipped hook). */
  async onShipped(order: DesignerTriggerOrder): Promise<void> {
    await this.run(order, 'onShipped', async () => {
      await this.queue.markShipped(order.id);
    });
  }

  /**
   * True when designer bookkeeping can matter for the store: the app is in
   * effect (cached isEnabled), or the store has order designs (cached
   * probe; switched off after use). A store that never used the designer
   * costs one cached isEnabled plus one probe per few minutes. Also used by
   * the order-email extension.
   */
  async storeHasDesigns(storeId: string): Promise<boolean> {
    if (await this.storeApps.isEnabled(storeId, 'designer')) return true;
    const now = Date.now();
    const hit = this.presence.get(storeId);
    if (hit && hit.expiresAt > now) return hit.value;
    const value = await this.queue.storeHasDesigns(storeId);
    if (this.presence.size >= PRESENCE_MAX_ENTRIES) this.presence.clear();
    this.presence.set(storeId, {
      value,
      expiresAt: now + (value ? PRESENCE_YES_TTL_MS : PRESENCE_NO_TTL_MS),
    });
    return value;
  }

  private async run(
    order: DesignerTriggerOrder,
    name: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    try {
      if (!order?.id || !order.store_id) return;
      if (!(await this.storeHasDesigns(order.store_id))) return;
      await fn();
    } catch (e) {
      this.logger.warn(
        `${name} for order ${order?.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

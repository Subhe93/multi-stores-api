import { Injectable } from '@nestjs/common';

/**
 * Order lifecycle hooks of the designer app (M4.2 §5.3, C28).
 *
 * Call sites: `OrdersService` (COD order created — after the order
 * transaction committed —, status changed) and the payment providers (order
 * paid). M4.2 WP5 implements them (print queue:
 * `print_requested_at`, `terminal_at`, `shipped_at`, worker nudge) and binds
 * its service to `DESIGNER_TRIGGERS_PORT` in `DesignerCoreModule`, replacing
 * the no-op default. Rules for an implementation (invoice-triggers pattern):
 * never throw, return quickly (only enqueue), be idempotent, and do nothing
 * (one cached `isEnabled`) for stores without the app.
 *
 * OrdersService additionally wraps every call in try/catch, so a failing
 * implementation never breaks an order flow.
 */
export const DESIGNER_TRIGGERS_PORT = Symbol('DESIGNER_TRIGGERS_PORT');

export interface DesignerTriggerOrder {
  id: string;
  store_id: string | null;
  /** A `PaymentMethod` value. */
  payment_method?: string | null;
}

export interface DesignerTriggersPort {
  /** A cash-on-delivery order was created (it is payable now): request print. */
  onCodOrderCreated(order: DesignerTriggerOrder): Promise<void>;
  /**
   * The order's payment was confirmed. Called ONLY by the payment providers
   * (`payments.service.ts` Stripe succeeded, `kustom.service.ts`
   * authorized), right after the invoice trigger — never by
   * `OrdersService.markOrderPaid`, so it runs once per payment.
   */
  onOrderPaid(order: DesignerTriggerOrder): Promise<void>;
  /**
   * The order status changed: `OrdersService` admin `updateStatus`, the
   * automatic recompute from item fulfilment, and `markOrderRefunded`.
   * These are also the only places SHIPPED is reached (the same sites run
   * the shipped hooks), so SHIPPED / DELIVERED set `shipped_at` here and no
   * separate shipped call exists; CANCELLED / REFUNDED set `terminal_at`
   * and cancel pending renders.
   */
  onStatusChanged(
    order: DesignerTriggerOrder,
    /** `OrderStatus` values. */
    from: string,
    to: string,
  ): Promise<void>;
  /**
   * The payment failed or was abandoned (`OrdersService.markOrderFailed`):
   * the order's designs become terminal and the designs it froze are
   * released (editable / orderable again). Optional for older bindings.
   */
  onPaymentFailed?(order: DesignerTriggerOrder): Promise<void>;
}

/** Default binding until WP5 provides the real triggers: does nothing. */
@Injectable()
export class NoopDesignerTriggers implements DesignerTriggersPort {
  onCodOrderCreated(): Promise<void> {
    return Promise.resolve();
  }
  onOrderPaid(): Promise<void> {
    return Promise.resolve();
  }
  onStatusChanged(): Promise<void> {
    return Promise.resolve();
  }
  onPaymentFailed(): Promise<void> {
    return Promise.resolve();
  }
}

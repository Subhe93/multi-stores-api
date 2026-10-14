import { Injectable, Logger } from '@nestjs/common';
import { InvoiceKind, InvoiceTrigger } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { currencyDecimals } from '../../common/money/currency.util';
import { errorCode } from './invoice-errors';
import { parseInvoiceSettings } from './invoice-settings';
import { InvoicesService } from './invoices.service';
import type { InvoiceSettings } from './invoices.types';

/** What every trigger needs; callers pass data they already loaded. */
export interface TriggerOrder {
  id: string;
  store_id: string | null;
  payment_method?: string | null;
  payment_status?: string | null;
  currency?: string | null;
}

/** Expected outcomes that are not worth a warning. */
const QUIET_CODES = new Set([
  'INVOICE_CREDIT_NOTHING_LEFT',
  'INVOICE_ALREADY_ISSUED',
]);

/**
 * Lifecycle hooks of the invoices app (D5, §3.3). Every method:
 *  - returns at once (one cached isEnabled call, no DB query) when the order
 *    has no store or the app is not in effect for it;
 *  - never throws: failures are logged, so checkout / webhooks / status
 *    changes are never blocked by invoicing;
 *  - is idempotent (issue per order; credit notes per idempotency key).
 * The call sites in orders / payments / kustom are wired separately.
 */
@Injectable()
export class InvoiceTriggersService {
  private readonly logger = new Logger(InvoiceTriggersService.name);

  constructor(
    private readonly storeApps: StoreAppsService,
    private readonly prisma: PrismaService,
    private readonly invoices: InvoicesService,
  ) {}

  /** Payment confirmed (Stripe succeeded, Kustom authorized). */
  async onOrderPaid(order: TriggerOrder): Promise<void> {
    await this.run(order, 'onOrderPaid', async (settings) => {
      if (!settings.auto_issue || order.payment_status !== 'paid') return;
      await this.invoices.issueForOrder(order.id, {
        trigger: InvoiceTrigger.PAYMENT,
      });
    });
  }

  /** A cash-on-delivery order was created. */
  async onCodOrderCreated(order: TriggerOrder): Promise<void> {
    await this.run(order, 'onCodOrderCreated', async (settings) => {
      if (!settings.auto_issue || settings.cod_issue_on !== 'created') return;
      await this.invoices.issueForOrder(order.id, {
        trigger: InvoiceTrigger.COD_CREATED,
      });
    });
  }

  /** The order status changed from `from` to `to`. */
  async onStatusChanged(
    order: TriggerOrder,
    from: string | null | undefined,
    to: string,
  ): Promise<void> {
    if (from === to) return;
    await this.run(order, 'onStatusChanged', async (settings) => {
      if (to === 'DELIVERED') {
        if (
          order.payment_method === 'COD' &&
          settings.auto_issue &&
          settings.cod_issue_on === 'delivered'
        ) {
          await this.invoices.issueForOrder(order.id, {
            trigger: InvoiceTrigger.COD_DELIVERED,
          });
        }
      } else if (to === 'CANCELLED') {
        if (settings.credit_on_cancel) await this.creditCancellation(order);
      } else if (to === 'REFUNDED') {
        await this.creditFullRefund(order);
      }
      // RETURNED: nothing; a refund event follows if money moves.
    });
  }

  /** The whole order was refunded. */
  async onFullRefund(order: TriggerOrder): Promise<void> {
    await this.run(order, 'onFullRefund', () => this.creditFullRefund(order));
  }

  /**
   * A partial refund. `cumulativeRefunded` is the provider's running total
   * (gross, major units); the credit is that total minus the refunds already
   * credited, capped at what is left (computed under the sequence lock).
   */
  async onPartialRefund(
    order: TriggerOrder,
    cumulativeRefunded: number,
  ): Promise<void> {
    await this.run(order, 'onPartialRefund', async () => {
      const invoice = await this.findInvoice(order.id);
      if (!invoice) return;
      const factor = 10 ** currencyDecimals(invoice.currency);
      const cumulativeMinor = Math.round(Number(cumulativeRefunded) * factor);
      if (!(cumulativeMinor > 0)) return;
      await this.invoices.issueCreditNote(invoice.id, {
        amount: { refundCumulative: cumulativeMinor / factor },
        trigger: InvoiceTrigger.REFUND,
        reasonCode: 'refund',
        idempotencyKey: `refund:${order.id}:${cumulativeMinor}`,
      });
    });
  }

  /** Cancelled (also a released Kustom authorization). */
  async onCancelled(order: TriggerOrder): Promise<void> {
    await this.run(order, 'onCancelled', async (settings) => {
      if (settings.credit_on_cancel) await this.creditCancellation(order);
    });
  }

  /**
   * A Kustom authorization was released (the money was never captured).
   * Always credits the invoice in full, regardless of credit_on_cancel: an
   * invoice for money that will never be collected must be voided.
   */
  async onAuthorizationReleased(order: TriggerOrder): Promise<void> {
    await this.run(order, 'onAuthorizationReleased', () =>
      this.creditCancellation(order),
    );
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async creditFullRefund(order: TriggerOrder): Promise<void> {
    const invoice = await this.findInvoice(order.id);
    if (!invoice) return;
    await this.invoices.issueCreditNote(invoice.id, {
      amount: 'full',
      trigger: InvoiceTrigger.REFUND,
      reasonCode: 'refund',
      idempotencyKey: `refund-full:${order.id}`,
    });
  }

  private async creditCancellation(order: TriggerOrder): Promise<void> {
    const invoice = await this.findInvoice(order.id);
    if (!invoice) return;
    await this.invoices.issueCreditNote(invoice.id, {
      amount: 'full',
      trigger: InvoiceTrigger.CANCELLATION,
      reasonCode: 'cancellation',
      idempotencyKey: `cancel:${order.id}`,
    });
  }

  /** The order's invoice; credit triggers no-op without one. */
  private findInvoice(orderId: string) {
    return this.prisma.invoice.findFirst({
      where: { order_id: orderId, kind: InvoiceKind.INVOICE },
      select: { id: true, currency: true },
    });
  }

  private async run(
    order: TriggerOrder,
    name: string,
    fn: (settings: InvoiceSettings) => Promise<void>,
  ): Promise<void> {
    try {
      if (!order?.store_id) return;
      if (!(await this.storeApps.isEnabled(order.store_id, 'invoices'))) return;
      const settings = parseInvoiceSettings(
        await this.storeApps.getSettings(order.store_id, 'invoices'),
      );
      await fn(settings);
    } catch (e) {
      const code = errorCode(e);
      if (code && QUIET_CODES.has(code)) return;
      this.logger.warn(
        `${name} for order ${order?.id}: ${code ?? ''} ${e instanceof Error ? e.message : String(e)}`.trim(),
      );
    }
  }
}

import { Injectable, Logger, Optional } from '@nestjs/common';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { ProductionChecklistService } from './production-checklist.service';
import { ProductionNotificationsService } from './production-notifications.service';

/** Registered by ProductionAutomationService (ProductionModule) on init. */
export type PrintReadyHandler = (
  orderId: string,
  storeId: string,
) => Promise<void>;

/**
 * The production app's hooks inside OrdersService (optional injection, C28)
 * and the designer print queue (M5.4). Each one costs a single cached
 * StoreAppsService.isEnabled() for stores without the app and never throws
 * into the order flow.
 */
@Injectable()
export class ProductionTriggersService {
  private readonly logger = new Logger(ProductionTriggersService.name);
  private printReadyHandler: PrintReadyHandler | null = null;

  constructor(
    private readonly storeApps: StoreAppsService,
    private readonly checklist: ProductionChecklistService,
    @Optional()
    private readonly notifications?: ProductionNotificationsService,
  ) {}

  /** Whether the production app is in effect for the store. */
  isEnabled(storeId: string): Promise<boolean> {
    return this.storeApps.isEnabled(storeId, 'production');
  }

  /**
   * Right after `order.create` returned (outside its transaction): generate
   * the checklist when the app is on, then the staff notification (M5.4,
   * opt-in). Best-effort: a failure is logged and repaired later by the
   * lazy sync (GET / summaries / backfill).
   */
  async onOrderCreated(orderId: string, storeId: string | null): Promise<void> {
    if (!storeId) return;
    try {
      if (!(await this.isEnabled(storeId))) return;
      await this.checklist.syncOrder(orderId, storeId);
    } catch (err) {
      this.logger.warn(
        `Production checklist generation failed for order ${orderId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    try {
      await this.notifications?.notifyNewOrder(orderId, storeId);
    } catch (err) {
      this.logger.warn(
        `Production new-order notification failed for order ${orderId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * The status automation lives in ProductionModule (it needs OrdersService,
   * which this cycle-free core module cannot import), so it registers its
   * print-ready step here, like the designer registers its source provider.
   */
  registerPrintReadyHandler(handler: PrintReadyHandler): void {
    this.printReadyHandler = handler;
  }

  /**
   * The designer print queue rendered a print file of the order (M5.4,
   * `on_print_ready`). A no-op without the app or a registered handler.
   */
  async onPrintReady(orderId: string, storeId: string | null): Promise<void> {
    if (!storeId || !this.printReadyHandler) return;
    try {
      if (!(await this.isEnabled(storeId))) return;
      await this.printReadyHandler(orderId, storeId);
    } catch (err) {
      this.logger.warn(
        `Production print-ready step failed for order ${orderId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

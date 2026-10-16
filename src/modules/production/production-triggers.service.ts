import { Injectable, Logger } from '@nestjs/common';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { ProductionChecklistService } from './production-checklist.service';

/**
 * The production app's hooks inside OrdersService (optional injection, C28).
 * Each one costs a single cached StoreAppsService.isEnabled() for stores
 * without the app and never throws into the order flow.
 */
@Injectable()
export class ProductionTriggersService {
  private readonly logger = new Logger(ProductionTriggersService.name);

  constructor(
    private readonly storeApps: StoreAppsService,
    private readonly checklist: ProductionChecklistService,
  ) {}

  /** Whether the production app is in effect for the store. */
  isEnabled(storeId: string): Promise<boolean> {
    return this.storeApps.isEnabled(storeId, 'production');
  }

  /**
   * Right after `order.create` returned (outside its transaction): generate
   * the checklist when the app is on. Best-effort: a failure is logged and
   * repaired later by the lazy sync (GET / summaries / backfill).
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
    }
  }
}

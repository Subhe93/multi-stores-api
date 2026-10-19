import { Injectable } from '@nestjs/common';
import { DesignPrintStatus, ProductionCheckSource } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { SORT_BASE } from './production-sources';
import type {
  ProductionLineRef,
  ProductionOrderRef,
  ProductionSourceProvider,
  SourceCheck,
} from './production.types';

/** Label of the design check (the only source without a store-locale snapshot). */
export const DESIGN_CHECK_LABEL = 'Print file';

/**
 * The designer's production source (C27), registered by `DesignerModule`
 * on init: one `design:<OrderItemDesign.id>` "Print file" check per
 * designed line, and the download links of the rendered print files for the
 * production sheet. A no-op for stores without the designer app (one cached
 * isEnabled); the frozen design row is order data, so it never changes and
 * its check can only go stale when the row itself is gone.
 */
@Injectable()
export class DesignProductionProvider implements ProductionSourceProvider {
  readonly key = 'designer';

  constructor(
    private readonly prisma: PrismaService,
    private readonly storeApps: StoreAppsService,
  ) {}

  private enabled(storeId: string): Promise<boolean> {
    if (!storeId) return Promise.resolve(false);
    return this.storeApps.isEnabled(storeId, 'designer');
  }

  async sources(
    item: ProductionLineRef,
    order: ProductionOrderRef,
  ): Promise<SourceCheck[]> {
    if (!(await this.enabled(order.store_id))) return [];
    const design = await this.prisma.orderItemDesign.findUnique({
      where: { order_item_id: item.id },
      select: { id: true },
    });
    if (!design) return [];
    return [
      {
        order_item_id: item.id,
        source: ProductionCheckSource.DESIGN,
        source_key: `design:${design.id}`,
        label: DESIGN_CHECK_LABEL,
        value: null,
        group_index: null,
        file_url: null,
        sort_order: SORT_BASE.provider,
      },
    ];
  }

  /** Download links of the READY, unpurged print files (creator route, Bearer). */
  async printFiles(
    orderId: string,
  ): Promise<{ order_item_id: string; url: string; label: string }[]> {
    const rows = await this.prisma.orderItemDesign.findMany({
      where: {
        order_id: orderId,
        print_status: DesignPrintStatus.READY,
        files_purged_at: null,
      },
      select: { order_item_id: true, store_id: true, back_mode: true },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    if (rows.length === 0 || !(await this.enabled(rows[0].store_id))) {
      return [];
    }
    // M5.6: a double-sided line lists its back file right after the front
    // one ("Print file 2 (back)"); single-sided lines are unchanged.
    return rows.flatMap((r, i) => {
      const base = `/api/designer/my/orders/${orderId}/items/${r.order_item_id}/print`;
      const front = {
        order_item_id: r.order_item_id,
        url: base,
        label: `${DESIGN_CHECK_LABEL} ${i + 1}`,
      };
      if (!r.back_mode) return [front];
      return [
        front,
        {
          order_item_id: r.order_item_id,
          url: `${base}?side=back`,
          label: `${DESIGN_CHECK_LABEL} ${i + 1} (back)`,
        },
      ];
    });
  }
}

import type { ProductionCheckSource } from '@prisma/client';

/** One thing to produce on an order line, before it is stored as a check. */
export interface SourceCheck {
  order_item_id: string;
  source: ProductionCheckSource;
  /** Stable per line: fv:<valueId> | opt:<name> | design:<id> | custom:default:<slug>. */
  source_key: string;
  label: string;
  value: string | null;
  group_index: number | null;
  file_url: string | null;
  sort_order: number;
  /**
   * The source has no order-time snapshot to compare against (variant
   * options of an order placed before `variant_options_snapshot` existed):
   * the check is inserted when missing and otherwise left exactly as it is
   * (never reset, never stale).
   */
  insert_only?: boolean;
}

/** The order data the source providers receive (read-only). */
export interface ProductionOrderRef {
  id: string;
  store_id: string;
  status: string;
}

/** The order line data the source providers receive (read-only). */
export interface ProductionLineRef {
  id: string;
  order_id: string;
}

/**
 * Seam for later apps (C27): the designer registers `designer` and returns
 * one `design:<OrderItemDesign.id>` check per designed line, plus the print
 * files shown on the production sheet. Empty in M4.3.
 */
export interface ProductionSourceProvider {
  key: string;
  sources(
    item: ProductionLineRef,
    order: ProductionOrderRef,
  ): Promise<SourceCheck[]>;
  printFiles?(
    orderId: string,
  ): Promise<{ order_item_id: string; url: string; label: string }[]>;
}

export interface ProductionActor {
  id: string;
  name: string | null;
}

export type ProductionStateName =
  | 'NONE'
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'READY';

export interface ProductionSummaryView {
  total: number;
  done: number;
  state: ProductionStateName;
  completed_at: Date | null;
}

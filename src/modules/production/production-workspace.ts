import type { OrderProductionCheck } from '@prisma/client';
import { pickTranslation } from '../../common/personalization/pick-translation';
import { pickLocaleText } from '../../common/personalization/snapshot-label';
import { isOwnLine } from './production-sources';
import { summarize } from './production-state';
import type { ProductionSettings } from './production-settings';
import type { ProductionSuggestion } from './production-automation.service';
import type { ProductionSummaryView } from './production.types';

// Pure shaping of GET production/my/orders/:orderId (workspace + print
// sheet) from the creator's order view (OrdersService.findById) and the
// stored checks.

interface TitledTranslations {
  translations?: { locale: string; title?: string | null }[] | null;
}

/** The parts of OrdersService.findById(…, CREATOR) this view reads. */
export interface WorkspaceOrderSource {
  id: string;
  order_number: string;
  status: string;
  created_at: Date | string;
  notes?: string | null;
  locale?: string | null;
  shipping_method_name?: string | null;
  customer?: { first_name?: string | null; last_name?: string | null } | null;
  address?: {
    full_name?: string | null;
    line1?: string | null;
    line2?: string | null;
    city?: string | null;
    state?: string | null;
    postal_code?: string | null;
    country_code?: string | null;
    phone?: string | null;
  } | null;
  market?: { key: string; name: string; currency: string } | null;
  items: {
    id: string;
    quantity: number;
    fulfiller_type: string;
    fulfiller_id: string | null;
    fulfillment_status: string;
    image_url?: string | null;
    /** Order-time option map (M4.3); the live variant is only a fallback. */
    variant_options_snapshot?: unknown;
    product?: TitledTranslations | null;
    custom_product?: TitledTranslations | null;
    variant?: {
      options?: unknown;
      product?: TitledTranslations | null;
    } | null;
    custom_field_values?: {
      id: string;
      upload_id?: string | null;
      upload?: { id: string; purged_at?: Date | string | null } | null;
      /** Repeater instance ("Artikel 2") of the value, M4.1. */
      group_index?: number | null;
      group_label?: unknown;
      /** `{ hex?, option_name? }`: colour of a swatch value. */
      meta?: unknown;
    }[];
  }[];
}

export interface WorkspaceCheckView {
  id: string;
  order_item_id: string;
  source: string;
  source_key: string;
  label: string;
  value: string | null;
  group_index: number | null;
  file_url: string | null;
  /** Private original behind a file value (GET /uploads/customer/:id/original). */
  upload_id: string | null;
  /** The original was purged by retention ("file removed"). */
  file_removed: boolean;
  sort_order: number;
  done: boolean;
  done_at: Date | null;
  done_by: string | null;
  done_by_name: string | null;
  stale: boolean;
  /** Added by hand or from default_custom_items (removable: source CUSTOM). */
  custom: boolean;
  /**
   * Units of the line (one check per line, design Q14): the sheet shows
   * "×qty" next to the check. Null on write responses, where the client
   * already holds the line.
   */
  quantity: number | null;
  /**
   * Swatch colour of the value (`#rrggbb`) from the order-time value row;
   * null when the value is not a colour. Workspace reads only: write
   * responses carry null and the client keeps the value it holds.
   */
  hex: string | null;
  /**
   * Repeater instance label ("Artikel 2") in the store's primary locale, the
   * same text that prefixes `label` ("Artikel 2 – Namn"). Null outside a
   * group and on write responses.
   */
  group_label: string | null;
}

/** Display extras of a value row, keyed by the row id (`fv:<id>`). */
export interface CheckValueExtras {
  hex: string | null;
  group_label: string | null;
}

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Swatch colour of a value row's meta, when it is a valid hex colour. */
export function hexOfMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const hex = (meta as Record<string, unknown>).hex;
  return typeof hex === 'string' && HEX_RE.test(hex) ? hex : null;
}

export function toCheckView(
  c: OrderProductionCheck,
  uploads?: Map<string, { id: string; purged: boolean }>,
  quantity: number | null = null,
  extras?: Map<string, CheckValueExtras>,
): WorkspaceCheckView {
  const rowId = c.source_key.startsWith('fv:') ? c.source_key.slice(3) : null;
  const up = rowId ? uploads?.get(rowId) : undefined;
  const extra = rowId ? extras?.get(rowId) : undefined;
  return {
    id: c.id,
    order_item_id: c.order_item_id,
    source: c.source,
    source_key: c.source_key,
    label: c.label,
    value: c.value,
    group_index: c.group_index,
    file_url: c.file_url,
    upload_id: up?.id ?? null,
    file_removed: up?.purged ?? false,
    sort_order: c.sort_order,
    done: c.done,
    done_at: c.done_at,
    done_by: c.done_by,
    done_by_name: c.done_by_name,
    stale: c.stale,
    custom: c.source === 'CUSTOM',
    quantity,
    hex: extra?.hex ?? null,
    group_label: c.group_index !== null ? (extra?.group_label ?? null) : null,
  };
}

function titleOf(
  item: WorkspaceOrderSource['items'][number],
  locale: string | null,
): string {
  for (const src of [
    item.custom_product,
    item.product,
    item.variant?.product,
  ]) {
    const tr = pickTranslation(src?.translations ?? [], locale);
    if (tr?.title) return tr.title;
  }
  return '—';
}

export function variantLabel(options: unknown): string | null {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return null;
  }
  const parts = Object.entries(options as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .map(([k, v]) => `${k}: ${String(v)}`);
  return parts.length ? parts.join(', ') : null;
}

export function buildWorkspace(input: {
  order: WorkspaceOrderSource;
  checks: OrderProductionCheck[];
  summary: ProductionSummaryView;
  suggestion: ProductionSuggestion | null;
  settings: ProductionSettings;
  creatorId: string;
  primaryLocale: string | null;
  printFiles: { order_item_id: string; url: string; label: string }[];
}) {
  const { order } = input;
  const locale = order.locale ?? input.primaryLocale;
  const uploads = new Map<string, { id: string; purged: boolean }>();
  const extras = new Map<string, CheckValueExtras>();
  for (const item of order.items) {
    for (const v of item.custom_field_values ?? []) {
      const id = v.upload?.id ?? v.upload_id ?? null;
      if (id) uploads.set(v.id, { id, purged: !!v.upload?.purged_at });
      // Same group text as the check label prefix (readValueSnapshot).
      const grouped = v.group_index !== null && v.group_index !== undefined;
      extras.set(v.id, {
        hex: hexOfMeta(v.meta),
        group_label: grouped
          ? (pickLocaleText(
              v.group_label,
              input.primaryLocale,
              input.primaryLocale,
            ) ?? `#${v.group_index}`)
          : null,
      });
    }
  }
  const quantities = new Map(order.items.map((i) => [i.id, i.quantity]));
  const byLine = new Map<string, WorkspaceCheckView[]>();
  for (const c of input.checks) {
    const list = byLine.get(c.order_item_id) ?? [];
    list.push(
      toCheckView(c, uploads, quantities.get(c.order_item_id) ?? null, extras),
    );
    byLine.set(c.order_item_id, list);
  }
  const customerName = [order.customer?.first_name, order.customer?.last_name]
    .filter(Boolean)
    .join(' ');

  return {
    order: {
      id: order.id,
      order_number: order.order_number,
      status: order.status,
      created_at: order.created_at,
      notes: order.notes ?? null,
      customer_name: customerName || order.address?.full_name || null,
      shipping_address: order.address
        ? {
            full_name: order.address.full_name ?? null,
            line1: order.address.line1 ?? null,
            line2: order.address.line2 ?? null,
            city: order.address.city ?? null,
            state: order.address.state ?? null,
            postal_code: order.address.postal_code ?? null,
            country_code: order.address.country_code ?? null,
            phone: order.address.phone ?? null,
          }
        : null,
      shipping_method_name: order.shipping_method_name ?? null,
      market: order.market ?? null,
      locale: order.locale ?? null,
    },
    lines: order.items.map((item) => {
      const checks = byLine.get(item.id) ?? [];
      const progress = summarize(checks);
      return {
        order_item_id: item.id,
        title: titleOf(item, locale),
        image_url: item.image_url ?? null,
        quantity: item.quantity,
        variant_label: variantLabel(
          item.variant_options_snapshot ?? item.variant?.options,
        ),
        fulfillment_status: item.fulfillment_status,
        fulfiller_type: item.fulfiller_type,
        /** False for provider lines: no checks, read-only. */
        owned: isOwnLine(item, input.creatorId),
        progress: { total: progress.total, done: progress.done },
        checks,
      };
    }),
    summary: input.summary,
    suggestion: input.suggestion,
    settings: {
      on_complete: input.settings.on_complete,
      complete_target: input.settings.complete_target,
      use_quality_check: input.settings.use_quality_check,
      start_on_first_check: input.settings.start_on_first_check,
    },
    print_files: input.printFiles,
  };
}

import { buyerOrderItem, publicTimeline } from './buyer-order-view';

/**
 * The order as a PROVIDER may read it (GET /orders as PROVIDER,
 * GET /orders/fulfiller/:id, GET /orders/:id as PROVIDER). A marketplace
 * order can mix lines of several providers, so a provider must not learn
 * what another provider charges (its cost price) or holds in stock:
 * - the provider's OWN lines (fulfiller_type PROVIDER and fulfiller_id = its
 *   id) are kept exactly as they are;
 * - every other line is shaped like a buyer's receipt line (buyerOrderItem):
 *   no `provider_base_amount`, and the nested product / variant / custom
 *   product keep only titles, images and the chosen options. The selling
 *   prices of the line (unit_price, total_price) stay: the buyer paid them
 *   and the store shows them publicly;
 * - `commission.provider_amount` becomes the provider's own share (the very
 *   split the transfers use, passed in as `myShare`);
 * - when another provider fulfils a line of the order, `platform_amount` and
 *   `creator_amount` become null: with the order total they would give the
 *   other providers' amount by subtraction (with two providers, the other
 *   one's exact cost price x quantity). `vat_amount` stays (the order's tax
 *   lines show it anyway).
 * - the timeline loses the internal bookkeeping rows (publicTimeline).
 * Every other key is kept. Pure.
 */

type Row = Record<string, unknown>;

function isRow(v: unknown): v is Row {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isOwnLine(item: unknown, providerId: string | null): boolean {
  return (
    isRow(item) &&
    providerId !== null &&
    item.fulfiller_type === 'PROVIDER' &&
    item.fulfiller_id === providerId
  );
}

function isOtherProviderLine(
  item: unknown,
  providerId: string | null,
): boolean {
  return (
    isRow(item) &&
    item.fulfiller_type === 'PROVIDER' &&
    item.fulfiller_id !== providerId
  );
}

export function forProvider<T>(
  order: T,
  providerId: string | null,
  myShare: number | null,
): T {
  if (!isRow(order)) return order;
  const items = Array.isArray(order.items) ? (order.items as unknown[]) : null;
  const out: Row = { ...order };
  if ('timeline' in order) out.timeline = publicTimeline(order.timeline);
  if (items) {
    out.items = items.map((it) =>
      isOwnLine(it, providerId) ? it : buyerOrderItem(it),
    );
  }
  if ('commission' in order && isRow(order.commission)) {
    if (providerId === null) {
      out.commission = null;
    } else {
      const shared = (items ?? []).some((it) =>
        isOtherProviderLine(it, providerId),
      );
      out.commission = {
        ...order.commission,
        provider_amount: myShare ?? 0,
        ...(shared ? { platform_amount: null, creator_amount: null } : {}),
      };
    }
  }
  return out as T;
}

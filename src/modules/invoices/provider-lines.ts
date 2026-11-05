import { FulfillerType } from '@prisma/client';
import { currencyDecimals } from '../../common/money/currency.util';
import {
  itemDetails,
  itemLineMinor,
  itemSku,
  itemTitle,
  type SnapshotOrderItem,
} from './invoice-snapshot.builder';
import type { InvoiceLineDetail, InvoiceSnapshot } from './invoices.types';

/** An order item as the supplier-copy matching reads it. */
export interface ProviderMatchItem extends SnapshotOrderItem {
  fulfiller_type: FulfillerType | null;
  fulfiller_id: string | null;
}

export interface ProviderLines {
  /** Indexes into snapshot.lines of the provider's own item lines. */
  indexes: number[];
  /** Σ line_net of those lines, major units (signed; credit notes < 0). */
  subtotal: number;
}

/**
 * Which item lines of a stored invoice / credit-note snapshot belong to
 * items `providerId` fulfils.
 *
 * Snapshot lines carry no order_item_id, so every order item is turned back
 * into the line the builder printed for it (same formula, itemLineMinor) and
 * matched on its immutable money columns (qty, unit and line net, VAT rate)
 * plus the printed title, SKU and detail rows (variant options,
 * personalization):
 *   1. exact match (amounts + title + SKU + details);
 *   2. amounts only, for lines whose title / SKU / details changed since
 *      issuing.
 * A line is the provider's only when every candidate item it could match
 * has the same owner. Candidates of different owners in pass 1 are only
 * accepted when they are truly identical in print: as many snapshot lines
 * as items carry that exact key, so each has its own line and consuming
 * mine first is exact. Any other mixed match is left out: the copy may
 * then miss a line, but never shows another party's line.
 *
 * Only `item` lines can match: shipping, discount, rounding and the
 * per-rate lines of a partial credit note are never the provider's. A full
 * credit note mirrors the invoice lines negated, so its amounts are flipped
 * before matching.
 */
export function providerLinesOf(
  snapshot: InvoiceSnapshot,
  items: readonly ProviderMatchItem[],
  providerId: string,
  /** Store primary locale (personalization label fallback, as at issue). */
  primaryLocale?: string | null,
): ProviderLines {
  const currency = snapshot.currency;
  const factor = 10 ** currencyDecimals(currency);
  const toMinor = (v: unknown) => Math.round(Number(v || 0) * factor);
  const inclusive = snapshot.tax_mode !== 'EXCLUSIVE';
  const sign = snapshot.kind === 'CREDIT_NOTE' ? -1 : 1;
  const locale = snapshot.locale;

  const pool = items.map((item) => {
    const { rate, unitNet, lineNet } = itemLineMinor(item, currency, inclusive);
    return {
      amountKey: `${item.quantity}|${unitNet}|${lineNet}|${rate}`,
      textKey: textKeyOf(
        itemTitle(item, locale),
        itemSku(item),
        itemDetails(item, locale, primaryLocale),
      ),
      mine:
        item.fulfiller_type === FulfillerType.PROVIDER &&
        item.fulfiller_id === providerId,
      used: false,
    };
  });

  const lines = snapshot.lines ?? [];
  const keys = lines.map((l) =>
    l.kind === 'item'
      ? {
          amountKey: `${l.qty}|${sign * toMinor(l.unit_net)}|${sign * toMinor(l.line_net)}|${Number(l.vat_rate_bp) || 0}`,
          textKey: textKeyOf(l.description, l.sku, l.details),
        }
      : null,
  );

  // How many snapshot lines / order items carry each exact key: a mixed
  // exact match is only safe when both sides agree (identical in print).
  const exactKey = (k: { amountKey: string; textKey: string }) =>
    `${k.amountKey}\u0001${k.textKey}`;
  const countOf = (all: string[]) => {
    const m = new Map<string, number>();
    for (const k of all) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  };
  const lineCount = countOf(keys.flatMap((k) => (k ? [exactKey(k)] : [])));
  const itemCount = countOf(pool.map(exactKey));

  const owner = new Map<number, boolean>();
  const consume = (
    lineIdx: number,
    match: (p: (typeof pool)[number]) => boolean,
    allowMixed: boolean,
  ) => {
    const candidates = pool.filter((p) => !p.used && match(p));
    if (!candidates.length) return;
    const mixed = candidates.some((c) => c.mine !== candidates[0].mine);
    if (mixed && !allowMixed) return;
    const pick = candidates.find((c) => c.mine) ?? candidates[0];
    pick.used = true;
    owner.set(lineIdx, pick.mine);
  };

  keys.forEach((k, i) => {
    if (k) {
      const key = exactKey(k);
      consume(
        i,
        (p) => p.amountKey === k.amountKey && p.textKey === k.textKey,
        lineCount.get(key) === itemCount.get(key),
      );
    }
  });
  keys.forEach((k, i) => {
    if (k && !owner.has(i)) {
      consume(i, (p) => p.amountKey === k.amountKey, false);
    }
  });

  const indexes = [...owner.entries()]
    .filter(([, mine]) => mine)
    .map(([i]) => i)
    .sort((a, b) => a - b);
  const subtotal =
    indexes.reduce((s, i) => s + toMinor(lines[i].line_net), 0) / factor || 0;
  return { indexes, subtotal };
}

/** Printed title, SKU and detail rows of an item line as one match key. */
function textKeyOf(
  title: string,
  sku: string | null | undefined,
  details: readonly InvoiceLineDetail[] | null | undefined,
): string {
  const rows = (details ?? []).map((d) => `${d.label}\u0002${d.value}`);
  return [title, sku ?? '', ...rows].join('\u0000');
}

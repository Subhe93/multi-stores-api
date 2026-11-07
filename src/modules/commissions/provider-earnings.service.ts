import { Injectable } from '@nestjs/common';
import { FulfillerType, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  fromStripeAmount,
  toStripeAmount,
} from '../../common/money/currency.util';
import { splitProviderShares } from '../../common/money/provider-share.util';
import { csvAmount, csvText } from '../invoices/invoices-csv';
import type {
  ProviderEarningsLinesQueryDto,
  ProviderEarningsRangeDto,
  ProviderLineStatus,
  ProviderPayoutsQueryDto,
} from './dto/provider-earnings.dto';

/** Order statuses that write the provider's share off (money went back). */
const REFUND_TERMINAL: OrderStatus[] = [
  OrderStatus.REFUNDED,
  OrderStatus.RETURNED,
];

/** Rows fetched per round trip by the CSV export. */
const CSV_BATCH = 1000;
/** Hard cap of the CSV export, so one request can't stream the whole table. */
export const CSV_MAX_ROWS = 20000;
/** Rows folded per round trip by the summary (keeps memory bounded). */
export const SUMMARY_BATCH = 500;

/** The minimal order shape the provider ledger is computed from. */
export interface ProviderOrderRow {
  id: string;
  order_number: string;
  created_at: Date;
  currency: string;
  status: OrderStatus;
  payment_status: string | null;
  store_id: string | null;
  /** Stripe references: without a platform charge no transfer can ever happen. */
  stripe_charge_id: string | null;
  stripe_payment_id: string | null;
  /** Direct charge on the creator's own account (no platform split). */
  stripe_account_id: string | null;
  /**
   * Stripe route of the charge (PLATFORM | CONNECT_DIRECT | OWN_KEY; null =
   * legacy). OWN_KEY / CONNECT_DIRECT money never reaches the platform.
   */
  payment_route?: string | null;
  /** Every PROVIDER item of the order (all providers: the share needs the total). */
  items: {
    fulfiller_id: string;
    provider_base_amount: Prisma.Decimal | number | string;
    quantity: number;
  }[];
  commission: { provider_amount: Prisma.Decimal | number | string } | null;
  /** This provider's payout row (0 or 1, unique per order + recipient). */
  payouts: {
    status: string;
    amount: Prisma.Decimal | number | string;
    stripe_transfer_id: string | null;
    updated_at: Date;
  }[];
}

/** One order seen by one provider, amounts in minor units of `currency`. */
export interface ProviderLine {
  currency: string;
  status: ProviderLineStatus;
  itemsCount: number;
  /** Unscaled base price of this provider's items. */
  grossMinor: number;
  /** This provider's share (the ledger amount once transferred). */
  amountMinor: number;
  /** What was actually transferred (0 without a paid payout). */
  transferredMinor: number;
}

/**
 * Classify one order for one provider and compute their share. The share
 * mirrors PaymentsService.issueOrderTransfers exactly: the aggregate
 * provider_amount is split by each provider's base, in minor units. Once a
 * transfer succeeded, the payout ledger amount is the truth.
 *
 * Precedence: refunded > cancelled > transferred > failed > offline >
 * pending > unpaid. `statusWhere` below must stay the SQL twin of this
 * function.
 *
 * `offline`: the order is paid (or delivered COD) but has no platform Stripe
 * charge (COD, Kustom, ...) or was a direct charge on the creator's own
 * account. PaymentsService.issueOrderTransfers returns early for those, so the
 * share is settled outside platform payouts and would otherwise sit in
 * `pending` forever.
 */
export function computeProviderLine(
  row: ProviderOrderRow,
  providerId: string,
): ProviderLine {
  const currency = (row.currency || 'EUR').toUpperCase();
  const mine = row.items.filter((i) => i.fulfiller_id === providerId);
  const myBase = mine.reduce((s, i) => s + Number(i.provider_base_amount), 0);
  const allBase = row.items.reduce(
    (s, i) => s + Number(i.provider_base_amount),
    0,
  );
  const grossMinor = toStripeAmount(myBase, currency);
  const poolMinor = row.commission
    ? toStripeAmount(Number(row.commission.provider_amount), currency)
    : 0;
  let amountMinor =
    allBase > 0 && poolMinor > 0
      ? (splitProviderShares(poolMinor, row.items).get(providerId) ?? 0)
      : 0;

  const payout = row.payouts[0];
  const transferredMinor =
    payout?.status === 'paid'
      ? toStripeAmount(Number(payout.amount), currency)
      : 0;
  if (payout?.status === 'paid') amountMinor = transferredMinor;

  let status: ProviderLineStatus;
  if (
    REFUND_TERMINAL.includes(row.status) ||
    row.payment_status === 'refunded'
  ) {
    status = 'refunded';
  } else if (row.status === OrderStatus.CANCELLED) {
    status = 'cancelled';
  } else if (payout?.status === 'paid') {
    status = 'transferred';
  } else if (payout?.status === 'failed') {
    status = 'failed';
  } else if (
    row.payment_status === 'paid' ||
    // COD: the money is collected on delivery and never flips payment_status.
    row.status === OrderStatus.DELIVERED
  ) {
    status = hasPlatformCharge(row) ? 'pending' : 'offline';
  } else {
    status = 'unpaid';
  }

  return {
    currency,
    status,
    itemsCount: mine.reduce((s, i) => s + i.quantity, 0),
    grossMinor,
    amountMinor,
    transferredMinor,
  };
}

/** True when the platform holds a Stripe charge it can transfer from. */
export function hasPlatformCharge(
  row: Pick<
    ProviderOrderRow,
    'stripe_charge_id' | 'stripe_payment_id' | 'stripe_account_id'
  > & { payment_route?: string | null },
): boolean {
  // OWN_KEY (the owner's own Stripe account) and CONNECT_DIRECT charges are
  // settled outside platform payouts: no transfer can ever happen.
  if (
    row.payment_route === 'OWN_KEY' ||
    row.payment_route === 'CONNECT_DIRECT'
  ) {
    return false;
  }
  return (
    !row.stripe_account_id && !!(row.stripe_charge_id || row.stripe_payment_id)
  );
}

/** Per-currency totals in minor units (never mixed across currencies). */
interface Bucket {
  orders: number;
  refunded_orders: number;
  gross: number;
  earned: number;
  pending: number;
  failed: number;
  unpaid: number;
  offline: number;
  transferred: number;
  refunded: number;
  refunded_after_transfer: number;
}

/**
 * Incremental fold of lines into per-currency totals, so the summary can be
 * fed in batches without holding every order in memory.
 *
 * `earned` = pending + failed + transferred + offline (everything owed to the
 * provider for live orders). `pending` only counts what the platform will
 * still transfer (pending + failed), so `offline` is excluded from it.
 */
export class ProviderSummaryAccumulator {
  private buckets = new Map<string, Bucket>();

  add(l: ProviderLine): void {
    const b = this.buckets.get(l.currency) ?? {
      orders: 0,
      refunded_orders: 0,
      gross: 0,
      earned: 0,
      pending: 0,
      failed: 0,
      unpaid: 0,
      offline: 0,
      transferred: 0,
      refunded: 0,
      refunded_after_transfer: 0,
    };
    this.buckets.set(l.currency, b);
    // A transfer is money that moved, whatever happened to the order after.
    b.transferred += l.transferredMinor;
    if (l.status === 'cancelled') return;
    b.orders += 1;
    b.gross += l.grossMinor;
    switch (l.status) {
      case 'refunded':
        b.refunded_orders += 1;
        b.refunded += l.amountMinor;
        // Refunds do not reverse transfers automatically (no reversal is
        // issued by the platform), so surface what was already sent.
        b.refunded_after_transfer += l.transferredMinor;
        break;
      case 'unpaid':
        b.unpaid += l.amountMinor;
        break;
      case 'transferred':
        b.earned += l.amountMinor;
        break;
      case 'failed':
        b.earned += l.amountMinor;
        b.pending += l.amountMinor;
        b.failed += l.amountMinor;
        break;
      case 'pending':
        b.earned += l.amountMinor;
        b.pending += l.amountMinor;
        break;
      case 'offline':
        b.earned += l.amountMinor;
        b.offline += l.amountMinor;
        break;
    }
  }

  /** Major units, sorted by order count. */
  result() {
    return [...this.buckets.entries()]
      .map(([currency, b]) => {
        const major = (n: number) => fromStripeAmount(n, currency);
        return {
          currency,
          orders: b.orders,
          refunded_orders: b.refunded_orders,
          gross: major(b.gross),
          earned: major(b.earned),
          pending: major(b.pending),
          failed: major(b.failed),
          unpaid: major(b.unpaid),
          offline: major(b.offline),
          transferred: major(b.transferred),
          refunded: major(b.refunded),
          refunded_after_transfer: major(b.refunded_after_transfer),
        };
      })
      .sort(
        (a, b) => b.orders - a.orders || a.currency.localeCompare(b.currency),
      );
  }
}

/** Fold lines into per-currency totals (major units, sorted by order count). */
export function summarizeProviderLines(lines: ProviderLine[]) {
  const acc = new ProviderSummaryAccumulator();
  for (const l of lines) acc.add(l);
  return acc.result();
}

/** Stripe transfer ids are not secret, but the tail is all a provider needs. */
export function maskTransferId(id: string | null | undefined): string | null {
  if (!id) return null;
  if (id.length <= 9) return id;
  return `${id.slice(0, 3)}…${id.slice(-6)}`;
}

/**
 * Parse a range bound. A date-only `to` is inclusive (the whole day, UTC),
 * so `from=2026-11-01&to=2026-11-30` covers November.
 */
export function rangeWhere(
  range: ProviderEarningsRangeDto,
): Prisma.DateTimeFilter | undefined {
  const filter: Prisma.DateTimeFilter = {};
  if (range.from) {
    const d = new Date(range.from);
    if (!Number.isNaN(d.getTime())) filter.gte = d;
  }
  if (range.to) {
    const d = new Date(range.to);
    if (!Number.isNaN(d.getTime())) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(range.to)) {
        d.setUTCDate(d.getUTCDate() + 1);
        filter.lt = d;
      } else {
        filter.lte = d;
      }
    }
  }
  return filter.gte || filter.lt || filter.lte ? filter : undefined;
}

@Injectable()
export class ProviderEarningsService {
  constructor(private prisma: PrismaService) {}

  private async providerId(userId: string): Promise<string | null> {
    const provider = await this.prisma.provider.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    return provider?.id ?? null;
  }

  /** Orders containing at least one item fulfilled by this provider. */
  private baseWhere(
    providerId: string,
    range: ProviderEarningsRangeDto,
  ): Prisma.OrderWhereInput {
    const where: Prisma.OrderWhereInput = {
      items: {
        some: {
          fulfiller_type: FulfillerType.PROVIDER,
          fulfiller_id: providerId,
        },
      },
    };
    const created = rangeWhere(range);
    if (created) where.created_at = created;
    if (range.currency) {
      where.currency = {
        equals: range.currency.toUpperCase(),
        mode: 'insensitive',
      };
    }
    return where;
  }

  /** SQL twin of the precedence in computeProviderLine. */
  statusWhere(
    providerId: string,
    status: ProviderLineStatus,
  ): Prisma.OrderWhereInput {
    const mine = {
      recipient_type: FulfillerType.PROVIDER,
      recipient_id: providerId,
    };
    // payment_status is nullable: `not` alone would drop NULL rows.
    const notRefunded: Prisma.OrderWhereInput = {
      AND: [
        { status: { notIn: REFUND_TERMINAL } },
        {
          OR: [
            { payment_status: null },
            { payment_status: { not: 'refunded' } },
          ],
        },
      ],
    };
    const active: Prisma.OrderWhereInput = {
      AND: [notRefunded, { status: { not: OrderStatus.CANCELLED } }],
    };
    const noSettledPayout: Prisma.OrderWhereInput = {
      payouts: { none: { ...mine, status: { in: ['paid', 'failed'] } } },
    };
    const collected: Prisma.OrderWhereInput = {
      OR: [{ payment_status: 'paid' }, { status: OrderStatus.DELIVERED }],
    };
    // SQL twin of hasPlatformCharge.
    // payment_route is nullable (legacy orders): `notIn` alone drops NULL.
    const platformRoute: Prisma.OrderWhereInput = {
      OR: [
        { payment_route: null },
        { payment_route: { notIn: ['OWN_KEY', 'CONNECT_DIRECT'] } },
      ],
    };
    const platformCharge: Prisma.OrderWhereInput = {
      AND: [
        platformRoute,
        { stripe_account_id: null },
        {
          OR: [
            { stripe_charge_id: { not: null } },
            { stripe_payment_id: { not: null } },
          ],
        },
      ],
    };
    const noPlatformCharge: Prisma.OrderWhereInput = {
      OR: [
        { payment_route: { in: ['OWN_KEY', 'CONNECT_DIRECT'] } },
        { stripe_account_id: { not: null } },
        { AND: [{ stripe_charge_id: null }, { stripe_payment_id: null }] },
      ],
    };
    switch (status) {
      case 'refunded':
        return {
          OR: [
            { status: { in: REFUND_TERMINAL } },
            { payment_status: 'refunded' },
          ],
        };
      case 'cancelled':
        return { AND: [notRefunded, { status: OrderStatus.CANCELLED }] };
      case 'transferred':
        return {
          AND: [active, { payouts: { some: { ...mine, status: 'paid' } } }],
        };
      case 'failed':
        return {
          AND: [
            active,
            { payouts: { none: { ...mine, status: 'paid' } } },
            { payouts: { some: { ...mine, status: 'failed' } } },
          ],
        };
      case 'pending':
        return { AND: [active, noSettledPayout, collected, platformCharge] };
      case 'offline':
        return { AND: [active, noSettledPayout, collected, noPlatformCharge] };
      case 'unpaid':
        return {
          AND: [
            active,
            noSettledPayout,
            { status: { not: OrderStatus.DELIVERED } },
            {
              OR: [
                { payment_status: null },
                { payment_status: { not: 'paid' } },
              ],
            },
          ],
        };
    }
  }

  private rowSelect(providerId: string) {
    return {
      id: true,
      order_number: true,
      created_at: true,
      currency: true,
      status: true,
      payment_status: true,
      store_id: true,
      stripe_charge_id: true,
      stripe_payment_id: true,
      stripe_account_id: true,
      payment_route: true,
      items: {
        where: { fulfiller_type: FulfillerType.PROVIDER },
        select: {
          fulfiller_id: true,
          provider_base_amount: true,
          quantity: true,
        },
      },
      commission: { select: { provider_amount: true } },
      payouts: {
        where: {
          recipient_type: FulfillerType.PROVIDER,
          recipient_id: providerId,
        },
        select: {
          status: true,
          amount: true,
          stripe_transfer_id: true,
          updated_at: true,
        },
      },
    } satisfies Prisma.OrderSelect;
  }

  async summary(userId: string, range: ProviderEarningsRangeDto) {
    const providerId = await this.providerId(userId);
    if (!providerId) return { by_currency: [] };
    const where = this.baseWhere(providerId, range);
    const acc = new ProviderSummaryAccumulator();
    // Keyset batches on the primary key: memory stays bounded by the batch
    // size whatever the number of orders, and the fold is order-independent.
    let cursor: string | null = null;
    for (;;) {
      const rows: ProviderOrderRow[] = await this.prisma.order.findMany({
        where: cursor ? { AND: [where, { id: { gt: cursor } }] } : where,
        select: this.rowSelect(providerId),
        orderBy: { id: 'asc' },
        take: SUMMARY_BATCH,
      });
      for (const r of rows) acc.add(computeProviderLine(r, providerId));
      if (rows.length < SUMMARY_BATCH) break;
      cursor = rows[rows.length - 1].id;
    }
    return {
      from: range.from ?? null,
      to: range.to ?? null,
      by_currency: acc.result(),
    };
  }

  private linesWhere(providerId: string, query: ProviderEarningsLinesQueryDto) {
    const where = this.baseWhere(providerId, query);
    return query.status
      ? { AND: [where, this.statusWhere(providerId, query.status)] }
      : where;
  }

  private async storeNames(rows: ProviderOrderRow[]) {
    const ids = [
      ...new Set(rows.map((r) => r.store_id).filter((x): x is string => !!x)),
    ];
    if (ids.length === 0) return new Map<string, string>();
    const stores = await this.prisma.store.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(stores.map((s) => [s.id, s.name] as const));
  }

  private toLineDto(
    row: ProviderOrderRow,
    providerId: string,
    stores: Map<string, string>,
  ) {
    const line = computeProviderLine(row, providerId);
    const payout = row.payouts[0];
    return {
      order_id: row.id,
      order_number: row.order_number,
      created_at: row.created_at,
      order_status: row.status,
      store: row.store_id
        ? { id: row.store_id, name: stores.get(row.store_id) ?? null }
        : null,
      items_count: line.itemsCount,
      gross: fromStripeAmount(line.grossMinor, line.currency),
      amount: fromStripeAmount(line.amountMinor, line.currency),
      currency: line.currency,
      status: line.status,
      payout: payout
        ? {
            status: payout.status,
            updated_at: payout.updated_at,
            stripe_transfer_id: maskTransferId(payout.stripe_transfer_id),
          }
        : null,
    };
  }

  async lines(userId: string, query: ProviderEarningsLinesQueryDto) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const providerId = await this.providerId(userId);
    if (!providerId) {
      return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
    }
    const where = this.linesWhere(providerId, query);
    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        select: this.rowSelect(providerId),
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }) as Promise<ProviderOrderRow[]>,
      this.prisma.order.count({ where }),
    ]);
    const stores = await this.storeNames(rows);
    return {
      data: rows.map((r) => this.toLineDto(r, providerId, stores)),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Same filters as the lines, every matching row (capped), as CSV text.
   * `truncated` is set when more rows matched than the cap; the CSV then ends
   * with a marker row.
   */
  async linesCsv(
    userId: string,
    query: ProviderEarningsLinesQueryDto,
  ): Promise<{ csv: string; truncated: boolean }> {
    const header = [
      'order_number',
      'date',
      'store',
      'items',
      'gross',
      'amount',
      'currency',
      'status',
      'transfer_id',
    ].join(',');
    const out = [header];
    let truncated = false;
    const providerId = await this.providerId(userId);
    if (providerId) {
      const where = this.linesWhere(providerId, query);
      for (let skip = 0; skip < CSV_MAX_ROWS; skip += CSV_BATCH) {
        const rows: ProviderOrderRow[] = await this.prisma.order.findMany({
          where,
          select: this.rowSelect(providerId),
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
          skip,
          take: CSV_BATCH,
        });
        const stores = await this.storeNames(rows);
        for (const r of rows) {
          const l = this.toLineDto(r, providerId, stores);
          out.push(
            [
              csvText(l.order_number),
              csvText(l.created_at.toISOString().slice(0, 10)),
              csvText(l.store?.name ?? ''),
              String(l.items_count),
              csvAmount(l.gross, l.currency),
              csvAmount(l.amount, l.currency),
              csvText(l.currency),
              csvText(l.status),
              csvText(l.payout?.stripe_transfer_id ?? ''),
            ].join(','),
          );
        }
        if (rows.length < CSV_BATCH) break;
      }
      if (out.length - 1 >= CSV_MAX_ROWS) {
        const more = await this.prisma.order.findMany({
          where,
          select: { id: true },
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
          skip: CSV_MAX_ROWS,
          take: 1,
        });
        truncated = more.length > 0;
      }
    }
    if (truncated) {
      out.push(
        csvText(`Truncated at ${CSV_MAX_ROWS} rows — narrow the date range`) +
          ','.repeat(8),
      );
    }
    return { csv: out.join('\r\n') + '\r\n', truncated };
  }

  async payouts(userId: string, query: ProviderPayoutsQueryDto) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const providerId = await this.providerId(userId);
    if (!providerId) {
      return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
    }
    const where: Prisma.OrderPayoutWhereInput = {
      recipient_type: FulfillerType.PROVIDER,
      recipient_id: providerId,
    };
    const [rows, total] = await Promise.all([
      this.prisma.orderPayout.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          order_id: true,
          amount: true,
          currency: true,
          status: true,
          stripe_transfer_id: true,
          error: true,
          created_at: true,
          updated_at: true,
          order: {
            select: { order_number: true, status: true, payment_status: true },
          },
        },
      }),
      this.prisma.orderPayout.count({ where }),
    ]);
    return {
      data: rows.map((p) => ({
        id: p.id,
        order_id: p.order_id,
        order_number: p.order.order_number,
        amount: Number(p.amount),
        currency: (p.currency || 'EUR').toUpperCase(),
        status: p.status,
        stripe_transfer_id: maskTransferId(p.stripe_transfer_id),
        // Only a failed attempt carries a reason worth showing.
        error: p.status === 'paid' ? null : (p.error ?? null),
        // The order was refunded after this transfer: the platform does not
        // reverse transfers automatically, so this is flagged for follow-up.
        order_refunded:
          REFUND_TERMINAL.includes(p.order.status) ||
          p.order.payment_status === 'refunded',
        created_at: p.created_at,
        updated_at: p.updated_at,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }
}

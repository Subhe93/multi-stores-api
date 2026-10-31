// Creator overview analytics: pure helpers for the reporting window (range ->
// bounds, bucket keys, previous period), timezone validation and the shared
// SQL fragments (which orders count as a sale, store-currency conversion).
// The data is loaded by OverviewService.

import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DEFAULT_EC_SALES_TIMEZONE,
  zonedDayStart,
  zonedParts,
} from '../taxes/ec-sales-report';

export const OVERVIEW_RANGES = ['today', '7d', '30d', '90d', '12m'] as const;
export type OverviewRange = (typeof OVERVIEW_RANGES)[number];
export type OverviewGranularity = 'hour' | 'day' | 'month';

export const DEFAULT_OVERVIEW_RANGE: OverviewRange = '30d';
/** Fallback when the store has no legal-profile timezone. */
export const DEFAULT_OVERVIEW_TIMEZONE = DEFAULT_EC_SALES_TIMEZONE;

/** Order statuses that never count as a sale. */
export const EXCLUDED_ORDER_STATUSES = ['CANCELLED', 'REFUNDED'] as const;

/** One resolved reporting window: current + previous period of equal length. */
export interface OverviewWindow {
  range: OverviewRange;
  granularity: OverviewGranularity;
  timezone: string;
  /** Current period [from, to) as instants. */
  from: Date;
  to: Date;
  /** Previous period [prevFrom, prevTo), prevTo === from. */
  prevFrom: Date;
  prevTo: Date;
  /** Bucket keys (local wall clock) of each period, same length. */
  keys: string[];
  prevKeys: string[];
}

export function parseRange(raw: string | undefined): OverviewRange {
  if (raw == null || raw === '') return DEFAULT_OVERVIEW_RANGE;
  if ((OVERVIEW_RANGES as readonly string[]).includes(raw)) {
    return raw as OverviewRange;
  }
  throw new BadRequestException({
    code: 'OVERVIEW_RANGE_INVALID',
    message: `range must be one of ${OVERVIEW_RANGES.join(', ')}.`,
  });
}

/**
 * True for an IANA zone name Intl understands. The character whitelist also
 * keeps anything odd away from Postgres (the value is bound as a parameter
 * regardless).
 */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(tz)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The explicit `tz` query when valid (400 otherwise), else the store's zone. */
export function resolveTimeZone(
  requested: string | undefined,
  storeZone: string | null | undefined,
): string {
  if (requested != null && requested !== '') {
    if (!isValidTimeZone(requested)) {
      throw new BadRequestException({
        code: 'OVERVIEW_TZ_INVALID',
        message: 'tz must be an IANA timezone such as Europe/Stockholm.',
      });
    }
    return requested;
  }
  return isValidTimeZone(storeZone) ? storeZone : DEFAULT_OVERVIEW_TIMEZONE;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Calendar date `days` after y-m-d (negative = before), as YYYY-MM-DD. */
function addDays(y: number, m: number, d: number, days: number): string {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Calendar month `months` after y-m (negative = before), as YYYY-MM. */
function addMonths(y: number, m: number, months: number): string {
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}`;
}

function dayKeys(firstYmd: string, count: number): string[] {
  const [y, m, d] = firstYmd.split('-').map(Number);
  return Array.from({ length: count }, (_, i) => addDays(y, m, d, i));
}

function monthKeys(firstYm: string, count: number): string[] {
  const [y, m] = firstYm.split('-').map(Number);
  return Array.from({ length: count }, (_, i) => addMonths(y, m, i));
}

function hourKeys(ymd: string): string[] {
  return Array.from({ length: 24 }, (_, h) => `${ymd}T${pad(h)}:00`);
}

const monthStart = (ym: string, tz: string) => zonedDayStart(`${ym}-01`, tz);

/**
 * Current and previous period for `range` as seen at `now` in `tz`.
 * - today: the local calendar day, 24 hourly buckets (a DST day still has
 *   24 keys: the skipped hour stays 0, the repeated hour holds both).
 * - 7d/30d/90d: today and the N-1 days before it, daily buckets.
 * - 12m: the current month and the 11 before it, monthly buckets.
 * The previous period is the same number of buckets immediately before.
 */
export function resolveWindow(
  range: OverviewRange,
  timezone: string,
  now: Date = new Date(),
): OverviewWindow {
  const p = zonedParts(now, timezone);
  const today = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  const tomorrow = addDays(p.y, p.m, p.d, 1);

  if (range === 'today') {
    const yesterday = addDays(p.y, p.m, p.d, -1);
    const from = zonedDayStart(today, timezone);
    return {
      range,
      granularity: 'hour',
      timezone,
      from,
      to: zonedDayStart(tomorrow, timezone),
      prevFrom: zonedDayStart(yesterday, timezone),
      prevTo: from,
      keys: hourKeys(today),
      prevKeys: hourKeys(yesterday),
    };
  }

  if (range === '12m') {
    const first = addMonths(p.y, p.m, -11);
    const prevFirst = addMonths(p.y, p.m, -23);
    const from = monthStart(first, timezone);
    return {
      range,
      granularity: 'month',
      timezone,
      from,
      to: monthStart(addMonths(p.y, p.m, 1), timezone),
      prevFrom: monthStart(prevFirst, timezone),
      prevTo: from,
      keys: monthKeys(first, 12),
      prevKeys: monthKeys(prevFirst, 12),
    };
  }

  const n = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const first = addDays(p.y, p.m, p.d, -(n - 1));
  const prevFirst = addDays(p.y, p.m, p.d, -(2 * n - 1));
  const from = zonedDayStart(first, timezone);
  return {
    range,
    granularity: 'day',
    timezone,
    from,
    to: zonedDayStart(tomorrow, timezone),
    prevFrom: zonedDayStart(prevFirst, timezone),
    prevTo: from,
    keys: dayKeys(first, n),
    prevKeys: dayKeys(prevFirst, n),
  };
}

/** ISO-8601 with the zone's UTC offset at that instant, second precision. */
export function isoWithOffset(date: Date, timezone: string): string {
  const p = zonedParts(date, timezone);
  const wall = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  const offsetMin = Math.round(
    (wall - Math.floor(date.getTime() / 1000) * 1000) / 60_000,
  );
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  return (
    `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export interface SeriesPoint {
  t: string;
  revenue: number;
  orders: number;
}

/** One entry per key, in key order; buckets without a row are 0. */
export function zeroFill(
  keys: string[],
  rows: Map<string, { revenue: number; orders: number }>,
): SeriesPoint[] {
  return keys.map((t) => {
    const r = rows.get(t);
    return { t, revenue: r ? round2(r.revenue) : 0, orders: r ? r.orders : 0 };
  });
}

export const round2 = (v: number) =>
  Math.round((v + Number.EPSILON) * 100) / 100;

/** Postgres date_trunc unit and to_char format producing the bucket keys. */
export function bucketSql(g: OverviewGranularity): {
  unit: string;
  format: string;
} {
  if (g === 'hour') return { unit: 'hour', format: 'YYYY-MM-DD"T"HH24:00' };
  if (g === 'month') return { unit: 'month', format: 'YYYY-MM' };
  return { unit: 'day', format: 'YYYY-MM-DD' };
}

/** A JS Date as the UTC `timestamp` Prisma stores DateTime columns in. */
export const tsParam = (d: Date) =>
  Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

/**
 * The order counts as a sale: not CANCELLED / REFUNDED, and its money is real
 * — paid online (payment_status 'paid', or a legacy row with no status but a
 * paid_at), or cash on delivery that has not failed / been refunded (COD
 * starts 'pending' and is collected on delivery). Card / Kustom orders still
 * 'awaiting_payment', 'failed' (abandoned or declined) or 'refunded' do not
 * count. `alias` is an internal table alias, never user input.
 */
export function countedOrderSql(alias: 'o' | 'p'): Prisma.Sql {
  const a = Prisma.raw(alias);
  return Prisma.sql`(${a}.status::text NOT IN (${Prisma.join([
    ...EXCLUDED_ORDER_STATUSES,
  ])})
    AND (
      ${a}.payment_status = 'paid'
      OR (${a}.payment_status IS NULL AND ${a}.paid_at IS NOT NULL)
      OR (${a}.payment_method::text = 'COD'
          AND COALESCE(${a}.payment_status, 'pending') NOT IN ('failed', 'refunded'))
    ))`;
}

/**
 * `amount` (a column of order `o`, in the order currency) in the store
 * currency: an order placed in a market currency is divided by the order's
 * Order.fx_rate_snapshot (the base->market rate it was priced with). Same
 * currency, or no usable rate, keeps the amount as is.
 */
export function storeAmountSql(
  amount: Prisma.Sql,
  storeCurrency: string,
): Prisma.Sql {
  return Prisma.sql`(CASE
    WHEN o.currency = ${storeCurrency}
      OR o.fx_rate_snapshot IS NULL
      OR o.fx_rate_snapshot <= 0
    THEN ${amount}
    ELSE ${amount} / o.fx_rate_snapshot
  END)`;
}

/**
 * Keep the `max` largest entries (by revenue) and fold the rest into one
 * `other` entry.
 */
export function capWithOther<
  T extends { key: string; label: string; revenue: number; orders: number },
>(
  rows: T[],
  max = 8,
): { key: string; label: string; revenue: number; orders: number }[] {
  const sorted = [...rows].sort(
    (a, b) => b.revenue - a.revenue || b.orders - a.orders,
  );
  const head = sorted.slice(0, max).map((r) => ({
    key: r.key,
    label: r.label,
    revenue: round2(r.revenue),
    orders: r.orders,
  }));
  const tail = sorted.slice(max);
  if (tail.length) {
    head.push({
      key: 'other',
      label: 'Other',
      revenue: round2(tail.reduce((s, r) => s + r.revenue, 0)),
      orders: tail.reduce((s, r) => s + r.orders, 0),
    });
  }
  return head;
}

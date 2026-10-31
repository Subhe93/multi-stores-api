import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  bucketSql,
  capWithOther,
  countedOrderSql,
  isValidTimeZone,
  isoWithOffset,
  parseRange,
  resolveTimeZone,
  resolveWindow,
  storeAmountSql,
  zeroFill,
} from './overview-range';

const TZ = 'Europe/Stockholm';
// 2026-10-31 12:00 UTC = 13:00 in Stockholm (CET, DST ended 2026-10-25).
const NOW = new Date('2026-10-31T12:00:00Z');

describe('overview range', () => {
  it('parses the range, defaulting to 30d and refusing unknown values', () => {
    expect(parseRange(undefined)).toBe('30d');
    expect(parseRange('')).toBe('30d');
    expect(parseRange('12m')).toBe('12m');
    expect(() => parseRange('1y')).toThrow(BadRequestException);
  });

  it('daily window: today + N-1 days, previous period of the same length', () => {
    const w = resolveWindow('7d', TZ, NOW);
    expect(w.granularity).toBe('day');
    expect(w.keys).toEqual([
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
    ]);
    expect(w.prevKeys).toHaveLength(7);
    expect(w.prevKeys[0]).toBe('2026-10-18');
    expect(w.prevKeys[6]).toBe('2026-10-24');
    // 2026-10-25 00:00 local was still CEST (+02:00).
    expect(w.from.toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-10-31T23:00:00.000Z');
    expect(w.prevTo).toEqual(w.from);
    expect(w.prevFrom.toISOString()).toBe('2026-10-17T22:00:00.000Z');
  });

  it('30d / 90d produce 30 / 90 buckets on both sides', () => {
    for (const [r, n] of [
      ['30d', 30],
      ['90d', 90],
    ] as const) {
      const w = resolveWindow(r, TZ, NOW);
      expect(w.keys).toHaveLength(n);
      expect(w.prevKeys).toHaveLength(n);
      expect(w.keys[n - 1]).toBe('2026-10-31');
      expect(new Set([...w.keys, ...w.prevKeys]).size).toBe(2 * n);
    }
  });

  it('today: 24 hourly buckets in the zone, previous = yesterday', () => {
    const w = resolveWindow('today', TZ, NOW);
    expect(w.granularity).toBe('hour');
    expect(w.keys[0]).toBe('2026-10-31T00:00');
    expect(w.keys[23]).toBe('2026-10-31T23:00');
    expect(w.prevKeys[0]).toBe('2026-10-30T00:00');
    expect(w.from.toISOString()).toBe('2026-10-30T23:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-10-31T23:00:00.000Z');
  });

  it('today follows the local day, not the UTC day', () => {
    // 23:30 UTC on Oct 31 is already Nov 1 in Stockholm.
    const w = resolveWindow('today', TZ, new Date('2026-10-31T23:30:00Z'));
    expect(w.keys[0]).toBe('2026-11-01T00:00');
  });

  it('12m: current month + 11 before, previous 12 months', () => {
    const w = resolveWindow('12m', TZ, NOW);
    expect(w.granularity).toBe('month');
    expect(w.keys[0]).toBe('2025-11');
    expect(w.keys[11]).toBe('2026-10');
    expect(w.prevKeys[0]).toBe('2024-11');
    expect(w.prevKeys[11]).toBe('2025-10');
    expect(w.to.toISOString()).toBe('2026-10-31T23:00:00.000Z');
  });

  it('formats bounds with the zone offset of each instant', () => {
    const w = resolveWindow('30d', TZ, NOW);
    expect(isoWithOffset(w.from, TZ)).toBe('2026-10-02T00:00:00+02:00');
    expect(isoWithOffset(new Date(w.to.getTime() - 1), TZ)).toBe(
      '2026-10-31T23:59:59+01:00',
    );
  });

  it('zero-fills missing buckets in key order', () => {
    const rows = new Map([
      ['2026-10-02', { revenue: 10.005, orders: 1 }],
      ['2026-09-30', { revenue: 99, orders: 9 }],
    ]);
    expect(zeroFill(['2026-10-01', '2026-10-02'], rows)).toEqual([
      { t: '2026-10-01', revenue: 0, orders: 0 },
      { t: '2026-10-02', revenue: 10.01, orders: 1 },
    ]);
  });

  it('bucket SQL matches the key formats', () => {
    expect(bucketSql('hour')).toEqual({
      unit: 'hour',
      format: 'YYYY-MM-DD"T"HH24:00',
    });
    expect(bucketSql('day').format).toBe('YYYY-MM-DD');
    expect(bucketSql('month').format).toBe('YYYY-MM');
  });
});

describe('overview timezone', () => {
  it('accepts IANA zones and rejects junk', () => {
    expect(isValidTimeZone('Europe/Stockholm')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone("Europe/Stockholm'; DROP TABLE")).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
  });

  it('explicit tz wins (400 when invalid), else the store zone, else Stockholm', () => {
    expect(resolveTimeZone('Asia/Dubai', 'Europe/Berlin')).toBe('Asia/Dubai');
    expect(() => resolveTimeZone('Nope/Zone', null)).toThrow(
      BadRequestException,
    );
    expect(resolveTimeZone(undefined, 'Europe/Berlin')).toBe('Europe/Berlin');
    expect(resolveTimeZone(undefined, 'bogus')).toBe('Europe/Stockholm');
    expect(resolveTimeZone('', null)).toBe('Europe/Stockholm');
  });
});

describe('overview SQL fragments', () => {
  it('counted orders exclude cancelled/refunded and unpaid online payments', () => {
    const sql = countedOrderSql('o');
    const text = sql.sql.replace(/\s+/g, ' ');
    expect(sql.values).toEqual(['CANCELLED', 'REFUNDED']);
    expect(text).toContain('o.status::text NOT IN (?,?)');
    expect(text).toContain("o.payment_status = 'paid'");
    expect(text).toContain(
      "o.payment_method::text = 'COD' AND COALESCE(o.payment_status, 'pending') NOT IN ('failed', 'refunded')",
    );
    // awaiting_payment / failed online orders match none of the branches.
    expect(text).not.toContain('awaiting_payment');
  });

  it('converts market-currency amounts with the order fx_rate_snapshot', () => {
    const sql = storeAmountSql(Prisma.sql`o.total`, 'SEK');
    const text = sql.sql.replace(/\s+/g, ' ');
    expect(sql.values).toEqual(['SEK']);
    expect(text).toContain('WHEN o.currency = ?');
    expect(text).toContain('o.fx_rate_snapshot <= 0 THEN o.total');
    expect(text).toContain('ELSE o.total / o.fx_rate_snapshot');
  });
});

describe('capWithOther', () => {
  it('keeps the top 8 by revenue and folds the rest into other', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      key: `C${i}`,
      label: `C${i}`,
      revenue: i + 1,
      orders: 1,
    }));
    const out = capWithOther(rows, 8);
    expect(out).toHaveLength(9);
    expect(out[0].key).toBe('C9');
    expect(out[8]).toEqual({
      key: 'other',
      label: 'Other',
      revenue: 3,
      orders: 2,
    });
  });

  it('adds no other bucket when everything fits', () => {
    expect(
      capWithOther([{ key: 'SE', label: 'Sweden', revenue: 1, orders: 1 }]),
    ).toHaveLength(1);
  });
});

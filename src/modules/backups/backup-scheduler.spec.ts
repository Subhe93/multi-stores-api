import {
  computeLastSlotAt,
  computeNextRunAt,
  isSlotDue,
  parseTime,
  SlotConfig,
} from './backup-scheduler.service';
import { formatBytes, parseDatabaseUrl } from './backup-runner';

/** Local-time constructor: month is 1-based to keep the cases readable. */
const local = (y: number, m: number, d: number, h = 0, min = 0, s = 0): Date =>
  new Date(y, m - 1, d, h, min, s, 0);

const daily: SlotConfig = { frequency: 'DAILY', time: '03:00', weekday: 0 };
// 2026-09-20 is a Sunday.
const weeklySunday: SlotConfig = {
  frequency: 'WEEKLY',
  time: '03:00',
  weekday: 0,
};

describe('isSlotDue — DAILY', () => {
  it('is due when the slot passed today and the last run was yesterday', () => {
    const now = local(2026, 9, 22, 9, 0);
    expect(isSlotDue(daily, now, local(2026, 9, 21, 3, 0, 5))).toBe(true);
  });

  it("is not due when the last run happened after today's slot", () => {
    const now = local(2026, 9, 22, 9, 0);
    expect(isSlotDue(daily, now, local(2026, 9, 22, 3, 0, 20))).toBe(false);
  });

  it("is not due before the slot when yesterday's slot already ran", () => {
    const now = local(2026, 9, 22, 2, 59);
    expect(isSlotDue(daily, now, local(2026, 9, 21, 3, 1))).toBe(false);
  });

  it("is due before today's slot when yesterday's slot was missed", () => {
    const now = local(2026, 9, 22, 2, 59);
    expect(isSlotDue(daily, now, local(2026, 9, 20, 3, 1))).toBe(true);
  });

  it('is due exactly at the slot minute', () => {
    const now = local(2026, 9, 22, 3, 0);
    expect(isSlotDue(daily, now, local(2026, 9, 21, 3, 0))).toBe(true);
  });

  it('is due when it never ran (first enable / catch-up)', () => {
    expect(isSlotDue(daily, local(2026, 9, 22, 15, 0), null)).toBe(true);
    expect(isSlotDue(daily, local(2026, 9, 22, 15, 0), undefined)).toBe(true);
  });

  it('a run one second before the slot does not satisfy it', () => {
    const now = local(2026, 9, 22, 3, 0, 30);
    expect(isSlotDue(daily, now, local(2026, 9, 22, 2, 59, 59))).toBe(true);
  });
});

describe('isSlotDue — WEEKLY', () => {
  it('is due on the weekday after the slot time with a week-old run', () => {
    const now = local(2026, 9, 20, 3, 30); // Sunday
    expect(isSlotDue(weeklySunday, now, local(2026, 9, 13, 3, 0, 10))).toBe(
      true,
    );
  });

  it('is not due on the weekday before the slot time', () => {
    const now = local(2026, 9, 20, 2, 30); // Sunday, before 03:00
    expect(isSlotDue(weeklySunday, now, local(2026, 9, 13, 3, 0, 10))).toBe(
      false,
    );
  });

  it("is not due mid-week when this week's slot already ran", () => {
    const now = local(2026, 9, 23, 12, 0); // Wednesday
    expect(isSlotDue(weeklySunday, now, local(2026, 9, 20, 3, 0, 40))).toBe(
      false,
    );
  });

  it("is due mid-week when this week's slot was missed", () => {
    const now = local(2026, 9, 23, 12, 0); // Wednesday
    expect(isSlotDue(weeklySunday, now, local(2026, 9, 13, 3, 0, 40))).toBe(
      true,
    );
  });

  it('handles a weekday later in the week than today', () => {
    const friday: SlotConfig = {
      frequency: 'WEEKLY',
      time: '22:15',
      weekday: 5,
    };
    const now = local(2026, 9, 23, 12, 0); // Wednesday
    // Last slot was Friday 2026-09-18 22:15.
    expect(computeLastSlotAt(friday, now)).toEqual(local(2026, 9, 18, 22, 15));
    expect(isSlotDue(friday, now, local(2026, 9, 18, 22, 16))).toBe(false);
    expect(isSlotDue(friday, now, local(2026, 9, 18, 22, 14))).toBe(true);
  });
});

describe('computeLastSlotAt / computeNextRunAt', () => {
  it('daily: last is today when passed, next is tomorrow', () => {
    const now = local(2026, 9, 22, 9, 0);
    expect(computeLastSlotAt(daily, now)).toEqual(local(2026, 9, 22, 3, 0));
    expect(computeNextRunAt(daily, now)).toEqual(local(2026, 9, 23, 3, 0));
  });

  it('daily: last is yesterday when not yet passed, next is today', () => {
    const now = local(2026, 9, 22, 1, 0);
    expect(computeLastSlotAt(daily, now)).toEqual(local(2026, 9, 21, 3, 0));
    expect(computeNextRunAt(daily, now)).toEqual(local(2026, 9, 22, 3, 0));
  });

  it("weekly: next is the following week once today's slot passed", () => {
    const now = local(2026, 9, 20, 4, 0); // Sunday after 03:00
    expect(computeNextRunAt(weeklySunday, now)).toEqual(
      local(2026, 9, 27, 3, 0),
    );
  });

  it('weekly: next is this week when the weekday is still ahead', () => {
    const wednesday: SlotConfig = {
      frequency: 'WEEKLY',
      time: '03:00',
      weekday: 3,
    };
    const now = local(2026, 9, 21, 10, 0); // Monday
    expect(computeNextRunAt(wednesday, now)).toEqual(local(2026, 9, 23, 3, 0));
  });

  it('keeps the wall-clock time across a DST change (local-time based)', () => {
    // Europe switches DST on the last Sunday of October (2026-10-25). Whatever
    // the host zone is, the slot must stay at 03:00 local on both sides.
    const before = local(2026, 10, 24, 12, 0);
    const next = computeNextRunAt(daily, before);
    expect(next.getHours()).toBe(3);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(25);
    const after = computeNextRunAt(daily, local(2026, 10, 25, 12, 0));
    expect(after.getHours()).toBe(3);
    expect(after.getDate()).toBe(26);
  });

  it('falls back to 03:00 for an unparsable time', () => {
    expect(parseTime('nope')).toEqual({ hours: 3, minutes: 0 });
    expect(parseTime('25:00')).toEqual({ hours: 3, minutes: 0 });
    expect(parseTime('7:05')).toEqual({ hours: 7, minutes: 5 });
    expect(parseTime('23:59')).toEqual({ hours: 23, minutes: 59 });
  });
});

describe('parseDatabaseUrl', () => {
  it("drops Prisma's schema parameter", () => {
    expect(
      parseDatabaseUrl(
        'postgresql://u:p@localhost:5432/multi_stores?schema=public',
      ),
    ).toBe('postgresql://u:p@localhost:5432/multi_stores');
  });

  it('keeps libpq parameters and only removes schema', () => {
    expect(
      parseDatabaseUrl(
        'postgresql://u:p@h/db?sslmode=require&schema=public&connect_timeout=5',
      ),
    ).toBe('postgresql://u:p@h/db?sslmode=require&connect_timeout=5');
  });

  it('returns the url untouched when there is no query', () => {
    expect(parseDatabaseUrl('postgresql://u:p@h/db')).toBe(
      'postgresql://u:p@h/db',
    );
  });

  it('throws on an empty value', () => {
    expect(() => parseDatabaseUrl('')).toThrow();
  });
});

describe('formatBytes', () => {
  it('formats sizes with one decimal and drops a trailing .0', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(BigInt(3 * 1024 * 1024 * 1024))).toBe('3 GB');
  });

  it('renders a dash for missing values', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
  });
});

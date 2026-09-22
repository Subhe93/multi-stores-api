/**
 * Pure slot arithmetic for the backup scheduler. Everything works on the
 * server's local wall-clock (Date#setHours & co), so a slot at "03:00" means
 * 03:00 local on every day — including the days a DST change makes 24 hours
 * into 23 or 25. No timezone library, no UTC conversions.
 */

export interface SlotConfig {
  frequency: 'DAILY' | 'WEEKLY';
  /** `HH:mm`, 24h, server local time. */
  time: string;
  /** 0 = Sunday … 6 = Saturday; used when `frequency` is WEEKLY. */
  weekday: number;
}

export function parseTime(time: string): { hours: number; minutes: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  const hours = match ? Number(match[1]) : NaN;
  const minutes = match ? Number(match[2]) : NaN;
  if (
    !match ||
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return { hours: 3, minutes: 0 };
  }
  return { hours, minutes };
}

/** `date` at the slot's HH:mm, local time (a copy; the input is untouched). */
function atSlotTime(date: Date, config: SlotConfig): Date {
  const { hours, minutes } = parseTime(config.time);
  const copy = new Date(date.getTime());
  copy.setHours(hours, minutes, 0, 0);
  return copy;
}

/** Move `date` by whole local days keeping the same wall-clock time. */
function addDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setDate(copy.getDate() + days);
  return copy;
}

/**
 * The most recent slot at or before `now`, or null when the configuration
 * makes no sense (never for a validated config).
 */
export function computeLastSlotAt(config: SlotConfig, now: Date): Date {
  if (config.frequency === 'WEEKLY') {
    const weekday = clampWeekday(config.weekday);
    // Walk back from today to the configured weekday, then one more week if
    // that slot is still in the future.
    const diff = (now.getDay() - weekday + 7) % 7;
    let slot = atSlotTime(addDays(now, -diff), config);
    if (slot.getTime() > now.getTime())
      slot = atSlotTime(addDays(slot, -7), config);
    return slot;
  }
  let slot = atSlotTime(now, config);
  if (slot.getTime() > now.getTime())
    slot = atSlotTime(addDays(slot, -1), config);
  return slot;
}

/** The first slot strictly after `now`. */
export function computeNextRunAt(config: SlotConfig, now: Date): Date {
  const last = computeLastSlotAt(config, now);
  const step = config.frequency === 'WEEKLY' ? 7 : 1;
  return atSlotTime(addDays(last, step), config);
}

/**
 * Should the scheduler run now? True when the most recent slot is at or
 * before `now` and the last run happened before that slot (or never). A
 * missed slot (server down at 03:00) is therefore caught up at the next tick.
 */
export function isSlotDue(
  config: SlotConfig,
  now: Date,
  lastRunAt: Date | null | undefined,
): boolean {
  const slot = computeLastSlotAt(config, now);
  if (slot.getTime() > now.getTime()) return false;
  if (!lastRunAt) return true;
  return lastRunAt.getTime() < slot.getTime();
}

function clampWeekday(weekday: number): number {
  if (!Number.isInteger(weekday)) return 0;
  return Math.min(6, Math.max(0, weekday));
}

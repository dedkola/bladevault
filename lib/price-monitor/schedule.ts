import type {
  ActiveHours,
  PriceMonitoringSettings,
} from '@/lib/settings-shared'

const HOUR_MS = 60 * 60 * 1000

/** Twice daily runs in daytime unless the user picks other hours. */
export const TWICE_DAILY_DEFAULT_HOURS: ActiveHours = [8, 22]

/** How often each source should be checked (the frequency window F). */
export function frequencyMs(
  schedule: PriceMonitoringSettings['schedule'],
): number {
  switch (schedule.mode) {
    case 'daily':
      return 24 * HOUR_MS
    case 'twice_daily':
    case 'every_12h':
      return 12 * HOUR_MS
    case 'custom':
      return schedule.intervalHours * HOUR_MS
  }
}

/** Hours checks may run in, or null for around the clock. */
export function effectiveActiveHours(
  schedule: PriceMonitoringSettings['schedule'],
): ActiveHours | null {
  // Every 12 hours means around the clock by definition.
  if (schedule.mode === 'every_12h') return null
  if (schedule.activeHours) return schedule.activeHours
  return schedule.mode === 'twice_daily' ? TWICE_DAILY_DEFAULT_HOURS : null
}

function hourOfDay(date: Date): number {
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600
}

/** Server local time; [22, 6] wraps midnight. */
export function isWithinActiveHours(
  hours: ActiveHours | null,
  date: Date,
): boolean {
  if (!hours) return true
  const [start, end] = hours
  const hour = hourOfDay(date)
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}

export function activeHoursPerDay(hours: ActiveHours | null): number {
  if (!hours) return 24
  const [start, end] = hours
  return start < end ? end - start : 24 - start + end
}

/**
 * Active time inside one frequency window, used to spread a store's checks:
 * "twice daily, 8–22" gives 12 h × 14/24 = 7 h of checking per window.
 */
export function activeWindowMs(
  schedule: PriceMonitoringSettings['schedule'],
): number {
  return (
    (frequencyMs(schedule) *
      activeHoursPerDay(effectiveActiveHours(schedule))) /
    24
  )
}

/** 0 inside the active hours, otherwise the wait until they start. */
export function msUntilActive(hours: ActiveHours | null, date: Date): number {
  if (isWithinActiveHours(hours, date) || !hours) return 0
  const start = new Date(date)
  start.setHours(hours[0], 0, 0, 0)
  if (start.getTime() <= date.getTime()) start.setDate(start.getDate() + 1)
  return start.getTime() - date.getTime()
}

const DAY_MS = 24 * HOUR_MS

/** A page out of stock this long is checked at most once a day. */
export const SLOW_OUT_OF_STOCK_AFTER_MS = 14 * DAY_MS
/** The slower pace for long out-of-stock pages: a restock shows within a day. */
export const SLOW_OUT_OF_STOCK_INTERVAL_MS = DAY_MS
/** Out of stock this long: the listing may be discontinued (Pause hint). */
export const STALE_OUT_OF_STOCK_MS = 60 * DAY_MS

/**
 * How long until a source's next scheduled check after a successful one:
 * the schedule's frequency, or at least a day for a page that has been out
 * of stock for two weeks or more (when `slowOutOfStock` is on). A knife the
 * AI supervisor watches closely is checked at its shorter interval, out of
 * stock or not. Check now and Check all ignore this; they make a source due
 * right away.
 */
export function scheduledIntervalMs(input: {
  intervalMs: number
  /** Start of the current out-of-stock run (epoch ms), or null. */
  outOfStockSince: number | null
  now: number
  slowOutOfStock: boolean
  /** The knife is watched closely: at most this long between checks. */
  focusIntervalMs?: number | null
}): number {
  const { intervalMs, outOfStockSince, now } = input
  if (input.focusIntervalMs && input.focusIntervalMs > 0)
    return Math.min(intervalMs, input.focusIntervalMs)
  if (
    input.slowOutOfStock &&
    outOfStockSince !== null &&
    now - outOfStockSince >= SLOW_OUT_OF_STOCK_AFTER_MS
  )
    return Math.max(intervalMs, SLOW_OUT_OF_STOCK_INTERVAL_MS)
  return intervalMs
}

/**
 * A source's share of its store's checks per frequency window: 1 normally,
 * less for a page checked less often, so the store's even spread is not
 * computed for checks that never come.
 */
export function checkLoad(input: {
  intervalMs: number
  outOfStockSince: number | null
  now: number
  slowOutOfStock: boolean
  focusIntervalMs?: number | null
}): number {
  return input.intervalMs / scheduledIntervalMs(input)
}

/** True when an out-of-stock page may be gone for good (suggest Pause). */
export function isStaleOutOfStock(
  outOfStockSince: number | null,
  now: number,
): boolean {
  return (
    outOfStockSince !== null && now - outOfStockSince >= STALE_OUT_OF_STOCK_MS
  )
}

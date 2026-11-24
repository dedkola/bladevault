import type {
  ActiveHours,
  PriceMonitoringSettings,
} from '@/lib/settings-shared'

const HOUR_MS = 60 * 60 * 1000

/** How often a price check round starts (6, 12 or 24 hours). */
export function frequencyMs(
  schedule: PriceMonitoringSettings['schedule'],
): number {
  return schedule.intervalHours * HOUR_MS
}

/**
 * The time AI pacing advice may stretch a store's checks over: one round
 * interval, so a slowed store still gets through before the next round.
 */
export function adviceWindowMs(
  schedule: PriceMonitoringSettings['schedule'],
): number {
  return frequencyMs(schedule)
}

function hourOfDay(date: Date): number {
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600
}

/** Server local time; [22, 6] wraps midnight. Null: around the clock. */
export function isWithinActiveHours(
  hours: ActiveHours | null,
  date: Date,
): boolean {
  if (!hours) return true
  const [start, end] = hours
  const hour = hourOfDay(date)
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
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
 * When a source is next due after a successful check (epoch ms): the next
 * round, about one interval later, or a day later for a page out of stock
 * for two weeks; sooner for a knife the AI supervisor watches closely.
 */
export function nextScheduledCheckAt(input: {
  schedule: PriceMonitoringSettings['schedule']
  /** The round interval (defaults to the schedule's). */
  intervalMs?: number
  outOfStockSince: number | null
  now: number
  focusIntervalMs?: number | null
}): number {
  return (
    input.now +
    scheduledIntervalMs({
      intervalMs: input.intervalMs ?? frequencyMs(input.schedule),
      outOfStockSince: input.outOfStockSince,
      now: input.now,
      slowOutOfStock: input.schedule.slowOutOfStock,
      focusIntervalMs: input.focusIntervalMs,
    })
  )
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

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

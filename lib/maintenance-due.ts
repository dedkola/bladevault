import type { MaintenanceType } from '@/lib/data'
import {
  CARE_TRACKS,
  CARE_TRACK_PAST,
  CARE_TRACK_VERBS,
  type CareIntervalOverrides,
  type CareTrack,
  type MaintenanceReminderSettings,
} from '@/lib/settings-shared'

/** Window event fired after maintenance events change, so derived care status refreshes. */
export const MAINTENANCE_UPDATED_EVENT = 'bladevault-maintenance-change'

export type CareStatusLevel = 'ok' | 'due-soon' | 'overdue' | 'never'

export const CARE_FILTER_VALUES: readonly CareStatusLevel[] = [
  'overdue',
  'due-soon',
  'never',
  'ok',
]

export const CARE_STATUS_LABELS: Record<CareStatusLevel, string> = {
  ok: 'Up to date',
  'due-soon': 'Due soon',
  overdue: 'Overdue',
  never: 'Missing care',
}

export type CareTrackStatus = {
  track: CareTrack
  intervalDays: number
  lastAt: string | null
  /** Calendar days since the last event; null when never logged. */
  daysSince: number | null
  /** Days until the deadline (negative = overdue); null when never logged. */
  dueInDays: number | null
  level: CareStatusLevel
}

export type KnifeCareStatus = {
  knifeId: string
  tracks: CareTrackStatus[]
  /** Worst track level; null when no track applies to this knife. */
  level: CareStatusLevel | null
  /** The track behind `level`; null when no track applies. */
  worst: CareTrackStatus | null
  /** Whether the knife has any maintenance entry, of any type. */
  hasHistory: boolean
}

/** Latest event date per knife and maintenance type, from storage. */
export type MaintenanceLatestEntry = {
  knifeId: string
  type: MaintenanceType
  lastAt: string
}

export type LatestByType = Partial<Record<MaintenanceType, string>>

/** Calendar-day age keeps badges stable across daylight-saving changes. */
function calendarDay(date: Date): number {
  return (
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000
  )
}

export function buildLatestByKnife(
  entries: MaintenanceLatestEntry[],
): Map<string, LatestByType> {
  const map = new Map<string, LatestByType>()
  for (const entry of entries) {
    const existing = map.get(entry.knifeId) ?? {}
    const previous = existing[entry.type]
    if (!previous || entry.lastAt > previous) {
      existing[entry.type] = entry.lastAt
      map.set(entry.knifeId, existing)
    }
  }
  return map
}

export function resolveCareIntervals(
  settings: MaintenanceReminderSettings,
  override?: Partial<Record<CareTrack, number | null>>,
): Record<CareTrack, number | null> {
  const resolved = {} as Record<CareTrack, number | null>
  for (const track of CARE_TRACKS) {
    resolved[track] =
      override && track in override
        ? (override[track] ?? null)
        : settings.intervals[track]
  }
  return resolved
}

function latestTrackDate(
  track: CareTrack,
  latestByType: LatestByType,
  settings: MaintenanceReminderSettings,
): string | null {
  const own = latestByType[track] ?? null
  if (track !== 'sharpening' || !settings.stroppingCountsAsSharpening) {
    return own
  }
  const stropped = latestByType.stropping ?? null
  if (!own) return stropped
  if (!stropped) return own
  return stropped > own ? stropped : own
}

/** A near deadline is more actionable than a track that was never logged. */
const LEVEL_SEVERITY: Record<CareStatusLevel, number> = {
  ok: 0,
  never: 1,
  'due-soon': 2,
  overdue: 3,
}

export function getKnifeCareStatus(
  knifeId: string,
  latestByType: LatestByType,
  settings: MaintenanceReminderSettings,
  override: Partial<Record<CareTrack, number | null>> | undefined,
  now: Date,
): KnifeCareStatus {
  const intervals = resolveCareIntervals(settings, override)
  const today = calendarDay(now)
  const tracks: CareTrackStatus[] = []
  for (const track of CARE_TRACKS) {
    const intervalDays = intervals[track]
    if (intervalDays === null) continue
    const lastAt = latestTrackDate(track, latestByType, settings)
    const lastDate = lastAt ? new Date(lastAt) : null
    const valid =
      lastDate && Number.isFinite(lastDate.getTime()) && lastDate <= now
    const daysSince = valid ? today - calendarDay(lastDate) : null
    const dueInDays = daysSince === null ? null : intervalDays - daysSince
    const level: CareStatusLevel =
      dueInDays === null
        ? 'never'
        : dueInDays < 0
          ? 'overdue'
          : dueInDays <= settings.dueSoonDays
            ? 'due-soon'
            : 'ok'
    tracks.push({
      track,
      intervalDays,
      lastAt: valid ? lastAt : null,
      daysSince,
      dueInDays,
      level,
    })
  }

  const hasHistory = Object.values(latestByType).some((value) => {
    const date = value ? new Date(value) : null
    return Boolean(date && Number.isFinite(date.getTime()) && date <= now)
  })
  // Reminders start with a knife's first maintenance entry unless every
  // knife is tracked; the tracks stay available for the knife's own page.
  if (!hasHistory && settings.neverLogged !== 'all') {
    return { knifeId, tracks, level: null, worst: null, hasHistory }
  }

  let level: CareStatusLevel | null = null
  let worst: CareTrackStatus | null = null
  for (const status of tracks) {
    if (status.level === 'never' && settings.neverLogged === 'off') continue
    if (
      level === null ||
      LEVEL_SEVERITY[status.level] > LEVEL_SEVERITY[level]
    ) {
      level = status.level
      worst = status
    } else if (
      status.level === level &&
      worst &&
      status.dueInDays !== null &&
      (worst.dueInDays === null || status.dueInDays < worst.dueInDays)
    ) {
      // Same severity: surface the track that is furthest past due.
      worst = status
    }
  }
  return { knifeId, tracks, level, worst, hasHistory }
}

export function getCareStatuses(
  knives: ReadonlyArray<{ id: string; sold?: boolean }>,
  latestByKnife: ReadonlyMap<string, LatestByType>,
  settings: MaintenanceReminderSettings,
  overrides: CareIntervalOverrides,
  now: Date,
): Map<string, KnifeCareStatus> {
  const statuses = new Map<string, KnifeCareStatus>()
  if (!settings.enabled) return statuses
  for (const knife of knives) {
    if (settings.skipSoldKnives && knife.sold) continue
    statuses.set(
      knife.id,
      getKnifeCareStatus(
        knife.id,
        latestByKnife.get(knife.id) ?? {},
        settings,
        overrides[knife.id],
        now,
      ),
    )
  }
  return statuses
}

export function countCareStatuses(
  statuses: ReadonlyMap<string, KnifeCareStatus>,
): Record<CareStatusLevel, number> {
  const counts: Record<CareStatusLevel, number> = {
    ok: 0,
    'due-soon': 0,
    overdue: 0,
    never: 0,
  }
  for (const status of statuses.values()) {
    if (status.level) counts[status.level] += 1
  }
  return counts
}

/**
 * Knives that need care soonest: overdue first (most overdue on top), then
 * due soon (closest deadline on top).
 */
export function rankCareAttention(
  statuses: ReadonlyMap<string, KnifeCareStatus>,
): KnifeCareStatus[] {
  return [...statuses.values()]
    .filter(
      (status) =>
        (status.level === 'overdue' || status.level === 'due-soon') &&
        status.worst?.dueInDays !== null &&
        status.worst?.dueInDays !== undefined,
    )
    .sort(
      (left, right) =>
        (left.worst?.dueInDays ?? 0) - (right.worst?.dueInDays ?? 0) ||
        left.knifeId.localeCompare(right.knifeId),
    )
}

export function formatDaysAgo(days: number): string {
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

/** Short due line for a track tile: "Overdue by 4 days" / "Due in 9 days". */
export function formatTrackDueLine(status: CareTrackStatus): string {
  if (status.dueInDays === null) return 'Not logged yet'
  if (status.dueInDays < 0)
    return `Overdue by ${-status.dueInDays} day${status.dueInDays === -1 ? '' : 's'}`
  if (status.dueInDays === 0) return 'Due today'
  return `Due in ${status.dueInDays} day${status.dueInDays === 1 ? '' : 's'}`
}

/**
 * "No care logged" when nothing was ever recorded, otherwise lists the
 * kinds of care the knife has never had: "Not yet cleaned or lubed".
 */
function missingCareLabel(status: KnifeCareStatus): string {
  const missing = status.tracks
    .filter((track) => track.level === 'never')
    .map((track) => CARE_TRACK_PAST[track.track])
  if (!status.hasHistory || missing.length === 0) return 'No care logged'
  const list =
    missing.length === 1
      ? missing[0]
      : `${missing.slice(0, -1).join(', ')} or ${missing[missing.length - 1]}`
  return `Not yet ${list}`
}

/** Compact badge label for cards: "Sharpen overdue · 4d". */
export function careBadgeLabel(status: KnifeCareStatus): string | null {
  if (status.level === null) return null
  if (status.level === 'ok') return 'Care up to date'
  if (status.level === 'never') return missingCareLabel(status)
  const worst = status.worst
  if (!worst || worst.dueInDays === null) return null
  const verb = CARE_TRACK_VERBS[worst.track]
  if (status.level === 'overdue')
    return `${verb} overdue · ${-worst.dueInDays}d`
  return worst.dueInDays === 0
    ? `${verb} due today`
    : `${verb} due in ${worst.dueInDays}d`
}

/** One-line summary for lists: "Sharpen · 34d overdue". */
export function careDueSummary(status: KnifeCareStatus): string | null {
  const worst = status.worst
  if (status.level === 'never') return missingCareLabel(status)
  if (!worst || worst.dueInDays === null) return null
  const verb = CARE_TRACK_VERBS[worst.track]
  if (worst.dueInDays < 0) return `${verb} · ${-worst.dueInDays}d overdue`
  if (worst.dueInDays === 0) return `${verb} · due today`
  return `${verb} · due in ${worst.dueInDays}d`
}

export function isCareStatusLevel(value: string): value is CareStatusLevel {
  return (CARE_FILTER_VALUES as string[]).includes(value)
}

import type { MaintenanceType } from '@/lib/data'
import {
  CARE_TRACKS,
  CARE_TRACK_NAMES,
  CARE_TRACK_VERBS,
  type CareDeferral,
  type CareDeferrals,
  type CareIntervalOverrides,
  type CareTrack,
  type MaintenanceReminderSettings,
} from '@/lib/settings-shared'

/** Window event fired after maintenance events change, so derived care status refreshes. */
export const MAINTENANCE_UPDATED_EVENT = 'bladevault-maintenance-change'

/** A knife's care status, from the kinds of care it has a logged date for. */
export type CareStatusLevel = 'ok' | 'due-soon' | 'overdue'
/** One kind of care; `never` when it has no entry yet, so no deadline. */
export type CareTrackLevel = CareStatusLevel | 'never'

export const CARE_FILTER_VALUES: readonly CareStatusLevel[] = [
  'overdue',
  'due-soon',
  'ok',
]

export const CARE_STATUS_LABELS: Record<CareStatusLevel, string> = {
  ok: 'Up to date',
  'due-soon': 'Due soon',
  overdue: 'Overdue',
}

export type CareTrackStatus = {
  track: CareTrack
  intervalDays: number
  lastAt: string | null
  /** Calendar days since the last event; null when never logged. */
  daysSince: number | null
  /** Days until the deadline (negative = overdue); null when never logged. */
  dueInDays: number | null
  level: CareTrackLevel
  /** Local date the job was pushed back to, while that still applies. */
  deferredUntil: string | null
}

export type KnifeCareStatus = {
  knifeId: string
  tracks: CareTrackStatus[]
  /**
   * Worst level among the kinds of care with a logged date; null when none
   * has one yet, so the knife gets no reminders.
   */
  level: CareStatusLevel | null
  /** The track behind `level`; null when no track applies. */
  worst: CareTrackStatus | null
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

const LEVEL_SEVERITY: Record<CareStatusLevel, number> = {
  ok: 0,
  'due-soon': 1,
  overdue: 2,
}

export function getKnifeCareStatus(
  knifeId: string,
  latestByType: LatestByType,
  settings: MaintenanceReminderSettings,
  override: Partial<Record<CareTrack, number | null>> | undefined,
  now: Date,
  deferral?: Partial<Record<CareTrack, CareDeferral>>,
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
    let dueInDays = daysSince === null ? null : intervalDays - daysSince
    // A pushed-back job keeps its new date until the care is logged again.
    let deferredUntil: string | null = null
    const pushed = deferral?.[track]
    if (pushed && dueInDays !== null && pushed.after === (lastAt ?? '')) {
      const [year, month, day] = pushed.until.split('-').map(Number)
      const untilDays = Date.UTC(year, month - 1, day) / 86_400_000 - today
      if (untilDays > dueInDays) {
        dueInDays = untilDays
        deferredUntil = pushed.until
      }
    }
    const level: CareTrackLevel =
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
      deferredUntil,
    })
  }

  let level: CareStatusLevel | null = null
  let worst: CareTrackStatus | null = null
  for (const status of tracks) {
    // A kind of care with no entry has no deadline, so it never flags a knife.
    if (status.level === 'never') continue
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
  return { knifeId, tracks, level, worst }
}

export function getCareStatuses(
  knives: ReadonlyArray<{ id: string; sold?: boolean }>,
  latestByKnife: ReadonlyMap<string, LatestByType>,
  settings: MaintenanceReminderSettings,
  overrides: CareIntervalOverrides,
  now: Date,
  deferrals: CareDeferrals = {},
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
        deferrals[knife.id],
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

/** Compact badge label for cards: "Sharpen overdue · 4d". */
export function careBadgeLabel(status: KnifeCareStatus): string | null {
  if (status.level === null) return null
  if (status.level === 'ok') return 'Care up to date'
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
  if (!worst || worst.dueInDays === null) return null
  const verb = CARE_TRACK_VERBS[worst.track]
  if (worst.dueInDays < 0) return `${verb} · ${-worst.dueInDays}d overdue`
  if (worst.dueInDays === 0) return `${verb} · due today`
  return `${verb} · due in ${worst.dueInDays}d`
}

export function isCareStatusLevel(value: string): value is CareStatusLevel {
  return (CARE_FILTER_VALUES as string[]).includes(value)
}

/**
 * URL parameter that narrows the `care` filter to one kind of care, so
 * "Sharpening overdue" lists knives whose sharpening is overdue rather than
 * every knife with any overdue care.
 */
export const CARE_KIND_PARAM = 'careKind'

export function parseCareKind(value: string | null): CareTrack | null {
  return value && (CARE_TRACKS as readonly string[]).includes(value)
    ? (value as CareTrack)
    : null
}

/**
 * Whether a knife passes the care filter. Without a kind it compares the
 * knife's overall (worst) level; with a kind it compares that kind's own
 * level and skips knives that have never had it logged.
 */
export function matchesCareFilter(
  status: KnifeCareStatus | undefined,
  levels: readonly CareStatusLevel[],
  kind: CareTrack | null,
): boolean {
  if (!kind) {
    if (levels.length === 0) return true
    return Boolean(status?.level && levels.includes(status.level))
  }
  const track = status?.tracks.find((item) => item.track === kind)
  if (!track || track.level === 'never') return false
  return levels.length === 0 || levels.includes(track.level)
}

/** Chip for an active care-kind filter, so it shows and can be cleared. */
export function careKindChip(
  value: string | null | undefined,
): { key: string; label: string } | null {
  const kind = parseCareKind(value ?? null)
  return kind
    ? { key: CARE_KIND_PARAM, label: `Care kind: ${CARE_TRACK_NAMES[kind]}` }
    : null
}

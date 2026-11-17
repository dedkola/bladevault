import type { MaintenanceEvent, MaintenanceType } from '@/lib/data'
import { localDateAfter } from '@/lib/care-notifications'
import type {
  CareStatusLevel,
  CareTrackStatus,
  KnifeCareStatus,
} from '@/lib/maintenance-due'
import {
  CARE_TRACKS,
  type CareTrack,
  type MaintenanceReminderSettings,
} from '@/lib/settings-shared'

/** One kind of care on one knife that has a deadline. */
export type CareJob = {
  knifeId: string
  track: CareTrack
  /** Days until the deadline; negative when overdue. */
  dueInDays: number
  /** Local deadline date, YYYY-MM-DD. */
  dueOn: string
  level: CareStatusLevel
  intervalDays: number
  lastAt: string
}

export type CareTrackSummary = {
  track: CareTrack
  /** The default interval from Settings; null when the kind is switched off. */
  intervalDays: number | null
  /** Knives with a logged date for this kind of care. */
  tracked: number
  counts: Record<CareStatusLevel, number>
  mostOverdue: CareJob | null
  /** Earliest deadline that hasn't passed, with every knife due that day. */
  nextDue: { dueOn: string; dueInDays: number; knifeIds: string[] } | null
  lastDone: { knifeId: string; at: string } | null
  /** Average days between logged entries on the same knife. */
  rhythmDays: number | null
  /** Gaps behind `rhythmDays`; a handful is needed before it means much. */
  rhythmSamples: number
}

/** Colour groups for care sessions on the timeline. */
export type CareSessionKind =
  'sharpening' | 'cleaning' | 'lubrication' | 'service' | 'other'

export const CARE_SESSION_KINDS: readonly CareSessionKind[] = [
  'sharpening',
  'cleaning',
  'lubrication',
  'service',
  'other',
]

/** Every entry logged on one knife on one local day. */
export type CareSession = {
  /** YYYY-MM-DD (local time). */
  day: string
  /** 0–1 across the timeline window. */
  position: number
  kinds: CareSessionKind[]
  types: MaintenanceType[]
  notes: string[]
  /** Sharpening details worth showing, such as "17°" or "1000 grit". */
  details: string[]
  /** The logged entries behind the session, in the order they happened. */
  entries: MaintenanceEvent[]
}

export type CareTimelineRow = {
  knifeId: string
  sessions: CareSession[]
  /** Latest session day, including any before the window. */
  lastDay: string
  daysSince: number
}

export type CareTimeline = {
  /** First day shown, YYYY-MM-DD: the 1st of the earliest month. */
  startDay: string
  today: string
  todayPosition: number
  /** First of each month in the window, with its 0–1 position. */
  months: { day: string; position: number }[]
  /** Knives with a session in the window, most recently cared for first. */
  rows: CareTimelineRow[]
  sessionCount: number
  careDays: number
  kindCounts: Record<CareSessionKind, number>
}

export type CareFeedItem = {
  knifeId: string
  /** Calendar day of the entries, YYYY-MM-DD (local time). */
  day: string
  occurredAt: string
  types: MaintenanceType[]
  notes: string[]
  angle?: string
  grit?: string
}

const FEED_TYPE_ORDER: readonly MaintenanceType[] = [
  'disassembly',
  'sharpening',
  'stropping',
  'cleaning',
  'lubrication',
  'reassembly',
  'hardware_replacement',
  'part_replacement',
  'other',
]

/** Rhythms need this many gaps before the page compares them to an interval. */
export const CARE_RHYTHM_MIN_SAMPLES = 3

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function localDay(value: string): string | null {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function dayNumber(day: string): number {
  const [year, month, date] = day.split('-').map(Number)
  return Date.UTC(year, month - 1, date) / 86_400_000
}

/** The reminder kind an event counts toward, if any. */
export function careTrackForType(
  type: MaintenanceType,
  settings: Pick<MaintenanceReminderSettings, 'stroppingCountsAsSharpening'>,
): CareTrack | null {
  if ((CARE_TRACKS as readonly string[]).includes(type))
    return type as CareTrack
  if (type === 'stropping' && settings.stroppingCountsAsSharpening)
    return 'sharpening'
  return null
}

/** The timeline colour group an entry belongs to. */
export function careSessionKind(type: MaintenanceType): CareSessionKind {
  if (type === 'sharpening' || type === 'stropping') return 'sharpening'
  if (type === 'cleaning' || type === 'lubrication') return type
  if (type === 'other') return 'other'
  return 'service'
}

function toJob(
  knifeId: string,
  track: CareTrackStatus,
  now: Date,
): CareJob | null {
  if (
    track.level === 'never' ||
    track.dueInDays === null ||
    track.lastAt === null
  )
    return null
  return {
    knifeId,
    track: track.track,
    dueInDays: track.dueInDays,
    dueOn: localDateAfter(now, track.dueInDays),
    level: track.level,
    intervalDays: track.intervalDays,
    lastAt: track.lastAt,
  }
}

/** Every kind of care with a deadline, most urgent first. */
export function listCareJobs(
  statuses: ReadonlyMap<string, KnifeCareStatus>,
  now: Date,
): CareJob[] {
  const jobs: CareJob[] = []
  for (const status of statuses.values()) {
    for (const track of status.tracks) {
      const job = toJob(status.knifeId, track, now)
      if (job) jobs.push(job)
    }
  }
  return jobs.sort(
    (left, right) =>
      left.dueInDays - right.dueInDays ||
      CARE_TRACKS.indexOf(left.track) - CARE_TRACKS.indexOf(right.track) ||
      left.knifeId.localeCompare(right.knifeId),
  )
}

/**
 * Average gap in days between entries of one kind on the same knife.
 * Several entries on one day count once.
 */
function careRhythms(
  events: readonly MaintenanceEvent[],
  settings: Pick<MaintenanceReminderSettings, 'stroppingCountsAsSharpening'>,
  knifeIds: ReadonlySet<string>,
): Record<CareTrack, { days: number | null; samples: number }> {
  const days = new Map<string, Set<string>>()
  for (const event of events) {
    if (!knifeIds.has(event.knifeId)) continue
    const track = careTrackForType(event.type, settings)
    const day = localDay(event.occurredAt)
    if (!track || !day) continue
    const key = `${track}\u0000${event.knifeId}`
    const set = days.get(key) ?? new Set<string>()
    set.add(day)
    days.set(key, set)
  }
  const totals = Object.fromEntries(
    CARE_TRACKS.map((track) => [track, { sum: 0, samples: 0 }]),
  ) as Record<CareTrack, { sum: number; samples: number }>
  for (const [key, set] of days) {
    const track = key.split('\u0000')[0] as CareTrack
    const sorted = [...set].map(dayNumber).sort((left, right) => left - right)
    for (let index = 1; index < sorted.length; index += 1) {
      totals[track].sum += sorted[index] - sorted[index - 1]
      totals[track].samples += 1
    }
  }
  return Object.fromEntries(
    CARE_TRACKS.map((track) => {
      const { sum, samples } = totals[track]
      return [
        track,
        { days: samples ? Math.round(sum / samples) : null, samples },
      ]
    }),
  ) as Record<CareTrack, { days: number | null; samples: number }>
}

/** Per-kind overview: counts, the worst and next deadline, and habits. */
export function summarizeCareTracks(
  statuses: ReadonlyMap<string, KnifeCareStatus>,
  events: readonly MaintenanceEvent[],
  settings: MaintenanceReminderSettings,
  now: Date,
): CareTrackSummary[] {
  const jobs = listCareJobs(statuses, now)
  const rhythms = careRhythms(events, settings, new Set(statuses.keys()))
  return CARE_TRACKS.flatMap((track) => {
    const own = jobs.filter((job) => job.track === track)
    const intervalDays = settings.intervals[track]
    // A kind switched off everywhere has nothing to show.
    if (intervalDays === null && own.length === 0) return []
    const counts: Record<CareStatusLevel, number> = {
      ok: 0,
      'due-soon': 0,
      overdue: 0,
    }
    for (const job of own) counts[job.level] += 1
    const overdue = own.filter((job) => job.dueInDays < 0)
    const upcoming = own.filter((job) => job.dueInDays >= 0)
    const next = upcoming[0]
    const lastDone = own.reduce<CareTrackSummary['lastDone']>(
      (latest, job) =>
        !latest || job.lastAt > latest.at
          ? { knifeId: job.knifeId, at: job.lastAt }
          : latest,
      null,
    )
    return [
      {
        track,
        intervalDays,
        tracked: own.length,
        counts,
        mostOverdue: overdue[0] ?? null,
        nextDue: next
          ? {
              dueOn: next.dueOn,
              dueInDays: next.dueInDays,
              knifeIds: upcoming
                .filter((job) => job.dueOn === next.dueOn)
                .map((job) => job.knifeId),
            }
          : null,
        lastDone,
        rhythmDays: rhythms[track].days,
        rhythmSamples: rhythms[track].samples,
      },
    ]
  })
}

/**
 * True when you usually wait clearly longer than the reminder interval, so
 * the reminder fires before you'd normally get to it.
 */
export function rhythmOutpacesInterval(summary: CareTrackSummary): boolean {
  return (
    summary.intervalDays !== null &&
    summary.rhythmDays !== null &&
    summary.rhythmSamples >= CARE_RHYTHM_MIN_SAMPLES &&
    summary.rhythmDays >= summary.intervalDays * 1.25
  )
}

/** Days of empty space after today, so today's dots aren't cut off. */
const TIMELINE_TAIL_DAYS = 3

/**
 * Care sessions (same knife, same local day) per knife, from the month of the
 * first entry, and at most `maxMonths` months back.
 */
export function buildCareTimeline(
  events: readonly MaintenanceEvent[],
  now: Date,
  maxMonths = 6,
): CareTimeline {
  const today = localDay(now.toISOString()) ?? '1970-01-01'
  const sessions = new Map<string, Map<string, CareSession>>()
  const lastDayByKnife = new Map<string, string>()
  let firstDay: string | null = null
  for (const event of events) {
    const day = localDay(event.occurredAt)
    if (!day || day > today) continue
    const last = lastDayByKnife.get(event.knifeId)
    if (!last || day > last) lastDayByKnife.set(event.knifeId, day)
    let byDay = sessions.get(event.knifeId)
    if (!byDay) {
      byDay = new Map()
      sessions.set(event.knifeId, byDay)
    }
    let session = byDay.get(day)
    if (!session) {
      session = {
        day,
        position: 0,
        kinds: [],
        types: [],
        notes: [],
        details: [],
        entries: [],
      }
      byDay.set(day, session)
    }
    session.entries.push(event)
    const kind = careSessionKind(event.type)
    if (!session.kinds.includes(kind)) session.kinds.push(kind)
    if (!session.types.includes(event.type)) session.types.push(event.type)
    const note = event.notes.trim()
    if (note && !session.notes.includes(note)) session.notes.push(note)
    const angle = event.sharpeningDetails?.angle?.trim().replace(/°$/, '')
    const grit = event.sharpeningDetails?.grit?.trim()
    for (const detail of [angle && `${angle}°`, grit && `${grit} grit`])
      if (detail && !session.details.includes(detail))
        session.details.push(detail)
    if (!firstDay || day < firstDay) firstDay = day
  }

  const [year, month] = today.split('-').map(Number)
  const earliest = new Date(year, month - maxMonths, 1)
  const earliestDay = `${earliest.getFullYear()}-${pad(earliest.getMonth() + 1)}-01`
  const firstMonth = firstDay ? `${firstDay.slice(0, 7)}-01` : today
  const startDay = firstMonth > earliestDay ? firstMonth : earliestDay
  const start = dayNumber(startDay)
  const span = Math.max(1, dayNumber(today) + TIMELINE_TAIL_DAYS - start)
  const position = (day: string) => (dayNumber(day) - start) / span

  const months: CareTimeline['months'] = []
  for (
    let date = new Date(
      Number(startDay.slice(0, 4)),
      Number(startDay.slice(5, 7)) - 1,
      1,
    );
    ;
    date = new Date(date.getFullYear(), date.getMonth() + 1, 1)
  ) {
    const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-01`
    if (day > today) break
    months.push({ day, position: position(day) })
  }

  const kindCounts = Object.fromEntries(
    CARE_SESSION_KINDS.map((kind) => [kind, 0]),
  ) as Record<CareSessionKind, number>
  const days = new Set<string>()
  const rows: CareTimelineRow[] = []
  for (const [knifeId, byDay] of sessions) {
    const shown = [...byDay.values()]
      .filter((session) => session.day >= startDay)
      .sort((left, right) => left.day.localeCompare(right.day))
    if (!shown.length) continue
    for (const session of shown) {
      session.position = position(session.day)
      session.kinds.sort(
        (left, right) =>
          CARE_SESSION_KINDS.indexOf(left) - CARE_SESSION_KINDS.indexOf(right),
      )
      session.types.sort(
        (left, right) =>
          FEED_TYPE_ORDER.indexOf(left) - FEED_TYPE_ORDER.indexOf(right),
      )
      session.entries.sort(
        (left, right) =>
          left.occurredAt.localeCompare(right.occurredAt) || left.id - right.id,
      )
      for (const kind of session.kinds) kindCounts[kind] += 1
      days.add(session.day)
    }
    const lastDay = lastDayByKnife.get(knifeId) ?? shown.at(-1)!.day
    rows.push({
      knifeId,
      sessions: shown,
      lastDay,
      daysSince: dayNumber(today) - dayNumber(lastDay),
    })
  }
  rows.sort(
    (left, right) =>
      right.lastDay.localeCompare(left.lastDay) ||
      right.sessions.length - left.sessions.length,
  )

  return {
    startDay,
    today,
    todayPosition: position(today),
    months,
    rows,
    sessionCount: rows.reduce((sum, row) => sum + row.sessions.length, 0),
    careDays: days.size,
    kindCounts,
  }
}

/**
 * Latest entries, with same-day entries on one knife merged ("Sharpened +
 * stropped"). Expects events newest first.
 */
export function recentCareFeed(
  events: readonly MaintenanceEvent[],
  limit = 8,
): CareFeedItem[] {
  const items: CareFeedItem[] = []
  const byKey = new Map<string, CareFeedItem>()
  for (const event of events) {
    const day = localDay(event.occurredAt)
    if (!day) continue
    const key = `${event.knifeId}\u0000${day}`
    let item = byKey.get(key)
    if (!item) {
      if (items.length >= limit) continue
      item = {
        knifeId: event.knifeId,
        day,
        occurredAt: event.occurredAt,
        types: [],
        notes: [],
      }
      byKey.set(key, item)
      items.push(item)
    }
    if (!item.types.includes(event.type)) item.types.push(event.type)
    const note = event.notes.trim()
    if (note && !item.notes.includes(note)) item.notes.push(note)
    item.angle ??= event.sharpeningDetails?.angle?.trim() || undefined
    item.grit ??= event.sharpeningDetails?.grit?.trim() || undefined
  }
  // A fixed order reads the same everywhere: "Sharpened + stropped".
  for (const item of items)
    item.types.sort(
      (left, right) =>
        FEED_TYPE_ORDER.indexOf(left) - FEED_TYPE_ORDER.indexOf(right),
    )
  return items
}

/** "Nov 26", with the year when it isn't this year. */
export function formatCareDate(value: string, now: Date): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(
        Number(value.slice(0, 4)),
        Number(value.slice(5, 7)) - 1,
        Number(value.slice(8, 10)),
      )
    : new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  })
}

/** One pin on the Coming up timeline: a job, or nearby jobs merged. */
export type CareTimelinePin = {
  jobs: CareJob[]
  /** Horizontal position within its region, 0–100. */
  position: number
  /** The most urgent level among `jobs`. */
  level: CareStatusLevel
}

const PIN_SEVERITY: Record<CareStatusLevel, number> = {
  ok: 0,
  'due-soon': 1,
  overdue: 2,
}

/**
 * Places jobs on a 0–100 scale and merges a job into the pin before it when
 * their centres are closer than `minGap`, so pins never overlap. `minGap`
 * can depend on the pins' labels, since wider labels need more room.
 */
export function clusterTimelinePins(
  jobs: readonly CareJob[],
  positionOf: (job: CareJob) => number,
  minGap: number | ((group: readonly CareJob[], next: CareJob) => number),
): CareTimelinePin[] {
  const placed = jobs
    .map((job) => ({ job, at: Math.min(100, Math.max(0, positionOf(job))) }))
    .sort(
      (left, right) =>
        left.at - right.at || left.job.knifeId.localeCompare(right.job.knifeId),
    )
  const groups: { first: number; last: number; jobs: CareJob[] }[] = []
  for (const { job, at } of placed) {
    const group = groups.at(-1)
    const gap =
      group && (typeof minGap === 'number' ? minGap : minGap(group.jobs, job))
    if (
      group &&
      gap !== undefined &&
      at - (group.first + group.last) / 2 < gap
    ) {
      group.jobs.push(job)
      group.last = at
    } else {
      groups.push({ first: at, last: at, jobs: [job] })
    }
  }
  return groups.map((group) => ({
    jobs: group.jobs,
    position: (group.first + group.last) / 2,
    level: group.jobs.reduce<CareStatusLevel>(
      (worst, job) =>
        PIN_SEVERITY[job.level] > PIN_SEVERITY[worst] ? job.level : worst,
      'ok',
    ),
  }))
}

/**
 * Overdue pins sit on one scale shared by every lane: the most overdue job
 * on the far left, just past due next to today.
 */
export function overduePinPosition(daysOverdue: number, maxDays: number) {
  if (maxDays <= 0) return 50
  return 8 + (1 - Math.min(daysOverdue, maxDays) / maxDays) * 84
}

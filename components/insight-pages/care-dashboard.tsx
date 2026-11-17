'use client'

import Link from 'next/link'
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useCare } from '@/components/providers/care-provider'
import { CareReschedulePopover } from '@/components/maintenance/care-reschedule-popover'
import { InsightPanel } from '@/components/insight-pages/detail-primitives'
import { careToneDotClass, careToneTextClass } from '@/components/care-badge'
import { careFilterHref } from '@/components/care-status-summary'
import { readJsonResponse } from '@/lib/api-response'
import {
  CARE_SESSION_KINDS,
  buildCareTimeline,
  careSessionKind,
  clusterTimelinePins,
  overduePinPosition,
  formatCareDate,
  listCareJobs,
  recentCareFeed,
  rhythmOutpacesInterval,
  summarizeCareTracks,
  type CareJob,
  type CareSession,
  type CareSessionKind,
  type CareTimelinePin,
  type CareTrackSummary,
} from '@/lib/care-insights'
import {
  maintenanceTypeLabel,
  maintenanceTypeName,
  type Knife,
  type MaintenanceEvent,
  type SharpeningDetails,
} from '@/lib/data'
import {
  MAINTENANCE_UPDATED_EVENT,
  type CareStatusLevel,
} from '@/lib/maintenance-due'
import {
  CARE_TRACK_NAMES,
  CARE_TRACK_VERBS,
  type CareTrack,
} from '@/lib/settings-shared'
import {
  getVaultClientState,
  subscribeVaultClientState,
} from '@/lib/vault-client-state'
import { cn } from '@/lib/utils'

/** Days shown to the right of "today" in the Coming up timeline. */
const HORIZON_DAYS = 30

const SESSION_KIND_NAMES: Record<CareSessionKind, string> = {
  sharpening: 'Sharpen / strop',
  cleaning: 'Clean',
  lubrication: 'Lube',
  service: 'Strip-down / parts',
  other: 'Other',
}

/** Rows shown before "Show all" on the care history chart. */
const HISTORY_ROWS = 10

const COUNT_WORDS: Record<CareStatusLevel, string> = {
  overdue: 'overdue',
  'due-soon': 'due soon',
  ok: 'up to date',
}

function plural(count: number, word: string, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`
}

function knifeLabel(knife: Knife | undefined) {
  if (!knife) return 'Removed knife'
  return knife.brand ? `${knife.brand} ${knife.name}` : knife.name
}

function knifeHref(knifeId: string) {
  return `/collection/${encodeURIComponent(knifeId)}`
}

function dueLabel(days: number) {
  if (days < 0) return `${-days}d overdue`
  if (days === 0) return 'today'
  return `in ${days}d`
}

/** Every maintenance entry in the vault, refreshed after edits and restores. */
export function useMaintenanceHistory() {
  const [events, setEvents] = useState<MaintenanceEvent[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    fetch('/api/maintenance/events', { cache: 'no-store' })
      .then(async (response) => {
        const data = await readJsonResponse<{ events?: MaintenanceEvent[] }>(
          response,
        )
        if (!cancelled && response.ok && Array.isArray(data.events))
          setEvents(data.events)
      })
      .catch(() => {
        // Keep the last history until a later refresh succeeds.
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  useEffect(() => {
    const refresh = () => setRefreshKey((key) => key + 1)
    window.addEventListener(MAINTENANCE_UPDATED_EVENT, refresh)
    let lastGeneration = getVaultClientState().generation
    const unsubscribe = subscribeVaultClientState(() => {
      const generation = getVaultClientState().generation
      if (generation !== lastGeneration) {
        lastGeneration = generation
        refresh()
      }
    })
    return () => {
      window.removeEventListener(MAINTENANCE_UPDATED_EVENT, refresh)
      unsubscribe()
    }
  }, [])

  return { events, isLoading }
}

function KnifeLink({
  knifeId,
  knivesById,
}: {
  knifeId: string
  knivesById: ReadonlyMap<string, Knife>
}) {
  return (
    <Link href={knifeHref(knifeId)}>{knifeLabel(knivesById.get(knifeId))}</Link>
  )
}

export function CareKpis({
  counts,
  tracked,
  jobs,
  events,
  dueSoonDays,
  knivesById,
  knifeLevelById,
  now,
}: {
  counts: Record<CareStatusLevel, number>
  tracked: number
  jobs: CareJob[]
  events: MaintenanceEvent[]
  dueSoonDays: number
  knivesById: ReadonlyMap<string, Knife>
  knifeLevelById: ReadonlyMap<string, CareStatusLevel | null>
  now: Date
}) {
  const overdueJobs = jobs.filter((job) => job.level === 'overdue').length
  const dueSoonJobs = jobs.filter((job) => job.level === 'due-soon')
  // A knife counts once, under its worst kind of care, so a due-soon job on
  // an already overdue knife is listed under Overdue; say so instead of
  // showing "0 due soon · 1 job within 14 days".
  const dueSoonElsewhere = dueSoonJobs.filter(
    (job) => knifeLevelById.get(job.knifeId) === 'overdue',
  ).length
  const upcoming = jobs.filter((job) => job.dueInDays >= 0)
  const next = upcoming[0]
  const sameDay = next
    ? upcoming.filter((job) => job.dueOn === next.dueOn).length
    : 0
  const month = now.toLocaleDateString(undefined, { month: 'short' })
  const thisMonth = events.filter((event) => {
    const date = new Date(event.occurredAt)
    return (
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth()
    )
  }).length
  const first = events.at(-1)

  return (
    <dl className="id-care-kpis" aria-label="Care at a glance">
      <div className="id-care-kpi">
        <dt>
          <span
            className={cn('size-2 rounded-full', careToneDotClass('overdue'))}
          />
          Overdue
        </dt>
        <dd>
          <strong
            className={
              counts.overdue ? careToneTextClass('overdue') : undefined
            }
          >
            {counts.overdue}
          </strong>
          <small>
            {counts.overdue === 1 ? 'knife' : 'knives'} ·{' '}
            {plural(overdueJobs, 'job')} past interval
          </small>
        </dd>
      </div>
      <div className="id-care-kpi">
        <dt>
          <span
            className={cn('size-2 rounded-full', careToneDotClass('due-soon'))}
          />
          Due soon
        </dt>
        <dd>
          <strong>{counts['due-soon']}</strong>
          <small
            title={
              dueSoonElsewhere > 0
                ? `${plural(dueSoonElsewhere, 'more job')} due within ${dueSoonDays} days on knives already counted as overdue`
                : undefined
            }
          >
            {dueSoonElsewhere > 0
              ? `+${plural(dueSoonElsewhere, 'job')} on overdue knives`
              : `${counts['due-soon'] === 1 ? 'knife' : 'knives'} within ${dueSoonDays} days`}
          </small>
        </dd>
      </div>
      <div className="id-care-kpi">
        <dt>
          <span className={cn('size-2 rounded-full', careToneDotClass('ok'))} />
          Up to date
        </dt>
        <dd>
          <strong>{counts.ok}</strong>
          <small>
            of {plural(tracked, 'tracked knife', 'tracked knives')} · every kind
          </small>
        </dd>
      </div>
      <div className="id-care-kpi">
        <dt>Next due</dt>
        <dd>
          <strong data-date="">
            {next ? formatCareDate(next.dueOn, now) : '—'}
          </strong>
          <small>
            {next
              ? sameDay > 1
                ? `${CARE_TRACK_VERBS[next.track]} and ${sameDay - 1} more`
                : `${CARE_TRACK_VERBS[next.track]} ${knifeLabel(knivesById.get(next.knifeId))}`
              : 'Nothing scheduled'}
          </small>
        </dd>
      </div>
      <div className="id-care-kpi">
        <dt>Logged in {month}</dt>
        <dd>
          <strong>{thisMonth}</strong>
          <small>
            {first
              ? `${plural(events.length, 'entry', 'entries')} since ${formatCareDate(first.occurredAt, now)}`
              : 'No entries yet'}
          </small>
        </dd>
      </div>
    </dl>
  )
}

function CareKindCard({
  summary,
  knivesById,
  now,
}: {
  summary: CareTrackSummary
  knivesById: ReadonlyMap<string, Knife>
  now: Date
}) {
  const { track, counts, tracked } = summary
  const segments: CareStatusLevel[] = ['overdue', 'due-soon', 'ok']
  const verb = CARE_TRACK_VERBS[track].toLowerCase()
  return (
    <section
      className="id-panel id-care-kind"
      aria-label={CARE_TRACK_NAMES[track]}
    >
      <div className="id-panel-head">
        <div>
          <span
            className="id-care-swatch"
            data-kind={track}
            aria-hidden="true"
          />
          <h2>{CARE_TRACK_NAMES[track]}</h2>
          <span className="id-care-interval">
            {summary.intervalDays === null
              ? 'Off by default'
              : `every ${summary.intervalDays} days`}
          </span>
        </div>
      </div>
      <div className="id-panel-body">
        <span
          aria-hidden="true"
          className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-muted"
        >
          {tracked > 0 &&
            segments.map((level) =>
              counts[level] ? (
                <span
                  key={level}
                  className={cn('h-full', careToneDotClass(level))}
                  style={{ width: `${(counts[level] / tracked) * 100}%` }}
                />
              ) : null,
            )}
        </span>
        <p className="id-care-counts">
          {segments.map((level) =>
            counts[level] ? (
              <Link key={level} href={careFilterHref(level, track)}>
                <b>{counts[level]}</b> {COUNT_WORDS[level]}
              </Link>
            ) : (
              <span key={level}>
                <b>0</b> {COUNT_WORDS[level]}
              </span>
            ),
          )}
        </p>
        <dl className="id-care-facts">
          <dt>Most overdue</dt>
          <dd>
            {summary.mostOverdue ? (
              <>
                <KnifeLink
                  knifeId={summary.mostOverdue.knifeId}
                  knivesById={knivesById}
                />{' '}
                ·{' '}
                <span className={careToneTextClass('overdue')}>
                  {-summary.mostOverdue.dueInDays}d
                </span>
              </>
            ) : (
              '—'
            )}
          </dd>
          <dt>Next due</dt>
          <dd>
            {summary.nextDue ? (
              <>
                {formatCareDate(summary.nextDue.dueOn, now)} ·{' '}
                {summary.nextDue.knifeIds.length > 1 ? (
                  plural(summary.nextDue.knifeIds.length, 'knife', 'knives')
                ) : (
                  <KnifeLink
                    knifeId={summary.nextDue.knifeIds[0]}
                    knivesById={knivesById}
                  />
                )}
              </>
            ) : (
              '—'
            )}
          </dd>
          <dt>Last done</dt>
          <dd>
            {summary.lastDone ? (
              <>
                {formatCareDate(summary.lastDone.at, now)} ·{' '}
                <KnifeLink
                  knifeId={summary.lastDone.knifeId}
                  knivesById={knivesById}
                />
              </>
            ) : (
              'Not logged yet'
            )}
          </dd>
          <dt>Your rhythm</dt>
          <dd>
            {summary.rhythmDays !== null
              ? `about every ${plural(summary.rhythmDays, 'day')}`
              : 'Needs two entries on a knife'}
          </dd>
        </dl>
        {rhythmOutpacesInterval(summary) && (
          <p className="id-care-hint">
            You usually {verb} about every {summary.rhythmDays} days, but the
            reminder is every {summary.intervalDays}.{' '}
            <Link href="/settings?tab=maintenance">Change interval</Link>
          </p>
        )}
      </div>
    </section>
  )
}

export function CareKindCards({
  summaries,
  knivesById,
  now,
}: {
  summaries: CareTrackSummary[]
  knivesById: ReadonlyMap<string, Knife>
  now: Date
}) {
  return (
    <div className="id-care-kinds">
      {summaries.map((summary) => (
        <CareKindCard
          key={summary.track}
          summary={summary}
          knivesById={knivesById}
          now={now}
        />
      ))}
    </div>
  )
}

function shortKnifeName(knife: Knife | undefined) {
  return knife?.name || 'Removed knife'
}

/** Pin anchor: near an edge it grows inward so it stays inside its region. */
function pinAlign(position: number) {
  if (position < 12) return 'start'
  if (position > 88) return 'end'
  return undefined
}

function CarePin({
  pin,
  track,
  label,
  knivesById,
  overdueCount,
  now,
  onSelect,
  onHover,
  onHoverEnd,
  row = 0,
}: {
  pin: CareTimelinePin
  track: CareTrack
  label: string
  knivesById: ReadonlyMap<string, Knife>
  /** Overdue jobs of this kind in total, for the "open all" link. */
  overdueCount: number
  now: Date
  /** Opens the reschedule box for one job. */
  onSelect: (job: CareJob, anchor: HTMLElement) => void
  /** Hovering a single-job pin previews the same card. */
  onHover: (job: CareJob, anchor: HTMLElement) => void
  onHoverEnd: () => void
  /** Sub-row inside the lane when pins would otherwise overlap. */
  row?: number
}) {
  const id = useId()
  const popoverRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const describe = (job: CareJob) =>
    `${knifeLabel(knivesById.get(job.knifeId))} (${dueLabel(job.dueInDays)})`
  const style: React.CSSProperties = {
    left: `${pin.position}%`,
    ...(row > 0 ? { top: `${3 + row * 24}px` } : {}),
  }
  const align = pinAlign(pin.position)

  if (pin.jobs.length === 1) {
    const description = describe(pin.jobs[0])
    return (
      <button
        type="button"
        className="id-care-pin"
        data-kind={track}
        data-level={pin.level}
        data-align={align}
        style={style}
        title={description}
        aria-haspopup="dialog"
        aria-label={`${CARE_TRACK_NAMES[track]}: ${description}`}
        onClick={(event) => onSelect(pin.jobs[0], event.currentTarget)}
        onMouseEnter={(event) => onHover(pin.jobs[0], event.currentTarget)}
        onMouseLeave={onHoverEnd}
      >
        {label}
      </button>
    )
  }

  // Place the list under the pin when it opens; it lives in the top layer,
  // so the timeline's clipping doesn't cut it off.
  const place = (event: React.ToggleEvent<HTMLDivElement>) => {
    const popover = popoverRef.current
    if (event.newState !== 'open') {
      popover?.removeAttribute('data-placed')
      return
    }
    const button = buttonRef.current
    if (!popover || !button) return
    const anchor = button.getBoundingClientRect()
    const width = popover.offsetWidth
    const height = popover.offsetHeight
    const left = Math.min(
      Math.max(8, anchor.left + anchor.width / 2 - width / 2),
      window.innerWidth - width - 8,
    )
    const below = anchor.bottom + 6
    const top =
      below + height > window.innerHeight - 8
        ? Math.max(8, anchor.top - height - 6)
        : below
    popover.style.left = `${left}px`
    popover.style.top = `${top}px`
    popover.setAttribute('data-placed', '')
  }
  const sorted = [...pin.jobs].sort(
    (left, right) =>
      left.dueInDays - right.dueInDays ||
      knifeLabel(knivesById.get(left.knifeId)).localeCompare(
        knifeLabel(knivesById.get(right.knifeId)),
      ),
  )
  const isOverdue = pin.jobs.every((job) => job.dueInDays < 0)

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="id-care-pin"
        data-kind={track}
        data-level={pin.level}
        data-align={align}
        style={style}
        popoverTarget={id}
        aria-label={`${CARE_TRACK_NAMES[track]}: ${pin.jobs.map(describe).join(', ')}`}
      >
        {label}
      </button>
      <div
        ref={popoverRef}
        id={id}
        popover="auto"
        className="id-care-pin-list"
        onToggle={place}
      >
        <p>
          {CARE_TRACK_NAMES[track]} ·{' '}
          {plural(pin.jobs.length, 'knife', 'knives')}
        </p>
        <ul>
          {sorted.map((job) => (
            <li key={job.knifeId}>
              <button
                type="button"
                onClick={() => {
                  popoverRef.current?.hidePopover()
                  if (buttonRef.current) onSelect(job, buttonRef.current)
                }}
              >
                <span>{knifeLabel(knivesById.get(job.knifeId))}</span>
                <span className={careToneTextClass(job.level)}>
                  {job.dueInDays < 0
                    ? dueLabel(job.dueInDays)
                    : formatCareDate(job.dueOn, now)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {isOverdue && overdueCount > pin.jobs.length && (
          <Link
            className="id-care-pin-all"
            href={careFilterHref('overdue', track)}
          >
            All {overdueCount} overdue in collection
          </Link>
        )}
      </div>
    </>
  )
}

function overduePinLabel(
  jobs: readonly CareJob[],
  position: number,
  knivesById: ReadonlyMap<string, Knife>,
) {
  const days = jobs.map((job) => -job.dueInDays)
  const most = Math.max(...days)
  const least = Math.min(...days)
  if (jobs.length === 1)
    return `${shortKnifeName(knivesById.get(jobs[0].knifeId))} ${most}d`
  // Right next to today there is little room: the count alone.
  if (position > 75) return String(jobs.length)
  return `${jobs.length} knives ${most === least ? most : `${least}–${most}`}d`
}

function upcomingPinLabel(
  jobs: readonly CareJob[],
  knivesById: ReadonlyMap<string, Knife>,
  now: Date,
) {
  const first = formatCareDate(jobs[0].dueOn, now)
  const last = formatCareDate(jobs[jobs.length - 1].dueOn, now)
  const days = first === last ? first : `${first}–${last}`
  return `${days} · ${
    jobs.length === 1
      ? shortKnifeName(knivesById.get(jobs[0].knifeId))
      : `${jobs.length} knives`
  }`
}

/** Rough pin width in px for a label at the pin's 10.5px semibold text. */
function estimatePinWidth(label: string) {
  return label.length * 6.2 + 16
}

/** Width of an element, kept current as the layout changes. */
function useElementWidth<T extends HTMLElement>(fallback: number) {
  const [element, setElement] = useState<T | null>(null)
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    if (!element) return
    const update = () => setWidth(element.clientWidth || fallback)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element, fallback])
  return [setElement, width] as const
}

/** Gives each pin a row so that no two labels in the same row overlap. */
function stackPins(
  pins: readonly CareTimelinePin[],
  labelOf: (pin: CareTimelinePin) => string,
  regionWidth: number,
) {
  const ends: number[] = []
  const stacked = pins.map((pin) => {
    const width =
      (estimatePinWidth(labelOf(pin)) / Math.max(regionWidth, 1)) * 100
    const align = pinAlign(pin.position)
    const start =
      align === 'start'
        ? pin.position
        : align === 'end'
          ? pin.position - width
          : pin.position - width / 2
    let row = ends.findIndex((end) => end + 0.5 <= start)
    if (row === -1) row = ends.length
    ends[row] = start + width
    return { pin, row }
  })
  return { pins: stacked, rows: Math.max(1, ends.length) }
}

/** Pins keep their urgency color until the job is done. */
const LEGEND: readonly { level: string; label: string }[] = [
  { level: 'overdue', label: 'Overdue' },
  { level: 'due-soon', label: 'Due soon' },
  { level: 'ok', label: 'Later' },
]

export function CareComingUp({
  jobs,
  tracks,
  knivesById,
  now,
}: {
  jobs: CareJob[]
  tracks: CareTrack[]
  knivesById: ReadonlyMap<string, Knife>
  now: Date
}) {
  const [selected, setSelected] = useState<{
    knifeId: string
    track: CareTrack
    anchor: HTMLElement
    /** Opened by a click or the keyboard rather than a hover preview. */
    pinned: boolean
  } | null>(null)
  // Resolve from the live jobs so the card follows a reschedule.
  const selectedJob = selected
    ? (jobs.find(
        (job) =>
          job.knifeId === selected.knifeId && job.track === selected.track,
      ) ?? null)
    : null
  const closeTimer = useRef<number | undefined>(undefined)
  const cancelClose = () => window.clearTimeout(closeTimer.current)
  const select = (job: CareJob, anchor: HTMLElement) => {
    cancelClose()
    setSelected({
      knifeId: job.knifeId,
      track: job.track,
      anchor,
      pinned: true,
    })
  }
  // A hover preview never replaces a card the user opened on purpose.
  const preview = (job: CareJob, anchor: HTMLElement) => {
    cancelClose()
    setSelected((current) =>
      current?.pinned
        ? current
        : { knifeId: job.knifeId, track: job.track, anchor, pinned: false },
    )
  }
  // The preview stays while the pointer moves from the pin onto the card.
  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = window.setTimeout(
      () => setSelected((current) => (current?.pinned ? current : null)),
      180,
    )
  }
  const close = useCallback(() => {
    window.clearTimeout(closeTimer.current)
    setSelected(null)
  }, [])
  useEffect(() => () => window.clearTimeout(closeTimer.current), [])
  const [overRef, overWidth] = useElementWidth<HTMLDivElement>(400)
  const [futureRef, futureWidth] = useElementWidth<HTMLDivElement>(1100)
  const middle = new Date(now)
  middle.setDate(middle.getDate() + HORIZON_DAYS / 2)
  const end = new Date(now)
  end.setDate(end.getDate() + HORIZON_DAYS)
  const maxOverdue = Math.max(
    0,
    ...jobs.filter((job) => job.dueInDays < 0).map((job) => -job.dueInDays),
  )
  const overdueAt = (job: CareJob) =>
    overduePinPosition(-job.dueInDays, maxOverdue)
  const upcomingAt = (job: CareJob) => (job.dueInDays / HORIZON_DAYS) * 100
  const lanes = tracks.map((track) => {
    const own = jobs.filter((job) => job.track === track)
    return {
      track,
      overdueCount: own.filter((job) => job.dueInDays < 0).length,
      overdue: stackPins(
        clusterTimelinePins(
          own.filter((job) => job.dueInDays < 0),
          overdueAt,
          0,
        ),
        (pin) => overduePinLabel(pin.jobs, pin.position, knivesById),
        overWidth,
      ),
      // Every upcoming job keeps its own pin so each knife is named;
      // pins that would collide go on their own row instead of merging.
      upcoming: stackPins(
        clusterTimelinePins(
          own.filter(
            (job) => job.dueInDays >= 0 && job.dueInDays <= HORIZON_DAYS,
          ),
          upcomingAt,
          0,
        ),
        (pin) => upcomingPinLabel(pin.jobs, knivesById, now),
        futureWidth,
      ),
    }
  })
  const isEmpty = lanes.every(
    (lane) => lane.overdue.pins.length === 0 && lane.upcoming.pins.length === 0,
  )

  return (
    <InsightPanel
      title="Coming up"
      description={`Overdue jobs on the left, the next ${HORIZON_DAYS} days on the right. Select a pin to reschedule it or open the knife.`}
      aside={
        <ul className="id-care-legend" aria-label="Pin colours">
          {LEGEND.map(({ level, label }) => (
            <li key={level} data-level={level}>
              {label}
            </li>
          ))}
        </ul>
      }
    >
      <div className="id-care-timeline">
        <div className="id-care-tl-axis" aria-hidden="true">
          <span>Overdue</span>
          <span className="id-care-tl-dates">
            <b>Today</b>
            <span>{formatCareDate(middle.toISOString(), now)}</span>
            <span>{formatCareDate(end.toISOString(), now)}</span>
          </span>
        </div>
        {lanes.map(({ track, overdue, upcoming, overdueCount }, index) => (
          <section
            key={track}
            className="id-care-tl-lane"
            aria-label={CARE_TRACK_NAMES[track]}
            style={
              {
                '--id-rows': Math.max(overdue.rows, upcoming.rows),
              } as React.CSSProperties
            }
          >
            <h3>
              <span
                className="id-care-swatch"
                data-kind={track}
                aria-hidden="true"
              />
              {CARE_TRACK_NAMES[track]}
            </h3>
            <div
              className="id-care-tl-over"
              ref={index === 0 ? overRef : undefined}
            >
              {overdue.pins.map(({ pin, row }) => (
                <CarePin
                  key={pin.jobs[0].knifeId}
                  pin={pin}
                  row={row}
                  track={track}
                  label={overduePinLabel(pin.jobs, pin.position, knivesById)}
                  knivesById={knivesById}
                  overdueCount={overdueCount}
                  now={now}
                  onSelect={select}
                  onHover={preview}
                  onHoverEnd={scheduleClose}
                />
              ))}
            </div>
            <div
              className="id-care-tl-future"
              ref={index === 0 ? futureRef : undefined}
            >
              {upcoming.pins.map(({ pin, row }) => (
                <CarePin
                  key={pin.jobs[0].knifeId}
                  pin={pin}
                  row={row}
                  track={track}
                  label={upcomingPinLabel(pin.jobs, knivesById, now)}
                  knivesById={knivesById}
                  overdueCount={overdueCount}
                  now={now}
                  onSelect={select}
                  onHover={preview}
                  onHoverEnd={scheduleClose}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
      <CareReschedulePopover
        job={selectedJob}
        anchor={selected?.anchor ?? null}
        pinned={selected?.pinned ?? false}
        knifeName={knifeLabel(
          selectedJob ? knivesById.get(selectedJob.knifeId) : undefined,
        )}
        now={now}
        onClose={close}
        onHoverStart={cancelClose}
        onHoverEnd={scheduleClose}
      />
      {isEmpty && (
        <p className="id-care-tl-empty">
          Nothing is overdue or comes due in the next {HORIZON_DAYS} days.
        </p>
      )}
    </InsightPanel>
  )
}

const SHARPENING_FIELDS: [keyof SharpeningDetails, string][] = [
  ['system', 'System'],
  ['grit', 'Grit'],
  ['angle', 'Angle'],
  ['passes', 'Passes'],
  ['ceramic', 'Ceramic'],
  ['strop', 'Strop'],
  ['compound', 'Compound'],
]

/** Clock time of an entry, or null when it was logged for the whole day. */
function entryTime(occurredAt: string) {
  const date = new Date(occurredAt)
  if (!Number.isFinite(date.getTime())) return null
  if (date.getHours() === 0 && date.getMinutes() === 0) return null
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
}

function sessionSummary(session: CareSession, knife: Knife | undefined) {
  const date = new Date(`${session.day}T00:00:00`).toLocaleDateString(
    undefined,
    { month: 'long', day: 'numeric' },
  )
  return `${feedTitle(session.types)} ${knifeLabel(knife)}, ${date}`
}

function CareSessionCard({
  session,
  knife,
  id,
  style,
}: {
  session: CareSession
  knife: Knife | undefined
  id: string
  style: React.CSSProperties
}) {
  const date = new Date(`${session.day}T00:00:00`).toLocaleDateString(
    undefined,
    { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' },
  )
  return (
    <div id={id} role="tooltip" className="id-care-log-card" style={style}>
      <header>
        <b>{knifeLabel(knife)}</b>
        <time dateTime={session.day}>{date}</time>
      </header>
      <ol>
        {session.entries.map((entry) => {
          const time = entryTime(entry.occurredAt)
          const details = SHARPENING_FIELDS.flatMap(([field, label]) => {
            const raw = entry.sharpeningDetails?.[field]
            const value = typeof raw === 'string' ? raw.trim() : raw
            if (value === undefined || value === null || value === '') return []
            const shown =
              field === 'angle' ? `${String(value).replace(/°$/, '')}°` : value
            return [{ label, value: String(shown) }]
          })
          const extra = entry.sharpeningDetails?.notes?.trim()
          const note = entry.notes.trim()
          return (
            <li key={entry.id}>
              <span
                className="id-care-swatch"
                data-kind={careSessionKind(entry.type)}
                aria-hidden="true"
              />
              <div>
                <p>
                  <b>{maintenanceTypeName(entry.type)}</b>
                  {time && <small>{time}</small>}
                </p>
                {details.length > 0 && (
                  <dl>
                    {details.map((detail) => (
                      <div key={detail.label}>
                        <dt>{detail.label}</dt>
                        <dd>{detail.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {extra && <q>{extra}</q>}
                {note && <q>{note}</q>}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

export function CareHistoryChart({
  events,
  knivesById,
  knifeLevelById,
  now,
  isLoading,
}: {
  events: MaintenanceEvent[]
  knivesById: ReadonlyMap<string, Knife>
  knifeLevelById: ReadonlyMap<string, CareStatusLevel | null>
  now: Date
  isLoading: boolean
}) {
  const [showAll, setShowAll] = useState(false)
  const [active, setActive] = useState<{
    key: string
    style: React.CSSProperties
  } | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const cardId = useId()
  const timeline = useMemo(() => buildCareTimeline(events, now), [events, now])
  let activeSession: { session: CareSession; knife: Knife | undefined } | null =
    null
  if (active)
    for (const row of timeline.rows)
      for (const session of row.sessions)
        if (`${row.knifeId}|${session.day}` === active.key)
          activeSession = { session, knife: knivesById.get(row.knifeId) }
  const open = (key: string, target: HTMLElement) => {
    const box = logRef.current?.getBoundingClientRect()
    if (!box) return
    const mark = target.getBoundingClientRect()
    const width = Math.min(280, box.width)
    const center = mark.left + mark.width / 2 - box.left
    const left = Math.min(Math.max(center - width / 2, 0), box.width - width)
    const top = mark.top - box.top
    // Open below marks in the upper half and above the rest, so the card
    // stays inside the panel.
    const style: React.CSSProperties =
      top < box.height / 2
        ? { left, width, top: top + mark.height + 8 }
        : { left, width, bottom: box.height - top + 8 }
    setActive({ key, style })
  }
  const close = (key?: string) =>
    setActive((current) => (!key || current?.key === key ? null : current))
  const rows = showAll ? timeline.rows : timeline.rows.slice(0, HISTORY_ROWS)
  const hidden = timeline.rows.length - rows.length
  const monthName = (day: string) =>
    new Date(
      Number(day.slice(0, 4)),
      Number(day.slice(5, 7)) - 1,
      1,
    ).toLocaleDateString(undefined, { month: 'short' })
  const percent = (position: number) => `${(position * 100).toFixed(2)}%`
  const kinds = CARE_SESSION_KINDS.filter((kind) => timeline.kindCounts[kind])
  const since = timeline.months[0] ? monthName(timeline.months[0].day) : null
  const grid = (
    <>
      {timeline.months.map((month) => (
        <i
          key={month.day}
          className="id-care-log-grid"
          style={{ left: percent(month.position) }}
        />
      ))}
      <i
        className="id-care-log-today"
        style={{ left: percent(timeline.todayPosition) }}
      />
    </>
  )

  return (
    <InsightPanel
      title="Care history"
      description={
        since
          ? `Every session, knife by knife, since ${since}`
          : 'Every session, knife by knife'
      }
      aside={
        timeline.rows.length > 0 ? (
          <dl className="id-care-log-stats">
            <div>
              <dt>Sessions</dt>
              <dd>{timeline.sessionCount}</dd>
            </div>
            <div>
              <dt>Knives</dt>
              <dd>
                {timeline.rows.length}
                <small> / {knivesById.size}</small>
              </dd>
            </div>
            <div>
              <dt>Care days</dt>
              <dd>{timeline.careDays}</dd>
            </div>
          </dl>
        ) : undefined
      }
      footer={
        timeline.rows.length > HISTORY_ROWS ? (
          <>
            <span>
              {showAll
                ? `All ${plural(timeline.rows.length, 'knife', 'knives')}`
                : `${plural(hidden, 'more knife', 'more knives')} with older care`}
            </span>
            <button type="button" onClick={() => setShowAll((value) => !value)}>
              {showAll ? 'Show fewer' : 'Show all'}
            </button>
          </>
        ) : undefined
      }
    >
      {isLoading ? (
        <p className="id-care-empty">Loading history…</p>
      ) : timeline.rows.length === 0 ? (
        <p className="id-care-empty">
          No care logged in the last six months. Log sharpening, cleaning or
          oiling from a knife’s page.
        </p>
      ) : (
        <div className="id-care-log" ref={logRef}>
          <ol>
            {rows.map((row) => {
              const knife = knivesById.get(row.knifeId)
              const level = knifeLevelById.get(row.knifeId) ?? null
              const last = formatCareDate(row.lastDay, now)
              return (
                <li key={row.knifeId}>
                  <Link
                    href={knifeHref(row.knifeId)}
                    className="id-care-log-name"
                  >
                    <b>{shortKnifeName(knife)}</b>
                    <small>
                      {[knife?.brand, plural(row.sessions.length, 'session')]
                        .filter(Boolean)
                        .join(' · ')}
                    </small>
                    <span className="sr-only">
                      , last care {last}
                      {level === 'overdue' || level === 'due-soon'
                        ? `, ${COUNT_WORDS[level]}`
                        : ''}
                    </span>
                  </Link>
                  <div className="id-care-log-lane">
                    {grid}
                    {row.sessions.map((session) => {
                      const key = `${row.knifeId}|${session.day}`
                      const isActive = active?.key === key
                      return (
                        <Fragment key={session.day}>
                          {(session.notes.length > 0 ||
                            session.details.length > 0) && (
                            <i
                              className="id-care-log-mark"
                              style={{ left: percent(session.position) }}
                            />
                          )}
                          <button
                            type="button"
                            className="id-care-log-session"
                            style={{ left: percent(session.position) }}
                            aria-label={sessionSummary(session, knife)}
                            aria-describedby={isActive ? cardId : undefined}
                            aria-expanded={isActive}
                            data-active={isActive ? '' : undefined}
                            onMouseEnter={(event) =>
                              open(key, event.currentTarget)
                            }
                            onMouseLeave={() => close(key)}
                            onFocus={(event) => open(key, event.currentTarget)}
                            onBlur={() => close(key)}
                            onClick={(event) =>
                              isActive
                                ? close(key)
                                : open(key, event.currentTarget)
                            }
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') close(key)
                            }}
                          >
                            {session.kinds.map((kind) => (
                              <i key={kind} data-kind={kind} />
                            ))}
                          </button>
                        </Fragment>
                      )
                    })}
                  </div>
                  <span
                    className="id-care-log-last"
                    title={`Last care ${last}`}
                    aria-hidden="true"
                  >
                    {(level === 'overdue' || level === 'due-soon') && (
                      <i className={careToneDotClass(level)} />
                    )}
                    {row.daysSince === 0 ? 'today' : `${row.daysSince}d ago`}
                  </span>
                </li>
              )
            })}
          </ol>
          <div className="id-care-log-axis" aria-hidden="true">
            <span />
            <div>
              {timeline.months.map((month, index) => {
                const next =
                  timeline.months[index + 1]?.position ?? timeline.todayPosition
                return (
                  <span
                    key={month.day}
                    style={{ left: percent((month.position + next) / 2) }}
                  >
                    {monthName(month.day)}
                  </span>
                )
              })}
            </div>
            <span>Last care</span>
          </div>
          <ul className="id-care-keys">
            {kinds.map((kind) => (
              <li key={kind}>
                <span
                  className="id-care-swatch"
                  data-kind={kind}
                  aria-hidden="true"
                />
                {SESSION_KIND_NAMES[kind]}
              </li>
            ))}
            <li>
              <span className="id-care-log-note" aria-hidden="true" />
              Note or angle
            </li>
          </ul>
          {active && activeSession && (
            <CareSessionCard
              id={cardId}
              session={activeSession.session}
              knife={activeSession.knife}
              style={active.style}
            />
          )}
        </div>
      )}
    </InsightPanel>
  )
}

function feedTitle(types: MaintenanceEvent['type'][]) {
  return types
    .map((type, index) => {
      const label = maintenanceTypeLabel(type)
      return index === 0 ? label : label.toLowerCase()
    })
    .join(' + ')
}

export function CareRecentFeed({
  events,
  knivesById,
  now,
  isLoading,
}: {
  events: MaintenanceEvent[]
  knivesById: ReadonlyMap<string, Knife>
  now: Date
  isLoading: boolean
}) {
  const items = useMemo(() => recentCareFeed(events, 8), [events])
  return (
    <InsightPanel
      title="Recent care"
      description="Latest entries across the collection"
      footer={<Link href="/maintenance/log">View all care logs →</Link>}
    >
      {isLoading ? (
        <p className="id-care-empty">Loading history…</p>
      ) : items.length ? (
        <ul className="id-care-feed">
          {items.map((item) => {
            const details = [
              item.angle ? `${item.angle.replace(/°$/, '')}°` : null,
              item.grit ? `${item.grit} grit` : null,
              ...item.notes.map((note) => `“${note}”`),
            ].filter(Boolean)
            const kind =
              item.types.find((type) =>
                ['sharpening', 'stropping', 'cleaning', 'lubrication'].includes(
                  type,
                ),
              ) ?? 'other'
            return (
              <li key={`${item.knifeId}-${item.day}`}>
                <Link href={knifeHref(item.knifeId)}>
                  <time dateTime={item.day}>
                    {formatCareDate(item.day, now)}
                  </time>
                  <span
                    className="id-care-swatch"
                    data-kind={kind === 'stropping' ? 'sharpening' : kind}
                    aria-hidden="true"
                  />
                  <span>
                    <b>{feedTitle(item.types)}</b>{' '}
                    {knifeLabel(knivesById.get(item.knifeId))}
                    {details.length > 0 && <small>{details.join(' · ')}</small>}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="id-care-empty">
          No care logged yet. Log sharpening, cleaning or oiling from a knife’s
          page.
        </p>
      )}
    </InsightPanel>
  )
}

/** Everything the dashboard sections need, derived once. */
export function useCareDashboard(knives: Knife[]) {
  const { reminders, statusById, now } = useCare()
  const history = useMaintenanceHistory()
  const knivesById = useMemo(
    () => new Map(knives.map((knife) => [knife.id, knife])),
    [knives],
  )
  const jobs = useMemo(() => listCareJobs(statusById, now), [statusById, now])
  const summaries = useMemo(
    () => summarizeCareTracks(statusById, history.events, reminders, now),
    [statusById, history.events, reminders, now],
  )
  return { ...history, knivesById, jobs, summaries, now, reminders }
}

'use client'

import Link from 'next/link'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useCare } from '@/components/providers/care-provider'
import { InsightPanel } from '@/components/insight-pages/detail-primitives'
import { careToneDotClass, careToneTextClass } from '@/components/care-badge'
import { careFilterHref } from '@/components/care-status-summary'
import { readJsonResponse } from '@/lib/api-response'
import {
  CARE_MONTH_GROUPS,
  clusterTimelinePins,
  countCareByMonth,
  overduePinPosition,
  formatCareDate,
  listCareJobs,
  recentCareFeed,
  rhythmOutpacesInterval,
  summarizeCareTracks,
  type CareJob,
  type CareMonthGroup,
  type CareTimelinePin,
  type CareTrackSummary,
} from '@/lib/care-insights'
import {
  maintenanceTypeLabel,
  type Knife,
  type MaintenanceEvent,
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

const GROUP_NAMES: Record<CareMonthGroup, string> = {
  sharpening: 'Sharpen + strop',
  cleaning: 'Clean',
  lubrication: 'Lube',
  other: 'Other',
}

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
            <Link href="/settings">Change interval</Link>
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
}: {
  pin: CareTimelinePin
  track: CareTrack
  label: string
  knivesById: ReadonlyMap<string, Knife>
  /** Overdue jobs of this kind in total, for the "open all" link. */
  overdueCount: number
  now: Date
}) {
  const id = useId()
  const popoverRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const describe = (job: CareJob) =>
    `${knifeLabel(knivesById.get(job.knifeId))} (${dueLabel(job.dueInDays)})`
  const style = { left: `${pin.position}%` }
  const align = pinAlign(pin.position)

  if (pin.jobs.length === 1) {
    const description = describe(pin.jobs[0])
    return (
      <Link
        className="id-care-pin"
        data-level={pin.level}
        data-align={align}
        style={style}
        href={knifeHref(pin.jobs[0].knifeId)}
        title={description}
        aria-label={`${CARE_TRACK_NAMES[track]}: ${description}`}
      >
        {label}
      </Link>
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
              <Link href={knifeHref(job.knifeId)}>
                <span>{knifeLabel(knivesById.get(job.knifeId))}</span>
                <span className={careToneTextClass(job.level)}>
                  {job.dueInDays < 0
                    ? dueLabel(job.dueInDays)
                    : formatCareDate(job.dueOn, now)}
                </span>
              </Link>
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

/** Percent gap two pins need so that their labels don't touch. */
function pinGap(left: string, right: string, regionWidth: number) {
  const px = (estimatePinWidth(left) + estimatePinWidth(right)) / 2 + 6
  return (px / Math.max(regionWidth, 1)) * 100
}

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
      overdue: clusterTimelinePins(
        own.filter((job) => job.dueInDays < 0),
        overdueAt,
        (group, next) =>
          pinGap(
            overduePinLabel(group, overdueAt(group[0]), knivesById),
            overduePinLabel([next], overdueAt(next), knivesById),
            overWidth,
          ),
      ),
      upcoming: clusterTimelinePins(
        own.filter(
          (job) => job.dueInDays >= 0 && job.dueInDays <= HORIZON_DAYS,
        ),
        upcomingAt,
        (group, next) =>
          pinGap(
            upcomingPinLabel(group, knivesById, now),
            upcomingPinLabel([next], knivesById, now),
            futureWidth,
          ),
      ),
    }
  })
  const isEmpty = lanes.every(
    (lane) => lane.overdue.length === 0 && lane.upcoming.length === 0,
  )

  return (
    <InsightPanel
      title="Coming up"
      description={`Overdue jobs on the left, the next ${HORIZON_DAYS} days on the right. Select a pin to open the knife.`}
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
          >
            <h3>{CARE_TRACK_NAMES[track]}</h3>
            <div
              className="id-care-tl-over"
              ref={index === 0 ? overRef : undefined}
            >
              {overdue.map((pin) => (
                <CarePin
                  key={pin.jobs[0].knifeId}
                  pin={pin}
                  track={track}
                  label={overduePinLabel(pin.jobs, pin.position, knivesById)}
                  knivesById={knivesById}
                  overdueCount={overdueCount}
                  now={now}
                />
              ))}
            </div>
            <div
              className="id-care-tl-future"
              ref={index === 0 ? futureRef : undefined}
            >
              {upcoming.map((pin) => (
                <CarePin
                  key={pin.jobs[0].knifeId}
                  pin={pin}
                  track={track}
                  label={upcomingPinLabel(pin.jobs, knivesById, now)}
                  knivesById={knivesById}
                  overdueCount={overdueCount}
                  now={now}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
      {isEmpty && (
        <p className="id-care-tl-empty">
          Nothing is overdue or comes due in the next {HORIZON_DAYS} days.
        </p>
      )}
    </InsightPanel>
  )
}

export function CareMonthlyChart({
  events,
  now,
  isLoading,
}: {
  events: MaintenanceEvent[]
  now: Date
  isLoading: boolean
}) {
  const months = useMemo(() => countCareByMonth(events, now, 6), [events, now])
  const max = Math.max(1, ...months.map((month) => month.total))
  const totals = CARE_MONTH_GROUPS.map((group) => ({
    group,
    count: months.reduce((sum, month) => sum + month.counts[group], 0),
  }))
  const monthName = (value: string) =>
    new Date(
      Number(value.slice(0, 4)),
      Number(value.slice(5)) - 1,
      1,
    ).toLocaleDateString(undefined, { month: 'short' })
  const summary = months
    .map((month) => `${monthName(month.month)} ${month.total}`)
    .join(', ')

  return (
    <InsightPanel
      title="Care logged per month"
      description="Every maintenance entry over the last six months"
    >
      {isLoading ? (
        <p className="id-care-empty">Loading history…</p>
      ) : (
        <>
          <div
            className="id-care-chart"
            role="img"
            aria-label={`Entries per month: ${summary}`}
          >
            {months.map((month) => (
              <div key={month.month}>
                {CARE_MONTH_GROUPS.map((group) =>
                  month.counts[group] ? (
                    <i
                      key={group}
                      className="id-care-swatch"
                      data-kind={group}
                      style={{
                        height: `${(month.counts[group] / max) * 82}%`,
                        width: '100%',
                      }}
                    />
                  ) : null,
                )}
                <em>{month.total || ''}</em>
              </div>
            ))}
          </div>
          <div className="id-care-months" aria-hidden="true">
            {months.map((month) => (
              <span key={month.month}>{monthName(month.month)}</span>
            ))}
          </div>
          <ul className="id-care-keys">
            {totals.map(({ group, count }) => (
              <li key={group}>
                <span
                  className="id-care-swatch"
                  data-kind={group}
                  aria-hidden="true"
                />
                {GROUP_NAMES[group]} {count}
              </li>
            ))}
          </ul>
        </>
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

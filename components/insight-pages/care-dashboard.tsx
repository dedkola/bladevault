'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { useCare } from '@/components/providers/care-provider'
import { InsightPanel } from '@/components/insight-pages/detail-primitives'
import { careToneDotClass, careToneTextClass } from '@/components/care-badge'
import { careFilterHref } from '@/components/care-status-summary'
import { readJsonResponse } from '@/lib/api-response'
import {
  CARE_MONTH_GROUPS,
  countCareByMonth,
  formatCareDate,
  listCareJobs,
  recentCareFeed,
  rhythmOutpacesInterval,
  summarizeCareTracks,
  type CareJob,
  type CareMonthGroup,
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
  now,
}: {
  counts: Record<CareStatusLevel, number>
  tracked: number
  jobs: CareJob[]
  events: MaintenanceEvent[]
  dueSoonDays: number
  knivesById: ReadonlyMap<string, Knife>
  now: Date
}) {
  const overdueJobs = jobs.filter((job) => job.level === 'overdue').length
  const dueSoonJobs = jobs.filter((job) => job.level === 'due-soon').length
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
          <small>{plural(overdueJobs, 'job')} past their interval</small>
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
          <small>
            {plural(dueSoonJobs, 'job')} within {dueSoonDays} days
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
          <small>of {plural(tracked, 'tracked knife', 'tracked knives')}</small>
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
          <span>
            <b>{counts.overdue}</b> overdue
          </span>
          <span>
            <b>{counts['due-soon']}</b> due soon
          </span>
          <span>
            <b>{counts.ok}</b> up to date
          </span>
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
  const soon = jobs.filter(
    (job) => job.dueInDays >= 0 && job.dueInDays <= HORIZON_DAYS,
  )
  const middle = new Date(now)
  middle.setDate(middle.getDate() + HORIZON_DAYS / 2)
  const end = new Date(now)
  end.setDate(end.getDate() + HORIZON_DAYS)

  return (
    <InsightPanel
      title="Coming up"
      description={`Overdue jobs on the left, the next ${HORIZON_DAYS} days on the right`}
    >
      <div className="id-care-lanes" aria-hidden="true">
        <span className="id-care-axis" data-spacer="" />
        <span className="id-care-axis">Overdue</span>
        <span className="id-care-axis id-care-axis-dates">
          <b>Today</b>
          <span>{formatCareDate(middle.toISOString(), now)}</span>
          <span>{formatCareDate(end.toISOString(), now)}</span>
        </span>
        {tracks.map((track) => {
          const own = jobs.filter((job) => job.track === track)
          const overdue = own.filter((job) => job.dueInDays < 0)
          const byDay = new Map<string, CareJob[]>()
          for (const job of own) {
            if (job.dueInDays < 0 || job.dueInDays > HORIZON_DAYS) continue
            byDay.set(job.dueOn, [...(byDay.get(job.dueOn) ?? []), job])
          }
          return [
            <span key={`${track}-label`} className="id-care-lane-label">
              <span className="id-care-swatch" data-kind={track} />
              {CARE_TRACK_NAMES[track]}
            </span>,
            <span key={`${track}-over`} className="id-care-lane-over">
              {overdue.length > 0 && (
                <Link href={careFilterHref('overdue')} tabIndex={-1}>
                  {overdue.length} · up to {-overdue[0].dueInDays}d
                </Link>
              )}
            </span>,
            <span key={`${track}-future`} className="id-care-lane-future">
              {[...byDay.values()].map((day) => (
                <span
                  key={day[0].dueOn}
                  className={cn(
                    'id-care-marker',
                    careToneDotClass(day[0].level),
                  )}
                  style={{
                    left: `${Math.max(2, (day[0].dueInDays / HORIZON_DAYS) * 100)}%`,
                  }}
                  title={`${formatCareDate(day[0].dueOn, now)}: ${day
                    .map((job) => knifeLabel(knivesById.get(job.knifeId)))
                    .join(', ')}`}
                >
                  {day.length > 1 ? day.length : ''}
                </span>
              ))}
            </span>,
          ]
        })}
      </div>
      <div className="id-care-next">
        {soon.length ? (
          soon.slice(0, 6).map((job) => (
            <Link
              key={`${job.knifeId}-${job.track}`}
              href={knifeHref(job.knifeId)}
            >
              <time dateTime={job.dueOn}>{formatCareDate(job.dueOn, now)}</time>
              <span
                className="id-care-swatch"
                data-kind={job.track}
                aria-hidden="true"
              />
              <span className="min-w-0 truncate">
                {CARE_TRACK_VERBS[job.track]}{' '}
                {knifeLabel(knivesById.get(job.knifeId))}
              </span>
              <span className={careToneTextClass(job.level)}>
                {dueLabel(job.dueInDays)}
              </span>
            </Link>
          ))
        ) : (
          <p className="text-muted-foreground">
            Nothing comes due in the next {HORIZON_DAYS} days.
          </p>
        )}
        {soon.length > 6 && (
          <p className="text-muted-foreground">
            +{soon.length - 6} more in the next {HORIZON_DAYS} days
          </p>
        )}
      </div>
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

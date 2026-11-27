'use client'

import { useEffect, useRef, useState } from 'react'
import { AppWindow, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type {
  MonitoredSource,
  PriceOverview,
  SourceResult,
} from '@/lib/price-monitor/insights'
import { cn } from '@/lib/utils'
import { verdictTitle } from './attention-actions'
import { isSnoozed, needsAttention } from './price-table-model'
import {
  durationLabel,
  money,
  percentLabel,
  relativeTime,
  storeLabel,
} from './price-format'
import './price-drops.css'

/** Lane names and legend labels, in display order. */
export const RESULT_LABEL: Record<SourceResult, string> = {
  drop: '↓ Down',
  increase: '↑ Up',
  restocked: 'Restocked',
  out_of_stock: 'Out of stock',
  same: 'Unchanged',
  attention: 'Needs attention',
  pending: 'Pending',
}

/** "−0.3%", "+1.2%", "<0.1%": a small move under the Minimum change. */
export function driftLabel(pct: number) {
  const sign = pct < 0 ? '−' : '+'
  const abs = Math.abs(pct)
  return abs < 0.1 ? `${sign}<0.1%` : `${sign}${abs.toFixed(1)}%`
}

const PAST_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/**
 * Results that color the top of a past bar, top first. Everything else
 * (unchanged, out of stock) stays in the neutral "checked" part.
 */
const NOTABLE: SourceResult[] = ['drop', 'increase', 'restocked', 'attention']

/** "41 d", "today": how long ago an ISO time was, in whole days. */
export function daysAgo(iso: string, now: number) {
  const days = Math.floor((now - Date.parse(iso)) / (24 * HOUR_MS))
  return days < 1 ? 'today' : `${days} d`
}

/**
 * When a source is next checked (epoch ms). A never-checked source has no
 * scheduled time: it waits at the front of its store's queue, so it shows at
 * Now with the other due checks.
 */
function nextCheckTime(source: MonitoredSource, now: number): number | null {
  if (source.nextCheckAt) return Date.parse(source.nextCheckAt)
  return source.lastCheckedAt ? null : now
}

type Bucket = {
  /** Checked in that hour, scheduled for that hour, or due and waiting. */
  kind: 'past' | 'upcoming' | 'due'
  /** "5–4 h ago", "in 2–3 h". */
  when: string
  sources: MonitoredSource[]
}

function knivesLabel(count: number) {
  return `${count} ${count === 1 ? 'knife' : 'knives'}`
}

/** "down", "needs attention": a result as plain lowercase words. */
function resultWords(result: SourceResult) {
  return RESULT_LABEL[result].replace(/^[↓↑] /, '').toLowerCase()
}

/** "20 unchanged, 2 down, 1 restocked". */
function resultSummary(sources: MonitoredSource[]) {
  const counts = new Map<SourceResult, number>()
  for (const source of sources)
    counts.set(source.result, (counts.get(source.result) ?? 0) + 1)
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([result, count]) => `${count} ${resultWords(result)}`)
    .join(', ')
}

/**
 * Hourly buckets: the last 24 hours of checks, the next `horizonHours` of
 * scheduled checks, and the checks already due that wait at Now.
 */
function bucketsFor(
  sources: MonitoredSource[],
  now: number,
  horizonHours: number,
) {
  const past: Bucket[] = Array.from({ length: 24 }, (_, index) => {
    const from = 24 - index
    return {
      kind: 'past',
      when: from === 1 ? 'in the last hour' : `${from}–${from - 1} h ago`,
      sources: [],
    }
  })
  const upcoming: Bucket[] = Array.from(
    { length: horizonHours },
    (_, index) => ({
      kind: 'upcoming',
      when: index === 0 ? 'within the hour' : `in ${index}–${index + 1} h`,
      sources: [],
    }),
  )
  const due: Bucket = { kind: 'due', when: 'now', sources: [] }
  for (const source of sources) {
    if (source.lastCheckedAt) {
      const ago = Math.max(0, now - Date.parse(source.lastCheckedAt))
      if (ago <= PAST_MS)
        past[Math.min(23, Math.floor((PAST_MS - ago) / HOUR_MS))].sources.push(
          source,
        )
    }
    const next = nextCheckTime(source, now)
    if (next === null) continue
    if (next <= now) due.sources.push(source)
    else if (next - now < horizonHours * HOUR_MS)
      upcoming[Math.floor((next - now) / HOUR_MS)].sources.push(source)
  }
  return { past, upcoming, due }
}

/** Hours before now marked on the past zone, oldest first. */
const PAST_TICKS = [24, 18, 12, 6]

/** Up to four evenly spaced hour marks across the upcoming zone. */
function futureTicks(horizonHours: number) {
  return [
    ...new Set([1, 2, 3, 4].map((i) => Math.round((horizonHours * i) / 4))),
  ]
}

/** Faint hour lines behind the bars, matching the axis marks. */
function GridLines({ positions }: { positions: number[] }) {
  return (
    <>
      {positions.map((position) => (
        <span
          key={position}
          className="pd-tl-grid"
          style={{ left: `${position}%` }}
          aria-hidden="true"
        />
      ))}
    </>
  )
}

/**
 * One hour's checks. A past bar is neutral, with drops, rises, restocks and
 * problems stacked on top in their colors; an upcoming bar is an outline.
 */
function ActivityBar({
  bucket,
  index,
  count,
  peak,
  open,
  onOpen,
}: {
  bucket: Bucket
  index: number
  count: number
  peak: number
  open: boolean
  onOpen: (bucket: Bucket, anchor: DOMRect) => void
}) {
  const total = bucket.sources.length
  const place = {
    left: `${(index / count) * 100}%`,
    width: `${100 / count}%`,
  }
  // An hour with no checks still gets a stub, so a gap reads as "none".
  if (!total) {
    const label = `${bucket.when}: no ${bucket.kind === 'past' ? 'checks' : 'checks scheduled'}`
    return (
      <span
        className="pd-bar"
        data-kind={bucket.kind}
        data-empty
        title={label}
        aria-hidden="true"
        style={place}
      >
        <span className="pd-bar-fill" />
      </span>
    )
  }
  const segments =
    bucket.kind === 'past'
      ? NOTABLE.map(
          (result) =>
            [
              result,
              bucket.sources.filter((source) => source.result === result)
                .length,
            ] as const,
        ).filter(([, n]) => n > 0)
      : []
  const rest = total - segments.reduce((sum, [, n]) => sum + n, 0)
  const label =
    bucket.kind === 'past'
      ? `${bucket.when}: ${knivesLabel(total)} checked, ${resultSummary(bucket.sources)}`
      : `${bucket.when}: ${knivesLabel(total)} scheduled`
  return (
    <button
      type="button"
      className="pd-bar"
      data-kind={bucket.kind}
      data-open={open || undefined}
      aria-label={label}
      title={label}
      style={place}
      onClick={(event) =>
        onOpen(bucket, event.currentTarget.getBoundingClientRect())
      }
    >
      <span
        className="pd-bar-fill"
        style={{ height: `max(2px, ${(total / peak) * 100}%)` }}
      >
        {segments.map(([result, n]) => (
          <i key={result} data-result={result} style={{ flex: `${n} 0 3px` }} />
        ))}
        {rest ? <i data-rest style={{ flex: `${rest} 0 0px` }} /> : null}
      </span>
    </button>
  )
}

/** The knives behind a bar or the queue, sorted for that bucket. */
function bucketList(bucket: Bucket) {
  if (bucket.kind !== 'past')
    return [...bucket.sources].sort((a, b) =>
      (a.nextCheckAt ?? '').localeCompare(b.nextCheckAt ?? ''),
    )
  // What the checks found first, then the most recent.
  const rank = (source: MonitoredSource) => {
    const index = NOTABLE.indexOf(source.result)
    return index === -1 ? NOTABLE.length : index
  }
  return [...bucket.sources].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (b.lastCheckedAt ?? '').localeCompare(a.lastCheckedAt ?? ''),
  )
}

/**
 * Monitoring status as one activity strip: how many knives were checked in
 * each of the last 24 hours, how many are scheduled for each coming hour, and
 * how many already due wait in the queue at Now.
 */
function ActivityTimeline({
  sources,
  horizonHours,
  now,
  onSelect,
}: {
  sources: MonitoredSource[]
  horizonHours: number
  now: number
  onSelect: (knifeId: string) => void
}) {
  const [open, setOpen] = useState<{
    bucket: Bucket
    left: number
    top: number
  } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (
        event instanceof MouseEvent &&
        listRef.current?.contains(event.target as Node)
      )
        return
      setOpen(null)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

  const { past, upcoming, due } = bucketsFor(sources, now, horizonHours)
  // One scale for both sides, so a scheduled hour compares with a past one.
  const peak = Math.max(
    1,
    ...past.map((bucket) => bucket.sources.length),
    ...upcoming.map((bucket) => bucket.sources.length),
  )
  const ticks = futureTicks(horizonHours)
  const pastGrid = PAST_TICKS.slice(1).map((hours) => 100 - (hours / 24) * 100)
  const futureGrid = ticks
    .filter((tick) => tick < horizonHours)
    .map((tick) => (tick / horizonHours) * 100)
  const show = (bucket: Bucket, rect: DOMRect) =>
    setOpen((current) =>
      current?.bucket === bucket
        ? null
        : { bucket, left: rect.left, top: rect.bottom + 4 },
    )

  return (
    <div className="pd-timeline">
      <div className="pd-tl-toolbar">
        <ul className="pd-legend" aria-label="Bar colours">
          {NOTABLE.map((result) => (
            <li key={result} data-result={result}>
              {RESULT_LABEL[result]}
            </li>
          ))}
          <li data-checked>Checked</li>
          <li data-upcoming>Scheduled</li>
        </ul>
      </div>
      <div className="pd-tl-axis" aria-hidden="true">
        <span className="pd-tl-dates">
          {PAST_TICKS.map((hours, index) => (
            <span
              key={hours}
              data-align={index === 0 ? 'start' : undefined}
              data-minor={hours % 12 ? true : undefined}
              style={{ left: `${100 - (hours / 24) * 100}%` }}
            >
              {index === 0 ? `${hours} h ago` : `−${hours} h`}
            </span>
          ))}
        </span>
        <span className="pd-tl-dates pd-tl-dates-future">
          <b data-align="start" style={{ left: 0 }}>
            Now
          </b>
          {ticks.map((tick, index) => (
            <span
              key={tick}
              data-align={tick === horizonHours ? 'end' : undefined}
              // Narrow screens keep Now, the middle and the end.
              data-minor={
                ticks.length === 4 && index % 2 === 0 ? true : undefined
              }
              style={{ left: `${(tick / horizonHours) * 100}%` }}
            >
              +{tick} h
            </span>
          ))}
        </span>
      </div>
      <div className="pd-tl-bars">
        <div className="pd-tl-past" aria-label="Checked in the last 24 hours">
          <GridLines positions={pastGrid} />
          {past.map((bucket, index) => (
            <ActivityBar
              key={index}
              bucket={bucket}
              index={index}
              count={past.length}
              peak={peak}
              open={open?.bucket === bucket}
              onOpen={show}
            />
          ))}
        </div>
        <div
          className="pd-tl-future"
          aria-label={`Scheduled for the next ${horizonHours} hours`}
        >
          <GridLines positions={futureGrid} />
          {upcoming.map((bucket, index) => (
            <ActivityBar
              key={index}
              bucket={bucket}
              index={index}
              count={upcoming.length}
              peak={peak}
              open={open?.bucket === bucket}
              onOpen={show}
            />
          ))}
          {due.sources.length ? (
            <button
              type="button"
              className="pd-queue"
              aria-label={`${knivesLabel(due.sources.length)} due and waiting in the store queue`}
              title="Due now; each is checked when its store's turn comes"
              onClick={(event) =>
                show(due, event.currentTarget.getBoundingClientRect())
              }
            >
              {due.sources.length} in queue
            </button>
          ) : null}
        </div>
      </div>
      {open ? (
        <div
          ref={listRef}
          role="dialog"
          aria-label={knivesLabel(open.bucket.sources.length)}
          className="pd-pin-list"
          style={{
            left: Math.max(8, Math.min(open.left, window.innerWidth - 300)),
            top: open.top,
          }}
        >
          <p>
            {knivesLabel(open.bucket.sources.length)} ·{' '}
            {open.bucket.kind === 'due'
              ? 'due, checked when their turn comes'
              : open.bucket.kind === 'upcoming'
                ? `next check ${open.bucket.when}`
                : `checked ${open.bucket.when}`}
          </p>
          <ul>
            {bucketList(open.bucket).map((source) => (
              <li key={source.sourceId}>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(null)
                    onSelect(source.knife.id)
                  }}
                >
                  <span>
                    {source.knife.brand} {source.knife.name}
                    <small>
                      {[source.knife.subtitle, storeLabel(source.storeName)]
                        .filter(Boolean)
                        .join(' · ')}
                    </small>
                  </span>
                  <span>
                    {open.bucket.kind === 'past' ? (
                      <>
                        {NOTABLE.includes(source.result) ? (
                          <span
                            className="pd-swatch"
                            data-result={source.result}
                            aria-hidden="true"
                          />
                        ) : null}
                        {RESULT_LABEL[source.result]} ·{' '}
                        {relativeTime(source.lastCheckedAt, now)}
                      </>
                    ) : open.bucket.kind === 'upcoming' ? (
                      relativeTime(source.nextCheckAt, now)
                    ) : source.nextCheckAt ? (
                      `waiting ${durationLabel(now - Date.parse(source.nextCheckAt))}`
                    ) : (
                      'first check'
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

export function MonitoringStatus({
  overview,
  now,
  collapsed = false,
  onCollapsedChange,
  onSelect,
}: {
  overview: PriceOverview
  now: number
  /** Only the counts show; the timeline is hidden. */
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
  onSelect: (knifeId: string) => void
}) {
  const sources = overview.monitored
  const checked24h = sources.filter(
    (source) =>
      source.lastCheckedAt && now - Date.parse(source.lastCheckedAt) <= PAST_MS,
  ).length
  const count = (result: SourceResult) =>
    sources.filter((source) => source.result === result).length
  const drops = count('drop')
  const rises = count('increase')
  const restocked = count('restocked')
  const outOfStock = count('out_of_stock')
  const attention = sources.filter(needsAttention).length
  const putOff = sources.filter(isSnoozed).length
  const waiting = count('pending')
  const nextChecks = sources
    .map((source) => nextCheckTime(source, now))
    .filter((value): value is number => value !== null)
  const queued = nextChecks.filter((value) => value <= now).length
  const nextDueAt = nextChecks.length ? Math.min(...nextChecks) : null
  const nextDue = nextDueAt === null ? null : new Date(nextDueAt).toISOString()
  const interval = overview.round.intervalHours
  const horizonHours = Math.min(24, Math.max(6, interval ?? 12))

  return (
    <section
      data-price-status
      aria-labelledby="price-status-title"
      className="pd-status rounded-xl border border-[var(--bladevault-line)] bg-card"
    >
      <header className="pd-status-head">
        <div>
          <h2 id="price-status-title">Monitoring status</h2>
          {collapsed ? null : (
            <p>
              Checks per hour over the last 24 hours and the next {horizonHours}
              . Colored tops mark drops, rises, restocks and pages that need
              attention; knives already due wait in the queue at Now. Select a
              bar to see its knives.
            </p>
          )}
        </div>
        {onCollapsedChange ? (
          <button
            type="button"
            className="pd-status-toggle"
            aria-expanded={!collapsed}
            aria-controls="price-status-body"
            onClick={() => onCollapsedChange(!collapsed)}
          >
            {collapsed ? 'Show timeline' : 'Hide timeline'}
            <ChevronDown aria-hidden="true" />
          </button>
        ) : null}
      </header>
      <div
        className="pd-status-body"
        id="price-status-body"
        data-collapsed={collapsed || undefined}
      >
        <p className="pd-counts">
          <span>
            <b>
              {checked24h}/{sources.length}
            </b>{' '}
            checked in 24 h
          </span>
          <span>
            <b>{drops}</b> {drops === 1 ? 'drop' : 'drops'}
          </span>
          <span>
            <b>{rises}</b> {rises === 1 ? 'rise' : 'rises'}
          </span>
          {restocked ? (
            <span>
              <b>{restocked}</b> restocked
            </span>
          ) : null}
          <span>
            <b>{outOfStock}</b> out of stock
          </span>
          <span>
            <b>{attention}</b> {attention === 1 ? 'needs' : 'need'} attention
          </span>
          {putOff ? (
            <span title="Store pages you put off with Later; they show under All">
              <b>{putOff}</b> put off
            </span>
          ) : null}
          {waiting ? (
            <span>
              <b>{waiting}</b> waiting for first check
            </span>
          ) : null}
          {queued ? (
            <span>
              <b>{queued}</b> waiting in the queue
            </span>
          ) : nextDue ? (
            <span>
              next check <b>{relativeTime(nextDue, now)}</b>
            </span>
          ) : null}
        </p>
        {collapsed ? null : sources.length ? (
          <ActivityTimeline
            sources={sources}
            horizonHours={horizonHours}
            now={now}
            onSelect={onSelect}
          />
        ) : null}
      </div>
    </section>
  )
}

/**
 * A source's result: icon plus words, never color alone. With `onResolve`, a
 * blocked, failed or unavailable store page also gets a Solve or Fix button
 * that opens it in a browser window; `solveUnavailable` explains instead,
 * where this server cannot open a visible window.
 */
export function ResultBadge({
  source,
  now,
  onResolve,
  solveUnavailable,
}: {
  source: MonitoredSource
  /** With `now`, stock badges say how long ago they changed. */
  now?: number
  onResolve?: () => void
  solveUnavailable?: string
}) {
  if (
    (source.result === 'drop' || source.result === 'increase') &&
    source.deltaMinor !== null
  )
    return (
      <span
        className={cn('pd-badge')}
        data-result={source.result}
        title={
          source.changedAt
            ? `${RESULT_LABEL[source.result]} ${new Date(source.changedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}${source.fluctuating ? '; the price has also gone back and forth' : ''}`
            : undefined
        }
      >
        {source.deltaMinor < 0 ? '▼' : '▲'}{' '}
        {money(Math.abs(source.deltaMinor), source.currency)}
        {source.deltaPct !== null ? ` · ${percentLabel(source.deltaPct)}` : ''}
      </span>
    )
  const icon: Record<SourceResult, string> = {
    drop: '▼',
    increase: '▲',
    restocked: '↺',
    out_of_stock: '⊘',
    same: '=',
    attention: '!',
    pending: '…',
  }
  const text =
    source.result === 'attention'
      ? source.status === 'price_unavailable'
        ? 'Unavailable'
        : source.status === 'blocked'
          ? 'Blocked'
          : source.status === 'needs_review'
            ? 'Review'
            : 'Failed'
      : source.result === 'pending'
        ? 'Pending'
        : source.result === 'drop'
          ? 'Down'
          : source.result === 'increase'
            ? 'Up'
            : source.result === 'restocked' && source.restockedAt && now
              ? `Restocked · ${daysAgo(source.restockedAt, now).replace(/ d$/, ' d ago')}`
              : source.result === 'out_of_stock' && source.since && now
                ? `Out of stock · ${daysAgo(source.since, now)}`
                : RESULT_LABEL[source.result]
  // A quiet or put-off problem: a grey mark that says why, no Solve.
  const muted =
    source.result === 'attention' &&
    source.attention !== null &&
    source.attention.class !== 'attention'
      ? source.attention
      : null
  if (muted)
    return (
      <span
        className="pd-badge"
        data-result={source.result}
        data-attention={muted.class}
        title={verdictTitle(muted) ?? undefined}
      >
        {muted.class === 'snoozed' ? '◷' : icon[source.result]} {text}
        {muted.class === 'snoozed'
          ? ` · later ${new Date(muted.until).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
          : null}
      </span>
    )
  if (source.result === 'attention' && solveUnavailable)
    return (
      <span
        className="pd-badge"
        data-result={source.result}
        title={solveUnavailable}
      >
        {icon[source.result]} {text}
      </span>
    )
  const solvable =
    source.status === 'blocked' ||
    source.status === 'failed' ||
    source.status === 'price_unavailable'
  if (source.result === 'attention' && solvable && onResolve) {
    const blocked = source.status === 'blocked'
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span className="pd-badge" data-result={source.result}>
          {icon[source.result]} {text}
        </span>
        <Button
          type="button"
          variant="outline"
          size="xs"
          data-price-solve
          title={
            blocked
              ? 'Solve the bot check in a browser window'
              : 'Open the store page in a browser window to fix it'
          }
          aria-label={`${blocked ? 'Solve the bot check' : 'Fix the page'} at ${storeLabel(source.storeName)} in a browser`}
          onClick={(event) => {
            event.stopPropagation()
            onResolve()
          }}
        >
          <AppWindow className="size-3" aria-hidden="true" />
          {blocked ? 'Solve' : 'Fix'}
        </Button>
      </span>
    )
  }
  if (source.result === 'same' && (source.fluctuating || source.driftPct))
    return (
      <span
        className="pd-badge"
        data-result="same"
        data-fluctuating={source.fluctuating || undefined}
        title={
          source.fluctuating
            ? 'The price moved and came back to an earlier level in the last 30 days, so it counts as no change.'
            : 'The price moved by less than the Minimum change in Settings, so it counts as no change.'
        }
      >
        {source.fluctuating ? '~ Fluctuating' : `${icon.same} ${text}`}
        {source.driftPct ? (
          <span className="pd-drift"> · {driftLabel(source.driftPct)}</span>
        ) : null}
      </span>
    )
  const since =
    source.result === 'out_of_stock' && source.since
      ? source.since
      : source.result === 'restocked'
        ? source.restockedAt
        : null
  return (
    <span
      className="pd-badge"
      data-result={source.result}
      title={
        since
          ? `Since ${new Date(since).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
          : undefined
      }
    >
      {icon[source.result]} {text}
    </span>
  )
}

'use client'

import { useEffect, useRef, useState } from 'react'
import type {
  CheckHour,
  MonitoredSource,
  PriceOverview,
  SourceResult,
} from '@/lib/price-monitor/insights'
import { cn } from '@/lib/utils'
import { money, relativeTime, storeLabel } from './price-format'
import './price-drops.css'

/** Lane names and legend labels, in display order. */
export const RESULT_LABEL: Record<SourceResult, string> = {
  drop: 'Dropped',
  increase: 'Rose',
  out_of_stock: 'Out of stock',
  same: 'No change',
  attention: 'Needs attention',
  pending: 'Waiting for first check',
}

const PAST_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const MAX_STORE_LANES = 6

type Group = 'result' | 'store'

/** Pins closer than this many pixels merge into one "N knives" pin. */
const MERGE_PX = 56

type Pin = {
  /** 0–100 across the zone. */
  position: number
  sources: MonitoredSource[]
  label: string
  result: SourceResult
  /** Already due and waiting in its store's queue. */
  due: boolean
}

type PlacedPin = Pin & { row: number; align: 'start' | 'mid' | 'end' }

/** "26 min", "3 h", "2 d": how long a due knife has been waiting. */
function waitLabel(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`
}

function shortName(source: MonitoredSource) {
  const name = source.knife.name || source.knife.brand
  return name.length > 14 ? name.split(' ')[0] : name
}

function pinLabel(source: MonitoredSource, upcoming: boolean) {
  const name = shortName(source)
  if (upcoming || source.deltaMinor === null) return name
  const arrow = source.deltaMinor < 0 ? '▼' : '▲'
  return `${name} ${arrow}${money(Math.abs(source.deltaMinor), source.currency)}`
}

/**
 * Merges pins that sit close together into one "N knives" pin, then gives
 * each pin a row so no two labels overlap (as in Maintenance > Coming up).
 */
function placePins(
  items: { position: number; source: MonitoredSource; due?: boolean }[],
  upcoming: boolean,
  width: number,
): { pins: PlacedPin[]; rows: number } {
  const sorted = [...items].sort(
    (a, b) =>
      Number(b.due ?? 0) - Number(a.due ?? 0) || a.position - b.position,
  )
  const gap = (MERGE_PX / Math.max(width, 1)) * 100
  const merged: Pin[] = []
  for (const item of sorted) {
    const last = merged.at(-1)
    const due = Boolean(item.due)
    // Due knives all wait at Now as one queue pin; the rest merge by distance.
    if (
      last &&
      last.due === due &&
      (due || item.position - last.position < gap)
    ) {
      last.sources.push(item.source)
      if (!due)
        last.position =
          last.position + (item.position - last.position) / last.sources.length
      last.label = due
        ? `${last.sources.length} in queue`
        : `${last.sources.length} knives`
      continue
    }
    merged.push({
      position: due ? 0 : item.position,
      sources: [item.source],
      label: pinLabel(item.source, upcoming),
      result: item.source.result,
      due,
    })
  }
  const ends: number[] = []
  const pins = merged.map((pin) => {
    const size = ((pin.label.length * 6.2 + 18) / Math.max(width, 1)) * 100
    const align: PlacedPin['align'] =
      pin.due || pin.position < size / 2
        ? 'start'
        : pin.position > 100 - size / 2
          ? 'end'
          : 'mid'
    const start =
      align === 'start'
        ? pin.position
        : align === 'end'
          ? pin.position - size
          : pin.position - size / 2
    let row = ends.findIndex((end) => end + 0.5 <= start)
    if (row === -1) row = ends.length
    ends[row] = start + size
    return { ...pin, row, align }
  })
  return { pins, rows: Math.max(1, ends.length) }
}

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

function describe(source: MonitoredSource, now: number) {
  const name = `${source.knife.brand} ${source.knife.name}`.trim()
  const checked = source.lastCheckedAt
    ? `checked ${relativeTime(source.lastCheckedAt, now)}`
    : 'not checked yet'
  const next = source.nextCheckAt
    ? `, next ${relativeTime(source.nextCheckAt, now)}`
    : ''
  return `${name} · ${RESULT_LABEL[source.result]} · ${money(
    source.priceMinor,
    source.currency,
  )} · ${storeLabel(source.storeName)}, ${checked}${next}`
}

function TimelinePin({
  pin,
  upcoming,
  selectedKnife,
  now,
  onSelect,
  onOpenCluster,
}: {
  pin: PlacedPin
  upcoming: boolean
  selectedKnife: string | null
  now: number
  onSelect: (knifeId: string) => void
  onOpenCluster: (pin: PlacedPin, upcoming: boolean, anchor: DOMRect) => void
}) {
  const single = pin.sources.length === 1 ? pin.sources[0] : null
  const label = single
    ? `${describe(single, now)}${pin.due ? ' · waiting in the store queue' : ''}`
    : `${pin.sources.length} knives ${
        pin.due
          ? 'due and waiting in the store queue'
          : upcoming
            ? 'with their next check around then'
            : 'checked around then'
      }`
  return (
    <button
      type="button"
      className="pd-pin"
      data-result={pin.result}
      data-upcoming={upcoming || undefined}
      data-due={pin.due || undefined}
      data-align={pin.align}
      aria-pressed={single ? selectedKnife === single.knife.id : undefined}
      aria-label={label}
      title={label}
      style={{ left: `${pin.position}%`, top: 3 + pin.row * 24 }}
      onClick={(event) =>
        single
          ? onSelect(single.knife.id)
          : onOpenCluster(
              pin,
              upcoming,
              event.currentTarget.getBoundingClientRect(),
            )
      }
    >
      {pin.label}
    </button>
  )
}

type Lane = {
  key: string
  label: string
  result?: SourceResult
  sources: MonitoredSource[]
}

function lanesFor(group: Group, sources: MonitoredSource[]): Lane[] {
  if (group === 'result') {
    const order: SourceResult[] = [
      'drop',
      'increase',
      'out_of_stock',
      'same',
      'attention',
    ]
    return order
      .map((result) => ({
        key: result,
        label: RESULT_LABEL[result],
        result,
        sources: sources.filter((source) =>
          result === 'attention'
            ? source.result === 'attention' || source.result === 'pending'
            : source.result === result,
        ),
      }))
      .filter((lane) => lane.sources.length > 0)
  }
  const byStore = new Map<string, MonitoredSource[]>()
  for (const source of sources) {
    const list = byStore.get(source.laneKey) ?? []
    list.push(source)
    byStore.set(source.laneKey, list)
  }
  const stores = [...byStore.values()].sort((a, b) => b.length - a.length)
  const lanes: Lane[] = stores.slice(0, MAX_STORE_LANES).map((list) => ({
    key: list[0].laneKey,
    label: storeLabel(list[0].storeName),
    sources: list,
  }))
  const rest = stores.slice(MAX_STORE_LANES)
  if (rest.length)
    lanes.push({
      key: 'other',
      label: `${rest.length} other ${rest.length === 1 ? 'store' : 'stores'}`,
      sources: rest.flat(),
    })
  return lanes
}

/** Hours before now marked on the past zone, oldest first. */
const PAST_TICKS = [24, 18, 12, 6]

/** Up to four evenly spaced hour marks across the upcoming zone. */
function futureTicks(horizonHours: number) {
  return [
    ...new Set([1, 2, 3, 4].map((i) => Math.round((horizonHours * i) / 4))),
  ]
}

/** Faint hour lines behind the pins, matching the axis marks. */
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
 * Monitoring status in the style of Maintenance > Coming up: each knife is
 * pinned where it was last checked over the past 24 hours, colored by what
 * that check found, and again where its next check is due.
 */
function StatusTimeline({
  sources,
  horizonHours,
  selectedKnife,
  now,
  onSelect,
}: {
  sources: MonitoredSource[]
  horizonHours: number
  selectedKnife: string | null
  now: number
  onSelect: (knifeId: string) => void
}) {
  const [group, setGroup] = useState<Group>('result')
  const [pastRef, pastWidth] = useElementWidth<HTMLDivElement>(700)
  const [futureRef, futureWidth] = useElementWidth<HTMLDivElement>(260)
  const [cluster, setCluster] = useState<{
    pin: PlacedPin
    upcoming: boolean
    left: number
    top: number
  } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!cluster) return
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (
        event instanceof MouseEvent &&
        listRef.current?.contains(event.target as Node)
      )
        return
      setCluster(null)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [cluster])

  const horizonMs = horizonHours * HOUR_MS
  const lanes = lanesFor(group, sources).map((lane) => {
    const past = placePins(
      lane.sources
        .filter((source) => source.lastCheckedAt)
        .map((source) => ({
          source,
          position: Math.max(
            0.5,
            100 -
              (Math.min(now - Date.parse(source.lastCheckedAt!), PAST_MS) /
                PAST_MS) *
                100,
          ),
        })),
      false,
      pastWidth,
    )
    const upcoming = placePins(
      lane.sources
        .filter((source) => source.nextCheckAt)
        .map((source) => {
          const at = Date.parse(source.nextCheckAt!)
          return {
            source,
            due: at <= now,
            position: Math.min(
              99.5,
              Math.max(0.5, ((at - now) / horizonMs) * 100),
            ),
          }
        }),
      true,
      futureWidth,
    )
    return { ...lane, past, upcoming }
  })
  const ticks = futureTicks(horizonHours)
  const pastGrid = PAST_TICKS.slice(1).map((hours) => 100 - (hours / 24) * 100)
  const futureGrid = ticks
    .filter((tick) => tick < horizonHours)
    .map((tick) => (tick / horizonHours) * 100)
  const openCluster = (pin: PlacedPin, upcoming: boolean, rect: DOMRect) =>
    setCluster({ pin, upcoming, left: rect.left, top: rect.bottom + 4 })

  return (
    <div className="pd-timeline">
      <div className="pd-tl-toolbar">
        <div role="radiogroup" aria-label="Group lanes" className="pd-seg">
          {(['result', 'store'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={group === value}
              onClick={() => setGroup(value)}
            >
              {value === 'result' ? 'By result' : 'By store'}
            </button>
          ))}
        </div>
        <ul className="pd-legend" aria-label="Pin colours">
          {(
            ['drop', 'increase', 'out_of_stock', 'same', 'attention'] as const
          ).map((result) => (
            <li key={result} data-result={result}>
              {RESULT_LABEL[result]}
            </li>
          ))}
          <li data-upcoming>Next check</li>
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
          {ticks.map((tick) => (
            <span
              key={tick}
              data-align={tick === horizonHours ? 'end' : undefined}
              style={{ left: `${(tick / horizonHours) * 100}%` }}
            >
              +{tick} h
            </span>
          ))}
        </span>
      </div>
      {lanes.map((lane, index) => {
        const rows = Math.max(lane.past.rows, lane.upcoming.rows)
        return (
          <section
            key={lane.key}
            className="pd-tl-lane"
            aria-label={lane.label}
            style={{ '--pd-rows': rows } as React.CSSProperties}
          >
            <h3>
              {lane.result ? (
                <span
                  className="pd-swatch"
                  data-result={lane.result}
                  aria-hidden="true"
                />
              ) : null}
              {lane.label}
              <span className="pd-tl-count">· {lane.sources.length}</span>
            </h3>
            <div className="pd-tl-past" ref={index === 0 ? pastRef : undefined}>
              <GridLines positions={pastGrid} />
              {lane.past.pins.map((pin) => (
                <TimelinePin
                  key={`p-${pin.sources[0].sourceId}`}
                  pin={pin}
                  upcoming={false}
                  selectedKnife={selectedKnife}
                  now={now}
                  onSelect={onSelect}
                  onOpenCluster={openCluster}
                />
              ))}
            </div>
            <div
              className="pd-tl-future"
              ref={index === 0 ? futureRef : undefined}
            >
              <GridLines positions={futureGrid} />
              {lane.upcoming.pins.map((pin) => (
                <TimelinePin
                  key={`u-${pin.due ? 'due-' : ''}${pin.sources[0].sourceId}`}
                  pin={pin}
                  upcoming
                  selectedKnife={selectedKnife}
                  now={now}
                  onSelect={onSelect}
                  onOpenCluster={openCluster}
                />
              ))}
            </div>
          </section>
        )
      })}
      {cluster ? (
        <div
          ref={listRef}
          role="dialog"
          aria-label={`${cluster.pin.sources.length} knives`}
          className="pd-pin-list"
          style={{
            left: Math.max(8, Math.min(cluster.left, window.innerWidth - 260)),
            top: cluster.top,
          }}
        >
          <p>
            {cluster.pin.sources.length} knives ·{' '}
            {cluster.pin.due
              ? 'due, checked one at a time per store'
              : cluster.upcoming
                ? 'next check'
                : 'last checked'}
          </p>
          <ul>
            {[...cluster.pin.sources]
              .sort((a, b) =>
                cluster.upcoming
                  ? (a.nextCheckAt ?? '').localeCompare(b.nextCheckAt ?? '')
                  : (b.lastCheckedAt ?? '').localeCompare(
                      a.lastCheckedAt ?? '',
                    ),
              )
              .map((source) => (
                <li key={source.sourceId}>
                  <button
                    type="button"
                    onClick={() => {
                      setCluster(null)
                      onSelect(source.knife.id)
                    }}
                  >
                    <span>
                      {source.knife.brand} {source.knife.name}
                    </span>
                    <span>
                      {cluster.pin.due
                        ? `waiting ${waitLabel(now - Date.parse(source.nextCheckAt!))}`
                        : cluster.upcoming
                          ? relativeTime(source.nextCheckAt, now)
                          : relativeTime(source.lastCheckedAt, now)}
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

const HOUR_ORDER = [
  'same',
  'attention',
  'out_of_stock',
  'increase',
  'drop',
] as const

/** Checks started per hour over the last day, stacked by what they found. */
function ChecksPerHour({ hours, now }: { hours: CheckHour[]; now: number }) {
  const width = 1000
  const height = 100
  const step = width / Math.max(hours.length, 1)
  const totals = hours.map((hour) =>
    HOUR_ORDER.reduce((sum, key) => sum + hour[key], 0),
  )
  const max = Math.max(1, ...totals)
  const all = totals.reduce((sum, value) => sum + value, 0)
  return (
    <figure className="pd-hours">
      <figcaption className="pd-eyebrow">
        Checks per hour · last 24 h
      </figcaption>
      {all === 0 ? (
        <p className="pd-hours-empty">No checks in the last 24 hours.</p>
      ) : (
        <svg
          viewBox={`0 0 ${width} ${height + 16}`}
          role="img"
          aria-label={`${all} checks in the last 24 hours`}
        >
          <line
            className="pd-hours-base"
            x1="0"
            x2={width}
            y1={height}
            y2={height}
          />
          {hours.map((hour, index) => {
            let y = height
            const ago = Math.round((now - Date.parse(hour.hour)) / HOUR_MS)
            const summary = HOUR_ORDER.filter((key) => hour[key])
              .map(
                (key) =>
                  `${key === 'attention' ? 'Unavailable or failed' : RESULT_LABEL[key]}: ${hour[key]}`,
              )
              .join(', ')
            return (
              <g key={hour.hour}>
                <title>
                  {`${ago <= 0 ? 'This hour' : `${ago} h ago`} · ${totals[index]} checks${summary ? ` (${summary})` : ''}`}
                </title>
                {HOUR_ORDER.map((key) => {
                  if (!hour[key]) return null
                  const size = (hour[key] / max) * (height - 12)
                  y -= size
                  return (
                    <rect
                      key={key}
                      data-result={key}
                      x={index * step + 3}
                      y={y + 1}
                      width={step - 6}
                      height={Math.max(size - 2, 1.5)}
                      rx="2"
                    />
                  )
                })}
                <rect
                  x={index * step}
                  y="0"
                  width={step}
                  height={height}
                  fill="transparent"
                />
              </g>
            )
          })}
          {[0, 6, 12, 18, hours.length - 1].map((index) => (
            <text
              key={index}
              className="pd-hours-axis"
              x={index * step + step / 2}
              y={height + 13}
              textAnchor="middle"
            >
              {index === hours.length - 1
                ? 'now'
                : `−${hours.length - 1 - index} h`}
            </text>
          ))}
        </svg>
      )}
    </figure>
  )
}

export function MonitoringStatus({
  overview,
  pausedStores,
  selectedKnife,
  now,
  onSelect,
}: {
  overview: PriceOverview
  pausedStores: number
  selectedKnife: string | null
  now: number
  onSelect: (knifeId: string) => void
}) {
  const sources = overview.monitored
  const checked24h = sources.filter(
    (source) =>
      source.lastCheckedAt && now - Date.parse(source.lastCheckedAt) <= PAST_MS,
  ).length
  const changed = sources.filter((source) =>
    ['drop', 'increase', 'out_of_stock'].includes(source.result),
  ).length
  const attention = sources.filter(
    (source) => source.result === 'attention' || source.result === 'pending',
  ).length
  const nextChecks = sources
    .map((source) => source.nextCheckAt)
    .filter((value): value is string => Boolean(value))
  const queued = nextChecks.filter((value) => Date.parse(value) <= now).length
  const nextDue = nextChecks.sort()[0]
  const interval = overview.round.intervalHours
  const horizonHours = Math.min(24, Math.max(6, interval ?? 12))

  return (
    <section
      data-price-status
      aria-labelledby="price-status-title"
      className="pd-status rounded-xl border border-[var(--bladevault-line)] bg-card"
    >
      <header className="pd-status-head">
        <h2 id="price-status-title">Monitoring status</h2>
        <p>
          What the next {horizonHours} hours will check, with the last 24 hours
          in brief on the left. Knives already due wait at Now and are checked
          one at a time per store. Select a pin to open the knife.
        </p>
      </header>
      <div className="pd-status-body">
        <p className="pd-counts">
          <span>
            <b>
              {checked24h}/{sources.length}
            </b>{' '}
            checked in 24 h
          </span>
          <span>
            <b>{changed}</b> changed
          </span>
          <span>
            <b>{attention}</b> need attention
          </span>
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
        {sources.length ? (
          <StatusTimeline
            sources={sources}
            horizonHours={horizonHours}
            selectedKnife={selectedKnife}
            now={now}
            onSelect={onSelect}
          />
        ) : null}
        <div className="pd-status-foot">
          <ChecksPerHour hours={overview.checksByHour} now={now} />
          <dl className="pd-round">
            <div className="pd-eyebrow">Round</div>
            <div>
              <dt>Check every</dt>
              <dd>{interval ? `${interval} h` : '—'}</dd>
            </div>
            <div>
              <dt>Stores</dt>
              <dd>{overview.kpis.stores}</dd>
            </div>
            <div>
              <dt>Stores paused</dt>
              <dd>{pausedStores}</dd>
            </div>
            <div>
              <dt>Failed in 24 h</dt>
              <dd>{overview.round.failed24h}</dd>
            </div>
            <div>
              <dt>Oldest result</dt>
              <dd>
                {overview.round.oldestCheckAt
                  ? relativeTime(overview.round.oldestCheckAt, now)
                  : '—'}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  )
}

/** Change badge for a monitored source: icon plus words, never color alone. */
/**
 * A source's result. With `onResolve`, a Needs attention badge is a button
 * that starts Solve in browser for that store page.
 */
export function ResultBadge({
  source,
  onResolve,
}: {
  source: MonitoredSource
  onResolve?: () => void
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
            ? `${RESULT_LABEL[source.result]} ${new Date(source.changedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
            : undefined
        }
      >
        {source.deltaMinor < 0 ? '▼' : '▲'}{' '}
        {money(Math.abs(source.deltaMinor), source.currency)}
        {source.deltaPct !== null
          ? ` · ${Math.abs(source.deltaPct).toFixed(0)}%`
          : ''}
      </span>
    )
  const icon: Record<SourceResult, string> = {
    drop: '▼',
    increase: '▲',
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
        ? 'Waiting'
        : RESULT_LABEL[source.result]
  if (source.result === 'attention' && onResolve)
    return (
      <button
        type="button"
        className="pd-badge cursor-pointer underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        data-result={source.result}
        title={
          source.status === 'blocked'
            ? 'Solve the bot check in a browser window'
            : 'Open the store page in a browser window to fix it'
        }
        onClick={(event) => {
          event.stopPropagation()
          onResolve()
        }}
      >
        {icon[source.result]} {text}
        <span className="sr-only">
          {' '}
          —{' '}
          {source.status === 'blocked' ? 'solve in browser' : 'fix in browser'}
        </span>
      </button>
    )
  return (
    <span className="pd-badge" data-result={source.result}>
      {icon[source.result]} {text}
    </span>
  )
}

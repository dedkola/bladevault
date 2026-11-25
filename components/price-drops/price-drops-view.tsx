'use client'

import type { PriceMonitorScopeKind } from '@/lib/settings-shared'
import Link from 'next/link'
import { Fragment, useEffect, useRef, useState } from 'react'
import {
  AppWindow,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bot,
  ChartLine,
  ChevronRight,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { getSafeExternalUrl } from '@/lib/external-url'
import type {
  MonitoredSource,
  PriceOverview,
  SourceSummary,
} from '@/lib/price-monitor/insights'
import type { PriceWatchMode } from '@/lib/price-monitor/shared'
import { cn } from '@/lib/utils'
import { useKnives } from '@/components/providers/knives-provider'
import { getHourCycle } from '@/lib/time-format'
import type { PriceTrends, WishlistTrend } from '@/lib/wishlist'
import {
  AgentActivity,
  AgentStrip,
  hasAgentActivity,
  useAgentState,
} from './agent-panel'
import { KnifePricePanel } from './knife-price-panel'
import { MonitoringStatus, ResultBadge } from './monitoring-status'
import { PriceExportButton } from './price-export-button'
import { RetireHintNotice } from './retire-hint'
import {
  clockTime,
  money,
  nextCheckLabel,
  percentLabel,
  relativeTime,
  storeLabel,
} from './price-format'
import { PriceTrend, trendNetChange } from './price-trend'
import {
  EMPTY_TEXT,
  groupByKnife,
  isBelowPaid,
  matchesQuery,
  nextSort,
  parseSection,
  SECTION_FILTER,
  SECTION_LABEL,
  SECTIONS,
  sortRows,
  storeOptions,
  vsPaid,
  type Section,
  type Sort,
  type SortKey,
} from './price-table-model'
import {
  CurrencyMismatch,
  KnifeThumb,
  StatusDot,
  useMediaQuery,
  useMinuteClock,
  useStoredValue,
} from './price-ui'
import {
  SOLVE_UNAVAILABLE_TEXT,
  SolveInBrowserDialog,
  useSolveInBrowserAvailable,
  type SolveTarget,
} from './solve-in-browser'

type QueueLane = {
  laneKey: string
  circuit: 'closed' | 'open'
  cooldownUntil: string | null
  checking: boolean
}

type QueueRound = {
  id: number
  trigger: 'scheduled' | 'manual'
  startedAt: string
  /** Knives in the round, and how many are done. */
  knives: number
  done: number
}

type QueueSnapshot = {
  enabled: boolean
  /** Check now requests waiting. */
  waiting: number
  /** The round in progress, if any. */
  round: QueueRound | null
  /** The last round that finished, if any. */
  lastRound: { id: number } | null
  /** When the next round starts (null while one runs or checks are off). */
  nextRoundAt: string | null
  /** The retry list: items waiting for a time, and items with one. */
  retries: { waiting: number; scheduled: number; nextAt: string | null }
  lanes: QueueLane[]
  /** What to monitor; `knives` is null for the whole collection. */
  scope?: { kind: PriceMonitorScopeKind; knives: number | null }
}

const SCOPE_LABEL = { wishlist: 'Wishlist', selected: 'Selected knives' }

const OVERVIEW_REFRESH_MS = 60_000
const QUEUE_REFRESH_MS = 10_000
/** Faster while a round runs, so its progress moves visibly. */
const PROGRESS_REFRESH_MS = 3_000
/** Bulk changes to this many listings or knives ask first. */
const BULK_CONFIRM_AT = 5
const NARROW_QUERY = '(max-width: 639px)'

const STORAGE = {
  section: 'bladevault.priceDrops.section',
  // A knife's stores are one item, so the list starts grouped. The key is
  // new so an older "ungrouped" choice does not hide that.
  grouped: 'bladevault.priceDrops.groupByKnife.v2',
  statusCollapsed: 'bladevault.priceDrops.statusCollapsed',
}

const parseFlag = (raw: string | null) =>
  raw === '1' ? '1' : raw === '0' ? '0' : null

type OverviewState = {
  overview: PriceOverview | null
  error: string | null
  /** When the shown data was loaded. */
  loadedAt: number | null
}

/**
 * The overview, refreshed every minute while visible. A failed refresh
 * keeps the last data and reports the error so the page can say it is stale.
 */
function useOverview(version: number) {
  const [state, setState] = useState<OverviewState>({
    overview: null,
    error: null,
    loadedAt: null,
  })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const response = await fetch('/api/prices/overview', {
          cache: 'no-store',
          signal: controller.signal,
        })
        const data = (await response.json()) as {
          overview?: PriceOverview
          error?: string
        }
        if (controller.signal.aborted) return
        if (!response.ok || !data.overview) {
          const error = data.error ?? 'Could not load price monitoring.'
          setState((previous) => ({ ...previous, error }))
        } else
          setState({
            overview: data.overview,
            error: null,
            loadedAt: Date.now(),
          })
      } catch {
        if (!controller.signal.aborted)
          setState((previous) => ({
            ...previous,
            error: 'Could not load price monitoring.',
          }))
      }
    }
    void load()
    return () => controller.abort()
  }, [version, tick])
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') setTick((value) => value + 1)
    }, OVERVIEW_REFRESH_MS)
    return () => clearInterval(timer)
  }, [])
  return { ...state, retry: () => setTick((value) => value + 1) }
}

/** The live queue; polled faster while a round runs (or was just started). */
function useQueue(fast: boolean, version: number) {
  const [queue, setQueue] = useState<QueueSnapshot | null>(null)
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const response = await fetch('/api/prices/queue', {
          cache: 'no-store',
        })
        if (!response.ok) return
        const data = (await response.json()) as { queue: QueueSnapshot }
        if (!cancelled) setQueue(data.queue)
      } catch {
        // The indicator is optional.
      }
    }
    void load()
    const timer = setInterval(
      () => {
        if (document.visibilityState === 'visible') void load()
      },
      fast ? PROGRESS_REFRESH_MS : QUEUE_REFRESH_MS,
    )
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [fast, version])
  return queue
}

/**
 * Row charts. Prices only move when a check finishes, so this reloads when
 * the last successful check or `version` changes, not on every poll. A
 * failed load keeps the last charts; rows without one say so.
 */
function usePriceTrends(key: string | null) {
  const [trends, setTrends] = useState<PriceTrends | null>(null)
  useEffect(() => {
    if (key === null) return
    const controller = new AbortController()
    fetch('/api/prices/trends', {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { trends?: PriceTrends } | null) => {
        if (data?.trends) setTrends(data.trends)
      })
      .catch(() => {
        // Charts are optional; the table works without them.
      })
    return () => controller.abort()
  }, [key])
  return trends
}

/** "12 of 38 knives checked", with why the rest may wait. */
function roundText(round: QueueRound, pausedStores: number): string {
  const parts = [
    `${Math.min(round.done, round.knives)} of ${round.knives} ${round.knives === 1 ? 'knife' : 'knives'} checked`,
  ]
  if (pausedStores)
    parts.push(
      `${pausedStores} ${pausedStores === 1 ? 'store is' : 'stores are'} paused after a bot check`,
    )
  else parts.push("all of a knife's stores at once, then a pause")
  return parts.join(' · ')
}

async function requestCheck(sourceId: number) {
  const response = await fetch('/api/prices/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'source', id: sourceId }),
  })
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as {
      error?: string
    }
    throw new Error(data.error ?? 'Could not start the check.')
  }
}

async function updateWatch(knifeId: string, body: unknown) {
  const response = await fetch(
    `/api/knives/${encodeURIComponent(knifeId)}/price-watch`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as {
      error?: string
    }
    throw new Error(data.error ?? 'Could not change monitoring.')
  }
}

/** Runs tasks a few at a time; returns how many failed and the first error. */
async function runEach<T>(items: T[], task: (item: T) => Promise<void>) {
  let failed = 0
  let firstError: string | null = null
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]
      try {
        await task(item)
      } catch (error) {
        failed += 1
        firstError ??= error instanceof Error ? error.message : String(error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker))
  return { failed, firstError }
}

const MODE_LABEL: Record<PriceWatchMode, string> = {
  auto: 'Auto',
  on: 'Always monitor',
  off: 'Never monitor',
}

type BulkAction =
  { kind: 'check' } | { kind: 'pause' } | { kind: 'mode'; mode: PriceWatchMode }

function knifeName(source: MonitoredSource) {
  return `${source.knife.brand} ${source.knife.name}`.trim()
}

function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

/** The latest check moved the price: "▼ $73.50 · 2 days ago". */
function ChangeTag({ source, now }: { source: MonitoredSource; now: number }) {
  if (
    (source.result !== 'drop' && source.result !== 'increase') ||
    source.deltaMinor === null
  )
    return null
  const down = source.deltaMinor < 0
  return (
    <span
      data-price-change-tag={down ? 'drop' : 'increase'}
      title={[
        `${down ? 'Down' : 'Up'} ${money(Math.abs(source.deltaMinor), source.currency)}${source.deltaPct !== null ? ` (${percentLabel(source.deltaPct)})` : ''}`,
        source.changedAt ? `on ${shortDate(source.changedAt)}` : '',
        source.fluctuating ? '; the price has also gone back and forth' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {down ? '▼' : '▲'} {money(Math.abs(source.deltaMinor), source.currency)}
      {source.changedAt
        ? ` · ${relativeTime(source.changedAt, now, 'short')}`
        : ''}
    </span>
  )
}

/**
 * The line under the price: the regular price it beats ("~~$294~~ · save
 * $73.50"), how far above it it is, or how old a price a failed check kept.
 */
function PriceNote({ source }: { source: MonitoredSource }) {
  if (source.result === 'attention' && source.priceMinor !== null)
    return (
      <>
        {source.priceSeenAt
          ? `as of ${shortDate(source.priceSeenAt)}`
          : 'last known'}
      </>
    )
  if (
    source.priceMinor !== null &&
    source.paidMinor === null &&
    source.currency &&
    source.paidCurrency &&
    source.paidCurrency !== source.currency
  )
    return (
      <CurrencyMismatch
        currency={source.currency}
        paidCurrency={source.paidCurrency}
      />
    )
  const paid = vsPaid(source)
  if (!paid) return null
  if (paid.deltaMinor === 0) return <>regular price</>
  if (paid.deltaMinor < 0)
    return (
      <>
        <s>{money(source.paidMinor, source.currency)}</s> ·{' '}
        <span data-price-save>
          save {money(-paid.deltaMinor, source.currency)}
        </span>
      </>
    )
  return (
    <>
      <span data-price-over>+{money(paid.deltaMinor, source.currency)}</span> vs
      regular
    </>
  )
}

/**
 * The price now, with the latest change beside it and the regular price
 * under it. A check that could not read the page keeps the last known price,
 * shown muted with its date so it never passes for a fresh reading.
 */
function PriceCell({ source, now }: { source: MonitoredSource; now: number }) {
  const stale = source.result === 'attention' && source.priceMinor !== null
  return (
    <div data-price-cell data-stale={stale || undefined}>
      <span data-price-line>
        <ChangeTag source={source} now={now} />
        <b title={stale ? 'Last price read on this page' : undefined}>
          {money(source.priceMinor, source.currency)}
        </b>
      </span>
      <span data-price-note>
        <PriceNote source={source} />
      </span>
    </div>
  )
}

/** Results that are news on their own; drops and rises show as a tag. */
const STATUS_RESULTS = new Set<MonitoredSource['result']>([
  'restocked',
  'out_of_stock',
  'attention',
  'pending',
])

/** At or under the lowest price in the trend's 90 days, after a higher one. */
function atNinetyDayLow(
  source: MonitoredSource,
  trend: WishlistTrend | undefined,
): boolean {
  const price = source.priceMinor
  return Boolean(
    trend &&
    price !== null &&
    trend.currency === source.currency &&
    trend.lowMinor !== null &&
    price <= trend.lowMinor &&
    !STATUS_RESULTS.has(source.result) &&
    // A price that never moved is not news: show it only after a higher one.
    trend.daily.some((value) => value !== null && value > price),
  )
}

/**
 * Wishlist-style signals under the knife: its stock or check status, On
 * sale against the regular price, and a 90-day low.
 */
function RowSignals({
  source,
  trend,
  now,
  canSolve,
  onResolve,
}: {
  source: MonitoredSource
  trend: WishlistTrend | undefined
  now: number
  canSolve: boolean | null
  onResolve: () => void
}) {
  const status = STATUS_RESULTS.has(source.result)
  const paid = isBelowPaid(source) ? vsPaid(source) : null
  const low = atNinetyDayLow(source, trend)
  if (!status && !paid && !low) return null
  return (
    <span data-price-signals>
      {status ? (
        <ResultBadge
          source={source}
          now={now}
          onResolve={canSolve ? onResolve : undefined}
          solveUnavailable={
            canSolve === false ? SOLVE_UNAVAILABLE_TEXT : undefined
          }
        />
      ) : null}
      {paid ? (
        <span
          className="pd-badge"
          data-result="drop"
          title={`${money(-paid.deltaMinor, source.currency)} below the regular price`}
        >
          On sale −{Math.round(Math.abs(paid.pct))}%
        </span>
      ) : null}
      {low ? (
        <span
          className="pd-badge"
          data-price-signal="low"
          title="The lowest price in the last 90 days"
        >
          90-day low
        </span>
      ) : null}
    </span>
  )
}

const iconLink = cn(
  buttonVariants({ variant: 'ghost', size: 'icon-xs' }),
  'text-muted-foreground hover:text-foreground',
)

/** Check now, store page, Market tab and Solve, without selecting the row. */
function RowActions({
  source,
  checking,
  canSolve,
  onCheckNow,
  onResolve,
}: {
  source: MonitoredSource
  checking: boolean
  canSolve: boolean | null
  onCheckNow: () => void
  onResolve: () => void
}) {
  const name = knifeName(source)
  const store = storeLabel(source.storeName)
  const safeUrl = getSafeExternalUrl(source.url)
  const stop = (event: React.SyntheticEvent) => event.stopPropagation()
  return (
    <div data-price-row-actions className="flex items-center justify-end">
      {source.result === 'attention' && canSolve ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Solve ${store} for ${name} in a browser`}
          title="Solve in browser"
          onClick={(event) => {
            stop(event)
            onResolve()
          }}
        >
          <AppWindow className="size-3.5" />
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Check ${name} at ${store} now`}
        title="Check now"
        disabled={checking}
        onClick={(event) => {
          stop(event)
          onCheckNow()
        }}
      >
        {checking ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <RefreshCw className="size-3.5" />
        )}
      </Button>
      {safeUrl ? (
        <a
          href={safeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={iconLink}
          aria-label={`Open the ${store} page for ${name}`}
          title="Store page"
          onClick={stop}
        >
          <ExternalLink className="size-3.5" />
        </a>
      ) : null}
      <Link
        href={`/collection/${encodeURIComponent(source.knife.id)}?tab=market`}
        className={iconLink}
        aria-label={`Open the Market tab for ${name}`}
        title="Market tab"
        onClick={stop}
      >
        <ChartLine className="size-3.5" />
      </Link>
    </div>
  )
}

function SourceTableRow({
  source,
  selected,
  checked,
  section,
  lanes,
  now,
  checkingNow,
  hourCycle,
  canSolve,
  trend,
  knifeTrend,
  bestMinor,
  group,
  child,
  onSelect,
  onToggleChecked,
  onResolve,
  onCheckNow,
}: {
  source: MonitoredSource
  selected: boolean
  /** Ticked for bulk actions: true, false or 'some' for a part group. */
  checked: boolean | 'some'
  section: Section
  lanes: Map<string, QueueLane>
  now: number
  checkingNow: boolean
  hourCycle: 'h12' | 'h23'
  canSolve: boolean | null
  /** The 30-day chart: the knife's best price, or this store's own. */
  trend: WishlistTrend | undefined
  /** `trend` is the knife's best price across its stores. */
  knifeTrend?: boolean
  /** A store row: the knife's best price, to say how far above it this is. */
  bestMinor?: number | null
  /** A grouped knife row: its stores count and expand state. */
  group?: { count: number; expanded: boolean; onToggle: () => void }
  /** A store row under an expanded knife. */
  child?: boolean
  onSelect: () => void
  onToggleChecked: () => void
  onResolve: () => void
  onCheckNow: () => void
}) {
  const paused = laneNote(lanes, source, hourCycle, now)
  const showNext = section === 'attention'
  const name = knifeName(source)
  const store = storeLabel(source.storeName)
  const aboveBest =
    child &&
    bestMinor != null &&
    source.priceMinor !== null &&
    source.priceMinor > bestMinor
      ? source.priceMinor - bestMinor
      : null
  return (
    <tr
      data-price-row={source.result}
      data-knife-row={source.knife.id}
      data-selected={selected || undefined}
      data-child={child || undefined}
      onClick={onSelect}
      className={cn(
        'cursor-pointer border-b border-[var(--bladevault-line)]/60 transition-colors hover:bg-[var(--bladevault-surface-soft)]',
        selected && 'bg-[var(--bladevault-surface-soft)]',
      )}
    >
      <td data-col="check" className="py-2.5 pr-2 pl-1">
        <Checkbox
          aria-label={
            group
              ? `Select ${name}, ${group.count} stores`
              : `Select ${name} at ${store}`
          }
          checked={checked === true}
          indeterminate={checked === 'some'}
          onClick={(event) => event.stopPropagation()}
          onCheckedChange={onToggleChecked}
        />
      </td>
      <td data-col="knife" className="py-2.5 pr-3">
        {child ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-[72px]">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                onSelect()
              }}
              className="truncate rounded-sm text-left text-[13px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              aria-label={`${store}: show ${name}`}
            >
              {store}
            </button>
            {STATUS_RESULTS.has(source.result) ? (
              <ResultBadge
                source={source}
                now={now}
                onResolve={canSolve ? onResolve : undefined}
                solveUnavailable={
                  canSolve === false ? SOLVE_UNAVAILABLE_TEXT : undefined
                }
              />
            ) : null}
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-3">
            <KnifeThumb
              knife={source.knife}
              className="h-11 w-[60px] rounded-[10px]"
            />
            <div className="min-w-0">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  onSelect()
                }}
                aria-pressed={selected}
                className="block max-w-full truncate rounded-sm text-left leading-tight font-semibold focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {name}
              </button>
              {source.knife.subtitle ? (
                <span
                  data-price-subtitle
                  className="block truncate text-xs text-muted-foreground"
                >
                  {source.knife.subtitle}
                </span>
              ) : null}
              <span className="block truncate text-xs text-muted-foreground">
                {group && group.count > 1 ? (
                  <>
                    Best at {store} ·{' '}
                    <button
                      type="button"
                      data-price-stores
                      aria-expanded={group.expanded}
                      aria-label={`${group.expanded ? 'Hide' : 'Show'} ${group.count} stores for ${name}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        group.onToggle()
                      }}
                    >
                      {group.count} stores
                      <ChevronRight aria-hidden="true" />
                    </button>
                  </>
                ) : (
                  store
                )}
              </span>
              <RowSignals
                source={source}
                trend={trend}
                now={now}
                canSolve={canSolve}
                onResolve={onResolve}
              />
            </div>
          </div>
        )}
      </td>
      <td data-col="price" className="py-2.5 pr-4">
        <PriceCell source={source} now={now} />
      </td>
      <td data-col="trend" className="py-2.5 pr-4">
        <div data-price-trend>
          {child ? (
            aboveBest !== null ? (
              <span className="text-[11.5px] text-muted-foreground">
                +{money(aboveBest, source.currency)} vs best
              </span>
            ) : null
          ) : (
            <PriceTrend
              trend={trend}
              label={knifeTrend ? 'Best store price' : `Price at ${store}`}
            />
          )}
        </div>
      </td>
      <td
        data-col="checked"
        className="py-2.5 pr-1 text-xs whitespace-nowrap text-muted-foreground"
      >
        {paused ? (
          <span className="flex items-center gap-1.5">
            <StatusDot tone="bad" />
            {paused}
          </span>
        ) : showNext ? (
          source.stockIgnored ? (
            'not monitored'
          ) : source.nextCheckAt ? (
            nextCheckLabel(source.nextCheckAt, now)
          ) : (
            '—'
          )
        ) : source.lastCheckedAt ? (
          relativeTime(source.lastCheckedAt, now)
        ) : (
          'not yet'
        )}
      </td>
      <td data-col="actions" className="py-1 pr-1">
        <RowActions
          source={source}
          checking={checkingNow}
          canSolve={canSolve}
          onCheckNow={onCheckNow}
          onResolve={onResolve}
        />
      </td>
    </tr>
  )
}

/** The Pause suggestion under a listing that may be gone for good. */
function RetireRow({
  source,
  selected,
  now,
  onPaused,
}: {
  source: MonitoredSource
  selected: boolean
  now: number
  onPaused: () => void
}) {
  if (!source.retireHint) return null
  return (
    <tr
      data-price-retire-row
      className={cn(
        'border-b border-[var(--bladevault-line)]/60',
        selected && 'bg-[var(--bladevault-surface-soft)]',
      )}
    >
      <td colSpan={6} className="px-1 pb-2.5">
        <RetireHintNotice
          hint={source.retireHint}
          knifeId={source.knife.id}
          sourceId={source.sourceId}
          storeName={source.storeName}
          outOfStockSince={source.since}
          now={now}
          onPaused={onPaused}
          className="max-w-md"
        />
      </td>
    </tr>
  )
}

function laneNote(
  lanes: Map<string, QueueLane>,
  source: SourceSummary,
  hourCycle: 'h12' | 'h23',
  now: number,
) {
  const lane = lanes.get(source.laneKey)
  if (lane?.circuit === 'open' && lane.cooldownUntil)
    return `Store paused until ${clockTime(lane.cooldownUntil, hourCycle, now)}`
  return null
}

function RoundProgress({
  round,
  pausedStores,
}: {
  round: QueueRound
  pausedStores: number
}) {
  const done = Math.min(round.done, round.knives)
  return (
    <div data-price-round={round.trigger} className="mb-4 space-y-1.5">
      <p
        role="status"
        aria-live="polite"
        className="text-sm text-muted-foreground"
      >
        {round.trigger === 'manual' ? 'Check all: ' : 'Round: '}
        {roundText(round, pausedStores)}
      </p>
      <div
        role="progressbar"
        aria-label="Round progress"
        aria-valuemin={0}
        aria-valuemax={round.knives}
        aria-valuenow={done}
        className="h-1.5 max-w-md overflow-hidden rounded-full bg-[var(--bladevault-surface-soft)]"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500"
          style={{
            width: `${round.knives ? (done / round.knives) * 100 : 0}%`,
          }}
        />
      </div>
    </div>
  )
}

function SortHeader({
  label,
  sortKey,
  sort,
  align = 'right',
  onSort,
}: {
  label: string
  sortKey: SortKey
  sort: Sort
  align?: 'left' | 'right'
  onSort: (key: SortKey) => void
}) {
  const active = sort?.key === sortKey ? sort.dir : null
  const Icon =
    active === 'asc' ? ArrowUp : active === 'desc' ? ArrowDown : ArrowUpDown
  return (
    <th
      aria-sort={
        active === 'asc'
          ? 'ascending'
          : active === 'desc'
            ? 'descending'
            : 'none'
      }
      className={cn(
        'py-2 font-medium',
        align === 'right' ? 'pr-4 text-right' : 'pr-3 text-left',
      )}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          'inline-flex items-center gap-1 rounded-sm uppercase hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
          active && 'text-foreground',
        )}
      >
        {label}
        <Icon
          className={cn('size-3', !active && 'opacity-40')}
          aria-hidden="true"
        />
      </button>
    </th>
  )
}

/** Sort choices for the narrow layout, where the header row is hidden. */
const MOBILE_SORTS: Array<{ value: string; label: string; sort: Sort }> = [
  { value: 'default', label: 'By result', sort: null },
  {
    value: 'price-asc',
    label: 'Price, low first',
    sort: { key: 'price', dir: 'asc' },
  },
  {
    value: 'price-desc',
    label: 'Price, high first',
    sort: { key: 'price', dir: 'desc' },
  },
  {
    value: 'change-asc',
    label: 'Biggest 30-day drop',
    sort: { key: 'change', dir: 'asc' },
  },
  {
    value: 'paid-asc',
    label: 'Furthest below regular price',
    sort: { key: 'paid', dir: 'asc' },
  },
  {
    value: 'checked-desc',
    label: 'Recently checked',
    sort: { key: 'checked', dir: 'desc' },
  },
]

function sortValueOf(sort: Sort) {
  return sort ? `${sort.key}-${sort.dir}` : 'default'
}

/**
 * Price Drops: a monitoring status timeline with checks per hour, then every
 * monitored store listing in tabs beside the selected knife's chart and
 * sources. The tab and selected knife live in the URL (`?section=`,
 * `?knife=`).
 */
export function PriceDropsView({
  initialSection,
  initialKnife,
}: {
  initialSection?: string
  initialKnife?: string
} = {}) {
  const [version, setVersion] = useState(0)
  const { overview, error, loadedAt, retry } = useOverview(version)
  const trends = usePriceTrends(
    overview ? `${version}|${overview.kpis.lastSuccessAt ?? ''}` : null,
  )
  // The round Check all started, so its end can be announced.
  const [started, setStarted] = useState<number | null>(null)
  const [queueVersion, setQueueVersion] = useState(0)
  const [roundSeen, setRoundSeen] = useState<number | null>(null)
  const queue = useQueue(started !== null || roundSeen !== null, queueVersion)
  const agent = useAgentState(version)
  const now = useMinuteClock()
  const hourCycle = getHourCycle(useKnives().timeFormat)
  const canSolve = useSolveInBrowserAvailable()
  const narrow = useMediaQuery(NARROW_QUERY)
  const [storedSection, storeSection] = useStoredValue<Section>(
    STORAGE.section,
    'all',
    parseSection,
  )
  // The URL wins; a deep link to a knife opens All so the knife is listed.
  const [sectionChoice, setSectionChoice] = useState<Section | null>(
    () => parseSection(initialSection) ?? (initialKnife ? 'all' : null),
  )
  const section = sectionChoice ?? storedSection
  // The Supervisor tab sits beside the sections but is not a table filter.
  const [supervisorChoice, setSupervisorChoice] = useState(
    initialSection === 'supervisor',
  )
  const showSupervisor = supervisorChoice && hasAgentActivity(agent.state)
  const [grouped, setGrouped] = useStoredValue(STORAGE.grouped, '1', parseFlag)
  const [statusCollapsed, setStatusCollapsed] = useStoredValue(
    STORAGE.statusCollapsed,
    '0',
    parseFlag,
  )
  const [query, setQuery] = useState('')
  const [store, setStore] = useState<string>('all')
  const [sort, setSort] = useState<Sort>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [checked, setChecked] = useState<Set<number>>(() => new Set())
  const [checkingIds, setCheckingIds] = useState<Set<number>>(() => new Set())
  const [solveTarget, setSolveTarget] = useState<SolveTarget | null>(null)
  const [selected, setSelected] = useState<string | null>(initialKnife ?? null)
  const [sheetOpen, setSheetOpen] = useState(false)
  // The listing clicked last, so ungrouped details open under that row.
  const [openSource, setOpenSource] = useState<number | null>(null)
  const [checking, setChecking] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [confirm, setConfirm] = useState<BulkAction | null>(null)
  const scrollTarget = useRef<string | null>(initialKnife ?? null)
  const listRef = useRef<HTMLDivElement>(null)

  const lanes = new Map(
    (queue?.lanes ?? []).map((lane) => [lane.laneKey, lane]),
  )
  const checkingStores =
    queue?.lanes.filter((lane) => lane.checking).length ?? 0
  const pausedStores =
    queue?.lanes.filter((lane) => lane.circuit === 'open').length ?? 0
  const round = queue?.round ?? null
  const retryCount = queue ? queue.retries.waiting + queue.retries.scheduled : 0
  // A round seen running that is gone from the queue has finished, and so
  // has the one Check all started once it is the last round (it may end
  // between two polls). The table then reloads, and Check all says so.
  // Derived from the polled queue, so it is applied while rendering (React's
  // pattern for state that follows other state).
  const startedDone =
    started !== null && !round && queue?.lastRound?.id === started
  if (queue && ((round?.id ?? null) !== roundSeen || startedDone)) {
    if (startedDone) {
      setStarted(null)
      setNotice(
        `Check all finished.${retryCount ? ` ${retryCount} ${retryCount === 1 ? 'listing or search is' : 'listings or searches are'} on the retry list and will be tried again before the next round.` : ''}`,
      )
    }
    if (roundSeen !== null || startedDone) setVersion((value) => value + 1)
    setRoundSeen(round?.id ?? null)
  }

  const monitored = overview?.monitored ?? []
  const filtered = monitored.filter(
    (source) =>
      (store === 'all' || source.laneKey === store) &&
      matchesQuery(source, query),
  )
  // A grouped row charts the knife's best price; a listing its own store.
  // A grouped row charts the knife's best price across its stores (one
  // knife, many sources); a listing on its own charts its store.
  const trendOf = (source: MonitoredSource, byKnife: boolean) =>
    byKnife
      ? trends?.knives[source.knife.id]
      : trends?.sources[String(source.sourceId)]
  const rows = sortRows(
    section,
    filtered.filter(SECTION_FILTER[section]),
    sort,
    (source) => {
      const net = trendNetChange(trendOf(source, grouped === '1'))
      return net === null ? null : net * 100
    },
  )
  const visibleKnives = new Set(rows.map((source) => source.knife.id))
  const monitoredKnives = new Set(monitored.map((source) => source.knife.id))
  // Details open only for a chosen knife. A selection the current tab hides
  // closes; a knife that is not monitored stays open above the table.
  const selectedKnife =
    selected && (visibleKnives.has(selected) || !monitoredKnives.has(selected))
      ? selected
      : null
  const selectedUnlisted =
    selectedKnife !== null && !visibleKnives.has(selectedKnife)

  // Keep the tab and an explicit selection in the URL without new history.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (supervisorChoice) url.searchParams.set('section', 'supervisor')
    else if (section === 'all') url.searchParams.delete('section')
    else url.searchParams.set('section', section)
    if (selected) url.searchParams.set('knife', selected)
    else url.searchParams.delete('knife')
    if (url.href !== window.location.href)
      window.history.replaceState(null, '', url)
  }, [section, selected, supervisorChoice])

  // Bring a knife chosen outside the table (pin, deep link) into view.
  useEffect(() => {
    const target = scrollTarget.current
    if (!target || target !== selectedKnife || !overview) return
    scrollTarget.current = null
    listRef.current
      ?.querySelector<HTMLElement>(`[data-knife-row="${CSS.escape(target)}"]`)
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [selectedKnife, overview])

  const changeSection = (value: Section) => {
    setSupervisorChoice(false)
    setSectionChoice(value)
    storeSection(value)
  }

  const selectRow = (knifeId: string) => {
    if (narrow) {
      setSelected(knifeId)
      setSheetOpen(true)
      return
    }
    // A click on the open knife closes its details.
    setSelected(knifeId === selectedKnife ? null : knifeId)
  }

  /** A timeline pin or AI note: clear filters that would hide the knife. */
  const selectFromOutside = (knifeId: string) => {
    if (!visibleKnives.has(knifeId) && monitoredKnives.has(knifeId)) {
      changeSection('all')
      setQuery('')
      setStore('all')
    }
    scrollTarget.current = knifeId
    setSelected(knifeId)
    if (narrow) setSheetOpen(true)
  }

  const checkAll = async () => {
    setChecking(true)
    setNotice(null)
    try {
      const response = await fetch('/api/prices/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'all' }),
      })
      const data = (await response.json().catch(() => ({}))) as {
        round?: { id: number; knives: number }
        error?: string
      }
      if (!response.ok || !data.round)
        throw new Error(data.error ?? 'Could not start checks.')
      if (data.round.knives) setStarted(data.round.id)
      else setNotice('Nothing to check yet.')
      setQueueVersion((value) => value + 1)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not start checks.')
    } finally {
      setChecking(false)
    }
  }

  const checkOne = async (source: MonitoredSource) => {
    setCheckingIds((ids) => new Set(ids).add(source.sourceId))
    try {
      await requestCheck(source.sourceId)
      setNotice(
        `${knifeName(source)} at ${storeLabel(source.storeName)} is queued. Its store is checked at its own pace.`,
      )
    } catch (err) {
      setNotice(
        err instanceof Error ? err.message : 'Could not start the check.',
      )
    } finally {
      setCheckingIds((ids) => {
        const next = new Set(ids)
        next.delete(source.sourceId)
        return next
      })
    }
  }

  const checkedSources = monitored.filter((source) =>
    checked.has(source.sourceId),
  )
  const checkedKnives = [
    ...new Set(checkedSources.map((source) => source.knife.id)),
  ]

  const toggleChecked = (ids: number[]) =>
    setChecked((current) => {
      const next = new Set(current)
      const all = ids.every((id) => next.has(id))
      for (const id of ids) {
        if (all) next.delete(id)
        else next.add(id)
      }
      return next
    })

  const bulkSize = (action: BulkAction) =>
    action.kind === 'mode' ? checkedKnives.length : checkedSources.length

  const runBulk = async (action: BulkAction) => {
    setConfirm(null)
    setBulkBusy(true)
    setNotice(null)
    try {
      let done: { failed: number; firstError: string | null }
      let summary: string
      if (action.kind === 'check') {
        done = await runEach(checkedSources, (source) =>
          requestCheck(source.sourceId),
        )
        summary = `${checkedSources.length - done.failed} ${checkedSources.length === 1 ? 'listing is' : 'listings are'} queued. Each store is checked at its own pace.`
      } else if (action.kind === 'pause') {
        done = await runEach(checkedKnives, (knifeId) =>
          updateWatch(knifeId, {
            update: checkedSources
              .filter((source) => source.knife.id === knifeId)
              .map((source) => ({ id: source.sourceId, enabled: false })),
          }),
        )
        summary = `Paused ${checkedSources.length} ${checkedSources.length === 1 ? 'listing' : 'listings'}. Resume them in each knife's edit mode.`
      } else {
        done = await runEach(checkedKnives, (knifeId) =>
          updateWatch(knifeId, { mode: action.mode }),
        )
        summary = `${checkedKnives.length - done.failed} ${checkedKnives.length === 1 ? 'knife is' : 'knives are'} set to ${MODE_LABEL[action.mode]}.`
      }
      setNotice(
        done.failed
          ? `${summary} ${done.failed} failed: ${done.firstError}`
          : summary,
      )
      if (action.kind !== 'check') setChecked(new Set())
      setVersion((value) => value + 1)
    } finally {
      setBulkBusy(false)
    }
  }

  const startBulk = (action: BulkAction) => {
    if (bulkSize(action) >= BULK_CONFIRM_AT) setConfirm(action)
    else void runBulk(action)
  }

  const header = (
    <PageHeader
      title="Price Drops"
      description="Market prices for knives in your collection, checked gently store by store."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {queue ? (
            <span
              data-price-queue
              className="inline-flex items-center gap-2 rounded-full border border-[var(--bladevault-line)] px-2.5 py-1 text-xs text-muted-foreground"
            >
              <StatusDot tone={checkingStores || round ? 'run' : 'idle'} />
              {!queue.enabled
                ? 'Automatic checks are off'
                : round
                  ? `Round: ${Math.min(round.done, round.knives)} of ${round.knives} ${round.knives === 1 ? 'knife' : 'knives'}`
                  : checkingStores
                    ? `${checkingStores} ${checkingStores === 1 ? 'store' : 'stores'} checking`
                    : queue.nextRoundAt
                      ? `Next round ${clockTime(queue.nextRoundAt, hourCycle, now)}`
                      : 'Waiting for the next check'}
              {queue.enabled && retryCount ? ` · retry list ${retryCount}` : ''}
              {overview?.kpis.lastSuccessAt
                ? ` · last check ${relativeTime(overview.kpis.lastSuccessAt, now)}`
                : ''}
            </span>
          ) : null}
          {queue?.scope && queue.scope.kind !== 'all' ? (
            <Link
              href="/settings?tab=prices"
              data-price-scope={queue.scope.kind}
              title="What to monitor: change it in Settings"
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--bladevault-line)] px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {queue.scope.knives
                ? `${SCOPE_LABEL[queue.scope.kind]} · ${queue.scope.knives} ${queue.scope.knives === 1 ? 'knife' : 'knives'}`
                : queue.scope.kind === 'wishlist'
                  ? 'Wishlist is empty: nothing is monitored'
                  : 'Monitoring stopped for every knife'}
              <span className="underline">Change</span>
            </Link>
          ) : null}
          <Button
            size="sm"
            onClick={() => void checkAll()}
            disabled={
              checking ||
              round !== null ||
              !overview?.kpis.monitoredKnives ||
              queue?.enabled === false
            }
            aria-describedby={
              queue?.enabled === false ? 'price-checks-off' : undefined
            }
            title={
              queue?.enabled === false
                ? 'Turn on automatic checks in Settings to check every knife.'
                : round
                  ? 'A round is checking every knife now.'
                  : undefined
            }
          >
            {checking || round ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Check all now
          </Button>
          <PriceExportButton label="Export all" />
        </div>
      }
    />
  )

  if (error && !overview)
    return (
      <div data-price-drops className="w-full">
        {header}
        <p className="text-sm text-destructive">{error}</p>
        <Button size="sm" variant="outline" className="mt-2" onClick={retry}>
          Try again
        </Button>
      </div>
    )
  if (!overview)
    return (
      <div data-price-drops className="w-full">
        {header}
        <div className="grid h-40 place-items-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    )

  const { kpis } = overview
  const empty = kpis.monitoredKnives === 0 && kpis.knivesWithSources === 0
  const stores = storeOptions(monitored)
  const filtering = query.trim() !== '' || store !== 'all'
  const groups = grouped === '1' ? groupByKnife(rows) : null
  const visibleIds = rows.map((source) => source.sourceId)
  const allChecked =
    visibleIds.length > 0 && visibleIds.every((id) => checked.has(id))
  const someChecked = !allChecked && visibleIds.some((id) => checked.has(id))

  const renderRow = (
    source: MonitoredSource,
    options: {
      group?: { count: number; expanded: boolean; onToggle: () => void }
      ids?: number[]
      child?: boolean
      bestMinor?: number | null
    } = {},
  ) => {
    const ids = options.ids ?? [source.sourceId]
    const byKnife = Boolean(options.group)
    const ticked = ids.filter((id) => checked.has(id)).length
    return (
      <SourceTableRow
        key={`${options.child ? 'c' : 'r'}-${source.sourceId}`}
        source={source}
        section={section}
        selected={!options.child && selectedKnife === source.knife.id}
        checked={ticked === ids.length ? true : ticked ? 'some' : false}
        lanes={lanes}
        now={now}
        checkingNow={checkingIds.has(source.sourceId)}
        hourCycle={hourCycle}
        canSolve={canSolve}
        trend={options.child ? undefined : trendOf(source, byKnife)}
        knifeTrend={byKnife}
        bestMinor={options.bestMinor}
        group={options.group}
        child={options.child}
        onSelect={() => {
          // Ungrouped, another listing of the open knife moves its details.
          if (
            !groups &&
            !narrow &&
            source.knife.id === selectedKnife &&
            source.sourceId !== openSource
          ) {
            setOpenSource(source.sourceId)
            return
          }
          setOpenSource(source.sourceId)
          selectRow(source.knife.id)
        }}
        onToggleChecked={() => toggleChecked(ids)}
        onCheckNow={() => void checkOne(source)}
        onResolve={() => {
          setSelected(source.knife.id)
          setSolveTarget({
            sourceId: source.sourceId,
            url: source.url,
            storeName: source.storeName,
            status: source.status,
          })
        }}
      />
    )
  }

  // On a phone the knife opens in a sheet with its own close button.
  const panel = selectedKnife ? (
    <KnifePricePanel
      key={selectedKnife}
      knifeId={selectedKnife}
      // A knife without a table row keeps its own header.
      variant={narrow || selectedUnlisted ? 'page' : 'inline'}
      onClose={narrow ? undefined : () => setSelected(null)}
      onChanged={() => setVersion((value) => value + 1)}
    />
  ) : null
  const detailRow = (knifeId: string) =>
    !narrow && panel && knifeId === selectedKnife ? (
      <tr key={`detail-${knifeId}`} data-price-detail-row>
        <td colSpan={6} className="px-4 pt-1 pb-4">
          <div role="region" aria-label="Knife prices">
            {panel}
          </div>
        </td>
      </tr>
    ) : null

  return (
    <div data-price-drops className="w-full">
      {header}
      {error ? (
        <div
          role="status"
          data-price-stale
          className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--bladevault-line)] bg-[var(--bladevault-surface-soft)] px-3 py-2 text-sm"
        >
          <span>
            Could not refresh prices: {error} Showing data from{' '}
            {loadedAt
              ? relativeTime(new Date(loadedAt).toISOString(), now)
              : 'earlier'}
            .
          </span>
          <Button size="xs" variant="outline" onClick={retry}>
            Retry
          </Button>
        </div>
      ) : null}
      {round ? (
        <RoundProgress round={round} pausedStores={pausedStores} />
      ) : notice ? (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {queue && !queue.enabled ? (
        <p
          id="price-checks-off"
          className="mb-4 rounded-lg border border-[var(--bladevault-line)] bg-[var(--bladevault-surface-soft)] px-3 py-2 text-sm"
        >
          Automatic checks are off, so Check all now is unavailable. Check now
          still works per knife and per store.{' '}
          <Link href="/settings?tab=prices" className="underline">
            Turn them on in Settings
          </Link>
          .
        </p>
      ) : null}

      {empty ? (
        <Card>
          <CardContent className="space-y-2 py-6 text-sm">
            <p className="font-medium">No knives are monitored yet.</p>
            <p className="text-muted-foreground">
              Knives with a stored regular price and a product link are checked
              automatically. Add a price to a knife, or open it in edit mode and
              choose Always monitor; you can add up to 10 store URLs per knife.
            </p>
            <Link
              href="/collection"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              Open the collection
            </Link>
          </CardContent>
        </Card>
      ) : (
        <>
          <AgentStrip controls={agent} now={now} />
          <MonitoringStatus
            overview={overview}
            selectedKnife={selectedKnife}
            now={now}
            collapsed={statusCollapsed === '1'}
            onCollapsedChange={(value) => setStatusCollapsed(value ? '1' : '0')}
            onSelect={selectFromOutside}
          />

          <Card data-price-table className="mt-4 gap-0 overflow-hidden py-0">
            <div className="space-y-2 border-b border-[var(--bladevault-line)]/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div
                  role="tablist"
                  aria-label="Price sections"
                  className="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg border border-[var(--bladevault-line)] p-0.5"
                >
                  {SECTIONS.map((value) => {
                    const count =
                      value === 'recent'
                        ? null
                        : filtered.filter(SECTION_FILTER[value]).length
                    return (
                      <button
                        key={value}
                        type="button"
                        role="tab"
                        aria-selected={!showSupervisor && section === value}
                        onClick={() => changeSection(value)}
                        className={cn(
                          'rounded-md px-2.5 py-1 text-xs transition-colors sm:text-sm',
                          !showSupervisor && section === value
                            ? 'bg-[var(--bladevault-nav-active-bg)] font-semibold text-[var(--bladevault-nav-active-fg)]'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {SECTION_LABEL[value]}
                        {count ? (
                          <span className="ml-1 text-[11px] opacity-75">
                            {count}
                          </span>
                        ) : null}
                      </button>
                    )
                  })}
                  {hasAgentActivity(agent.state) ? (
                    <>
                      <span
                        aria-hidden="true"
                        className="mx-1 my-1 w-px bg-[var(--bladevault-line)]"
                      />
                      <button
                        type="button"
                        role="tab"
                        aria-selected={showSupervisor}
                        onClick={() => setSupervisorChoice(true)}
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors sm:text-sm',
                          showSupervisor
                            ? 'bg-[var(--bladevault-nav-active-bg)] font-semibold text-[var(--bladevault-nav-active-fg)]'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        <Bot className="size-3.5" aria-hidden="true" />
                        Supervisor
                      </button>
                    </>
                  ) : null}
                </div>
                <Link
                  href="/settings?tab=prices"
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Monitoring settings ›
                </Link>
              </div>
              <div
                data-price-toolbar
                className={cn(
                  'flex flex-wrap items-center gap-2',
                  showSupervisor && 'hidden',
                )}
              >
                <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
                  <Search
                    className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search brand, name, model or store"
                    aria-label="Search monitored knives"
                    className="pl-8"
                  />
                </div>
                <Select
                  value={store}
                  onValueChange={(value) => setStore(value ?? 'all')}
                >
                  <SelectTrigger
                    aria-label="Filter by store"
                    className="max-w-[14rem]"
                  >
                    <SelectValue>
                      {store === 'all'
                        ? 'All stores'
                        : (stores.find((option) => option.laneKey === store)
                            ?.label ?? 'All stores')}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All stores</SelectItem>
                    {stores.map((option) => (
                      <SelectItem key={option.laneKey} value={option.laneKey}>
                        {option.label} · {option.count}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="sm:hidden">
                  <Select
                    value={sortValueOf(sort)}
                    onValueChange={(value) =>
                      setSort(
                        MOBILE_SORTS.find((option) => option.value === value)
                          ?.sort ?? null,
                      )
                    }
                  >
                    <SelectTrigger aria-label="Sort listings">
                      <SelectValue>
                        {MOBILE_SORTS.find(
                          (option) => option.value === sortValueOf(sort),
                        )?.label ?? 'By result'}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {MOBILE_SORTS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-pressed={grouped === '1'}
                  onClick={() => setGrouped(grouped === '1' ? '0' : '1')}
                  className={cn(
                    grouped === '1' &&
                      'bg-[var(--bladevault-surface-soft)] font-semibold',
                  )}
                >
                  Group by knife
                </Button>
                {filtering ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setQuery('')
                      setStore('all')
                    }}
                  >
                    Clear filters
                  </Button>
                ) : null}
              </div>
              {checkedSources.length && !showSupervisor ? (
                <div
                  data-price-bulk
                  role="toolbar"
                  aria-label="Bulk actions"
                  className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--bladevault-surface-soft)] px-2.5 py-1.5 text-sm"
                >
                  <span className="font-medium">
                    {checkedSources.length}{' '}
                    {checkedSources.length === 1 ? 'listing' : 'listings'}{' '}
                    selected
                  </span>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={bulkBusy}
                    onClick={() => startBulk({ kind: 'check' })}
                  >
                    Check now
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={bulkBusy}
                    onClick={() => startBulk({ kind: 'pause' })}
                  >
                    Pause
                  </Button>
                  <Select
                    value={null}
                    onValueChange={(value) => {
                      if (value)
                        startBulk({
                          kind: 'mode',
                          mode: value as PriceWatchMode,
                        })
                    }}
                    disabled={bulkBusy}
                  >
                    <SelectTrigger size="sm" aria-label="Set monitoring mode">
                      <SelectValue placeholder="Set mode…" />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(MODE_LABEL) as PriceWatchMode[]).map(
                        (mode) => (
                          <SelectItem key={mode} value={mode}>
                            {MODE_LABEL[mode]}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={bulkBusy}
                    onClick={() => setChecked(new Set())}
                  >
                    Clear selection
                  </Button>
                  {bulkBusy ? (
                    <Loader2
                      className="size-3.5 animate-spin text-muted-foreground"
                      aria-label="Working"
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
            {showSupervisor ? (
              <div role="tabpanel" aria-label="Supervisor">
                <AgentActivity
                  controls={agent}
                  onSelect={(knifeId) => {
                    setSupervisorChoice(false)
                    selectFromOutside(knifeId)
                  }}
                />
              </div>
            ) : (
              <div>
                {!narrow && selectedUnlisted && panel ? (
                  <section
                    aria-label="Knife prices"
                    data-price-detail-unlisted
                    className="mx-3 mb-3 rounded-lg border border-[var(--bladevault-line)] bg-[var(--bladevault-surface-soft)] p-4"
                  >
                    {panel}
                  </section>
                ) : null}
                <div
                  ref={listRef}
                  role="tabpanel"
                  aria-label={SECTION_LABEL[section]}
                  className="min-w-0 overflow-x-auto px-3 pb-2"
                >
                  {rows.length ? (
                    <table
                      data-price-grid
                      className="w-full border-collapse text-sm"
                    >
                      <thead>
                        <tr className="border-b border-[var(--bladevault-line)] text-left text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
                          <th className="w-7 py-2 pr-2 pl-1 font-medium">
                            <Checkbox
                              aria-label="Select every listing shown"
                              checked={allChecked}
                              indeterminate={someChecked}
                              onCheckedChange={() =>
                                setChecked((current) => {
                                  const next = new Set(current)
                                  for (const id of visibleIds) {
                                    if (allChecked) next.delete(id)
                                    else next.add(id)
                                  }
                                  return next
                                })
                              }
                            />
                          </th>
                          <th className="py-2 pr-3 font-medium">Knife</th>
                          <SortHeader
                            label="Price"
                            sortKey="price"
                            sort={sort}
                            onSort={(key) => setSort(nextSort(sort, key))}
                          />
                          <SortHeader
                            label="Trend · 30d"
                            sortKey="change"
                            sort={sort}
                            onSort={(key) => setSort(nextSort(sort, key))}
                          />
                          {section === 'attention' ? (
                            <th className="py-2 pr-1 font-medium">
                              Next check
                            </th>
                          ) : (
                            <SortHeader
                              label="Checked"
                              sortKey="checked"
                              sort={sort}
                              align="left"
                              onSort={(key) => setSort(nextSort(sort, key))}
                            />
                          )}
                          <th className="py-2 pr-1 font-medium">
                            <span className="sr-only">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {groups
                          ? groups.map((group) => {
                              const open = expanded.has(group.knifeId)
                              return (
                                <Fragment key={group.knifeId}>
                                  {renderRow(group.lead, {
                                    ids: group.sources.map((s) => s.sourceId),
                                    group: {
                                      count: group.sources.length,
                                      expanded: open,
                                      onToggle: () =>
                                        setExpanded((current) => {
                                          const next = new Set(current)
                                          if (next.has(group.knifeId))
                                            next.delete(group.knifeId)
                                          else next.add(group.knifeId)
                                          return next
                                        }),
                                    },
                                  })}
                                  {open && group.sources.length > 1
                                    ? group.sources.map((source) =>
                                        renderRow(source, {
                                          child: true,
                                          bestMinor: group.lead.priceMinor,
                                        }),
                                      )
                                    : null}
                                  {detailRow(group.knifeId)}
                                </Fragment>
                              )
                            })
                          : rows.flatMap((source, index) => [
                              renderRow(source),
                              section === 'attention' && source.retireHint ? (
                                <RetireRow
                                  key={`${source.sourceId}-retire`}
                                  source={source}
                                  selected={selectedKnife === source.knife.id}
                                  now={now}
                                  onPaused={() =>
                                    setVersion((value) => value + 1)
                                  }
                                />
                              ) : null,
                              // Details open under the clicked listing, or
                              // the knife's first one.
                              source.knife.id === selectedKnife &&
                              (source.sourceId === openSource ||
                                (!rows.some(
                                  (row) =>
                                    row.sourceId === openSource &&
                                    row.knife.id === selectedKnife,
                                ) &&
                                  rows.findIndex(
                                    (row) => row.knife.id === selectedKnife,
                                  ) === index))
                                ? detailRow(source.knife.id)
                                : null,
                            ])}
                      </tbody>
                    </table>
                  ) : (
                    <p className="py-6 text-sm text-muted-foreground">
                      {filtering
                        ? 'Nothing here matches the search or store filter.'
                        : EMPTY_TEXT[section]}
                    </p>
                  )}
                </div>
              </div>
            )}
          </Card>
        </>
      )}
      <Dialog
        open={narrow && sheetOpen && Boolean(panel)}
        onOpenChange={(open) => {
          if (!open) setSheetOpen(false)
        }}
      >
        <DialogContent
          data-price-sheet
          className="top-auto bottom-0 max-h-[88dvh] max-w-full translate-y-0 overflow-y-auto rounded-b-none pt-10 sm:max-w-full"
        >
          <DialogTitle className="sr-only">Knife prices</DialogTitle>
          {panel}
        </DialogContent>
      </Dialog>
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm?.kind === 'check'
                ? `Check ${checkedSources.length} listings now?`
                : confirm?.kind === 'pause'
                  ? `Pause ${checkedSources.length} listings?`
                  : confirm?.kind === 'mode'
                    ? `Set ${checkedKnives.length} knives to ${MODE_LABEL[confirm.mode]}?`
                    : ''}
            </DialogTitle>
            <DialogDescription>
              {confirm?.kind === 'check'
                ? 'They join each store’s queue and are checked one at a time per store, so this can take a while.'
                : confirm?.kind === 'pause'
                  ? 'Paused listings are not checked and leave this list. Resume them in each knife’s edit mode.'
                  : confirm?.kind === 'mode' && confirm.mode === 'off'
                    ? 'These knives stop being monitored and leave this list. Their price history is kept.'
                    : 'This changes how each knife is monitored. You can change it back in edit mode.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (confirm) void runBulk(confirm)
              }}
            >
              {confirm?.kind === 'check'
                ? 'Check now'
                : confirm?.kind === 'pause'
                  ? 'Pause'
                  : 'Change mode'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <SolveInBrowserDialog
        target={solveTarget}
        onClose={() => setSolveTarget(null)}
        onSolved={() => setVersion((value) => value + 1)}
      />
    </div>
  )
}

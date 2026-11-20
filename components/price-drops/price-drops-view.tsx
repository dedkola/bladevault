'use client'

import Link from 'next/link'
import { Fragment, useEffect, useRef, useState } from 'react'
import {
  AppWindow,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
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
import { AgentFeed, AgentStrip, useAgentState } from './agent-panel'
import { KnifePricePanel } from './knife-price-panel'
import { MonitoringStatus, ResultBadge } from './monitoring-status'
import { PriceExportButton } from './price-export-button'
import { RetireHintNotice } from './retire-hint'
import {
  clockTime,
  money,
  nextCheckLabel,
  relativeTime,
  storeLabel,
} from './price-format'
import {
  EMPTY_TEXT,
  groupByKnife,
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

type QueueSnapshot = {
  enabled: boolean
  scheduledActive: boolean
  /** Check now requests and due scheduled checks. */
  waiting: number
  /** Sources checked since the `since` asked for, else null. */
  checkedSince: number | null
  lanes: QueueLane[]
}

/** A running Check all: when it started (server time) and how many. */
type CheckAllRun = { startedAt: string; total: number }

const OVERVIEW_REFRESH_MS = 60_000
const QUEUE_REFRESH_MS = 10_000
/** Faster while Check all runs, so its progress moves visibly. */
const PROGRESS_REFRESH_MS = 3_000
/** Bulk changes to this many listings or knives ask first. */
const BULK_CONFIRM_AT = 5
const NARROW_QUERY = '(max-width: 639px)'

const STORAGE = {
  section: 'bladevault.priceDrops.section',
  grouped: 'bladevault.priceDrops.groupByKnife',
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

function useQueue(since: string | null) {
  const [queue, setQueue] = useState<QueueSnapshot | null>(null)
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const url = since
          ? `/api/prices/queue?since=${encodeURIComponent(since)}`
          : '/api/prices/queue'
        const response = await fetch(url, { cache: 'no-store' })
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
      since ? PROGRESS_REFRESH_MS : QUEUE_REFRESH_MS,
    )
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [since])
  return queue
}

/** "34 of 221 checked", with why the rest may wait. */
function progressText(
  run: CheckAllRun,
  checked: number,
  queue: QueueSnapshot,
  pausedStores: number,
): string {
  const parts = [`${Math.min(checked, run.total)} of ${run.total} checked`]
  if (!queue.scheduledActive) parts.push('waiting for the checking hours')
  else if (pausedStores)
    parts.push(
      `${pausedStores} ${pausedStores === 1 ? 'store is' : 'stores are'} paused after a bot check`,
    )
  else parts.push('each store at its own pace')
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

function VsPaid({ source }: { source: MonitoredSource }) {
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
  if (!paid) return <span className="text-muted-foreground">—</span>
  if (paid.deltaMinor === 0)
    return <span className="text-muted-foreground">same</span>
  const below = paid.deltaMinor < 0
  return (
    <span
      className="tabular-nums"
      data-result={below ? 'drop' : 'increase'}
      style={{
        color: 'color-mix(in srgb, var(--pd-color) 80%, var(--foreground))',
      }}
    >
      {below ? '−' : '+'}
      {money(Math.abs(paid.deltaMinor), source.currency)}
      <span className="block text-[11px] opacity-80">
        {below ? '−' : '+'}
        {Math.abs(paid.pct).toFixed(0)}%
      </span>
    </span>
  )
}

/**
 * The price now. A check that could not read the page keeps the last known
 * price, shown muted with its date so it never passes for a fresh reading.
 */
function PriceCell({ source }: { source: MonitoredSource }) {
  if (source.result === 'attention' && source.priceMinor !== null)
    return (
      <span
        className="text-muted-foreground"
        title="Last price read on this page"
      >
        <span className="tabular-nums">
          {money(source.priceMinor, source.currency)}
        </span>
        <span className="block text-[11px]">
          {source.priceSeenAt
            ? `as of ${shortDate(source.priceSeenAt)}`
            : 'last known'}
        </span>
      </span>
    )
  return (
    <>
      <span className="font-semibold tabular-nums">
        {money(source.priceMinor, source.currency)}
      </span>
      {source.previousPriceMinor !== null ? (
        <span className="block text-[11px] text-muted-foreground line-through tabular-nums">
          {money(source.previousPriceMinor, source.currency)}
        </span>
      ) : null}
    </>
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
      <td data-col="check" className="py-2 pr-2 pl-1">
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
      <td data-col="knife" className="py-2 pr-3">
        <div className={cn('flex min-w-0 items-center gap-1', child && 'pl-6')}>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onSelect()
            }}
            aria-pressed={selected}
            className="flex min-w-0 items-center gap-2.5 rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {child ? null : (
              <KnifeThumb knife={source.knife} className="size-8" />
            )}
            <span className="min-w-0">
              {child ? null : (
                <span className="block max-w-[16rem] truncate font-medium">
                  {name}
                </span>
              )}
              {source.knife.subtitle && !child ? (
                <span
                  data-price-subtitle
                  className="block max-w-[16rem] truncate text-xs text-muted-foreground"
                >
                  {source.knife.subtitle}
                </span>
              ) : null}
              <span className="block truncate text-xs text-muted-foreground">
                {group && group.count > 1
                  ? `Best at ${store} · ${group.count} stores`
                  : store}
              </span>
            </span>
          </button>
          {group && group.count > 1 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-expanded={group.expanded}
              aria-label={`${group.expanded ? 'Hide' : 'Show'} ${group.count} stores for ${name}`}
              onClick={(event) => {
                event.stopPropagation()
                group.onToggle()
              }}
            >
              <ChevronRight
                className={cn(
                  'size-3.5 transition-transform',
                  group.expanded && 'rotate-90',
                )}
              />
            </Button>
          ) : null}
        </div>
      </td>
      <td data-col="price" className="py-2 pr-3 text-right whitespace-nowrap">
        <PriceCell source={source} />
      </td>
      <td data-col="change" className="py-2 pr-3">
        <ResultBadge
          source={source}
          now={now}
          onResolve={canSolve ? onResolve : undefined}
          solveUnavailable={
            canSolve === false ? SOLVE_UNAVAILABLE_TEXT : undefined
          }
        />
      </td>
      <td data-col="paid" className="py-2 pr-3 text-right whitespace-nowrap">
        <VsPaid source={source} />
      </td>
      <td
        data-col="checked"
        className="py-2 pr-1 text-xs whitespace-nowrap text-muted-foreground"
      >
        {paused ? (
          <span className="flex items-center gap-1.5">
            <StatusDot tone="bad" />
            {paused}
          </span>
        ) : showNext ? (
          source.nextCheckAt ? (
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
      <td colSpan={7} className="px-1 pb-2.5">
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

function CheckAllProgress({
  run,
  checked,
  queue,
  pausedStores,
}: {
  run: CheckAllRun
  checked: number | null
  queue: QueueSnapshot | null
  pausedStores: number
}) {
  const done = Math.min(checked ?? 0, run.total)
  return (
    <div data-price-check-progress className="mb-4 space-y-1.5">
      <p
        role="status"
        aria-live="polite"
        className="text-sm text-muted-foreground"
      >
        {queue && checked !== null
          ? progressText(run, checked, queue, pausedStores)
          : `${run.total} ${run.total === 1 ? 'product' : 'products'} queued`}
      </p>
      <div
        role="progressbar"
        aria-label="Check all progress"
        aria-valuemin={0}
        aria-valuemax={run.total}
        aria-valuenow={done}
        className="h-1.5 max-w-md overflow-hidden rounded-full bg-[var(--bladevault-surface-soft)]"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500"
          style={{ width: `${(done / run.total) * 100}%` }}
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
        'py-2 pr-3 font-medium',
        align === 'right' ? 'text-right' : 'text-left',
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
    label: 'Biggest drop',
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
  const [run, setRun] = useState<CheckAllRun | null>(null)
  const queue = useQueue(run?.startedAt ?? null)
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
  const [grouped, setGrouped] = useStoredValue(STORAGE.grouped, '0', parseFlag)
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
  // Check all is done when every queued product was checked, or nothing is
  // waiting or running any more (e.g. sources removed meanwhile).
  const runChecked = run ? (queue?.checkedSince ?? null) : null
  const runDone =
    run !== null &&
    runChecked !== null &&
    (runChecked >= run.total || (queue!.waiting === 0 && checkingStores === 0))
  // Finishing is derived from the polled queue, so it is applied while
  // rendering (React's pattern for state that follows other state).
  if (run && runDone) {
    setRun(null)
    setNotice(
      `Check all finished: ${Math.min(runChecked ?? 0, run.total)} of ${run.total} checked.`,
    )
    setVersion((value) => value + 1)
  }

  const monitored = overview?.monitored ?? []
  const filtered = monitored.filter(
    (source) =>
      (store === 'all' || source.laneKey === store) &&
      matchesQuery(source, query),
  )
  const rows = sortRows(section, filtered.filter(SECTION_FILTER[section]), sort)
  const visibleKnives = new Set(rows.map((source) => source.knife.id))
  const monitoredKnives = new Set(monitored.map((source) => source.knife.id))
  // The panel follows the table: a selection the current tab hides gives
  // way to its first row. A knife that is not monitored stays selected.
  const selectedKnife =
    selected && (visibleKnives.has(selected) || !monitoredKnives.has(selected))
      ? selected
      : (rows[0]?.knife.id ?? selected ?? monitored[0]?.knife.id ?? null)

  // Keep the tab and an explicit selection in the URL without new history.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (section === 'all') url.searchParams.delete('section')
    else url.searchParams.set('section', section)
    if (selected) url.searchParams.set('knife', selected)
    else url.searchParams.delete('knife')
    if (url.href !== window.location.href)
      window.history.replaceState(null, '', url)
  }, [section, selected])

  // Bring a knife chosen outside the table (pin, deep link) into view.
  useEffect(() => {
    const target = scrollTarget.current
    if (!target || target !== selectedKnife || !overview) return
    scrollTarget.current = null
    listRef.current
      ?.querySelector<HTMLElement>(`[data-knife-row="${CSS.escape(target)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedKnife, overview])

  const changeSection = (value: Section) => {
    setSectionChoice(value)
    storeSection(value)
  }

  const selectRow = (knifeId: string) => {
    setSelected(knifeId)
    if (narrow) setSheetOpen(true)
  }

  /** A timeline pin or AI note: clear filters that would hide the knife. */
  const selectFromOutside = (knifeId: string) => {
    if (!visibleKnives.has(knifeId) && monitoredKnives.has(knifeId)) {
      changeSection('all')
      setQuery('')
      setStore('all')
    }
    scrollTarget.current = knifeId
    selectRow(knifeId)
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
        due?: number
        startedAt?: string
        error?: string
      }
      if (!response.ok) throw new Error(data.error ?? 'Could not start checks.')
      if (data.due && data.startedAt)
        setRun({ startedAt: data.startedAt, total: data.due })
      else setNotice('Nothing to check yet.')
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
              <StatusDot tone={checkingStores ? 'run' : 'idle'} />
              {!queue.enabled
                ? 'Automatic checks are off'
                : checkingStores
                  ? `${checkingStores} ${checkingStores === 1 ? 'store' : 'stores'} checking`
                  : queue.scheduledActive
                    ? 'Waiting for the next check'
                    : 'Outside checking hours'}
              {overview?.kpis.lastSuccessAt
                ? ` · last check ${relativeTime(overview.kpis.lastSuccessAt, now)}`
                : ''}
            </span>
          ) : null}
          <Button
            size="sm"
            onClick={() => void checkAll()}
            disabled={
              checking ||
              run !== null ||
              !overview?.kpis.monitoredKnives ||
              queue?.enabled === false
            }
            aria-describedby={
              queue?.enabled === false ? 'price-checks-off' : undefined
            }
            title={
              queue?.enabled === false
                ? 'Turn on automatic checks in Settings to check every knife.'
                : undefined
            }
          >
            {checking || run ? (
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
    } = {},
  ) => {
    const ids = options.ids ?? [source.sourceId]
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
        group={options.group}
        child={options.child}
        onSelect={() => selectRow(source.knife.id)}
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

  const panel = selectedKnife ? (
    <KnifePricePanel
      key={selectedKnife}
      knifeId={selectedKnife}
      variant="page"
      // On a phone the sheet has its own close button.
      onClose={!narrow && selected ? () => setSelected(null) : undefined}
      onChanged={() => setVersion((value) => value + 1)}
    />
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
      {run ? (
        <CheckAllProgress
          run={run}
          checked={runChecked}
          queue={queue}
          pausedStores={pausedStores}
        />
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
            pausedStores={pausedStores}
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
                        aria-selected={section === value}
                        onClick={() => changeSection(value)}
                        className={cn(
                          'rounded-md px-2.5 py-1 text-xs transition-colors sm:text-sm',
                          section === value
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
                className="flex flex-wrap items-center gap-2"
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
              {checkedSources.length ? (
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
            <div className="grid items-start lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
              <div
                ref={listRef}
                role="tabpanel"
                aria-label={SECTION_LABEL[section]}
                className="min-w-0 overflow-x-auto px-3 pb-2 lg:max-h-[720px] lg:overflow-y-auto"
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
                          label="Price now"
                          sortKey="price"
                          sort={sort}
                          onSort={(key) => setSort(nextSort(sort, key))}
                        />
                        <SortHeader
                          label="Change"
                          sortKey="change"
                          sort={sort}
                          align="left"
                          onSort={(key) => setSort(nextSort(sort, key))}
                        />
                        <SortHeader
                          label="vs regular"
                          sortKey="paid"
                          sort={sort}
                          onSort={(key) => setSort(nextSort(sort, key))}
                        />
                        {section === 'attention' ? (
                          <th className="py-2 pr-1 font-medium">Next check</th>
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
                                      renderRow(source, { child: true }),
                                    )
                                  : null}
                              </Fragment>
                            )
                          })
                        : rows.flatMap((source) => [
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
              <aside
                aria-label="Selected knife"
                className="border-t border-[var(--bladevault-line)]/60 p-4 lg:sticky lg:top-0 lg:border-t-0 lg:border-l"
              >
                {narrow ? null : panel ? (
                  panel
                ) : (
                  <p className="py-6 text-sm text-muted-foreground">
                    Select a knife to see its price history.
                  </p>
                )}
                <AgentFeed controls={agent} onSelect={selectFromOutside} />
              </aside>
            </div>
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

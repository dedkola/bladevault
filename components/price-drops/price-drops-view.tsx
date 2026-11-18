'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type {
  MonitoredSource,
  PriceOverview,
  SourceSummary,
} from '@/lib/price-monitor/insights'
import { cn } from '@/lib/utils'
import { KnifePricePanel } from './knife-price-panel'
import { MonitoringStatus, ResultBadge } from './monitoring-status'
import { money, relativeTime, storeLabel } from './price-format'
import { KnifeThumb, StatusDot, useMinuteClock } from './price-ui'
import { SolveInBrowserDialog, type SolveTarget } from './solve-in-browser'

type QueueLane = {
  laneKey: string
  circuit: 'closed' | 'open'
  cooldownUntil: string | null
  checking: boolean
}

type QueueSnapshot = {
  enabled: boolean
  scheduledActive: boolean
  lanes: QueueLane[]
}

type Section =
  'all' | 'changes' | 'drops' | 'increases' | 'oos' | 'attention' | 'recent'

const OVERVIEW_REFRESH_MS = 60_000
const QUEUE_REFRESH_MS = 10_000

function useOverview(version: number) {
  const [overview, setOverview] = useState<PriceOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
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
        if (!response.ok || !data.overview)
          setError(data.error ?? 'Could not load price monitoring.')
        else {
          setError(null)
          setOverview(data.overview)
        }
      } catch {
        if (!controller.signal.aborted)
          setError('Could not load price monitoring.')
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
  return { overview, error }
}

function useQueue() {
  const [queue, setQueue] = useState<QueueSnapshot | null>(null)
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const response = await fetch('/api/prices/queue', { cache: 'no-store' })
        if (!response.ok) return
        const data = (await response.json()) as { queue: QueueSnapshot }
        if (!cancelled) setQueue(data.queue)
      } catch {
        // The indicator is optional.
      }
    }
    void load()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, QUEUE_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])
  return queue
}

const SECTION_LABEL: Record<Section, string> = {
  all: 'All',
  changes: 'Changes',
  drops: 'Drops',
  increases: 'Increases',
  oos: 'Out of stock',
  attention: 'Needs attention',
  recent: 'Recently monitored',
}

const SECTION_FILTER: Record<Section, (source: MonitoredSource) => boolean> = {
  all: () => true,
  changes: (source) =>
    source.result === 'drop' ||
    source.result === 'increase' ||
    source.result === 'out_of_stock',
  drops: (source) => source.result === 'drop',
  increases: (source) => source.result === 'increase',
  oos: (source) => source.result === 'out_of_stock',
  attention: (source) =>
    source.result === 'attention' || source.result === 'pending',
  recent: (source) => Boolean(source.lastCheckedAt),
}

const EMPTY_TEXT: Record<Section, string> = {
  all: 'Nothing is monitored yet.',
  changes: 'No price or stock changes in the last 30 days.',
  drops: 'No price drops in the last 30 days.',
  increases: 'No price increases in the last 30 days.',
  oos: 'Nothing is out of stock.',
  attention: 'Every store page was read on its last check.',
  recent: 'Nothing has been checked yet.',
}

const RESULT_ORDER: Record<MonitoredSource['result'], number> = {
  drop: 0,
  increase: 1,
  out_of_stock: 2,
  attention: 3,
  pending: 4,
  same: 5,
}

function sortSources(section: Section, list: MonitoredSource[]) {
  const sorted = [...list]
  if (section === 'recent')
    return sorted
      .sort((a, b) => b.lastCheckedAt!.localeCompare(a.lastCheckedAt!))
      .slice(0, 30)
  return sorted.sort(
    (a, b) =>
      RESULT_ORDER[a.result] - RESULT_ORDER[b.result] ||
      (b.changedAt ?? '').localeCompare(a.changedAt ?? '') ||
      `${a.knife.brand} ${a.knife.name}`.localeCompare(
        `${b.knife.brand} ${b.knife.name}`,
      ),
  )
}

function VsPaid({ source }: { source: MonitoredSource }) {
  if (source.priceMinor === null || source.paidMinor === null)
    return <span className="text-muted-foreground">—</span>
  const delta = source.priceMinor - source.paidMinor
  if (delta === 0) return <span className="text-muted-foreground">same</span>
  return (
    <span
      className="tabular-nums"
      data-result={delta < 0 ? 'drop' : 'increase'}
      style={{
        color: 'color-mix(in srgb, var(--pd-color) 80%, var(--foreground))',
      }}
    >
      {delta < 0 ? '−' : '+'}
      {money(Math.abs(delta), source.currency)}
    </span>
  )
}

function SourceTableRow({
  source,
  selected,
  section,
  lanes,
  now,
  onSelect,
  onResolve,
}: {
  source: MonitoredSource
  selected: boolean
  section: Section
  lanes: Map<string, QueueLane>
  now: number
  onSelect: () => void
  onResolve: () => void
}) {
  const paused = laneNote(lanes, source)
  const showNext = section === 'attention'
  return (
    <tr
      data-price-row={source.result}
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        'cursor-pointer border-b border-[var(--bladevault-line)]/60 transition-colors hover:bg-[var(--bladevault-surface-soft)]',
        selected && 'bg-[var(--bladevault-surface-soft)]',
      )}
    >
      <td className="py-2 pr-3 pl-1">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onSelect()
          }}
          aria-pressed={selected}
          className="flex min-w-0 items-center gap-2.5 text-left"
        >
          <KnifeThumb knife={source.knife} className="size-8" />
          <span className="min-w-0">
            <span className="block max-w-[16rem] truncate font-medium">
              {source.knife.brand} {source.knife.name}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {storeLabel(source.storeName)}
            </span>
          </span>
        </button>
      </td>
      <td className="py-2 pr-3 text-right whitespace-nowrap">
        <span className="font-semibold tabular-nums">
          {money(source.priceMinor, source.currency)}
        </span>
        {source.previousPriceMinor !== null ? (
          <span className="block text-[11px] text-muted-foreground line-through tabular-nums">
            {money(source.previousPriceMinor, source.currency)}
          </span>
        ) : null}
      </td>
      <td className="py-2 pr-3">
        <ResultBadge source={source} onResolve={onResolve} />
      </td>
      <td className="py-2 pr-3 text-right whitespace-nowrap">
        <VsPaid source={source} />
      </td>
      <td className="py-2 pr-1 text-xs whitespace-nowrap text-muted-foreground">
        {paused ? (
          <span className="flex items-center gap-1.5">
            <StatusDot tone="bad" />
            {paused}
          </span>
        ) : showNext ? (
          source.nextCheckAt ? (
            `next ${relativeTime(source.nextCheckAt, now)}`
          ) : (
            '—'
          )
        ) : source.lastCheckedAt ? (
          relativeTime(source.lastCheckedAt, now)
        ) : (
          'not yet'
        )}
      </td>
    </tr>
  )
}

function laneNote(lanes: Map<string, QueueLane>, source: SourceSummary) {
  const lane = lanes.get(source.laneKey)
  if (lane?.circuit === 'open' && lane.cooldownUntil)
    return `Store paused until ${new Date(
      lane.cooldownUntil,
    ).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    })}`
  return null
}

/**
 * Price Drops: a monitoring status timeline with checks per hour, then every
 * monitored store listing in tabs beside the selected knife's chart and
 * sources.
 */
export function PriceDropsView({
  initialSection = 'all',
}: {
  initialSection?: string
} = {}) {
  const [version, setVersion] = useState(0)
  const { overview, error } = useOverview(version)
  const queue = useQueue()
  const now = useMinuteClock()
  const [section, setSection] = useState<Section>(
    initialSection in SECTION_LABEL ? (initialSection as Section) : 'all',
  )
  const [solveTarget, setSolveTarget] = useState<SolveTarget | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const firstKnife =
    (overview ? sortSources('all', overview.monitored)[0]?.knife.id : null) ??
    overview?.knives.find((knife) => knife.monitored)?.knife.id ??
    null
  const selectedKnife = selected ?? firstKnife
  const lanes = new Map(
    (queue?.lanes ?? []).map((lane) => [lane.laneKey, lane]),
  )
  const checkingStores =
    queue?.lanes.filter((lane) => lane.checking).length ?? 0
  const pausedStores =
    queue?.lanes.filter((lane) => lane.circuit === 'open').length ?? 0

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
        error?: string
      }
      if (!response.ok) throw new Error(data.error ?? 'Could not start checks.')
      setNotice(
        data.due
          ? `${data.due} ${data.due === 1 ? 'product is' : 'products are'} queued. Each store is checked at its own pace, so this can take a while.`
          : 'Nothing to check yet.',
      )
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not start checks.')
    } finally {
      setChecking(false)
    }
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
            disabled={checking || !overview?.kpis.monitoredKnives}
          >
            {checking ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Check all now
          </Button>
        </div>
      }
    />
  )

  if (error && !overview)
    return (
      <div data-price-drops className="w-full">
        {header}
        <p className="text-sm text-destructive">{error}</p>
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
  const empty = kpis.monitoredKnives === 0 && overview.knives.length === 0
  const rows = sortSources(
    section,
    overview.monitored.filter(SECTION_FILTER[section]),
  )

  return (
    <div data-price-drops className="w-full">
      {header}
      {notice ? (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {queue && !queue.enabled ? (
        <p className="mb-4 rounded-lg border border-[var(--bladevault-line)] bg-[var(--bladevault-surface-soft)] px-3 py-2 text-sm">
          Automatic checks are off. Check now still works per knife.{' '}
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
              Knives with a stored purchase price and a product link are checked
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
          <MonitoringStatus
            overview={overview}
            pausedStores={pausedStores}
            selectedKnife={selectedKnife}
            now={now}
            onSelect={setSelected}
          />

          <Card data-price-table className="mt-4 gap-0 overflow-hidden py-0">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--bladevault-line)]/60 p-3">
              <div
                role="tablist"
                aria-label="Price sections"
                className="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg border border-[var(--bladevault-line)] p-0.5"
              >
                {(Object.keys(SECTION_LABEL) as Section[]).map((value) => {
                  const count =
                    value === 'recent'
                      ? null
                      : overview.monitored.filter(SECTION_FILTER[value]).length
                  return (
                    <button
                      key={value}
                      type="button"
                      role="tab"
                      aria-selected={section === value}
                      onClick={() => setSection(value)}
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
            <div className="grid items-start lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
              <div
                role="tabpanel"
                aria-label={SECTION_LABEL[section]}
                className="min-w-0 overflow-x-auto px-3 pb-2 lg:max-h-[720px] lg:overflow-y-auto"
              >
                {rows.length ? (
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-[var(--bladevault-line)] text-left text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
                        <th className="py-2 pl-1 font-medium">Knife</th>
                        <th className="py-2 pr-3 text-right font-medium">
                          Price now
                        </th>
                        <th className="py-2 pr-3 font-medium">Change</th>
                        <th className="py-2 pr-3 text-right font-medium">
                          vs paid
                        </th>
                        <th className="py-2 pr-1 font-medium">
                          {section === 'attention' ? 'Next check' : 'Checked'}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((source) => (
                        <SourceTableRow
                          key={source.sourceId}
                          source={source}
                          section={section}
                          selected={selectedKnife === source.knife.id}
                          lanes={lanes}
                          now={now}
                          onSelect={() => setSelected(source.knife.id)}
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
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="py-6 text-sm text-muted-foreground">
                    {EMPTY_TEXT[section]}
                  </p>
                )}
              </div>
              <aside
                aria-label="Selected knife"
                className="border-t border-[var(--bladevault-line)]/60 p-4 lg:sticky lg:top-0 lg:border-t-0 lg:border-l"
              >
                {selectedKnife ? (
                  <KnifePricePanel
                    key={selectedKnife}
                    knifeId={selectedKnife}
                    variant="page"
                    onClose={selected ? () => setSelected(null) : undefined}
                    onChanged={() => setVersion((value) => value + 1)}
                  />
                ) : (
                  <p className="py-6 text-sm text-muted-foreground">
                    Select a knife to see its price history.
                  </p>
                )}
              </aside>
            </div>
          </Card>
        </>
      )}
      <SolveInBrowserDialog
        target={solveTarget}
        onClose={() => setSolveTarget(null)}
        onSolved={() => setVersion((value) => value + 1)}
      />
    </div>
  )
}

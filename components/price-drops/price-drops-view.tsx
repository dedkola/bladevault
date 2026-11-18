'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { useKnives } from '@/components/providers/knives-provider'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type {
  ChangeEvent,
  PriceOverview,
  SourceSummary,
} from '@/lib/price-monitor/insights'
import { getHourCycle } from '@/lib/time-format'
import { cn } from '@/lib/utils'
import { KnifePricePanel } from './knife-price-panel'
import {
  money,
  relativeTime,
  shortDateTime,
  STATUS_LABEL,
  STATUS_TONE,
  storeLabel,
} from './price-format'
import { ChangePill, KnifeThumb, StatusDot, useMinuteClock } from './price-ui'

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

type Section = 'recent' | 'drops' | 'increases' | 'oos' | 'monitored'

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

function Kpi({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note: string
}) {
  return (
    <Card size="sm" data-price-kpi>
      <CardContent>
        <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          {label}
        </div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
        <div className="text-xs text-muted-foreground">{note}</div>
      </CardContent>
    </Card>
  )
}

function EventRow({
  event,
  selected,
  hourCycle,
  now,
  onSelect,
}: {
  event: ChangeEvent
  selected: boolean
  hourCycle: 'h12' | 'h23'
  now: number
  onSelect: () => void
}) {
  return (
    <li>
      <button
        type="button"
        data-price-event={event.kind}
        aria-pressed={selected}
        onClick={onSelect}
        className={cn(
          'flex w-full flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--bladevault-line)]/60 px-1 py-2.5 text-left transition-colors hover:bg-[var(--bladevault-surface-soft)]',
          selected && 'bg-[var(--bladevault-surface-soft)]',
        )}
      >
        <KnifeThumb knife={event.knife} />
        <span className="min-w-[9rem] flex-1">
          <span className="block truncate font-medium">
            {event.knife.brand} {event.knife.name}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {storeLabel(event.storeName)} ·{' '}
            {shortDateTime(event.occurredAt, hourCycle, now)}
          </span>
        </span>
        <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {event.type === 'price' ? (
            <>
              <span className="text-xs text-muted-foreground line-through tabular-nums">
                {money(event.previousPriceMinor, event.currency)}
              </span>
              <span className="font-semibold tabular-nums">
                {money(event.priceMinor, event.currency)}
              </span>
            </>
          ) : event.kind === 'back_in_stock' && event.priceMinor !== null ? (
            <span className="font-semibold tabular-nums">
              {money(event.priceMinor, event.currency)}
            </span>
          ) : null}
          <ChangePill event={event} />
        </span>
      </button>
    </li>
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
    })} · bot check`
  return null
}

function SourceRow({
  source,
  selected,
  lanes,
  now,
  onSelect,
  detail,
}: {
  source: SourceSummary
  selected: boolean
  lanes: Map<string, QueueLane>
  now: number
  onSelect: () => void
  detail: 'since' | 'checked'
}) {
  const paused = laneNote(lanes, source)
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={cn(
          'flex w-full flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--bladevault-line)]/60 px-1 py-2.5 text-left transition-colors hover:bg-[var(--bladevault-surface-soft)]',
          selected && 'bg-[var(--bladevault-surface-soft)]',
        )}
      >
        <KnifeThumb knife={source.knife} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">
            {source.knife.brand} {source.knife.name}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {storeLabel(source.storeName)}
            {detail === 'since' && source.since
              ? ` · since ${new Date(source.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
              : ''}
          </span>
        </span>
        {detail === 'checked' ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <StatusDot tone={paused ? 'bad' : STATUS_TONE[source.status]} />
            {paused ??
              (source.status === 'ok' || source.status === 'out_of_stock'
                ? relativeTime(source.lastCheckedAt, now)
                : STATUS_LABEL[source.status])}
          </span>
        ) : (
          <span
            data-price-pill="oos"
            className="rounded-full px-2 py-0.5 text-[11.5px] font-semibold"
          >
            Out of stock
          </span>
        )}
      </button>
    </li>
  )
}

const SECTION_LABEL: Record<Section, string> = {
  recent: 'Recent changes',
  drops: 'Price drops',
  increases: 'Increases',
  oos: 'Out of stock',
  monitored: 'Recently monitored',
}

const EMPTY_TEXT: Record<Section, string> = {
  recent:
    'No price or stock changes yet. They appear here after the first checks.',
  drops: 'No price drops in the last 30 days.',
  increases: 'No price increases in the last 30 days.',
  oos: 'Nothing is out of stock.',
  monitored: 'Nothing has been checked yet.',
}

/**
 * Price Drops: KPI row, recent changes with section tabs, a side panel with
 * the selected knife's chart and sources, then out-of-stock and recently
 * monitored cards.
 */
export function PriceDropsView() {
  const [version, setVersion] = useState(0)
  const { overview, error } = useOverview(version)
  const queue = useQueue()
  const { timeFormat } = useKnives()
  const hourCycle = getHourCycle(timeFormat)
  const now = useMinuteClock()
  const [section, setSection] = useState<Section>('recent')
  const [selected, setSelected] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const firstKnife =
    overview?.recent[0]?.knife.id ??
    overview?.knives.find((knife) => knife.monitored)?.knife.id ??
    null
  const selectedKnife = selected ?? firstKnife
  const lanes = new Map(
    (queue?.lanes ?? []).map((lane) => [lane.laneKey, lane]),
  )
  const checkingStores =
    queue?.lanes.filter((lane) => lane.checking).length ?? 0

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
  const counts: Record<Section, number | null> = {
    recent: null,
    drops: overview.drops.length,
    increases: overview.increases.length,
    oos: overview.outOfStock.length,
    monitored: null,
  }
  const empty = kpis.monitoredKnives === 0 && overview.knives.length === 0

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

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Kpi
          label="Monitored"
          value={String(kpis.monitoredKnives)}
          note={`on ${kpis.stores} ${kpis.stores === 1 ? 'store' : 'stores'}`}
        />
        <Kpi
          label="Price drops"
          value={String(kpis.drops)}
          note={`last ${overview.windowDays} days`}
        />
        <Kpi
          label="Price increases"
          value={String(kpis.increases)}
          note={`last ${overview.windowDays} days`}
        />
        <Kpi
          label="Out of stock"
          value={String(kpis.outOfStock)}
          note="right now"
        />
        <Kpi
          label="Last successful check"
          value={
            kpis.lastSuccessAt
              ? relativeTime(kpis.lastSuccessAt, now, 'short')
              : '—'
          }
          note={
            kpis.lastSuccessAt
              ? new Date(kpis.lastSuccessAt).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  hourCycle,
                })
              : 'not yet'
          }
        />
      </div>

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
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <Card className="gap-0 py-0">
              <div className="border-b border-[var(--bladevault-line)]/60 p-3">
                <div
                  role="tablist"
                  aria-label="Price sections"
                  className="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg border border-[var(--bladevault-line)] p-0.5"
                >
                  {(Object.keys(SECTION_LABEL) as Section[]).map((value) => (
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
                      {counts[value] ? (
                        <span className="ml-1 text-[11px] opacity-75">
                          {counts[value]}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </div>
              <div role="tabpanel" className="px-3 pb-2">
                {(() => {
                  const events =
                    section === 'recent'
                      ? overview.recent
                      : section === 'drops'
                        ? overview.drops
                        : section === 'increases'
                          ? overview.increases
                          : null
                  const sources =
                    section === 'oos'
                      ? overview.outOfStock
                      : section === 'monitored'
                        ? overview.recentlyMonitored
                        : null
                  if (events)
                    return events.length ? (
                      <ul>
                        {events.map((event) => (
                          <EventRow
                            key={event.id}
                            event={event}
                            selected={selectedKnife === event.knife.id}
                            hourCycle={hourCycle}
                            now={now}
                            onSelect={() => setSelected(event.knife.id)}
                          />
                        ))}
                      </ul>
                    ) : (
                      <p className="py-6 text-sm text-muted-foreground">
                        {EMPTY_TEXT[section]}
                      </p>
                    )
                  return sources && sources.length ? (
                    <ul>
                      {sources.map((source) => (
                        <SourceRow
                          key={source.sourceId}
                          source={source}
                          selected={selectedKnife === source.knife.id}
                          lanes={lanes}
                          now={now}
                          detail={section === 'oos' ? 'since' : 'checked'}
                          onSelect={() => setSelected(source.knife.id)}
                        />
                      ))}
                    </ul>
                  ) : (
                    <p className="py-6 text-sm text-muted-foreground">
                      {EMPTY_TEXT[section]}
                    </p>
                  )
                })()}
              </div>
            </Card>

            <Card className="lg:sticky lg:top-4">
              <CardContent>
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
              </CardContent>
            </Card>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Card className="gap-0 py-0">
              <div className="flex items-center justify-between border-b border-[var(--bladevault-line)]/60 px-4 py-3">
                <h2 className="text-sm font-semibold">Out of stock</h2>
                <span className="text-xs text-muted-foreground">
                  kept apart from price changes
                </span>
              </div>
              <div className="px-3 pb-2">
                {overview.outOfStock.length ? (
                  <ul>
                    {overview.outOfStock.slice(0, 5).map((source) => (
                      <SourceRow
                        key={source.sourceId}
                        source={source}
                        selected={selectedKnife === source.knife.id}
                        lanes={lanes}
                        now={now}
                        detail="since"
                        onSelect={() => setSelected(source.knife.id)}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="py-5 text-sm text-muted-foreground">
                    {EMPTY_TEXT.oos}
                  </p>
                )}
              </div>
            </Card>
            <Card className="gap-0 py-0">
              <div className="flex items-center justify-between border-b border-[var(--bladevault-line)]/60 px-4 py-3">
                <h2 className="text-sm font-semibold">Recently monitored</h2>
                <Link
                  href="/settings?tab=prices"
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Monitoring settings ›
                </Link>
              </div>
              <div className="px-3 pb-2">
                {overview.recentlyMonitored.length ? (
                  <ul>
                    {overview.recentlyMonitored.slice(0, 6).map((source) => (
                      <SourceRow
                        key={source.sourceId}
                        source={source}
                        selected={selectedKnife === source.knife.id}
                        lanes={lanes}
                        now={now}
                        detail="checked"
                        onSelect={() => setSelected(source.knife.id)}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="py-5 text-sm text-muted-foreground">
                    {EMPTY_TEXT.monitored}
                  </p>
                )}
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}

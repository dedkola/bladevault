'use client'

import Link from 'next/link'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import {
  AppWindow,
  ChevronDown,
  ExternalLink,
  History,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getSafeExternalUrl } from '@/lib/external-url'
import { announcePriceDataUpdated } from '@/lib/market-status'
import {
  HISTORY_RANGES,
  type ChangeEvent,
  type HistoryRange,
  type KnifeHistoryStats,
} from '@/lib/price-monitor/insights'
import type {
  EligibilityReason,
  PriceSourceView,
  PriceWatchUpdate,
  PriceWatchView,
} from '@/lib/price-monitor/shared'
import { cn } from '@/lib/utils'
import {
  AVAILABILITY_LABEL,
  money,
  moneyMajor,
  relativeTime,
  STATUS_LABEL,
  STATUS_TONE,
  storeLabel,
} from './price-format'
import {
  chartCurrency,
  ChartLegend,
  PriceHistoryChart,
  RangeButtons,
  usePriceHistory,
} from './price-history-chart'
import { PriceExportButton } from './price-export-button'
import {
  CheckHistoryDialog,
  type CheckHistoryTarget,
} from './check-history-dialog'
import {
  ChangePill,
  CurrencyMismatch,
  KnifeThumb,
  StatusDot,
  useMinuteClock,
  useStoredValue,
} from './price-ui'
import { PriceWatchEditor } from './price-watch-editor'
import { RetireHintNotice } from './retire-hint'
import {
  SOLVE_UNAVAILABLE_TEXT,
  SolveInBrowserDialog,
  useSolveInBrowserAvailable,
  type SolveTarget,
} from './solve-in-browser'
import { PriceAlertRules } from './price-alert-rules'

const MODE_LABEL = { auto: 'Auto', on: 'Always monitor', off: 'Never monitor' }

const REASON_TEXT: Record<EligibilityReason, string> = {
  monitored_auto: 'a purchase price is stored',
  monitored_forced: 'monitored without a stored price',
  off: 'not checked automatically',
  no_price: 'no purchase price stored, so not monitored',
  sold: 'sold, so not monitored',
  no_source: 'no product URL yet',
}

const POLL_MS = 3000

function isPending(watch: PriceWatchView | null): boolean {
  return Boolean(
    watch &&
    (watch.queuedSourceIds.length ||
      watch.sources.some((source) => source.status === 'checking')),
  )
}

/**
 * A knife's sources and mode, polled while checks are queued. `onSettled`
 * runs when queued checks finish, so the chart and page can reload.
 */
function usePriceWatch(
  knifeId: string,
  version: number,
  onSettled: () => void,
) {
  const [watch, setWatch] = useState<PriceWatchView | null>(null)
  const [tick, setTick] = useState(0)
  const wasPending = useRef(false)
  const settled = useEffectEvent(onSettled)
  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const response = await fetch(
          `/api/knives/${encodeURIComponent(knifeId)}/price-watch`,
          { cache: 'no-store', signal: controller.signal },
        )
        if (!response.ok) return
        const data = (await response.json()) as { watch: PriceWatchView }
        if (controller.signal.aborted) return
        const pendingNow = isPending(data.watch)
        if (wasPending.current && !pendingNow) settled()
        wasPending.current = pendingNow
        setWatch(data.watch)
      } catch {
        // Keep the last state; the next poll retries.
      }
    }
    void load()
    return () => controller.abort()
  }, [knifeId, version, tick])

  const pending = isPending(watch)
  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(() => setTick((value) => value + 1), POLL_MS)
    return () => clearTimeout(timer)
  }, [pending, watch])
  return { watch, pending }
}

/** Best in-stock offer from the live source list, until history loads. */
function bestOffer(
  sources: PriceSourceView[],
  currency: string | null,
): KnifeHistoryStats['bestNow'] {
  let best: PriceSourceView | null = null
  for (const source of sources)
    if (
      source.lastPriceMinor !== null &&
      source.lastCurrency === currency &&
      source.lastAvailability !== 'out_of_stock' &&
      (!best || source.lastPriceMinor < best.lastPriceMinor!)
    )
      best = source
  return best
    ? {
        priceMinor: best.lastPriceMinor!,
        sourceId: best.id,
        storeName: best.storeName,
        url: best.url,
        availability: best.lastAvailability,
      }
    : null
}

/** A store name that opens the listing, when the link is safe. */
function StoreLink({
  url,
  storeName,
  className,
}: {
  url: string
  storeName: string
  className?: string
}) {
  const safeUrl = getSafeExternalUrl(url)
  if (!safeUrl) return <>{storeLabel(storeName)}</>
  return (
    <a
      href={safeUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'inline-flex items-center gap-1 hover:underline',
        className,
      )}
    >
      {storeLabel(storeName)}
      <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
    </a>
  )
}

function SourceLine({
  source,
  knifeId,
  queued,
  now,
  canSolve,
  onCheck,
  onSolve,
  onHistory,
  onPaused,
}: {
  source: PriceSourceView
  knifeId: string
  queued: boolean
  now: number
  canSolve: boolean | null
  onCheck: () => void
  onSolve: () => void
  onHistory: () => void
  onPaused: () => void
}) {
  const retire = source.enabled ? (source.retireHint ?? null) : null
  const needsHelp =
    source.status === 'blocked' ||
    source.status === 'failed' ||
    source.status === 'price_unavailable'
  const safeUrl = getSafeExternalUrl(source.url)
  const status =
    queued && source.status !== 'checking' ? 'checking' : source.status
  const statusText =
    queued && source.status !== 'checking'
      ? 'Queued'
      : source.status === 'ok' || source.status === 'out_of_stock'
        ? `${STATUS_LABEL[source.status]} ${relativeTime(source.lastCheckedAt, now)}`
        : STATUS_LABEL[source.status]
  return (
    <li
      data-price-source-line
      className="flex flex-wrap items-center gap-2.5 border-t border-[var(--bladevault-line)]/60 py-2 first:border-t-0"
    >
      <StatusDot tone={STATUS_TONE[status]} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 text-sm">
          {safeUrl ? (
            <a
              href={safeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-w-0 items-center gap-1 truncate hover:underline"
            >
              {storeLabel(source.storeName)}
              <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
            </a>
          ) : (
            storeLabel(source.storeName)
          )}
          {source.foundByAi ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              · found by AI
            </span>
          ) : null}
          {!source.enabled ? (
            <span className="text-xs text-muted-foreground">· paused</span>
          ) : null}
          {source.stockIgnored ? (
            <span
              className="shrink-0 text-xs text-muted-foreground"
              title="Out of stock on the official site is ignored (Settings → Price monitoring). Not checked on schedule until Check now finds it in stock."
            >
              · ignored
            </span>
          ) : null}
        </div>
        <div
          className={cn(
            'truncate text-xs text-muted-foreground',
            (source.status === 'failed' || source.status === 'blocked') &&
              'text-destructive',
          )}
          title={source.lastError ?? undefined}
        >
          {source.status === 'failed' ||
          source.status === 'blocked' ||
          source.status === 'needs_review'
            ? (source.lastError ?? statusText)
            : statusText}
        </div>
      </div>
      <span className="flex flex-col items-end">
        <span className="text-sm font-semibold tabular-nums">
          {source.lastAvailability === 'out_of_stock'
            ? '—'
            : money(source.lastPriceMinor, source.lastCurrency)}
        </span>
        {source.lastAvailability &&
        AVAILABILITY_LABEL[source.lastAvailability] ? (
          <span
            data-price-availability
            className="rounded-full px-1.5 text-[10.5px] font-semibold whitespace-nowrap"
          >
            {AVAILABILITY_LABEL[source.lastAvailability]}
          </span>
        ) : null}
      </span>
      {needsHelp && canSolve !== null ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={
            canSolve
              ? `${source.status === 'blocked' ? 'Solve the bot check' : 'Fix the page'} at ${storeLabel(source.storeName)} in a browser`
              : `Solve in browser is unavailable here. ${SOLVE_UNAVAILABLE_TEXT}`
          }
          title={
            !canSolve
              ? SOLVE_UNAVAILABLE_TEXT
              : source.status === 'blocked'
                ? 'Solve in browser'
                : 'Open in a browser to fix'
          }
          disabled={queued || !canSolve}
          onClick={onSolve}
        >
          <AppWindow className="size-3" />
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Check history of ${storeLabel(source.storeName)}`}
        title="Check history"
        onClick={onHistory}
      >
        <History className="size-3" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Check ${storeLabel(source.storeName)} now`}
        title="Check now"
        disabled={queued}
        onClick={onCheck}
      >
        {queued ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <RefreshCw className="size-3" />
        )}
      </Button>
      {retire ? (
        <RetireHintNotice
          hint={retire}
          knifeId={knifeId}
          sourceId={source.id}
          storeName={source.storeName}
          outOfStockSince={source.outOfStockSince ?? null}
          now={now}
          onPaused={onPaused}
          className="basis-full pl-5"
        />
      ) : null}
    </li>
  )
}

const LABEL =
  'text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground'

function shortDate(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== new Date().getFullYear()
      ? { year: 'numeric' as const }
      : {}),
  })
}

function signedMoney(minor: number, currency: string | null): string {
  if (minor === 0) return money(0, currency)
  return `${minor < 0 ? '−' : '+'}${money(Math.abs(minor), currency)}`
}

/** Lowest and highest seen, tracking since and the gap to what you paid. */
function HistoryStats({ stats }: { stats: KnifeHistoryStats }) {
  const items: Array<{ label: string; value: string; note?: string }> = [
    {
      label: 'Lowest seen',
      value: stats.lowest
        ? money(stats.lowest.priceMinor, stats.currency)
        : '—',
      note: stats.lowest
        ? `${shortDate(stats.lowest.at)} · ${storeLabel(stats.lowest.storeName)}`
        : undefined,
    },
    {
      label: 'Highest seen',
      value: stats.highest
        ? money(stats.highest.priceMinor, stats.currency)
        : '—',
      note: stats.highest
        ? `${shortDate(stats.highest.at)} · ${storeLabel(stats.highest.storeName)}`
        : undefined,
    },
    {
      label: 'Tracking since',
      value: stats.trackingSince ? shortDate(stats.trackingSince) : '—',
    },
    {
      label: 'Now vs you paid',
      value:
        stats.gapMinor !== null
          ? signedMoney(stats.gapMinor, stats.currency)
          : '—',
      note:
        stats.gapPct !== null
          ? `${stats.gapPct > 0 ? '+' : stats.gapPct < 0 ? '−' : ''}${Math.abs(stats.gapPct).toFixed(1)}%`
          : stats.paidMinor === null
            ? 'No comparable purchase price'
            : undefined,
    },
  ]
  return (
    <dl
      data-price-stats
      className="grid grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] gap-x-4 gap-y-2"
    >
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className={LABEL}>{item.label}</dt>
          <dd className="text-sm font-semibold tabular-nums">{item.value}</dd>
          {item.note ? (
            <dd className="truncate text-xs text-muted-foreground">
              {item.note}
            </dd>
          ) : null}
        </div>
      ))}
    </dl>
  )
}

function LatestChanges({
  events,
  now,
}: {
  events: ChangeEvent[]
  now: number
}) {
  return (
    <div>
      <div className={cn('mb-1', LABEL)}>Latest changes</div>
      <ul data-price-latest-changes className="text-sm">
        {events.slice(0, 5).map((event) => (
          <li
            key={event.id}
            className="flex items-start gap-2 border-t border-[var(--bladevault-line)]/60 py-1.5 first:border-t-0"
          >
            <ChangePill event={event} />
            <div className="min-w-0 flex-1">
              <div className="truncate">
                <StoreLink url={event.sourceUrl} storeName={event.storeName} />
              </div>
              {event.type === 'price' ? (
                <div className="text-xs text-muted-foreground tabular-nums">
                  {money(event.previousPriceMinor, event.currency)} →{' '}
                  {money(event.priceMinor, event.currency)}
                </div>
              ) : null}
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">
              {relativeTime(event.occurredAt, now)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Best price, stats, history chart, sources and latest changes for one
 * knife. `page` is the Price Drops side panel; `tab` is the knife's Market
 * tab, which adds the purchase price and mode. Both can manage sources.
 */
export function KnifePricePanel({
  knifeId,
  variant,
  onClose,
  onChanged,
}: {
  knifeId: string
  variant: 'page' | 'tab'
  onClose?: () => void
  onChanged?: () => void
}) {
  // The chart range is remembered per browser, separately for each place.
  const [range, setRange] = useStoredValue<HistoryRange>(
    `bladevault.priceDrops.range.${variant}`,
    variant === 'tab' ? '1m' : '3m',
    (raw) =>
      (HISTORY_RANGES as readonly (string | null)[]).includes(raw)
        ? (raw as HistoryRange)
        : null,
  )
  const [version, setVersion] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [solveTarget, setSolveTarget] = useState<SolveTarget | null>(null)
  const [historyTarget, setHistoryTarget] = useState<CheckHistoryTarget | null>(
    null,
  )
  const [managing, setManaging] = useState(false)
  const now = useMinuteClock()
  const canSolve = useSolveInBrowserAvailable()
  const [historyVersion, setHistoryVersion] = useState(0)
  const { watch, pending } = usePriceWatch(knifeId, version, () => {
    setHistoryVersion((value) => value + 1)
    announcePriceDataUpdated()
    onChanged?.()
  })
  const historyState = usePriceHistory(knifeId, range, historyVersion)
  const history = historyState.status === 'ready' ? historyState.history : null
  const manageId = `knife-price-manage-${knifeId}`

  const startCheck = async (body: {
    scope: 'knife' | 'source'
    id: string | number
  }) => {
    setError(null)
    try {
      const response = await fetch('/api/prices/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string
        }
        throw new Error(data.error ?? 'Could not start the check.')
      }
      setVersion((value) => value + 1)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not start the check.',
      )
    }
  }

  const stats = history?.stats ?? null
  const [saving, setSaving] = useState(false)
  const saveWatch = async (body: PriceWatchUpdate) => {
    setError(null)
    setSaving(true)
    try {
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
        throw new Error(data.error ?? 'Could not save the alert rules.')
      }
      setVersion((value) => value + 1)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not save the alert rules.',
      )
    } finally {
      setSaving(false)
    }
  }

  const currency =
    stats?.currency ??
    (history && chartCurrency(history)) ??
    watch?.sources.find((source) => source.lastCurrency)?.lastCurrency ??
    null
  const best =
    stats?.bestNow ?? (watch ? bestOffer(watch.sources, currency) : null)
  // The latest drop while its price still holds at that store.
  const latestDrop = history?.events.find(
    (event) =>
      event.type === 'price' &&
      event.kind === 'drop' &&
      watch?.sources.some(
        (source) =>
          source.id === event.sourceId &&
          source.lastPriceMinor === event.priceMinor &&
          source.lastAvailability !== 'out_of_stock',
      ),
  )
  // The purchase price is always shown; it is compared only in one currency.
  const paid = history?.paid ?? null
  // Stores priced only in other currencies than the purchase price.
  const storeCurrencies = new Set(
    (watch?.sources ?? [])
      .filter((source) => source.lastPriceMinor !== null)
      .map((source) => source.lastCurrency)
      .filter((value): value is string => Boolean(value)),
  )
  const otherCurrency =
    paid && storeCurrencies.size && !storeCurrencies.has(paid.currency)
      ? currency && storeCurrencies.has(currency)
        ? currency
        : [...storeCurrencies][0]
      : null
  const queued = new Set(watch?.queuedSourceIds ?? [])
  const enabledSources = watch?.sources.filter((source) => source.enabled) ?? []

  return (
    <div data-knife-price-panel={variant} className="space-y-3">
      {variant === 'page' && history ? (
        <div className="flex items-start gap-3">
          <KnifeThumb knife={history.knife} />
          <div className="min-w-0 flex-1">
            <Link
              href={`/collection/${encodeURIComponent(knifeId)}?tab=market`}
              className="block truncate font-semibold hover:underline"
            >
              {history.knife.brand} {history.knife.name}
            </Link>
            {history.knife.subtitle ? (
              <div
                data-price-subtitle
                className="truncate text-xs text-muted-foreground"
              >
                {history.knife.subtitle}
              </div>
            ) : null}
            <div className="text-xs text-muted-foreground">
              {watch?.sources.length ?? 0}{' '}
              {watch?.sources.length === 1 ? 'source' : 'sources'}
              {history.paid
                ? ` · You paid ${moneyMajor(history.paid.amount, history.paid.currency)}`
                : ''}
            </div>
          </div>
          {onClose ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Close price panel"
              onClick={onClose}
            >
              <X className="size-3.5" />
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          <div className="min-w-0">
            <div className={LABEL}>Best price now</div>
            <div className="text-2xl font-semibold tabular-nums">
              {money(best?.priceMinor ?? null, currency)}
            </div>
            {best ? (
              <div
                data-price-best-store
                className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground"
              >
                <span>
                  at{' '}
                  <StoreLink
                    url={best.url}
                    storeName={best.storeName}
                    className="text-foreground"
                  />
                </span>
                {best.availability && AVAILABILITY_LABEL[best.availability] ? (
                  <span
                    data-price-availability
                    className="rounded-full px-1.5 text-[10.5px] font-semibold"
                  >
                    {AVAILABILITY_LABEL[best.availability]}
                  </span>
                ) : null}
              </div>
            ) : null}
            {otherCurrency && paid ? (
              <CurrencyMismatch
                currency={otherCurrency}
                paidCurrency={paid.currency}
                className="block"
              />
            ) : null}
          </div>
          {variant === 'tab' ? (
            <>
              <div>
                <div className={LABEL}>You paid</div>
                <div className="text-base font-semibold tabular-nums">
                  {paid
                    ? moneyMajor(paid.amount, paid.currency)
                    : stats?.paidMinor != null
                      ? money(stats.paidMinor, stats.currency)
                      : '—'}
                </div>
              </div>
              {watch ? (
                <div>
                  <div className={LABEL}>Monitoring</div>
                  <div className="text-sm font-semibold">
                    {MODE_LABEL[watch.mode]}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {REASON_TEXT[watch.eligibility.reason]}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
        <RangeButtons value={range} onChange={setRange} />
      </div>

      {latestDrop ? (
        <div
          data-price-drop-link
          data-result="drop"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-[var(--bladevault-line)] bg-[var(--bladevault-surface-soft)] px-3 py-2 text-sm"
        >
          <ChangePill event={latestDrop} />
          <span>
            Price dropped at{' '}
            <StoreLink
              url={latestDrop.sourceUrl}
              storeName={latestDrop.storeName}
              className="font-semibold"
            />
          </span>
          <span className="tabular-nums text-muted-foreground">
            {money(latestDrop.previousPriceMinor, latestDrop.currency)} →{' '}
            <span className="font-semibold text-foreground">
              {money(latestDrop.priceMinor, latestDrop.currency)}
            </span>
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            {relativeTime(latestDrop.occurredAt, now)}
          </span>
        </div>
      ) : null}
      {stats ? <HistoryStats stats={stats} /> : null}

      {historyState.status === 'error' ? (
        <p className="text-xs text-destructive">{historyState.message}</p>
      ) : history ? (
        <>
          <PriceHistoryChart
            history={history}
            className={variant === 'tab' ? 'h-48' : 'h-52'}
          />
          <ChartLegend history={history} />
        </>
      ) : (
        <div className="grid h-48 place-items-center text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
        </div>
      )}

      <div>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <span className={LABEL}>Sources</span>
          <div className="flex flex-wrap items-center gap-1">
            {enabledSources.length && !managing ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={pending}
                onClick={() => void startCheck({ scope: 'knife', id: knifeId })}
              >
                {pending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <RefreshCw className="size-3" />
                )}
                Check all sources
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-expanded={managing}
              aria-controls={manageId}
              onClick={() => setManaging((value) => !value)}
            >
              Manage sources
              <ChevronDown
                className={cn(
                  'size-3 transition-transform',
                  managing && 'rotate-180',
                )}
              />
            </Button>
          </div>
        </div>
        {managing ? (
          <div
            id={manageId}
            data-price-manage-sources
            className="rounded-lg border border-[var(--bladevault-line)] p-3"
          >
            <PriceWatchEditor
              knifeId={knifeId}
              onChanged={() => setVersion((value) => value + 1)}
            />
          </div>
        ) : watch && watch.sources.length ? (
          <ul>
            {watch.sources.map((source) => (
              <SourceLine
                key={source.id}
                source={source}
                knifeId={knifeId}
                queued={queued.has(source.id)}
                now={now}
                canSolve={canSolve}
                onCheck={() =>
                  void startCheck({ scope: 'source', id: source.id })
                }
                onSolve={() =>
                  setSolveTarget({
                    sourceId: source.id,
                    url: source.url,
                    storeName: source.storeName,
                    status: source.status,
                  })
                }
                onHistory={() =>
                  setHistoryTarget({
                    sourceId: source.id,
                    storeName: source.storeName,
                  })
                }
                onPaused={() => {
                  setVersion((value) => value + 1)
                  onChanged?.()
                }}
              />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            No product URLs yet. Add one under Manage sources.
          </p>
        )}
        {canSolve === false &&
        watch?.sources.some((source) =>
          ['blocked', 'failed', 'price_unavailable'].includes(source.status),
        ) ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {SOLVE_UNAVAILABLE_TEXT}
          </p>
        ) : null}
      </div>

      {history && history.events.length ? (
        <LatestChanges events={history.events} now={now} />
      ) : null}

      {variant === 'tab' && watch ? (
        <PriceAlertRules
          watch={watch}
          busy={saving}
          onChange={(alerts) => void saveWatch({ alerts })}
          onUnmuteSource={(id) =>
            void saveWatch({ update: [{ id, muteDays: 0 }] })
          }
          className="border-t border-[var(--bladevault-line)]/60 pt-3"
        />
      ) : null}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <div className="flex justify-end">
        <PriceExportButton knifeId={knifeId} />
      </div>
      <SolveInBrowserDialog
        target={solveTarget}
        onClose={() => setSolveTarget(null)}
        onSolved={() => setVersion((value) => value + 1)}
      />
      <CheckHistoryDialog
        target={historyTarget}
        onClose={() => setHistoryTarget(null)}
      />
    </div>
  )
}

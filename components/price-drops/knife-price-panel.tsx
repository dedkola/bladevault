'use client'

import Link from 'next/link'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { AppWindow, ExternalLink, Loader2, RefreshCw, X } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { getSafeExternalUrl } from '@/lib/external-url'
import type { HistoryRange } from '@/lib/price-monitor/insights'
import type {
  EligibilityReason,
  PriceSourceView,
  PriceWatchUpdate,
  PriceWatchView,
} from '@/lib/price-monitor/shared'
import { cn } from '@/lib/utils'
import {
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
  ChangePill,
  CurrencyMismatch,
  KnifeThumb,
  StatusDot,
  useMinuteClock,
} from './price-ui'
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

function bestPrice(sources: PriceSourceView[], currency: string | null) {
  const prices = sources
    .filter(
      (source) =>
        source.lastPriceMinor !== null &&
        source.lastCurrency === currency &&
        source.lastAvailability !== 'out_of_stock',
    )
    .map((source) => source.lastPriceMinor!)
  return prices.length ? Math.min(...prices) : null
}

function SourceLine({
  source,
  knifeId,
  queued,
  now,
  canSolve,
  onCheck,
  onSolve,
  onPaused,
}: {
  source: PriceSourceView
  knifeId: string
  queued: boolean
  now: number
  canSolve: boolean | null
  onCheck: () => void
  onSolve: () => void
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
      <span className="text-sm font-semibold tabular-nums">
        {source.lastAvailability === 'out_of_stock'
          ? '—'
          : money(source.lastPriceMinor, source.lastCurrency)}
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

/**
 * Best price, history chart and sources for one knife. `page` is the Price
 * Drops side panel; `tab` is the knife's Market tab with the purchase price,
 * mode and latest changes.
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
  const [range, setRange] = useState<HistoryRange>(
    variant === 'tab' ? '1m' : '3m',
  )
  const [version, setVersion] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [solveTarget, setSolveTarget] = useState<SolveTarget | null>(null)
  const now = useMinuteClock()
  const canSolve = useSolveInBrowserAvailable()
  const [historyVersion, setHistoryVersion] = useState(0)
  const { watch } = usePriceWatch(knifeId, version, () => {
    setHistoryVersion((value) => value + 1)
    onChanged?.()
  })
  const historyState = usePriceHistory(knifeId, range, historyVersion)
  const history = historyState.status === 'ready' ? historyState.history : null

  const check = async (sourceId: number) => {
    setError(null)
    try {
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
      setVersion((value) => value + 1)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not start the check.',
      )
    }
  }

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
    (history && chartCurrency(history)) ??
    watch?.sources.find((source) => source.lastCurrency)?.lastCurrency ??
    null
  const best = watch ? bestPrice(watch.sources, currency) : null
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
          <div>
            <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Best price now
            </div>
            <div className="text-2xl font-semibold tabular-nums">
              {money(best, currency)}
            </div>
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
                <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                  You paid
                </div>
                <div className="text-base font-semibold tabular-nums">
                  {moneyMajor(paid?.amount ?? null, paid?.currency ?? null)}
                </div>
              </div>
              {watch ? (
                <div>
                  <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                    Monitoring
                  </div>
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
        <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Sources
        </div>
        {watch && watch.sources.length ? (
          <ul>
            {watch.sources.map((source) => (
              <SourceLine
                key={source.id}
                source={source}
                knifeId={knifeId}
                queued={queued.has(source.id)}
                now={now}
                canSolve={canSolve}
                onCheck={() => void check(source.id)}
                onSolve={() =>
                  setSolveTarget({
                    sourceId: source.id,
                    url: source.url,
                    storeName: source.storeName,
                    status: source.status,
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
            No product URLs yet. Add them in edit mode.
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

      {variant === 'tab' && history && history.events.length ? (
        <div>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Latest changes
          </div>
          <ul className="text-sm">
            {history.events.slice(0, 5).map((event) => (
              <li
                key={event.id}
                className="flex items-center gap-2 border-t border-[var(--bladevault-line)]/60 py-1.5 first:border-t-0"
              >
                <ChangePill event={event} />
                <span className="min-w-0 flex-1 truncate">
                  {storeLabel(event.storeName)}
                  {event.type === 'price'
                    ? ` · ${money(event.previousPriceMinor, event.currency)} → ${money(event.priceMinor, event.currency)}`
                    : ''}
                </span>
                <span className="text-xs text-muted-foreground">
                  {relativeTime(event.occurredAt, now)}
                </span>
              </li>
            ))}
          </ul>
        </div>
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

      <div className="flex flex-wrap items-center justify-between gap-2">
        {variant === 'tab' ? (
          <span className="text-xs text-muted-foreground">
            Sources and Auto / Always / Never are set in edit mode.
          </span>
        ) : (
          <span />
        )}
        <div className="flex flex-wrap items-center gap-1">
          <PriceExportButton knifeId={knifeId} />
          <Link
            href={`/collection/${encodeURIComponent(knifeId)}?edit=1`}
            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
          >
            Edit monitoring
          </Link>
        </div>
      </div>
      <SolveInBrowserDialog
        target={solveTarget}
        onClose={() => setSolveTarget(null)}
        onSolved={() => setVersion((value) => value + 1)}
      />
    </div>
  )
}

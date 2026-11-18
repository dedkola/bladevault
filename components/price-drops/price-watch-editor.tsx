'use client'

import { useEffect, useEffectEvent, useId, useState } from 'react'
import {
  AlertCircle,
  ExternalLink,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { getSafeExternalUrl } from '@/lib/external-url'
import { formatMoney } from '@/lib/price-monitor/money'
import type {
  EligibilityReason,
  FetchOverride,
  PriceSourceStatus,
  PriceSourceView,
  PriceWatchMode,
  PriceWatchUpdate,
  PriceWatchView,
} from '@/lib/price-monitor/shared'
import { cn } from '@/lib/utils'

const MODE_OPTIONS: Array<{ value: PriceWatchMode; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'on', label: 'Always monitor' },
  { value: 'off', label: 'Never monitor' },
]

const ELIGIBILITY_TEXT: Record<EligibilityReason, string> = {
  monitored_auto: 'Monitored because a purchase price is stored.',
  monitored_forced: 'Monitored even without a stored purchase price.',
  off: 'Not monitored. Check now still works for a single reading.',
  no_price:
    'Not monitored: no purchase price is stored. Add a price or choose Always monitor.',
  sold: 'Not monitored: the knife is marked as sold. Choose Always monitor to keep watching it.',
  no_source: 'Not monitored yet: add a product URL below.',
}

const STATUS_LABEL: Record<PriceSourceStatus, string> = {
  pending: 'Not checked yet',
  checking: 'Checking',
  ok: 'Checked',
  price_unavailable: 'Price unavailable',
  out_of_stock: 'Out of stock',
  failed: 'Failed',
  blocked: 'Blocked',
}

const STATUS_TONE: Record<PriceSourceStatus, string> = {
  pending: 'border-[var(--bladevault-line)] text-muted-foreground',
  checking: 'border-[var(--bladevault-line)] text-foreground',
  ok: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400',
  price_unavailable: 'border-amber-500/40 text-amber-700 dark:text-amber-400',
  out_of_stock: 'border-amber-500/40 text-amber-700 dark:text-amber-400',
  failed: 'border-destructive/40 text-destructive',
  blocked: 'border-destructive/40 text-destructive',
}

const FETCH_LABEL: Record<FetchOverride, string> = {
  auto: 'Fetch: auto',
  browser: 'Fetch: browser',
  http: 'Fetch: HTTP',
}

const POLL_MS = 2500

function relativeTime(iso: string | null): string {
  if (!iso) return ''
  const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000)
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const abs = Math.abs(seconds)
  if (abs < 60) return format.format(seconds, 'second')
  if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute')
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), 'hour')
  return format.format(Math.round(seconds / 86_400), 'day')
}

async function readError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string }
    if (data.error) return data.error
  } catch {
    // Fall through to the generic message.
  }
  return `Request failed (${response.status}).`
}

type WatchResponse = { watch: PriceWatchView } | { unavailable: true }

async function fetchWatch(
  endpoint: string,
  signal?: AbortSignal,
): Promise<WatchResponse> {
  const response = await fetch(endpoint, { cache: 'no-store', signal })
  if (response.status === 501 || response.status === 404)
    return { unavailable: true }
  if (!response.ok) throw new Error(await readError(response))
  return (await response.json()) as { watch: PriceWatchView }
}

function SourceRow({
  source,
  queued,
  busy,
  onChange,
  onRemove,
  onCheck,
}: {
  source: PriceSourceView
  queued: boolean
  busy: boolean
  onChange: (change: NonNullable<PriceWatchUpdate['update']>[number]) => void
  onRemove: () => void
  onCheck: () => void
}) {
  const safeUrl = getSafeExternalUrl(source.url)
  const waiting = queued && source.status !== 'checking'
  const status: PriceSourceStatus = waiting ? 'checking' : source.status
  const statusLabel = waiting ? 'Queued' : STATUS_LABEL[status]
  const price =
    source.lastPriceMinor !== null && source.lastCurrency
      ? formatMoney(source.lastPriceMinor, source.lastCurrency)
      : null

  return (
    <li
      data-price-source
      className={cn(
        'space-y-2 rounded-lg border border-[var(--bladevault-line)] p-3',
        !source.enabled && 'opacity-70',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              {source.storeName}
            </span>
            {source.origin === 'auto' ? (
              <span className="rounded-full border border-[var(--bladevault-line)] px-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                Product link
              </span>
            ) : null}
            {!source.enabled ? (
              <span className="rounded-full border border-[var(--bladevault-line)] px-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                Paused
              </span>
            ) : null}
          </div>
          {safeUrl ? (
            <a
              href={safeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <span className="truncate">{source.url}</span>
              <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
          ) : (
            <span className="block truncate text-xs text-muted-foreground">
              {source.url}
            </span>
          )}
        </div>
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
            STATUS_TONE[status],
          )}
          role="status"
        >
          {status === 'checking' ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : null}
          {statusLabel}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {price ? (
          <span className="font-medium text-foreground">{price}</span>
        ) : null}
        {source.lastCheckedAt ? (
          <span>Checked {relativeTime(source.lastCheckedAt)}</span>
        ) : null}
      </div>

      {source.lastError &&
      (source.status === 'failed' ||
        source.status === 'blocked' ||
        source.status === 'price_unavailable') ? (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          {source.lastError}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={onCheck}
          disabled={busy || queued}
        >
          <RefreshCw className="h-3 w-3" />
          Check now
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => onChange({ id: source.id, enabled: !source.enabled })}
          disabled={busy}
        >
          {source.enabled ? (
            <Pause className="h-3 w-3" />
          ) : (
            <Play className="h-3 w-3" />
          )}
          {source.enabled ? 'Pause' : 'Resume'}
        </Button>
        {source.origin === 'manual' ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onRemove}
            disabled={busy}
          >
            <Trash2 className="h-3 w-3" />
            Remove
          </Button>
        ) : null}
        <Select
          value={source.fetchOverride}
          onValueChange={(value) =>
            onChange({
              id: source.id,
              fetchOverride: (value ?? 'auto') as FetchOverride,
            })
          }
          disabled={busy}
        >
          <SelectTrigger
            size="sm"
            className="ml-auto h-6 text-xs"
            aria-label="How to load this page"
          >
            <SelectValue>{FETCH_LABEL[source.fetchOverride]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Auto (learned per store)</SelectItem>
            <SelectItem value="browser">Always browser</SelectItem>
            <SelectItem value="http">Always plain HTTP</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </li>
  )
}

/**
 * Edit-mode price monitoring: Auto / Always / Never, and up to 10 product
 * URLs. Changes save immediately, separately from the knife form. Hides
 * itself where the server feature is unavailable (static web app: 501).
 */
export function PriceWatchEditor({
  knifeId,
  onUnavailable,
}: {
  knifeId: string
  onUnavailable?: () => void
}) {
  const inputId = useId()
  const [watch, setWatch] = useState<PriceWatchView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newUrl, setNewUrl] = useState('')
  const endpoint = `/api/knives/${encodeURIComponent(knifeId)}/price-watch`

  const applyResponse = useEffectEvent((result: WatchResponse) => {
    if ('unavailable' in result) onUnavailable?.()
    else setWatch(result.watch)
  })

  const refresh = async () => {
    const result = await fetchWatch(endpoint)
    if ('unavailable' in result) onUnavailable?.()
    else setWatch(result.watch)
  }

  useEffect(() => {
    const controller = new AbortController()
    async function loadInitial() {
      try {
        const result = await fetchWatch(endpoint, controller.signal)
        if (!controller.signal.aborted) applyResponse(result)
      } catch (err) {
        if (!controller.signal.aborted)
          setError(
            err instanceof Error ? err.message : 'Could not load sources.',
          )
      }
    }
    void loadInitial()
    return () => controller.abort()
  }, [endpoint])

  const pending = Boolean(
    watch &&
    (watch.queuedSourceIds.length > 0 ||
      watch.sources.some((source) => source.status === 'checking')),
  )
  useEffect(() => {
    if (!pending) return
    const timer = setInterval(() => {
      fetchWatch(endpoint)
        .then(applyResponse)
        .catch(() => {})
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [pending, endpoint])

  const update = async (body: PriceWatchUpdate): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(await readError(response))
      const data = (await response.json()) as { watch: PriceWatchView }
      setWatch(data.watch)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.')
      return false
    } finally {
      setBusy(false)
    }
  }

  const check = async (scope: 'knife' | 'source', id: string | number) => {
    setError(null)
    try {
      const response = await fetch('/api/prices/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, id }),
      })
      if (!response.ok) throw new Error(await readError(response))
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start check.')
    }
  }

  const addSource = async () => {
    const url = newUrl.trim()
    if (!url) return
    if (await update({ add: [{ url }] })) setNewUrl('')
  }

  if (!watch) {
    return error ? (
      <p className="text-xs text-destructive">{error}</p>
    ) : (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading price monitoring
      </div>
    )
  }

  const queued = new Set(watch.queuedSourceIds)
  const full = watch.sources.length >= watch.maxSources

  return (
    <div data-price-watch-editor className="space-y-4">
      <div className="space-y-2">
        <div
          role="group"
          aria-label="Price monitoring mode"
          className="inline-flex flex-wrap gap-1 rounded-lg border border-[var(--bladevault-line)] p-0.5"
        >
          {MODE_OPTIONS.map((option) => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={watch.mode === option.value ? 'secondary' : 'ghost'}
              aria-pressed={watch.mode === option.value}
              onClick={() => {
                if (watch.mode !== option.value)
                  void update({ mode: option.value })
              }}
              disabled={busy}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <p
          className={cn(
            'text-xs xl:text-sm',
            watch.eligibility.monitored
              ? 'text-foreground'
              : 'text-muted-foreground',
          )}
        >
          {ELIGIBILITY_TEXT[watch.eligibility.reason]}
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] xl:text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Sources {watch.sources.length} / {watch.maxSources}
          </span>
          {watch.sources.length > 1 ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => void check('knife', knifeId)}
              disabled={busy || pending}
            >
              <RefreshCw className="h-3 w-3" />
              Check all
            </Button>
          ) : null}
        </div>
        {watch.sources.length ? (
          <ul className="space-y-2">
            {watch.sources.map((source) => (
              <SourceRow
                key={source.id}
                source={source}
                queued={queued.has(source.id)}
                busy={busy}
                onChange={(change) => void update({ update: [change] })}
                onRemove={() => void update({ remove: [source.id] })}
                onCheck={() => void check('source', source.id)}
              />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            No product URLs yet. The knife’s product link is added automatically
            when it has one.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <label
          htmlFor={inputId}
          className="text-[10px] xl:text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground"
        >
          Add store URL
        </label>
        <div className="flex gap-2">
          <Input
            id={inputId}
            type="url"
            inputMode="url"
            value={newUrl}
            onChange={(event) => setNewUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void addSource()
              }
            }}
            placeholder="https://store.example/products/knife"
            disabled={busy || full}
            className="bg-background/80"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void addSource()}
            disabled={busy || full || !newUrl.trim()}
          >
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        </div>
        {full ? (
          <p className="text-xs text-muted-foreground">
            The limit is {watch.maxSources} sources per knife.
          </p>
        ) : null}
      </div>

      {error ? (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  )
}

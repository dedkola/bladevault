'use client'

import { useMemo, useRef, useState, type DragEvent } from 'react'
import Link from 'next/link'
import { Bell, BellOff, Heart, Loader2, Plus, X } from 'lucide-react'
import Image from '@/components/vault-image'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { money } from '@/components/price-drops/price-format'
import { useKnives } from '@/components/providers/knives-provider'
import { useMarket } from '@/components/providers/market-provider'
import { useWishlist } from '@/components/providers/wishlist-provider'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { getImageUrl, type Knife } from '@/lib/data'
import {
  announcePriceDataUpdated,
  type KnifeMarketSummary,
} from '@/lib/market-status'
import {
  fromMinorUnits,
  parseStoredPrice,
  toMinorUnits,
} from '@/lib/price-monitor/money'
import { cn } from '@/lib/utils'
import {
  WISHLIST_LANE_LABELS,
  WISHLIST_LANES,
  WISHLIST_SIGNAL_LABELS,
  wishlistSignal,
  wishlistTargetGap,
  type WishlistItem,
  type WishlistLane,
  type WishlistSignal,
  type WishlistTrend,
} from '@/lib/wishlist'
import './wishlist.css'

type Row = {
  item: WishlistItem
  knife: Knife
  summary: KnifeMarketSummary | undefined
  trend: WishlistTrend | undefined
  /** Best store price when known, else the knife's regular price. */
  priceMinor: number | null
  currency: string | null
  live: boolean
  signal: WishlistSignal
  gap: number | null
}

const DEFAULT_CURRENCY = 'USD'

function buildRow(
  item: WishlistItem,
  knife: Knife,
  summary: KnifeMarketSummary | undefined,
  trend: WishlistTrend | undefined,
): Row {
  let priceMinor: number | null = null,
    currency: string | null = null,
    live = false
  if (summary?.bestPriceMinor != null && summary.currency) {
    priceMinor = summary.bestPriceMinor
    currency = summary.currency
    live = true
  } else {
    const regular = parseStoredPrice(knife.specs.price)
    if (regular) {
      currency = regular.currency || DEFAULT_CURRENCY
      priceMinor = toMinorUnits(regular.amount, currency)
    }
  }
  return {
    item,
    knife,
    summary,
    trend,
    priceMinor,
    currency,
    live,
    signal: live
      ? wishlistSignal(
          priceMinor,
          currency,
          item.targetMinor,
          item.targetCurrency,
        )
      : 'none',
    gap: live
      ? wishlistTargetGap(
          priceMinor,
          currency,
          item.targetMinor,
          item.targetCurrency,
        )
      : null,
  }
}

function mostCommonCurrency(rows: Row[]): string {
  const counts = new Map<string, number>()
  for (const row of rows)
    if (row.currency)
      counts.set(row.currency, (counts.get(row.currency) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? DEFAULT_CURRENCY
}

function gapLabel(gap: number): string {
  const pct = Math.round(gap * 100)
  return pct === 0 ? 'at target' : `${pct > 0 ? '+' : ''}${pct}% vs target`
}

function knifeTitle(knife: Knife) {
  return [knife.brand, knife.name].filter(Boolean).join(' ')
}

/* ---------- small pieces ---------- */

function Thumb({ knife, size }: { knife: Knife; size: 'sm' | 'md' | 'lg' }) {
  const image = knife.images[0]
  return (
    <span data-wishlist-thumb={size} data-photo-stage>
      {image ? (
        <Image
          src={getImageUrl(image)}
          alt=""
          width={size === 'lg' ? 320 : 160}
          height={size === 'lg' ? 200 : 100}
        />
      ) : (
        <Heart aria-hidden className="size-5 opacity-30" />
      )}
    </span>
  )
}

function SignalPill({ signal }: { signal: WishlistSignal }) {
  if (signal === 'none') return null
  return (
    <span data-wishlist-signal={signal}>{WISHLIST_SIGNAL_LABELS[signal]}</span>
  )
}

function LowPill({ row }: { row: Row }) {
  const low = row.trend?.lowMinor
  if (
    !row.live ||
    low == null ||
    row.trend?.currency !== row.currency ||
    row.priceMinor === null ||
    row.priceMinor > low ||
    // A price that never moved is not news: show it only after a higher one.
    !row.trend?.daily.some((value) => value !== null && value > row.priceMinor!)
  )
    return null
  return <span data-wishlist-signal="low">90-day low</span>
}

function Sparkline({
  trend,
  signal,
  width = 84,
  height = 26,
}: {
  trend: WishlistTrend | undefined
  signal: WishlistSignal
  width?: number
  height?: number
}) {
  const points = (trend?.daily ?? [])
    .map((value, index) => ({ value, index }))
    .filter((p): p is { value: number; index: number } => p.value !== null)
  if (points.length < 2)
    return (
      <span data-wishlist-spark-empty style={{ width }}>
        No history yet
      </span>
    )
  // Span the days with data, so a short history still reads as a line.
  const first = points[0].index,
    days = points[points.length - 1].index - first || 1
  const values = points.map((p) => p.value)
  const min = Math.min(...values),
    range = Math.max(...values) - min || 1
  const line = points
    .map(
      (p) =>
        `${(((p.index - first) / days) * (width - 2) + 1).toFixed(1)},${(height - 3 - ((p.value - min) / range) * (height - 6)).toFixed(1)}`,
    )
    .join(' ')
  return (
    <svg
      data-wishlist-spark={signal}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Best store price over the last 30 days"
    >
      <polyline
        points={line}
        fill="none"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function TargetBar({ row }: { row: Row }) {
  const { priceMinor, item } = row
  if (
    priceMinor === null ||
    !item.targetMinor ||
    item.targetCurrency !== row.currency
  )
    return <div data-wishlist-bar aria-hidden />
  const max = Math.max(priceMinor, item.targetMinor) * 1.15
  return (
    <div data-wishlist-bar aria-hidden>
      <i
        data-signal={row.signal}
        style={{ width: `${(priceMinor / max) * 100}%` }}
      />
      <b style={{ left: `${(item.targetMinor / max) * 100}%` }} />
    </div>
  )
}

function WatchBell({ row }: { row: Row }) {
  const { showFeedback } = useKnives()
  const [busy, setBusy] = useState(false)
  const sources = row.summary?.sources ?? 0
  const watched = Boolean(row.summary?.monitored)
  const label = !sources
    ? 'Add a store link to watch this price'
    : watched
      ? 'Watching price. Click to stop.'
      : 'Watch price'
  async function toggle() {
    setBusy(true)
    try {
      const response = await fetch(
        `/api/knives/${encodeURIComponent(row.knife.id)}/price-watch`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: watched ? 'off' : 'on' }),
        },
      )
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string
        }
        throw new Error(data.error || 'Could not change price watching.')
      }
      announcePriceDataUpdated()
      showFeedback(
        watched
          ? `Stopped watching ${row.knife.name}`
          : `Watching ${row.knife.name} in Price Drops`,
      )
    } catch (error) {
      showFeedback(
        error instanceof Error
          ? error.message
          : 'Could not change price watching.',
        'error',
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      type="button"
      data-wishlist-bell
      aria-pressed={watched}
      aria-label={label}
      title={label}
      disabled={busy || !sources}
      onClick={() => void toggle()}
    >
      {busy ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : sources ? (
        <Bell className="size-3.5" />
      ) : (
        <BellOff className="size-3.5" />
      )}
    </button>
  )
}

function TargetEditor({ row }: { row: Row }) {
  const { refresh } = useWishlist()
  const { showFeedback } = useKnives()
  const [busy, setBusy] = useState(false)
  const currency = row.item.targetCurrency ?? row.currency ?? DEFAULT_CURRENCY
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const input = useRef<HTMLInputElement>(null)

  function start() {
    setValue(
      row.item.targetMinor
        ? String(fromMinorUnits(row.item.targetMinor, currency))
        : '',
    )
    setEditing(true)
    requestAnimationFrame(() => input.current?.select())
  }
  async function save() {
    const trimmed = value.trim().replace(',', '.')
    const amount = trimmed ? Number(trimmed) : 0
    if (!Number.isFinite(amount) || amount < 0) {
      showFeedback('Enter a target price as a number.', 'error')
      return
    }
    setBusy(true)
    try {
      // The target is the knife's price alert target, shared with Price Drops.
      const response = await fetch(
        `/api/knives/${encodeURIComponent(row.knife.id)}/price-watch`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            alerts: { targetPrice: amount ? { amount, currency } : null },
          }),
        },
      )
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string
        }
        throw new Error(data.error || 'Could not save the target.')
      }
      await refresh()
      announcePriceDataUpdated()
      setEditing(false)
    } catch (error) {
      showFeedback(
        error instanceof Error ? error.message : 'Could not save the target.',
        'error',
      )
    } finally {
      setBusy(false)
    }
  }

  if (editing)
    return (
      <form
        data-wishlist-target-form
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <label className="sr-only" htmlFor={`target-${row.knife.id}`}>
          Target price in {currency}. Price Drops alerts you when it is reached.
        </label>
        <Input
          ref={input}
          id={`target-${row.knife.id}`}
          inputMode="decimal"
          value={value}
          placeholder={currency}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setEditing(false)
          }}
          className="h-7 w-24 text-xs"
        />
        <Button type="submit" size="sm" className="h-7" disabled={busy}>
          Save
        </Button>
      </form>
    )
  return (
    <button
      type="button"
      data-wishlist-target
      title="Also your Price Drops alert target"
      onClick={start}
    >
      {row.item.targetMinor
        ? `Target ${money(row.item.targetMinor, row.item.targetCurrency)}`
        : 'Set target price'}
    </button>
  )
}

function RemoveButton({ row }: { row: Row }) {
  const { mutate, busy } = useWishlist()
  const { showFeedback } = useKnives()
  return (
    <button
      type="button"
      data-wishlist-remove
      aria-label={`Remove ${knifeTitle(row.knife)} from the wishlist`}
      title="Remove from wishlist"
      disabled={busy}
      onClick={() =>
        void mutate(
          { action: 'remove', knifeIds: [row.knife.id] },
          `Removed ${row.knife.name} from the wishlist`,
        ).catch((error) =>
          showFeedback(
            error instanceof Error ? error.message : 'Could not remove.',
            'error',
          ),
        )
      }
    >
      <X className="size-3.5" />
    </button>
  )
}

/* ---------- board ---------- */

function WishCard({
  row,
  onDragStart,
  onDropBefore,
  dragging,
}: {
  row: Row
  onDragStart: (id: string) => void
  onDropBefore: (event: DragEvent, beforeId: string) => void
  dragging: boolean
}) {
  const { mutate, busy } = useWishlist()
  const { showFeedback } = useKnives()
  return (
    <article
      data-wishlist-card
      data-dragging={dragging || undefined}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', row.knife.id)
        onDragStart(row.knife.id)
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => onDropBefore(event, row.knife.id)}
    >
      <div data-wishlist-card-top>
        <Thumb knife={row.knife} size="sm" />
        <div className="min-w-0">
          <div data-wishlist-brand>{row.knife.brand}</div>
          <Link
            href={`/collection/${encodeURIComponent(row.knife.id)}`}
            data-wishlist-name
          >
            {row.knife.name}
          </Link>
          <div data-wishlist-pills>
            <SignalPill signal={row.signal} />
            <LowPill row={row} />
          </div>
        </div>
        <div data-wishlist-card-actions>
          <WatchBell row={row} />
          <RemoveButton row={row} />
        </div>
      </div>
      <div data-wishlist-card-mid>
        <div className="min-w-0">
          <span data-wishlist-price>{money(row.priceMinor, row.currency)}</span>{' '}
          <span data-wishlist-sub>
            {row.gap !== null
              ? gapLabel(row.gap)
              : row.live
                ? 'best store price'
                : row.priceMinor !== null
                  ? 'regular price'
                  : 'no price yet'}
          </span>
        </div>
        <Sparkline trend={row.trend} signal={row.signal} />
      </div>
      <TargetBar row={row} />
      <div data-wishlist-card-foot>
        <TargetEditor row={row} />
        <span className="flex items-center gap-2">
          {row.summary?.sources ? (
            <Link
              href={`/price-drops?knife=${encodeURIComponent(row.knife.id)}`}
            >
              {row.summary.sources}{' '}
              {row.summary.sources === 1 ? 'store' : 'stores'}
            </Link>
          ) : (
            <span>No store links</span>
          )}
          <label className="sr-only" htmlFor={`lane-${row.knife.id}`}>
            Move {row.knife.name} to
          </label>
          <select
            id={`lane-${row.knife.id}`}
            data-wishlist-lane-select
            value={row.item.lane}
            disabled={busy}
            onChange={(event) =>
              void mutate({
                action: 'move',
                knifeId: row.knife.id,
                lane: event.target.value as WishlistLane,
              }).catch((error) =>
                showFeedback(
                  error instanceof Error ? error.message : 'Could not move.',
                  'error',
                ),
              )
            }
          >
            {WISHLIST_LANES.map((lane) => (
              <option key={lane} value={lane}>
                {WISHLIST_LANE_LABELS[lane].title}
              </option>
            ))}
          </select>
        </span>
      </div>
    </article>
  )
}

function Board({ rows, currency }: { rows: Row[]; currency: string }) {
  const { mutate } = useWishlist()
  const { showFeedback } = useKnives()
  const [dragId, setDragId] = useState<string | null>(null)
  const [overLane, setOverLane] = useState<WishlistLane | null>(null)

  function drop(event: DragEvent, lane: WishlistLane, beforeId?: string) {
    event.preventDefault()
    event.stopPropagation()
    const id = dragId ?? event.dataTransfer.getData('text/plain')
    setDragId(null)
    setOverLane(null)
    if (!id || id === beforeId) return
    void mutate({
      action: 'move',
      knifeId: id,
      lane,
      beforeKnifeId: beforeId ?? null,
    }).catch((error) =>
      showFeedback(
        error instanceof Error ? error.message : 'Could not move.',
        'error',
      ),
    )
  }

  return (
    <div data-wishlist-lanes onDragEnd={() => setDragId(null)}>
      {WISHLIST_LANES.map((lane) => {
        const laneRows = rows.filter((row) => row.item.lane === lane)
        const total = laneRows.reduce(
          (sum, row) =>
            sum + (row.currency === currency ? (row.priceMinor ?? 0) : 0),
          0,
        )
        return (
          <section
            key={lane}
            data-wishlist-lane={lane}
            data-over={overLane === lane || undefined}
            aria-label={WISHLIST_LANE_LABELS[lane].title}
            onDragOver={(event) => {
              event.preventDefault()
              if (overLane !== lane) setOverLane(lane)
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node))
                setOverLane(null)
            }}
            onDrop={(event) => drop(event, lane)}
          >
            <header>
              <h2>{WISHLIST_LANE_LABELS[lane].title}</h2>
              <span>{total ? money(total, currency) : ''}</span>
            </header>
            <p>
              {WISHLIST_LANE_LABELS[lane].hint} · {laneRows.length}
            </p>
            {laneRows.map((row) => (
              <WishCard
                key={row.knife.id}
                row={row}
                dragging={dragId === row.knife.id}
                onDragStart={setDragId}
                onDropBefore={(event, beforeId) => drop(event, lane, beforeId)}
              />
            ))}
            {!laneRows.length && (
              <div data-wishlist-lane-empty>Drag a knife here</div>
            )}
          </section>
        )
      })}
    </div>
  )
}

/* ---------- ranked list ---------- */

function RankedList({ rows }: { rows: Row[] }) {
  const ranked = [...rows].sort(
    (a, b) =>
      (a.gap ?? Number.POSITIVE_INFINITY) -
        (b.gap ?? Number.POSITIVE_INFINITY) ||
      WISHLIST_LANES.indexOf(a.item.lane) -
        WISHLIST_LANES.indexOf(b.item.lane) ||
      a.item.position - b.item.position,
  )
  return (
    <div data-wishlist-list role="table" aria-label="Wishlist ranked by price">
      <div data-wishlist-row="head" role="row">
        <span role="columnheader">#</span>
        <span role="columnheader" aria-label="Photo" />
        <span role="columnheader">Knife</span>
        <span role="columnheader">Now</span>
        <span role="columnheader">Lane</span>
        <span role="columnheader">Distance to target</span>
        <span role="columnheader">30 days</span>
        <span role="columnheader" aria-label="Watch" />
      </div>
      {ranked.map((row, index) => (
        <div key={row.knife.id} data-wishlist-row role="row">
          <span role="cell" data-wishlist-sub>
            {index + 1}
          </span>
          <span role="cell">
            <Thumb knife={row.knife} size="sm" />
          </span>
          <span role="cell" className="min-w-0">
            <Link
              href={`/collection/${encodeURIComponent(row.knife.id)}`}
              data-wishlist-name
            >
              {row.knife.name}
            </Link>
            <span data-wishlist-sub className="block">
              {row.knife.brand}
              {row.summary?.sources
                ? ` · ${row.summary.sources} ${row.summary.sources === 1 ? 'store' : 'stores'}`
                : ''}{' '}
              <LowPill row={row} />
            </span>
          </span>
          <span role="cell">
            <b>{money(row.priceMinor, row.currency)}</b>
            <span data-wishlist-sub className="block">
              {row.item.targetMinor
                ? `target ${money(row.item.targetMinor, row.item.targetCurrency)}`
                : 'no target'}
            </span>
          </span>
          <span role="cell" data-wishlist-sub>
            {WISHLIST_LANE_LABELS[row.item.lane].title}
          </span>
          <span role="cell">
            <span className="flex items-center gap-2">
              <SignalPill signal={row.signal} />
              {row.gap !== null && (
                <span data-wishlist-sub>{gapLabel(row.gap)}</span>
              )}
            </span>
            <TargetBar row={row} />
          </span>
          <span role="cell">
            <Sparkline trend={row.trend} signal={row.signal} width={100} />
          </span>
          <span role="cell">
            <WatchBell row={row} />
          </span>
        </div>
      ))}
    </div>
  )
}

/* ---------- summary ---------- */

function BudgetCard({
  currency,
  plannedMinor,
}: {
  currency: string
  plannedMinor: number
}) {
  const { budget, mutate, busy } = useWishlist()
  const { showFeedback } = useKnives()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const budgetCurrency = budget.currency ?? currency
  const amount = budget.amountMinor
  const comparable = amount !== null && budgetCurrency === currency

  async function save() {
    const parsed = Number(value.trim().replace(',', '.') || 0)
    if (!Number.isFinite(parsed) || parsed < 0) {
      showFeedback('Enter the budget as a number.', 'error')
      return
    }
    try {
      await mutate({
        action: 'budget',
        amountMinor: parsed ? toMinorUnits(parsed, currency) : null,
        currency: parsed ? currency : null,
      })
      setEditing(false)
    } catch (error) {
      showFeedback(
        error instanceof Error ? error.message : 'Could not save the budget.',
        'error',
      )
    }
  }

  return (
    <div data-wishlist-stat>
      <div data-wishlist-stat-label>Budget this month</div>
      {editing ? (
        <form
          data-wishlist-target-form
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <label className="sr-only" htmlFor="wishlist-budget">
            Monthly budget in {currency}
          </label>
          <Input
            id="wishlist-budget"
            autoFocus
            inputMode="decimal"
            value={value}
            placeholder={currency}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setEditing(false)
            }}
            className="h-8 w-28"
          />
          <Button type="submit" size="sm" disabled={busy}>
            Save
          </Button>
        </form>
      ) : (
        <button
          type="button"
          data-wishlist-stat-value
          data-editable
          onClick={() => {
            setValue(
              amount ? String(fromMinorUnits(amount, budgetCurrency)) : '',
            )
            setEditing(true)
          }}
        >
          {amount ? money(amount, budgetCurrency) : 'Set budget'}
        </button>
      )}
      {comparable && (
        <div data-wishlist-meter aria-hidden>
          <i
            data-over={plannedMinor > amount! || undefined}
            style={{
              width: `${Math.min(100, (plannedMinor / amount!) * 100)}%`,
            }}
          />
        </div>
      )}
      <div data-wishlist-stat-label>
        {money(plannedMinor, currency)} planned in “Next up”
        {comparable && plannedMinor > amount! ? ' · over budget' : ''}
      </div>
    </div>
  )
}

function Summary({ rows, currency }: { rows: Row[]; currency: string }) {
  const inCurrency = rows.filter(
    (row) => row.currency === currency && row.priceMinor !== null,
  )
  const today = inCurrency.reduce((sum, row) => sum + row.priceMinor!, 0)
  const atTarget = inCurrency.reduce(
    (sum, row) =>
      sum +
      (row.item.targetMinor && row.item.targetCurrency === currency
        ? Math.min(row.priceMinor!, row.item.targetMinor)
        : row.priceMinor!),
    0,
  )
  const planned = inCurrency
    .filter((row) => row.item.lane === 'next')
    .reduce((sum, row) => sum + row.priceMinor!, 0)
  const other = rows.length - inCurrency.length
  const watched = rows.filter((row) => row.summary?.monitored)
  const pages = watched.reduce(
    (sum, row) => sum + (row.summary?.sources ?? 0),
    0,
  )
  const ready = rows.filter((row) => row.signal === 'buy').length
  return (
    <div data-wishlist-summary>
      <div data-wishlist-stat>
        <div data-wishlist-stat-label>All of it today</div>
        <div data-wishlist-stat-value>{money(today, currency)}</div>
        <div data-wishlist-stat-label>
          {inCurrency.length} {inCurrency.length === 1 ? 'knife' : 'knives'}
          {other ? ` · ${other} without a ${currency} price` : ''}
        </div>
      </div>
      <div data-wishlist-stat>
        <div data-wishlist-stat-label>At your target prices</div>
        <div data-wishlist-stat-value>{money(atTarget, currency)}</div>
        <div data-wishlist-stat-label>
          {today > atTarget
            ? `${money(today - atTarget, currency)} less if you wait`
            : 'Set targets to see what waiting saves'}
        </div>
      </div>
      <BudgetCard currency={currency} plannedMinor={planned} />
      <div data-wishlist-stat data-wishlist-watch>
        <div data-wishlist-stat-label>Price Drops watches</div>
        <div data-wishlist-stat-value>
          {watched.length} / {rows.length}
        </div>
        <div data-wishlist-stat-label>
          {pages} store {pages === 1 ? 'page' : 'pages'}
          {ready ? ` · ${ready} at or under target` : ''} ·{' '}
          <Link href="/price-drops">Open Price Drops</Link>
        </div>
      </div>
    </div>
  )
}

function BestDeal({ rows }: { rows: Row[] }) {
  const { mutate, busy } = useWishlist()
  const { showFeedback } = useKnives()
  const best = rows
    .filter((row) => row.signal === 'buy' || row.signal === 'close')
    .sort((a, b) => (a.gap ?? 0) - (b.gap ?? 0))[0]
  if (!best) return null
  const under =
    best.item.targetMinor !== null && best.priceMinor !== null
      ? best.item.targetMinor - best.priceMinor
      : 0
  const first = best.trend?.daily.find((value) => value !== null) ?? null
  return (
    <section data-wishlist-hero data-signal={best.signal}>
      <Thumb knife={best.knife} size="lg" />
      <div className="min-w-0">
        <div data-wishlist-eyebrow>
          {best.signal === 'buy' ? 'Best moment to buy' : 'Almost there'}
        </div>
        <h2>{knifeTitle(best.knife)}</h2>
        <div data-wishlist-hero-price>
          <span data-wishlist-big>{money(best.priceMinor, best.currency)}</span>
          {first !== null &&
            best.priceMinor !== null &&
            first > best.priceMinor && (
              <s data-wishlist-sub>{money(first, best.currency)}</s>
            )}
          {under >= 0 ? (
            <span data-wishlist-signal="buy">
              {under
                ? `${money(under, best.currency)} under target`
                : 'At target'}
            </span>
          ) : (
            <span data-wishlist-signal="close">
              {money(-under, best.currency)} above target
            </span>
          )}
          <LowPill row={best} />
        </div>
        <div data-wishlist-sub>
          {best.summary?.sources ?? 0}{' '}
          {best.summary?.sources === 1 ? 'store' : 'stores'} · in “
          {WISHLIST_LANE_LABELS[best.item.lane].title}”
        </div>
      </div>
      <div data-wishlist-hero-actions>
        <Button
          render={
            <Link
              href={`/price-drops?knife=${encodeURIComponent(best.knife.id)}`}
            />
          }
          nativeButton={false}
        >
          See store prices
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void mutate(
              { action: 'remove', knifeIds: [best.knife.id] },
              `Bought ${best.knife.name} — removed from the wishlist`,
            ).catch((error) =>
              showFeedback(
                error instanceof Error ? error.message : 'Could not update.',
                'error',
              ),
            )
          }
        >
          Bought it
        </Button>
      </div>
    </section>
  )
}

/* ---------- add dialog ---------- */

function AddKnivesDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { knives } = useKnives()
  const { has, mutate, busy } = useWishlist()
  const { showFeedback } = useKnives()
  const [query, setQuery] = useState('')
  const [lane, setLane] = useState<WishlistLane>('saving')
  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    return knives
      .filter((knife) =>
        [
          knife.name,
          knife.brand,
          knife.specs.modelNumber,
          knife.specs.bladeMaterial,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(q),
      )
      .slice(0, 60)
  }, [knives, query])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add knives to the wishlist</DialogTitle>
          <DialogDescription>
            Pick knives from your vault. To add a new one, create it first with
            Add Knife.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
            aria-label="Search knives to add"
            placeholder="Search name, brand, steel, model…"
            value={query}
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
          />
          <label className="sr-only" htmlFor="wishlist-add-lane">
            Lane for new knives
          </label>
          <select
            id="wishlist-add-lane"
            data-wishlist-lane-select
            data-size="md"
            value={lane}
            onChange={(event) => setLane(event.target.value as WishlistLane)}
          >
            {WISHLIST_LANES.map((value) => (
              <option key={value} value={value}>
                {WISHLIST_LANE_LABELS[value].title}
              </option>
            ))}
          </select>
        </div>
        <div className="max-h-80 overflow-y-auto">
          {results.map((knife) => {
            const added = has(knife.id)
            return (
              <div
                key={knife.id}
                className="flex items-center gap-3 border-b py-2.5"
              >
                <Thumb knife={knife} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{knife.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[knife.brand, knife.specs.modelNumber]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || added}
                  aria-label={`Add ${knifeTitle(knife)} to the wishlist`}
                  onClick={() =>
                    void mutate(
                      { action: 'add', knifeIds: [knife.id], lane },
                      `Added ${knife.name} to ${WISHLIST_LANE_LABELS[lane].title}`,
                    ).catch((error) =>
                      showFeedback(
                        error instanceof Error
                          ? error.message
                          : 'Could not add.',
                        'error',
                      ),
                    )
                  }
                >
                  {added ? 'Added' : 'Add'}
                </Button>
              </div>
            )
          })}
          {!results.length && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No knives match.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ---------- page ---------- */

export function WishlistView() {
  const { knives, isLoading: knivesLoading } = useKnives()
  const { byId } = useMarket()
  const { available, items, trends, loading, error } = useWishlist()
  const [view, setView] = useState<'board' | 'list'>('board')
  const [adding, setAdding] = useState(false)

  const rows = useMemo(() => {
    const knivesById = new Map(knives.map((knife) => [knife.id, knife]))
    return items.flatMap((item) => {
      const knife = knivesById.get(item.knifeId)
      return knife
        ? [buildRow(item, knife, byId.get(knife.id), trends[knife.id])]
        : []
    })
  }, [items, knives, byId, trends])
  const currency = useMemo(() => mostCommonCurrency(rows), [rows])

  const header = (
    <PageHeader
      title="Wishlist"
      description="Knives you plan to buy, by priority and price"
      actions={
        available ? (
          <>
            <Button
              variant="outline"
              render={<Link href="/add" />}
              nativeButton={false}
            >
              New knife
            </Button>
            <Button onClick={() => setAdding(true)}>
              <Plus className="size-4" />
              Add knives
            </Button>
          </>
        ) : undefined
      }
    />
  )

  if (!available)
    return (
      <div data-wishlist>
        {header}
        <EmptyState
          title="Wishlist needs the BladeVault app"
          description="The wishlist and price watching are not available in this preview."
        />
      </div>
    )

  if (loading || knivesLoading)
    return (
      <div data-wishlist>
        {header}
        <div role="status" className="text-sm text-muted-foreground">
          Loading wishlist…
        </div>
      </div>
    )

  return (
    <div data-wishlist>
      {header}
      {error && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      )}
      {!rows.length ? (
        <EmptyState
          icon={<Heart className="size-8" />}
          title="Your wishlist is empty"
          description="Add knives you plan to buy. Set a target price, and the wishlist tells you when it’s a good moment to buy."
          action={
            <Button onClick={() => setAdding(true)}>
              <Plus className="size-4" />
              Add knives
            </Button>
          }
        />
      ) : (
        <>
          <Summary rows={rows} currency={currency} />
          <BestDeal rows={rows} />
          <div data-wishlist-toolbar>
            <div data-wishlist-seg role="group" aria-label="View">
              <button
                type="button"
                aria-pressed={view === 'board'}
                onClick={() => setView('board')}
              >
                Board
              </button>
              <button
                type="button"
                aria-pressed={view === 'list'}
                onClick={() => setView('list')}
              >
                Ranked by price
              </button>
            </div>
            <div data-wishlist-legend>
              <span data-wishlist-signal="buy">Buy now</span> at or under target
              <span data-wishlist-signal="close">Close</span> within 10%
              <span data-wishlist-signal="wait">Wait</span> further
              <span data-wishlist-signal="low">90-day low</span>
            </div>
          </div>
          <div className={cn(view !== 'board' && 'hidden')}>
            <Board rows={rows} currency={currency} />
          </div>
          {view === 'list' && <RankedList rows={rows} />}
        </>
      )}
      <AddKnivesDialog open={adding} onOpenChange={setAdding} />
    </div>
  )
}

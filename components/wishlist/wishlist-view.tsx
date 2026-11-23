'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Bell, BellOff, ChartLine, Heart, Loader2, Plus, X } from 'lucide-react'
import Image from '@/components/vault-image'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { money, relativeTime } from '@/components/price-drops/price-format'
import { useMinuteClock } from '@/components/price-drops/price-ui'
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
import { parseStoredPrice, toMinorUnits } from '@/lib/price-monitor/money'
import {
  WISHLIST_DEAL_LABELS,
  WISHLIST_DEALS,
  WISHLIST_REGULAR_TOLERANCE,
  priceChange,
  rangePosition,
  trendChange,
  wishlistDeal,
  type WishlistDeal,
  type WishlistItem,
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
  /** Regular price in `currency`, when comparable. */
  regularMinor: number | null
  /** Store price vs regular price: -0.2 is 20% below. */
  vsRegular: number | null
  /** Change over the last 30 days of store prices. */
  change30: number | null
  /** Price range for the bar: 90-day store low/high, today's and regular price. */
  rangeLow: number | null
  rangeHigh: number | null
  /** Where today's price sits in that range, 0 = low, 1 = high. */
  rangePos: number | null
  deal: WishlistDeal
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
    regularMinor: number | null = null,
    live = false
  if (summary?.bestPriceMinor != null && summary.currency) {
    priceMinor = summary.bestPriceMinor
    currency = summary.currency
    regularMinor = summary.paidMinor
    live = true
  } else {
    const regular = parseStoredPrice(knife.specs.price)
    if (regular) {
      currency = regular.currency || DEFAULT_CURRENCY
      priceMinor = toMinorUnits(regular.amount, currency)
      regularMinor = priceMinor
    }
  }
  const vsRegular = live ? priceChange(priceMinor, regularMinor) : null
  const sameCurrency = live && trend?.currency === currency
  // The regular price widens the range, so a discount shows on the bar even
  // before the store history has moved.
  const bounds = live
    ? [
        priceMinor,
        regularMinor,
        sameCurrency ? trend!.lowMinor : null,
        sameCurrency ? trend!.highMinor : null,
      ].filter((value): value is number => value !== null)
    : []
  const rangeLow = bounds.length ? Math.min(...bounds) : null,
    rangeHigh = bounds.length ? Math.max(...bounds) : null
  return {
    item,
    knife,
    summary,
    trend,
    priceMinor,
    currency,
    live,
    regularMinor,
    vsRegular,
    change30: sameCurrency ? trendChange(trend) : null,
    rangeLow,
    rangeHigh,
    rangePos: rangePosition(priceMinor, rangeLow, rangeHigh),
    deal: wishlistDeal({
      live,
      outOfStock: Boolean(summary?.outOfStock),
      vsRegular,
    }),
  }
}

/** Biggest discount first, then closest to the 90-day low, then newest. */
function compareDeals(a: Row, b: Row): number {
  return (
    (a.vsRegular ?? Number.POSITIVE_INFINITY) -
      (b.vsRegular ?? Number.POSITIVE_INFINITY) ||
    (a.rangePos ?? Number.POSITIVE_INFINITY) -
      (b.rangePos ?? Number.POSITIVE_INFINITY) ||
    b.item.addedAt.localeCompare(a.item.addedAt)
  )
}

function mostCommonCurrency(rows: Row[]): string {
  const counts = new Map<string, number>()
  for (const row of rows)
    if (row.currency)
      counts.set(row.currency, (counts.get(row.currency) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? DEFAULT_CURRENCY
}

/** "−20%", "+5%", "±0%". */
function pct(value: number): string {
  const rounded = Math.round(value * 100)
  if (!rounded) return '±0%'
  return `${rounded < 0 ? '−' : '+'}${Math.abs(rounded)}%`
}

function changeDirection(value: number | null): 'down' | 'up' | 'flat' {
  if (value === null || Math.abs(value) < WISHLIST_REGULAR_TOLERANCE)
    return 'flat'
  return value < 0 ? 'down' : 'up'
}

function knifeTitle(knife: Knife) {
  return [knife.brand, knife.name].filter(Boolean).join(' ')
}

function storesLabel(sources: number) {
  return `${sources} ${sources === 1 ? 'store' : 'stores'}`
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

function isAtLow(row: Row): boolean {
  const low = row.trend?.lowMinor
  return Boolean(
    row.live &&
    low != null &&
    row.trend?.currency === row.currency &&
    row.priceMinor !== null &&
    row.priceMinor <= low &&
    // A price that never moved is not news: show it only after a higher one.
    row.trend?.daily.some((value) => value !== null && value > row.priceMinor!),
  )
}

/** Sale, 90-day low, recent drop and stock badges for one knife. */
function DealPills({ row }: { row: Row }) {
  const now = useMinuteClock()
  const { summary, deal, vsRegular } = row
  if (deal === 'out')
    return <span data-wishlist-signal="out">Out of stock</span>
  return (
    <>
      {deal === 'sale' && vsRegular !== null && (
        <span data-wishlist-signal="sale">On sale {pct(vsRegular)}</span>
      )}
      {deal === 'above' && vsRegular !== null && (
        <span data-wishlist-signal="above">{pct(vsRegular)} above regular</span>
      )}
      {isAtLow(row) && <span data-wishlist-signal="low">90-day low</span>}
      {summary?.droppedAt ? (
        <span
          data-wishlist-signal="drop"
          title={`Price dropped ${relativeTime(summary.droppedAt, now)}`}
        >
          ↓{' '}
          {summary.dropPct !== null
            ? `${Math.round(Math.abs(summary.dropPct))}% `
            : ''}
          {relativeTime(summary.droppedAt, now, 'short')}
        </span>
      ) : summary?.restockedAt ? (
        <span data-wishlist-signal="restock">Back in stock</span>
      ) : null}
    </>
  )
}

function Change({ value }: { value: number | null }) {
  if (value === null) return <span data-wishlist-sub>—</span>
  return <span data-wishlist-change={changeDirection(value)}>{pct(value)}</span>
}

function Sparkline({
  row,
  width = 84,
  height = 26,
}: {
  row: Row
  width?: number
  height?: number
}) {
  const points = (row.trend?.daily ?? [])
    .map((value, index) => ({ value, index }))
    .filter((p): p is { value: number; index: number } => p.value !== null)
  if (!points.length)
    return (
      <span data-wishlist-spark-empty style={{ width }}>
        No history yet
      </span>
    )
  // One day of data: a flat dashed line until the history grows.
  if (points.length === 1)
    return (
      <svg
        data-wishlist-spark="flat"
        data-placeholder
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Only one day of store prices so far"
      >
        <polyline
          points={`1,${height / 2} ${width - 1},${height / 2}`}
          fill="none"
          strokeWidth="2"
          strokeDasharray="3 4"
        />
      </svg>
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
      data-wishlist-spark={changeDirection(row.change30)}
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

/** The 90-day low–high range, with today's price and the regular price. */
function RangeBar({ row }: { row: Row }) {
  const { rangeLow: low, rangeHigh: high, currency } = row
  if (low === null || high === null)
    return <div data-wishlist-range aria-hidden />
  const flat = high <= low
  const at = (value: number) => (flat ? 0 : (value - low) / (high - low))
  const regular = row.regularMinor
  return (
    <div
      data-wishlist-range
      role="img"
      aria-label={
        flat
          ? `${money(low, currency)}, no price change yet`
          : `Price range ${money(low, currency)} to ${money(high, currency)}, now ${money(row.priceMinor, currency)}`
      }
    >
      <div data-wishlist-range-track data-flat={flat || undefined}>
        {regular !== null && !flat && (
          <b style={{ left: `${at(regular) * 100}%` }} title="Regular price" />
        )}
        {row.priceMinor !== null && (
          <i style={{ left: `${at(row.priceMinor) * 100}%` }} />
        )}
      </div>
      <div data-wishlist-range-ends>
        <span>{money(low, currency)}</span>
        <span>{flat ? 'no change yet' : money(high, currency)}</span>
      </div>
    </div>
  )
}

/** "~~$229~~ · save $45", "regular $135" when above it, "regular price", … */
function PriceNote({ row }: { row: Row }) {
  if (!row.live)
    return <>{row.priceMinor !== null ? 'regular price' : 'no price yet'}</>
  if (row.regularMinor === null) return <>best store price</>
  if (row.deal === 'sale')
    return (
      <>
        <s>{money(row.regularMinor, row.currency)}</s> · save{' '}
        {money(row.regularMinor - row.priceMinor!, row.currency)}
      </>
    )
  if (row.deal === 'above')
    return <>regular {money(row.regularMinor, row.currency)}</>
  return <>regular price</>
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

function PriceDetailsLink({ row }: { row: Row }) {
  const label = `See ${knifeTitle(row.knife)} on Price Drops`
  return (
    <Link
      href={`/price-drops?knife=${encodeURIComponent(row.knife.id)}`}
      data-wishlist-details
      aria-label={label}
      title="Price details on Price Drops"
    >
      <ChartLine className="size-3.5" />
    </Link>
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

/* ---------- grouped by deal ---------- */

function DealGroups({ rows }: { rows: Row[] }) {
  return (
    <div data-wishlist-groups>
      {WISHLIST_DEALS.map((deal) => {
        const groupRows = rows
          .filter((row) => row.deal === deal)
          .sort(compareDeals)
        if (!groupRows.length) return null
        const { title, hint } = WISHLIST_DEAL_LABELS[deal]
        return (
          <section
            key={deal}
            data-wishlist-group={deal}
            aria-labelledby={`wishlist-group-${deal}`}
          >
            <header>
              <h2 id={`wishlist-group-${deal}`}>{title}</h2>
              <span data-wishlist-sub>
                {hint} · {groupRows.length}
              </span>
            </header>
            <ul data-wishlist-list>
              {groupRows.map((row) => (
                <li key={row.knife.id} data-wishlist-row>
                  <Thumb knife={row.knife} size="sm" />
                  <div className="min-w-0">
                    <Link
                      href={`/collection/${encodeURIComponent(row.knife.id)}?tab=market`}
                      data-wishlist-name
                    >
                      {row.knife.name}
                    </Link>
                    <span data-wishlist-sub className="block truncate">
                      {[
                        row.knife.brand,
                        row.summary?.sources
                          ? storesLabel(row.summary.sources)
                          : 'No store links',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    <div data-wishlist-pills>
                      <DealPills row={row} />
                    </div>
                  </div>
                  <div data-wishlist-row-price>
                    <b>{money(row.priceMinor, row.currency)}</b>
                    <span data-wishlist-sub>
                      <PriceNote row={row} />
                    </span>
                  </div>
                  <div data-wishlist-row-range>
                    <RangeBar row={row} />
                  </div>
                  <div data-wishlist-row-trend>
                    <Sparkline row={row} width={110} />
                    {row.change30 !== null && (
                      <span data-wishlist-sub>
                        30d <Change value={row.change30} />
                      </span>
                    )}
                  </div>
                  <div data-wishlist-row-actions>
                    <PriceDetailsLink row={row} />
                    <WatchBell row={row} />
                    <RemoveButton row={row} />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

/* ---------- summary ---------- */

function Summary({ rows, currency }: { rows: Row[]; currency: string }) {
  const inCurrency = rows.filter(
    (row) => row.currency === currency && row.priceMinor !== null,
  )
  const today = inCurrency.reduce((sum, row) => sum + row.priceMinor!, 0)
  const onSale = inCurrency.filter(
    (row) => row.deal === 'sale' && row.regularMinor !== null,
  )
  const savings = onSale.reduce(
    (sum, row) => sum + (row.regularMinor! - row.priceMinor!),
    0,
  )
  const other = rows.length - inCurrency.length
  const outOfStock = rows.filter((row) => row.deal === 'out').length
  const watched = rows.filter((row) => row.summary?.monitored)
  const pages = watched.reduce(
    (sum, row) => sum + (row.summary?.sources ?? 0),
    0,
  )
  return (
    <div data-wishlist-summary>
      <div data-wishlist-stat>
        <div data-wishlist-stat-label>All of it today</div>
        <div data-wishlist-stat-value>{money(today, currency)}</div>
        <div data-wishlist-stat-label>
          {inCurrency.length} {inCurrency.length === 1 ? 'knife' : 'knives'}
          {other ? ` · ${other} without a ${currency} price` : ''}
          {outOfStock ? ` · ${outOfStock} out of stock` : ''}
        </div>
      </div>
      <div data-wishlist-stat>
        <div data-wishlist-stat-label>On sale now</div>
        <div data-wishlist-stat-value data-good={savings > 0 || undefined}>
          {savings > 0 ? `${money(savings, currency)} off` : 'Nothing yet'}
        </div>
        <div data-wishlist-stat-label>
          {onSale.length
            ? `${onSale.length} of ${rows.length} ${rows.length === 1 ? 'knife' : 'knives'} below regular price`
            : 'No knife is below its regular price'}
        </div>
      </div>
      <div data-wishlist-stat data-wishlist-watch>
        <div data-wishlist-stat-label>Price Drops watches</div>
        <div data-wishlist-stat-value>
          {watched.length} / {rows.length}
        </div>
        <div data-wishlist-stat-label>
          {pages} store {pages === 1 ? 'page' : 'pages'} ·{' '}
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
    .filter((row) => row.deal === 'sale' && row.regularMinor !== null)
    .sort(compareDeals)[0]
  if (!best) return null
  const saved = best.regularMinor! - best.priceMinor!
  const sources = best.summary?.sources ?? 0
  return (
    <section data-wishlist-hero>
      <Thumb knife={best.knife} size="lg" />
      <div className="min-w-0">
        <div data-wishlist-eyebrow>Best deal right now</div>
        <h2>{knifeTitle(best.knife)}</h2>
        <div data-wishlist-hero-price>
          <span data-wishlist-big>{money(best.priceMinor, best.currency)}</span>
          <s data-wishlist-sub>{money(best.regularMinor, best.currency)}</s>
          <DealPills row={best} />
        </div>
        <div data-wishlist-sub>
          {money(saved, best.currency)} below regular price
          {best.change30 !== null && best.change30 < 0
            ? ` · ${pct(best.change30)} in 30 days`
            : ''}{' '}
          · {storesLabel(sources)}
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
                      { action: 'add', knifeIds: [knife.id], lane: 'saving' },
                      `Added ${knife.name} to the wishlist`,
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
          description="Add knives you plan to buy. The wishlist shows store prices against the regular price, so you can see what’s on sale."
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
          <DealGroups rows={rows} />
        </>
      )}
      <AddKnivesDialog open={adding} onOpenChange={setAdding} />
    </div>
  )
}

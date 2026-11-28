'use client'

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import Link from 'next/link'
import { Popover } from '@base-ui/react/popover'
import { ArrowUpRight, ChartLine, Heart, Plus, X } from 'lucide-react'
import Image from '@/components/vault-image'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import {
  KnifeStoresList,
  knifeStoresLabel,
} from '@/components/price-drops/knife-stores-list'
import { money, relativeTime } from '@/components/price-drops/price-format'
import {
  regularChipLabel,
  regularGap,
} from '@/components/price-drops/price-trend'
import { RowPriceChart } from '@/components/price-drops/row-price-chart'
import {
  cachedRowChartStores,
  rowChartDirection,
  storeColor,
  type RowChartStore,
} from '@/components/price-drops/row-price-chart-model'
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
import { getSafeExternalUrl } from '@/lib/external-url'
import { type KnifeMarketSummary } from '@/lib/market-status'
import {
  fromMinorUnits,
  parseStoredPrice,
  toMinorUnits,
} from '@/lib/price-monitor/money'
import {
  WISHLIST_DEAL_LABELS,
  WISHLIST_DEALS,
  priceChange,
  rangePosition,
  wishlistDeal,
  wishlistMoves,
  wishlistStorePrices,
  wishlistDayTicks,
  wishlistTrackedDays,
  wishlistTrendDirection,
  type PriceTrends,
  type WishlistDeal,
  type WishlistItem,
  type WishlistMove,
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
  /** Price range: 90-day store low/high, today's and regular price. */
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
  // The regular price widens the range, so a discount shows in it even
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

function knifeTitle(knife: Knife) {
  return [knife.brand, knife.name].filter(Boolean).join(' ')
}

function storesLabel(sources: number) {
  return `${sources} ${sources === 1 ? 'store' : 'stores'}`
}

/** "$215" for compact range and chart labels. */
function wholeMoney(minor: number, currency: string | null): string {
  if (!currency) return '—'
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(fromMinorUnits(minor, currency))
  } catch {
    return money(minor, currency)
  }
}

/**
 * "3 of 6 stores" (or `label`, e.g. "+2 more"): opens where the knife is
 * sold, store by store (its store links, and what Other stores found at
 * each searched store).
 */
function StoresButton({ row, label }: { row: Row; label?: string }) {
  const { stores } = useWishlist()
  const now = useMinuteClock()
  const entries = stores[row.knife.id]
  if (!entries)
    return label ? null : (
      <>
        {row.summary?.sources
          ? storesLabel(row.summary.sources)
          : 'No store links'}
      </>
    )
  const storesText = knifeStoresLabel(entries)
  return (
    <Popover.Root>
      <Popover.Trigger
        type="button"
        data-wishlist-stores
        aria-label={
          label
            ? `${label} stores for ${knifeTitle(row.knife)}: show each store`
            : `${storesText} for ${knifeTitle(row.knife)}: show each store`
        }
      >
        {label ?? storesText}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={6}
          className="z-50"
        >
          <Popover.Popup
            data-wishlist-stores-popup
            className="max-h-[min(28rem,calc(100vh-2rem))] w-80 max-w-[calc(100vw-2rem)] overflow-auto rounded-xl border border-[var(--bladevault-line)] bg-popover p-3 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          >
            <Popover.Title className="mb-2 text-sm font-semibold">
              Stores for {row.knife.name}
            </Popover.Title>
            <KnifeStoresList entries={entries} now={now} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
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

/** "21 Nov" for the snapshot that introduced a move. */
function moveDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  })
}

/** "↓ $40.50 · 21 Nov". */
function moveLabel(move: WishlistMove, currency: string | null): string {
  return `${move.delta < 0 ? '↓' : '↑'} ${money(Math.abs(move.delta), currency)} · ${moveDate(move.at)}`
}

/** "▼ 20%" for the net change over the chart window; "<1%" for tiny moves. */
function chipLabel(net: number, base: number): string {
  if (!net) return '0%'
  const share = Math.round((Math.abs(net) / base) * 100)
  return `${net < 0 ? '▼' : '▲'} ${share ? `${share}%` : '<1%'}`
}

/**
 * Each store link's own 30-day history, by source id: the row charts'
 * dots. Loaded once per wishlist load; the charts work without it.
 */
const SourceTrendsContext = createContext<PriceTrends | null>(null)

function useSourceTrends(reloadKey: unknown): PriceTrends | null {
  const [trends, setTrends] = useState<PriceTrends | null>(null)
  useEffect(() => {
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
        // Dots are optional; the chart draws the best price without them.
      })
    return () => controller.abort()
  }, [reloadKey])
  return trends
}

const NO_STORES: RowChartStore[] = []

/**
 * Best store price while the knife has been tracked, as on Price Drops
 * (see `rowChartOption`): a filled area coloured by its latest move, a dot
 * in the store's colour for every store reading (the store list beside it
 * uses the same colours). Hovering lists every store's price at that
 * moment. Above the chart: how far the price is from the regular price and
 * the last move; under it, a mark per day, so a two-day chart does not read
 * like a month. The chart takes the rest of the row's width.
 */
function Sparkline({ row }: { row: Row }) {
  const { stores } = useWishlist()
  const sourceTrends = useContext(SourceTrendsContext)
  const trend = row.trend
  if (!trend) return <span data-wishlist-spark-empty>Not tracked yet</span>
  const priced = trend.steps.filter(
    (step): step is { at: number; price: number } => step.price !== null,
  )
  // Tracked, but no store has shown a price inside the window. Prices shown
  // while out of stock still chart: the chart is price history.
  if (!priced.length && !trend.readings?.length)
    return <span data-wishlist-spark-empty>No price yet</span>

  const regular =
    row.regularMinor !== null && row.currency === trend.currency
      ? row.regularMinor
      : null
  const entries = stores[row.knife.id] ?? []
  const chartStores = sourceTrends
    ? cachedRowChartStores(
        sourceTrends,
        entries.map((entry) => entry.source?.id ?? '').join(','),
        () =>
          entries.flatMap((entry) => {
            const own = entry.source && sourceTrends.sources[entry.source.id]
            return own
              ? [{ key: entry.laneKey, label: entry.label, trend: own }]
              : []
          }),
      )
    : NO_STORES

  const days = wishlistTrackedDays(trend)
  const dayText = `${days} ${days === 1 ? 'day' : 'days'}`
  const moves = wishlistMoves(trend)
  const change = moves.at(-1)
  const current = trend.steps[trend.steps.length - 1].price
  const stockNote = current === null ? ', out of stock now' : ''
  const net = priced.length
    ? priced[priced.length - 1].price - priced[0].price
    : 0
  // The chip reads against the regular price, when there is one.
  const gap = regularGap(
    row.live && !row.summary?.outOfStock ? row.priceMinor : null,
    regular,
  )
  const ticks = wishlistDayTicks(trend)
  const summary = moves.length
    ? `net ${net < 0 ? 'down' : 'up'} ${money(Math.abs(net), trend.currency)}, last change ${change!.delta < 0 ? 'down' : 'up'} ${money(Math.abs(change!.delta), trend.currency)} on ${moveDate(change!.at)}`
    : 'no price change'

  return (
    <div data-wishlist-spark-cell>
      <div data-wishlist-spark-head>
        {gap ? (
          <span>
            <span
              data-wishlist-spark-chip={gap.direction}
              data-wishlist-savings={gap.direction === 'down' || undefined}
              title={
                gap.direction === 'flat'
                  ? `At the regular price ${money(regular, trend.currency)}`
                  : `${money(Math.abs(gap.delta), trend.currency)} (${gap.share}%) ${gap.direction === 'down' ? 'below' : 'above'} the regular price ${money(regular, trend.currency)}`
              }
            >
              {regularChipLabel(gap, trend.currency)}
            </span>
            {gap.direction !== 'flat' && (
              <span data-wishlist-spark-note>
                {' '}
                {gap.direction === 'down' ? 'below' : 'above'} your price
              </span>
            )}
          </span>
        ) : (
          <span
            data-wishlist-spark-chip={wishlistTrendDirection(moves)}
            title={
              net
                ? `${net < 0 ? 'Down' : 'Up'} ${money(Math.abs(net), trend.currency)} over ${dayText}`
                : `No price change over ${dayText}`
            }
          >
            {chipLabel(net, priced[0]?.price ?? 0)}
          </span>
        )}
        {change ? (
          <span data-wishlist-spark-note>
            Last move{' '}
            <span data-wishlist-change={change.delta < 0 ? 'down' : 'up'}>
              {moveLabel(change, trend.currency)}
            </span>
          </span>
        ) : (
          <span data-wishlist-spark-note>No price change</span>
        )}
      </div>
      <div
        data-wishlist-spark-box
        data-wishlist-spark={rowChartDirection(trend)}
      >
        <div data-wishlist-spark-grid aria-hidden>
          {ticks.map((tick) => (
            <span key={tick.at} style={{ left: `${tick.left}%` }} />
          ))}
        </div>
        <RowPriceChart
          trend={trend}
          stores={chartStores}
          regularMinor={regular}
          ariaLabel={`Best store price over ${dayText}: ${summary}${stockNote}`}
        />
      </div>
      <div data-wishlist-spark-ticks aria-hidden>
        {ticks.map((tick) => (
          <span
            key={tick.at}
            style={{
              left: `${tick.left}%`,
              transform: `translateX(-${tick.left}%)`,
            }}
          >
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  )
}

/** How many of the cheapest stores a row lists. */
const BEST_STORES = 3

/**
 * The cheapest stores selling the knife now, each linking to its store
 * page, with the gap to the cheapest; "+N more" opens every store.
 */
function BestStores({ row }: { row: Row }) {
  const { stores } = useWishlist()
  const entries = stores[row.knife.id]
  const prices = wishlistStorePrices(entries, row.currency)
  if (!prices.length)
    return (
      <span data-wishlist-sub>
        {entries?.length || row.summary?.sources
          ? 'No store has it in stock'
          : 'Add a store link to compare'}
      </span>
    )
  const best = prices[0].priceMinor
  const shown = prices.slice(0, BEST_STORES)
  const more = (entries?.length ?? prices.length) - shown.length
  return (
    <div data-wishlist-best-stores>
      <ul aria-label={`Cheapest stores for ${knifeTitle(row.knife)}`}>
        {shown.map((price) => {
          const url = getSafeExternalUrl(price.url)
          const diff = price.priceMinor - best
          const content = (
            <>
              <span data-wishlist-store-name>
                <i
                  data-wishlist-store-dot
                  aria-hidden
                  style={
                    {
                      '--store-light': storeColor(price.key),
                      '--store-dark': storeColor(price.key, true),
                    } as CSSProperties
                  }
                />
                {price.label}
                <ArrowUpRight aria-hidden className="size-3 shrink-0" />
              </span>
              <b>{money(price.priceMinor, row.currency)}</b>
              <span data-wishlist-store-diff>
                {diff ? `+${money(diff, row.currency)}` : 'best'}
              </span>
            </>
          )
          return (
            <li key={price.key} data-best={!diff || undefined}>
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Open ${price.label}`}
                >
                  {content}
                </a>
              ) : (
                <span>{content}</span>
              )}
            </li>
          )
        })}
      </ul>
      {more > 0 && <StoresButton row={row} label={`+${more} more`} />}
    </div>
  )
}

/** "90-day $122–$215": the range the price moved in, with the regular price. */
function RangeNote({ row }: { row: Row }) {
  const { rangeLow: low, rangeHigh: high, currency } = row
  if (low === null || high === null || high <= low) return null
  return (
    <span
      data-wishlist-sub
      title="Lowest and highest store price in the last 90 days, with the regular price"
    >
      90-day {wholeMoney(low, currency)}–{wholeMoney(high, currency)}
    </span>
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
        <span data-wishlist-savings>
          {money(row.regularMinor - row.priceMinor!, row.currency)}
        </span>
      </>
    )
  if (row.deal === 'above')
    return <>regular {money(row.regularMinor, row.currency)}</>
  return <>regular price</>
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

function DealGroups({ rows, tabs }: { rows: Row[]; tabs?: ReactNode }) {
  // The brand tabs ride on the first group that actually renders.
  const firstDeal = WISHLIST_DEALS.find((deal) =>
    rows.some((row) => row.deal === deal),
  )
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
              {deal === firstDeal && tabs}
            </header>
            <ul data-wishlist-list>
              {groupRows.map((row) => (
                <li key={row.knife.id} data-wishlist-row>
                  <Thumb knife={row.knife} size="sm" />
                  <div data-wishlist-row-info className="min-w-0">
                    <div data-wishlist-title-line>
                      <Link
                        href={`/collection/${encodeURIComponent(row.knife.id)}?tab=market`}
                        data-wishlist-name
                      >
                        {row.knife.name}
                      </Link>
                      <PriceDetailsLink row={row} />
                      <RemoveButton row={row} />
                    </div>
                    <span data-wishlist-sub className="block truncate">
                      {row.knife.brand ? `${row.knife.brand} · ` : ''}
                      <StoresButton row={row} />
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
                    <RangeNote row={row} />
                  </div>
                  <div data-wishlist-row-stores>
                    <BestStores row={row} />
                  </div>
                  <div data-wishlist-row-trend>
                    <Sparkline row={row} />
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

/* ---------- brand tabs ---------- */

/** Tab key for knives saved without a brand. */
const NO_BRAND = '\u0000none'

type BrandTab = { key: string; label: string; count: number }

function brandKey(knife: Knife): string {
  return knife.brand?.trim() || NO_BRAND
}

/** Brands present in the wishlist, most knives first. */
function wishlistBrands(rows: Row[]): BrandTab[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = brandKey(row.knife)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts]
    .map(([key, count]) => ({
      key,
      label: key === NO_BRAND ? 'Other' : key,
      count,
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        Number(a.key === NO_BRAND) - Number(b.key === NO_BRAND) ||
        a.label.localeCompare(b.label),
    )
}

function BrandTabs({
  brands,
  total,
  active,
  onChange,
}: {
  brands: BrandTab[]
  total: number
  active: string | null
  onChange: (brand: string | null) => void
}) {
  if (brands.length < 2) return null
  const tabs = [{ key: null, label: 'All', count: total }, ...brands]
  return (
    <div
      role="tablist"
      aria-label="Filter wishlist by brand"
      data-wishlist-brand-tabs
    >
      {tabs.map((tab) => (
        <button
          key={tab.key ?? 'all'}
          type="button"
          role="tab"
          aria-selected={tab.key === active}
          data-wishlist-brand-tab
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
          <span data-wishlist-sub>{tab.count}</span>
        </button>
      ))}
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

/** How many deal cards the page leads with. */
const BEST_DEALS = 3
const DEAL_EYEBROWS = ['Best deal right now', '2nd best deal', '3rd best deal']

/** The biggest discounts as compact cards; each opens the knife's prices. */
function BestDeals({ rows }: { rows: Row[] }) {
  const best = rows
    .filter((row) => row.deal === 'sale' && row.regularMinor !== null)
    .sort(compareDeals)
    .slice(0, BEST_DEALS)
  if (!best.length) return null
  return (
    <section data-wishlist-deals aria-label="Best deals">
      {best.map((row, index) => {
        const title = knifeTitle(row.knife)
        const price = money(row.priceMinor, row.currency)
        return (
          <Link
            key={row.knife.id}
            href={`/price-drops?knife=${encodeURIComponent(row.knife.id)}`}
            data-wishlist-deal
            aria-label={`${DEAL_EYEBROWS[index]}: ${title}, ${price}. See store prices`}
          >
            <Thumb knife={row.knife} size="lg" />
            <div className="min-w-0">
              <div data-wishlist-eyebrow>{DEAL_EYEBROWS[index]}</div>
              <h2>{title}</h2>
              <div data-wishlist-deal-price>
                <span data-wishlist-big>{price}</span>
                <s data-wishlist-sub>{money(row.regularMinor, row.currency)}</s>
              </div>
              <div data-wishlist-pills>
                <DealPills row={row} />
              </div>
              <div data-wishlist-sub>
                <span data-wishlist-savings>
                  {money(row.regularMinor! - row.priceMinor!, row.currency)}
                </span>{' '}
                below regular price
              </div>
            </div>
          </Link>
        )
      })}
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
  // Reloads with the wishlist's own trends (after a check or an edit).
  const sourceTrends = useSourceTrends(available ? trends : null)
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
  const [brand, setBrand] = useState<string | null>(null)
  const brands = useMemo(() => wishlistBrands(rows), [rows])
  // A brand whose last knife left the wishlist falls back to All.
  const activeBrand =
    brand !== null && brands.length > 1 && brands.some((b) => b.key === brand)
      ? brand
      : null
  const visibleRows = useMemo(
    () =>
      activeBrand === null
        ? rows
        : rows.filter((row) => brandKey(row.knife) === activeBrand),
    [rows, activeBrand],
  )

  const header = (
    <PageHeader
      title="Wishlist"
      actions={
        available ? (
          <Button onClick={() => setAdding(true)}>
            <Plus className="size-4" />
            Add to wishlist
          </Button>
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
    <SourceTrendsContext.Provider value={sourceTrends}>
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
            <Summary rows={visibleRows} currency={currency} />
            <BestDeals rows={visibleRows} />
            <DealGroups
              rows={visibleRows}
              tabs={
                <BrandTabs
                  brands={brands}
                  total={rows.length}
                  active={activeBrand}
                  onChange={setBrand}
                />
              }
            />
          </>
        )}
        <AddKnivesDialog open={adding} onOpenChange={setAdding} />
      </div>
    </SourceTrendsContext.Provider>
  )
}

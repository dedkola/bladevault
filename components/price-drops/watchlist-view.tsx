'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { ExternalLink, Loader2, Plus, ShoppingBag, Trash2 } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { getSafeExternalUrl } from '@/lib/external-url'
import { fromMinorUnits } from '@/lib/price-monitor/money'
import type {
  WatchlistItem,
  Watchlist,
} from '@/lib/price-monitor/watchlist-shared'
import { cn } from '@/lib/utils'
import { KnifePricePanel } from './knife-price-panel'
import { money, relativeTime, storeLabel } from './price-format'
import { PriceWatchEditor } from './price-watch-editor'
import { KnifeThumb, useMinuteClock } from './price-ui'
import { WatchlistAddDialog } from './watchlist-add-dialog'

const REFRESH_MS = 60_000

function useWatchlist(version: number) {
  const [watchlist, setWatchlist] = useState<Watchlist | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const response = await fetch('/api/watchlist', {
          cache: 'no-store',
          signal: controller.signal,
        })
        const data = (await response.json()) as {
          watchlist?: Watchlist
          error?: string
        }
        if (controller.signal.aborted) return
        if (!response.ok || !data.watchlist)
          setError(data.error ?? 'Could not load the watchlist.')
        else {
          setError(null)
          setWatchlist(data.watchlist)
        }
      } catch {
        if (!controller.signal.aborted)
          setError('Could not load the watchlist.')
      }
    }
    void load()
    return () => controller.abort()
  }, [version, tick])
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') setTick((value) => value + 1)
    }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [])
  return { watchlist, error }
}

function GapText({ item }: { item: WatchlistItem }) {
  if (!item.target) return <span className="text-muted-foreground">—</span>
  if (item.gapMinor === null)
    return <span className="text-muted-foreground">no price yet</span>
  if (item.atTarget)
    return (
      <span
        data-price-pill="target"
        className="inline-flex rounded-full px-2 py-0.5 text-[11.5px] font-semibold"
      >
        At target
      </span>
    )
  return (
    <span className="tabular-nums">
      {money(item.gapMinor, item.target.currency)} to go
    </span>
  )
}

const STOCK_LABEL: Record<WatchlistItem['stock'], string> = {
  in_stock: 'In stock',
  out_of_stock: 'Out of stock',
  unknown: '—',
}

function TargetEditor({
  item,
  onSaved,
}: {
  item: WatchlistItem
  onSaved: () => void
}) {
  const id = useId()
  const [amount, setAmount] = useState(
    item.target
      ? String(fromMinorUnits(item.target.minor, item.target.currency))
      : '',
  )
  const [currency, setCurrency] = useState(
    item.target?.currency ?? item.best?.currency ?? 'USD',
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (clear: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(
        `/api/watchlist/${encodeURIComponent(item.knife.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target: clear ? null : { amount, currency },
          }),
        },
      )
      const data = (await response.json().catch(() => ({}))) as {
        error?: string
      }
      if (!response.ok) throw new Error(data.error ?? 'Could not save.')
      if (clear) setAmount('')
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      data-watchlist-target
      className="space-y-1.5"
      onSubmit={(event) => {
        event.preventDefault()
        void save(false)
      }}
    >
      <label
        htmlFor={`${id}-amount`}
        className="block text-[10px] font-medium tracking-[0.16em] text-muted-foreground uppercase"
      >
        Target price
      </label>
      <div className="flex flex-wrap gap-2">
        <Input
          id={`${id}-amount`}
          inputMode="decimal"
          placeholder="e.g. 120"
          className="w-28"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
        <Input
          aria-label="Currency"
          className="w-20 uppercase"
          maxLength={3}
          value={currency}
          onChange={(event) => setCurrency(event.target.value.toUpperCase())}
        />
        <Button type="submit" size="sm" disabled={busy || !amount.trim()}>
          Save
        </Button>
        {item.target ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void save(true)}
          >
            Clear
          </Button>
        ) : null}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </form>
  )
}

function BoughtForm({
  item,
  onCancel,
}: {
  item: WatchlistItem
  onCancel: () => void
}) {
  const id = useId()
  const router = useRouter()
  const suggested = item.best
    ? `${fromMinorUnits(item.best.priceMinor, item.best.currency)} ${item.best.currency}`
    : ''
  const [price, setPrice] = useState(suggested)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(
        `/api/watchlist/${encodeURIComponent(item.knife.id)}/bought`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ price }),
        },
      )
      const data = (await response.json().catch(() => ({}))) as {
        error?: string
      }
      if (!response.ok) throw new Error(data.error ?? 'Could not move it.')
      // A full load so the collection list picks the knife up.
      router.push(`/collection/${encodeURIComponent(item.knife.id)}`)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not move it.')
      setBusy(false)
    }
  }

  return (
    <form
      data-watchlist-bought
      onSubmit={(event) => void submit(event)}
      className="space-y-2 rounded-lg border border-[var(--bladevault-line)] p-3"
    >
      <p className="text-sm">
        Move it into your collection. Its price history and stores come with it.
      </p>
      <label htmlFor={`${id}-price`} className="block text-xs font-medium">
        What you paid <span className="text-muted-foreground">(optional)</span>
      </label>
      <Input
        id={`${id}-price`}
        placeholder="e.g. 129.00 USD"
        value={price}
        onChange={(event) => setPrice(event.target.value)}
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Move to collection
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function WatchlistDetail({
  item,
  onChanged,
  onRemoved,
}: {
  item: WatchlistItem
  onChanged: () => void
  onRemoved: () => void
}) {
  const [buying, setBuying] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editorVersion, setEditorVersion] = useState(0)
  const [panelVersion, setPanelVersion] = useState(0)
  const storeUrl = getSafeExternalUrl(item.sourceUrl)

  const remove = async () => {
    if (
      !window.confirm(
        `Remove ${item.knife.brand} ${item.knife.name} from the watchlist? Its price history is deleted too.`,
      )
    )
      return
    setRemoving(true)
    setError(null)
    try {
      const response = await fetch(
        `/api/knives/${encodeURIComponent(item.knife.id)}`,
        { method: 'DELETE' },
      )
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string
        }
        throw new Error(data.error ?? 'Could not remove it.')
      }
      onRemoved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove it.')
      setRemoving(false)
    }
  }

  return (
    <div data-watchlist-detail={item.knife.id} className="space-y-4">
      <div className="flex items-start gap-3">
        <KnifeThumb knife={item.knife} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold">
            {item.knife.brand} {item.knife.name}
          </h2>
          <p className="text-xs text-muted-foreground">
            Wanted since{' '}
            {new Date(item.addedAt).toLocaleDateString(undefined, {
              dateStyle: 'medium',
            })}
            {storeUrl ? (
              <>
                {' · '}
                <a
                  href={storeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
                >
                  Product page <ExternalLink className="size-3" />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </>
            ) : null}
          </p>
        </div>
      </div>

      <TargetEditor
        key={`${item.knife.id}-${item.target?.minor}-${item.target?.currency}`}
        item={item}
        onSaved={onChanged}
      />

      <KnifePricePanel
        key={`${item.knife.id}-${panelVersion}`}
        knifeId={item.knife.id}
        variant="tab"
        wanted
        onChanged={onChanged}
      />

      <details
        className="rounded-lg border border-[var(--bladevault-line)] p-3"
        onToggle={(event) => {
          // Reload the panel after the editor changed sources.
          if (!event.currentTarget.open) setPanelVersion((value) => value + 1)
        }}
      >
        <summary className="cursor-pointer text-sm font-medium">
          Stores and monitoring
        </summary>
        <div className="mt-3">
          <PriceWatchEditor
            key={editorVersion}
            knifeId={item.knife.id}
            onUnavailable={() => setEditorVersion((value) => value + 1)}
          />
        </div>
      </details>

      {buying ? (
        <BoughtForm item={item} onCancel={() => setBuying(false)} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setBuying(true)}>
            <ShoppingBag className="size-3.5" />I bought it
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={removing}
            onClick={() => void remove()}
          >
            <Trash2 className="size-3.5" />
            Remove
          </Button>
        </div>
      )}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}

/**
 * Watchlist: knives the collector wants, each with an optional target price.
 * Price Drops monitors their stores like any collection knife; they stay out
 * of the collection until "I bought it".
 */
export function WatchlistView({ initialKnife }: { initialKnife?: string }) {
  const [version, setVersion] = useState(0)
  const { watchlist, error } = useWatchlist(version)
  const [selected, setSelected] = useState<string | null>(initialKnife ?? null)
  const [adding, setAdding] = useState(false)
  const now = useMinuteClock()
  const reload = () => setVersion((value) => value + 1)

  const items = watchlist?.items ?? []
  const current =
    items.find((item) => item.knife.id === selected) ?? items[0] ?? null

  const header = (
    <PageHeader
      title="Watchlist"
      description="Knives you want but don’t own yet. Their stores are checked with the rest of Price Drops, and your Inbox tells you when a price reaches your target."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/price-drops"
            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
          >
            Price Drops
          </Link>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            Add wanted knife
          </Button>
        </div>
      }
    />
  )

  const dialog = (
    <WatchlistAddDialog
      open={adding}
      onOpenChange={setAdding}
      onAdded={(knifeId) => {
        setSelected(knifeId)
        reload()
      }}
    />
  )

  if (!watchlist)
    return (
      <div data-watchlist className="w-full">
        {header}
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : (
          <div className="grid h-40 place-items-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {dialog}
      </div>
    )

  return (
    <div data-watchlist className="w-full">
      {header}
      {!items.length ? (
        <Card>
          <CardContent className="space-y-2 py-6 text-sm">
            <p className="font-medium">Your watchlist is empty.</p>
            <p className="text-muted-foreground">
              Add a knife you want with its store link and a target price. Price
              Drops checks it on the same schedule as your collection, and it
              never shows up in your collection, Insights or Studio until you
              buy it.
            </p>
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="size-3.5" />
              Add wanted knife
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card data-price-table className="gap-0 overflow-hidden py-0">
          <div className="grid items-start lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)]">
            <div className="min-w-0 overflow-x-auto px-3 pb-2">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--bladevault-line)] text-left text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
                    <th className="py-2 pl-1 font-medium">Knife</th>
                    <th className="py-2 pr-3 text-right font-medium">
                      Best price
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">Target</th>
                    <th className="py-2 pr-3 font-medium">Gap</th>
                    <th className="py-2 pr-3 font-medium">Stock</th>
                    <th className="py-2 pr-1 font-medium">Checked</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const isSelected = current?.knife.id === item.knife.id
                    return (
                      <tr
                        key={item.knife.id}
                        data-watchlist-row={item.atTarget ? 'target' : 'wait'}
                        aria-selected={isSelected}
                        onClick={() => setSelected(item.knife.id)}
                        className={cn(
                          'cursor-pointer border-b border-[var(--bladevault-line)]/60 transition-colors hover:bg-[var(--bladevault-surface-soft)]',
                          isSelected && 'bg-[var(--bladevault-surface-soft)]',
                        )}
                      >
                        <td className="py-2 pr-3 pl-1">
                          <button
                            type="button"
                            aria-pressed={isSelected}
                            onClick={(event) => {
                              event.stopPropagation()
                              setSelected(item.knife.id)
                            }}
                            className="flex min-w-0 items-center gap-2.5 text-left"
                          >
                            <KnifeThumb knife={item.knife} className="size-8" />
                            <span className="min-w-0">
                              <span className="block max-w-[16rem] truncate font-medium">
                                {item.knife.brand} {item.knife.name}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {item.best
                                  ? storeLabel(item.best.storeName)
                                  : item.sources
                                    ? `${item.sources} ${item.sources === 1 ? 'store' : 'stores'}`
                                    : 'No store link yet'}
                              </span>
                            </span>
                          </button>
                        </td>
                        <td className="py-2 pr-3 text-right font-semibold whitespace-nowrap tabular-nums">
                          {item.best
                            ? money(item.best.priceMinor, item.best.currency)
                            : '—'}
                        </td>
                        <td className="py-2 pr-3 text-right whitespace-nowrap tabular-nums">
                          {item.target
                            ? money(item.target.minor, item.target.currency)
                            : '—'}
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap">
                          <GapText item={item} />
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap text-xs">
                          {STOCK_LABEL[item.stock]}
                        </td>
                        <td className="py-2 pr-1 text-xs whitespace-nowrap text-muted-foreground">
                          {item.lastCheckedAt
                            ? relativeTime(item.lastCheckedAt, now)
                            : item.monitored
                              ? 'not yet'
                              : 'not monitored'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <aside
              aria-label="Selected wanted knife"
              className="border-t border-[var(--bladevault-line)]/60 p-4 lg:border-t-0 lg:border-l"
            >
              {current ? (
                <WatchlistDetail
                  key={current.knife.id}
                  item={current}
                  onChanged={reload}
                  onRemoved={() => {
                    setSelected(null)
                    reload()
                  }}
                />
              ) : null}
            </aside>
          </div>
        </Card>
      )}
      {dialog}
    </div>
  )
}

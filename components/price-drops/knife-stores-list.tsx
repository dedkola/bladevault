'use client'

import {
  AlertTriangle,
  Check,
  CircleSlash,
  Clock,
  ExternalLink,
  Layers,
  Minus,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { money, relativeTime } from '@/components/price-drops/price-format'
import { getSafeExternalUrl } from '@/lib/external-url'
import type {
  KnifeStoreEntry,
  KnifeStoreState,
  KnifeStoreVariant,
} from '@/lib/price-monitor/shared'
import { cn } from '@/lib/utils'

/**
 * Where a knife is sold, store by store: its store links with their price,
 * and for the stores Other stores searches, what the last search found.
 * Shared by the Wishlist's store popover and the knife's Market tab.
 */

const STATE_ICON: Record<KnifeStoreState, typeof Check> = {
  listed: Check,
  variant: Layers,
  not_sold: Minus,
  failed: AlertTriangle,
  waiting: Clock,
  off: CircleSlash,
}

/** "3 of 6 stores", or "3 stores" when no other store is searched. */
export function knifeStoresLabel(entries: readonly KnifeStoreEntry[]): string {
  const listed = entries.filter((entry) => entry.state === 'listed').length
  const total = entries.length
  if (!total) return 'No store links'
  if (listed === total) return `${total} ${total === 1 ? 'store' : 'stores'}`
  return `${listed} of ${total} stores`
}

function statusText(entry: KnifeStoreEntry, now: number): string {
  switch (entry.state) {
    case 'listed': {
      const source = entry.source
      if (!source) return ''
      if (!source.enabled) return 'paused'
      if (source.availability === 'out_of_stock') return 'out of stock'
      if (source.priceMinor !== null && source.currency)
        return money(source.priceMinor, source.currency)
      if (source.status === 'pending') return 'first check pending'
      return 'no price yet'
    }
    case 'variant': {
      const count = entry.variants.length
      return `${count} other ${count === 1 ? 'variant' : 'variants'}`
    }
    case 'not_sold':
      return 'not sold here'
    case 'failed':
      return entry.search?.nextAt
        ? `search failed · retry ${relativeTime(entry.search.nextAt, now, 'short')}`
        : 'search failed'
    case 'waiting':
      return 'not searched yet'
    case 'off':
      return 'not searched'
  }
}

/**
 * A monitored variant shows its latest check; the rest the price from the
 * store's search results.
 */
function variantPrice(variant: KnifeStoreVariant): string | null {
  const live = variant.monitored
  if (!live) return variant.price
  if (!live.enabled) return 'paused'
  if (live.availability === 'out_of_stock') return 'out of stock'
  if (live.priceMinor !== null && live.currency)
    return money(live.priceMinor, live.currency)
  return variant.price
}

/** When the store is searched again, for stores without a listing. */
function nextSearchText(entry: KnifeStoreEntry, now: number): string | null {
  if (entry.state === 'listed' || entry.state === 'failed') return null
  const next = entry.search?.nextAt
  if (!next) return null
  return Date.parse(next) <= now
    ? 'searched again soon'
    : `searched again ${relativeTime(next, now, 'short')}`
}

function StoreLink({
  url,
  children,
  className,
  title,
}: {
  url: string | null
  children: ReactNode
  className?: string
  title?: string
}) {
  const safe = getSafeExternalUrl(url)
  if (!safe)
    return <span className={cn('min-w-0 truncate', className)}>{children}</span>
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className={cn(
        'inline-flex min-w-0 items-center gap-1 hover:underline',
        className,
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
      <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
    </a>
  )
}

export function KnifeStoresList({
  entries,
  now,
  className,
}: {
  entries: readonly KnifeStoreEntry[]
  now: number
  className?: string
}) {
  if (!entries.length)
    return (
      <p className={cn('text-sm text-muted-foreground', className)}>
        No store links yet.
      </p>
    )
  return (
    <ul className={cn('grid gap-2', className)} data-knife-stores>
      {entries.map((entry) => {
        const Icon = STATE_ICON[entry.state]
        const next = nextSearchText(entry, now)
        const listed = entry.state === 'listed'
        return (
          <li
            key={entry.laneKey}
            data-knife-store-state={entry.state}
            className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2 text-sm"
          >
            <Icon
              aria-hidden
              className={cn(
                'mt-0.5 size-4',
                listed
                  ? 'text-[var(--bladevault-gold)]'
                  : entry.state === 'failed'
                    ? 'text-destructive'
                    : 'text-muted-foreground',
              )}
            />
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2">
                {listed ? (
                  <StoreLink
                    url={entry.source?.url ?? null}
                    className="font-medium"
                  >
                    {entry.label}
                  </StoreLink>
                ) : (
                  <span className="truncate font-medium">{entry.label}</span>
                )}
                <span
                  className={cn(
                    'shrink-0 tabular-nums',
                    listed ? 'font-medium' : 'text-muted-foreground',
                  )}
                >
                  {statusText(entry, now)}
                </span>
              </div>
              {entry.detail && !listed ? (
                <p className="text-xs text-muted-foreground">{entry.detail}</p>
              ) : null}
              {next ? (
                <p className="text-xs text-muted-foreground">{next}</p>
              ) : null}
              {entry.variants.length ? (
                <ul
                  className="mt-1 grid gap-0.5 text-xs"
                  aria-label="Other variants at this store"
                >
                  {entry.variants.map((variant) => (
                    <li
                      key={variant.url}
                      className="flex min-w-0 items-baseline justify-between gap-2"
                    >
                      <StoreLink url={variant.url} title={variant.title}>
                        {variant.title}
                      </StoreLink>
                      {variantPrice(variant) ? (
                        <span
                          className="shrink-0 tabular-nums text-muted-foreground"
                          title={
                            variant.monitored
                              ? 'Monitored: latest checked price'
                              : 'Price from the store’s search results'
                          }
                        >
                          {variantPrice(variant)}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

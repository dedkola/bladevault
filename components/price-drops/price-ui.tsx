'use client'

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { getImageUrl } from '@/lib/data'
import type { ChangeEvent, KnifeRef } from '@/lib/price-monitor/insights'
import { cn } from '@/lib/utils'
import { deltaLabel, type StatusTone } from './price-format'

/** Shared small pieces of the Price Drops page and the Market tab. */

export function KnifeThumb({
  knife,
  className,
}: {
  knife: KnifeRef
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  const initials = (knife.brand || knife.name).slice(0, 2).toUpperCase()
  return (
    <span
      data-price-thumb
      className={cn(
        'grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-[var(--bladevault-surface-soft)] text-[11px] font-semibold text-muted-foreground',
        className,
      )}
      aria-hidden="true"
    >
      {knife.image && !failed ? (
        // Collection images are local files served by the vault API.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={getImageUrl(knife.image)}
          alt=""
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        initials
      )}
    </span>
  )
}

const PILL =
  'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-semibold tabular-nums'

/** Drop, increase or stock change, styled so stock never reads as price. */
export function ChangePill({ event }: { event: ChangeEvent }) {
  if (event.kind === 'out_of_stock')
    return (
      <span data-price-pill="oos" className={PILL}>
        Out of stock
      </span>
    )
  if (event.kind === 'back_in_stock')
    return (
      <span data-price-pill="back" className={PILL}>
        Back in stock
      </span>
    )
  return (
    <span data-price-pill={event.kind} className={PILL}>
      {deltaLabel(event)}
    </span>
  )
}

/**
 * Stands in for a price comparison when the store shows another currency
 * than the purchase price ("UAH price"), so the blank reads as intended.
 */
export function CurrencyMismatch({
  currency,
  paidCurrency,
  className,
}: {
  currency: string
  paidCurrency: string
  className?: string
}) {
  const title = `This store shows prices in ${currency} and you paid in ${paidCurrency}, so they are not compared.`
  return (
    <span
      data-price-currency-mismatch
      title={title}
      className={cn('text-xs text-muted-foreground', className)}
    >
      {currency} price
      <span className="sr-only"> — {title}</span>
    </span>
  )
}

export function StatusDot({ tone }: { tone: StatusTone }) {
  return (
    <span
      data-price-dot={tone}
      aria-hidden="true"
      className="inline-block size-2 shrink-0 rounded-full"
    />
  )
}

/** Re-renders every minute so relative times stay current. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/**
 * Per-browser preferences (last tab, chart range, collapsed panels). Storage
 * can be blocked or throw, so a value written this session is also kept in
 * memory and the page works without it.
 */
const memory = new Map<string, string>()
const storageListeners = new Set<() => void>()

function readStored(key: string): string | null {
  if (memory.has(key)) return memory.get(key)!
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function subscribeStored(listener: () => void) {
  storageListeners.add(listener)
  window.addEventListener('storage', listener)
  return () => {
    storageListeners.delete(listener)
    window.removeEventListener('storage', listener)
  }
}

/**
 * A string preference stored in localStorage under `key`. The server render
 * and first paint use `fallback`, so hydration never mismatches.
 */
export function useStoredValue<T extends string>(
  key: string,
  fallback: T,
  parse: (raw: string | null) => T | null,
): [T, (value: T) => void] {
  const raw = useSyncExternalStore(
    subscribeStored,
    () => readStored(key),
    () => null,
  )
  const value = parse(raw) ?? fallback
  const setValue = useCallback(
    (next: T) => {
      memory.set(key, next)
      try {
        window.localStorage.setItem(key, next)
      } catch {
        // Private windows and blocked storage keep it for this session only.
      }
      for (const listener of storageListeners) listener()
    },
    [key],
  )
  return [value, setValue]
}

/** True while a CSS media query matches; false on the server. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', listener)
      return () => list.removeEventListener('change', listener)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

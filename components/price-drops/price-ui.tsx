'use client'

import { useEffect, useState } from 'react'
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

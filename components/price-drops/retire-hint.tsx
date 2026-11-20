'use client'

import Link from 'next/link'
import { useState } from 'react'
import { Loader2, Pause } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import type { RetireHint } from '@/lib/price-monitor/shared'
import { cn } from '@/lib/utils'
import { storeLabel } from './price-format'

const DAY_MS = 24 * 60 * 60 * 1000

/** Why the listing may be gone, in one sentence. */
export function retireHintText(input: {
  hint: RetireHint
  storeName: string
  outOfStockSince: string | null
  now: number
}): string {
  const store = storeLabel(input.storeName)
  if (input.hint === 'page_gone')
    return `The page at ${store} is gone (not found), so the listing may have been removed.`
  const since = input.outOfStockSince ? Date.parse(input.outOfStockSince) : NaN
  const days = Number.isFinite(since)
    ? Math.floor((input.now - since) / DAY_MS)
    : null
  return days
    ? `Out of stock at ${store} for ${days} days, so it may be discontinued.`
    : `Out of stock at ${store} for a long time, so it may be discontinued.`
}

/**
 * A listing that may be gone for good: out of stock for 60 days or its page
 * is missing. Suggests pausing the source (one click) or adding another
 * store for the knife.
 */
export function RetireHintNotice({
  hint,
  knifeId,
  sourceId,
  storeName,
  outOfStockSince,
  now,
  onPaused,
  className,
}: {
  hint: RetireHint
  knifeId: string
  sourceId: number
  storeName: string
  outOfStockSince: string | null
  now: number
  onPaused: () => void
  className?: string
}) {
  const [pausing, setPausing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pause = async () => {
    setPausing(true)
    setError(null)
    try {
      const response = await fetch(
        `/api/knives/${encodeURIComponent(knifeId)}/price-watch`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ update: [{ id: sourceId, enabled: false }] }),
        },
      )
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string
        }
        throw new Error(data.error ?? 'Could not pause this source.')
      }
      onPaused()
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not pause this source.',
      )
    } finally {
      setPausing(false)
    }
  }
  return (
    <div
      data-price-retire-hint={hint}
      className={cn('text-xs text-muted-foreground', className)}
    >
      <p>
        {retireHintText({ hint, storeName, outOfStockSince, now })} Pause it, or
        add another store for this knife.
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={pausing}
          onClick={(event) => {
            event.stopPropagation()
            void pause()
          }}
        >
          {pausing ? <Loader2 className="animate-spin" /> : <Pause />}
          Pause
        </Button>
        <Link
          href={`/collection/${encodeURIComponent(knifeId)}?edit=1`}
          onClick={(event) => event.stopPropagation()}
          className={buttonVariants({ variant: 'ghost', size: 'xs' })}
        >
          Add another store
        </Link>
      </div>
      {error ? <p className="mt-1 text-destructive">{error}</p> : null}
    </div>
  )
}

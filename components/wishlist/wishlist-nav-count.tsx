'use client'

import { useMemo, type ComponentProps } from 'react'
import { ArrowDown } from 'lucide-react'
import { useKnives } from '@/components/providers/knives-provider'
import { useMarket } from '@/components/providers/market-provider'
import { useWishlist } from '@/components/providers/wishlist-provider'
import { wishlistSummaryDeal } from '@/lib/wishlist'
import { cn } from '@/lib/utils'

export function formatNavCount(count: number) {
  return count > 99 ? '99+' : String(count)
}

/** Wishlisted knives still in the vault, and how many are on sale now. */
export function useWishlistNavCounts(): { total: number; onSale: number } {
  const { knives } = useKnives()
  const { byId } = useMarket()
  const { available, items } = useWishlist()
  return useMemo(() => {
    if (!available) return { total: 0, onSale: 0 }
    const ids = new Set(knives.map((knife) => knife.id))
    let total = 0,
      onSale = 0
    for (const item of items) {
      if (!ids.has(item.knifeId)) continue
      total++
      if (wishlistSummaryDeal(byId.get(item.knifeId)) === 'sale') onSale++
    }
    return { total, onSale }
  }, [available, items, knives, byId])
}

export function wishlistCountLabel(total: number, onSale: number) {
  const knives = `${total} ${total === 1 ? 'knife' : 'knives'} on the wishlist`
  return onSale > 0 ? `${knives}, ${onSale} on sale now` : knives
}

/** Sidebar badges: a green "↓ n" for knives on sale, then the total. */
export function WishlistNavCount({ active }: { active: boolean }) {
  const { total, onSale } = useWishlistNavCounts()
  if (total === 0) return null
  return (
    <span data-wishlist-nav-count className="inline-flex items-center gap-1">
      <span className="sr-only">{wishlistCountLabel(total, onSale)}</span>
      {onSale > 0 ? <WishlistSaleBadge count={onSale} /> : null}
      <span
        data-sidebar-count
        aria-hidden="true"
        className={cn(
          'inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none',
          active
            ? 'bg-[var(--bladevault-gold)] text-[var(--bladevault-olive)]'
            : 'bg-muted text-foreground',
        )}
      >
        {formatNavCount(total)}
      </span>
    </span>
  )
}

/** Green "↓ n" badge for wishlisted knives on sale now. Decorative: pair it
 * with `wishlistCountLabel` for screen readers. */
export function WishlistSaleBadge({
  count,
  className,
  ...props
}: ComponentProps<'span'> & { count: number }) {
  return (
    <span
      data-wishlist-sale-count
      aria-hidden="true"
      title={`${count} on sale now`}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-full bg-[color-mix(in_srgb,var(--price-drop)_16%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-[var(--price-drop)] tabular-nums',
        className,
      )}
      {...props}
    >
      <ArrowDown className="h-2.5 w-2.5" strokeWidth={3} />
      {formatNavCount(count)}
    </span>
  )
}

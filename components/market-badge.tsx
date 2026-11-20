'use client'

import { useSearchParams } from 'next/navigation'
import { useKnives } from '@/components/providers/knives-provider'
import { useMarket } from '@/components/providers/market-provider'
import {
  MARKET_PARAM,
  marketDescription,
  marketLabel,
  marketTone,
  type MarketTone,
} from '@/lib/market-status'
import { cn } from '@/lib/utils'

export function marketToneTextClass(tone: MarketTone): string {
  switch (tone) {
    case 'dropped':
    case 'below_paid':
      return 'text-emerald-700 dark:text-emerald-400'
    case 'restocked':
      return 'text-sky-700 dark:text-sky-400'
    case 'out_of_stock':
      return 'text-amber-700 dark:text-amber-400'
    default:
      return 'text-muted-foreground'
  }
}

function marketToneDotClass(tone: MarketTone): string {
  switch (tone) {
    case 'dropped':
    case 'below_paid':
      return 'bg-emerald-500'
    case 'restocked':
      return 'bg-sky-500'
    case 'out_of_stock':
      return 'bg-amber-500'
    default:
      return 'bg-muted-foreground/60'
  }
}

/**
 * Best market price and its state for collection cards ("$89.00 · ↓ 12%").
 * Shown only with the Market price card field or an active market filter,
 * and never where price monitoring is unavailable.
 */
export function KnifeMarketBadge({
  knifeId,
  className,
}: {
  knifeId: string
  className?: string
}) {
  const { cardFields } = useKnives()
  const { available, byId } = useMarket()
  const marketFilterActive = useSearchParams()?.has(MARKET_PARAM) ?? false
  if (!available || (!cardFields.includes('market') && !marketFilterActive))
    return null
  const summary = byId.get(knifeId)
  const label = marketLabel(summary)
  if (!label) return null
  return (
    <MarketBadgePill
      tone={marketTone(summary)}
      label={label}
      title={marketDescription(summary)}
      className={className}
    />
  )
}

export function MarketBadgePill({
  tone,
  label,
  title,
  className,
}: {
  tone: MarketTone
  label: string
  title?: string
  className?: string
}) {
  return (
    <span
      data-market-badge={tone}
      className={cn(
        'inline-flex max-w-full items-start gap-1.5 rounded-[0.625rem] border border-border/70 bg-background/60 px-2 py-0.5 text-[11px] font-medium leading-4 tabular-nums',
        marketToneTextClass(tone),
        className,
      )}
      title={title ?? label}
    >
      <span
        aria-hidden
        className={cn(
          'mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full',
          marketToneDotClass(tone),
        )}
      />
      <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
    </span>
  )
}

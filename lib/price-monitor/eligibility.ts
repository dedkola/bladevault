import { parseStoredPrice } from '@/lib/price-monitor/money'
import {
  normalizeSourceUrl,
  type PriceSourceOrigin,
  type PriceWatchEligibility,
  type PriceWatchMode,
} from '@/lib/price-monitor/shared'

export type EligibilitySettings = {
  /** Auto mode skips sold knives; Always monitor still covers them. */
  skipSoldKnives: boolean
}

export const DEFAULT_ELIGIBILITY_SETTINGS: EligibilitySettings = {
  skipSoldKnives: true,
}

/**
 * Whether scheduled monitoring covers a knife.
 * - off: never.
 * - on: whenever it has an enabled source.
 * - auto: when its stored purchase price is above 0, it is not sold (unless
 *   the setting allows sold knives), and it has an enabled source. A wanted
 *   (watchlist) knife has no purchase price yet, so only its source counts.
 */
export function getEligibility(
  knife: { sold: boolean; wanted?: boolean; specs: { price?: string } },
  mode: PriceWatchMode,
  enabledSourceCount: number,
  settings: EligibilitySettings = DEFAULT_ELIGIBILITY_SETTINGS,
): PriceWatchEligibility {
  if (mode === 'off') return { monitored: false, reason: 'off' }
  if (mode === 'auto' && !knife.wanted) {
    if (!parseStoredPrice(knife.specs.price))
      return { monitored: false, reason: 'no_price' }
    if (settings.skipSoldKnives && knife.sold)
      return { monitored: false, reason: 'sold' }
  }
  if (enabledSourceCount === 0) return { monitored: false, reason: 'no_source' }
  return {
    monitored: true,
    reason: mode === 'on' ? 'monitored_forced' : 'monitored_auto',
  }
}

export type ExistingSource = {
  id: number
  origin: PriceSourceOrigin
  normalizedUrl: string
}

export type AutoSourcePlan = {
  /** URL to add as the knife's auto source, if any. */
  add: string | null
  /** Auto sources to soft-remove; their history stays. */
  removeIds: number[]
}

/**
 * Keeps the knife's single auto source in line with its `sourceUrl`. Manual
 * sources are never touched. The auto source cannot be removed by the user
 * (only paused), so re-adding it never resurrects something they deleted.
 * A manual source with the same URL already covers it.
 */
export function planAutoSource(
  sourceUrl: string,
  active: readonly ExistingSource[],
): AutoSourcePlan {
  const normalized = normalizeSourceUrl(sourceUrl)
  const autos = active.filter((source) => source.origin === 'auto')
  if (!normalized) return { add: null, removeIds: autos.map((s) => s.id) }
  const keep = autos.find((source) => source.normalizedUrl === normalized)
  const removeIds = autos
    .filter((source) => source !== keep)
    .map((source) => source.id)
  const coveredByManual = active.some(
    (source) =>
      source.origin === 'manual' && source.normalizedUrl === normalized,
  )
  return {
    add: keep || coveredByManual ? null : sourceUrl.trim(),
    removeIds,
  }
}

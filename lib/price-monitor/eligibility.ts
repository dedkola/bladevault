import { parseStoredPrice } from '@/lib/price-monitor/money'
import type { PriceMonitorScope } from '@/lib/settings-shared'
import {
  normalizeSourceUrl,
  type PriceSourceOrigin,
  type PriceWatchEligibility,
  type PriceWatchMode,
} from '@/lib/price-monitor/shared'

export type EligibilitySettings = {
  /** Auto mode skips sold knives; Always monitor still covers them. */
  skipSoldKnives: boolean
  /** Out of stock on the knife's own product link is ignored. */
  ignoreOfficialOutOfStock?: boolean
  /** Which knives monitoring covers; missing means the whole collection. */
  scope?: PriceMonitorScope
  /**
   * The scope resolved to knife ids (see `withMonitorScope`); null or
   * missing covers every knife.
   */
  scopeKnifeIds?: ReadonlySet<string> | null
}

/**
 * The knife's own product link (its official store) reports out of stock
 * and the setting ignores that: it does not count as out of stock, does not
 * notify, and is not checked on schedule until Check now finds it in stock.
 */
export function isIgnoredOfficialOutOfStock(
  source: { origin: PriceSourceOrigin; availability: string | null },
  settings: Pick<EligibilitySettings, 'ignoreOfficialOutOfStock'>,
): boolean {
  return (
    Boolean(settings.ignoreOfficialOutOfStock) &&
    source.origin === 'auto' &&
    source.availability === 'out_of_stock'
  )
}

export const DEFAULT_ELIGIBILITY_SETTINGS: EligibilitySettings = {
  skipSoldKnives: true,
}

/**
 * Whether scheduled monitoring covers a knife.
 * - off: never.
 * - outside the monitoring scope (What to monitor): never, also with
 *   Always monitor.
 * - on: whenever it has an enabled source.
 * - auto: when its stored regular price is above 0, it is not sold (unless
 *   the setting allows sold knives), and it has an enabled source.
 */
export function getEligibility(
  knife: { id: string; sold: boolean; specs: { price?: string } },
  mode: PriceWatchMode,
  enabledSourceCount: number,
  settings: EligibilitySettings = DEFAULT_ELIGIBILITY_SETTINGS,
): PriceWatchEligibility {
  if (mode === 'off') return { monitored: false, reason: 'off' }
  if (settings.scopeKnifeIds && !settings.scopeKnifeIds.has(knife.id))
    return { monitored: false, reason: 'out_of_scope' }
  if (mode === 'auto') {
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

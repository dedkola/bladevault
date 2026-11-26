import type { PriceMonitorScope } from '@/lib/settings-shared'
import {
  type MonitorTier,
  normalizeSourceUrl,
  type PriceSourceOrigin,
  type PriceWatchEligibility,
  type PriceWatchMode,
} from '@/lib/price-monitor/shared'

export type EligibilitySettings = {
  /** Auto mode skips sold knives; Always monitor still covers them. */
  skipSoldKnives: boolean
  /** No out-of-stock alerts for the knife's own product link. */
  ignoreOfficialOutOfStock?: boolean
  /** Which knives monitoring covers; missing means the whole collection. */
  scope?: PriceMonitorScope
  /**
   * The scope resolved to knife ids (see `withMonitorScope`); null or
   * missing covers every knife.
   */
  scopeKnifeIds?: ReadonlySet<string> | null
  /**
   * Knives outside the scope are checked in free time (the collection
   * pass) instead of not at all; see PriceMonitoringSettings.collectionPass.
   */
  collectionPass?: { enabled: boolean }
}

/**
 * The knife's own product link (its official store) reports out of stock
 * and the setting quiets that: no out-of-stock alert. It changes nothing
 * else: the link is checked on every round, counts and shows as out of
 * stock, and a restock still notifies.
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
 *   Always monitor, unless the collection pass is on: then the rules below
 *   apply and the knife is covered in the `collection` tier (checked in free
 *   time, notifying only about a super sale).
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
  const tier: MonitorTier =
    settings.scopeKnifeIds && !settings.scopeKnifeIds.has(knife.id)
      ? 'collection'
      : 'scope'
  if (mode === 'off') return { monitored: false, reason: 'off', tier }
  if (tier === 'collection' && !settings.collectionPass?.enabled)
    return { monitored: false, reason: 'out_of_scope', tier }
  // Only your own choices stop monitoring (Off, Skip sold knives, a paused
  // store); a knife without a regular price is monitored too, it just has
  // no regular price to compare with.
  if (mode === 'auto' && settings.skipSoldKnives && knife.sold)
    return { monitored: false, reason: 'sold', tier }
  if (enabledSourceCount === 0)
    return { monitored: false, reason: 'no_source', tier }
  return {
    monitored: true,
    reason:
      tier === 'collection'
        ? 'monitored_collection'
        : mode === 'on'
          ? 'monitored_forced'
          : 'monitored_auto',
    tier,
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

import type Database from 'better-sqlite3'
import { aiConfigured } from '@/lib/price-monitor/ai'
import type { DiscoveryStatus } from '@/lib/price-monitor/discovery-store'
import { DISCOVERY_STORES } from '@/lib/price-monitor/discovery-stores'
import {
  type Availability,
  type KnifeStoreEntry,
  type KnifeStoreState,
  type KnifeStoreVariant,
  normalizeSourceUrl,
  type PriceSourceStatus,
} from '@/lib/price-monitor/shared'
import {
  OTHER_STORE_IDS,
  type OtherStoreId,
  type PriceMonitoringSettings,
} from '@/lib/settings-shared'

/**
 * Where each knife is sold, store by store: its price sources, and for the
 * stores Other stores searches, what the last search found (other variants,
 * nothing, a failure) and when it searches next. Read-only; the Wishlist
 * and the knife's Market tab show it.
 */

type SourceRow = {
  id: number
  knife_id: string
  url: string
  normalized_url: string
  variant_search: string | null
  lane_key: string
  store_name: string | null
  status: PriceSourceStatus
  enabled: number
  last_price_minor: number | null
  last_currency: string | null
  last_availability: Availability | null
}

type SearchRow = {
  knife_id: string
  store: string
  marketplace: string
  status: DiscoveryStatus
  source_id: number | null
  detail: string | null
  last_attempt_at: string | null
  next_attempt_at: string | null
}

type VariantRow = {
  knife_id: string
  store: string
  marketplace: string
  url: string
  title: string
  price_text: string | null
  seen_at: string
}

const STATE_ORDER: Record<KnifeStoreState, number> = {
  listed: 0,
  variant: 1,
  failed: 2,
  waiting: 3,
  not_sold: 4,
  off: 5,
}

/** Stores Other stores searches right now (it needs AI connected). */
function searchedStores(settings: PriceMonitoringSettings): OtherStoreId[] {
  if (!settings.otherStores.enabled || !aiConfigured(settings.ai)) return []
  return OTHER_STORE_IDS.filter((id) => settings.otherStores.stores[id])
}

/** A searched store's own name, else the name saved with the link. */
function laneLabel(laneKey: string, storeName: string | null): string {
  const store = Object.values(DISCOVERY_STORES).find(
    (item) => item.laneKey === laneKey,
  )
  return store?.label ?? (storeName?.trim() || laneKey)
}

/** In stock with a price first, then out of stock, then no price, then paused. */
function sourceRank(source: {
  enabled: boolean
  priceMinor: number | null
  availability: Availability | null
}): number {
  if (!source.enabled) return 3
  if (source.priceMinor === null) return 2
  return source.availability === 'out_of_stock' ? 1 : 0
}

const rowRank = (row: SourceRow) =>
  sourceRank({
    enabled: row.enabled === 1,
    priceMinor: row.last_price_minor,
    availability: row.last_availability,
  })

function bestSource(rows: SourceRow[]): SourceRow {
  return [...rows].sort(
    (a, b) =>
      rowRank(a) - rowRank(b) ||
      (a.last_price_minor ?? Infinity) - (b.last_price_minor ?? Infinity) ||
      a.id - b.id,
  )[0]
}

function searchState(search: SearchRow | undefined): KnifeStoreState {
  if (!search) return 'waiting'
  switch (search.status) {
    case 'variant':
      return 'variant'
    case 'not_found':
    case 'rejected':
      return 'not_sold'
    case 'failed':
    case 'blocked':
      return 'failed'
    // A found listing whose source was removed is never added again.
    case 'found':
    case 'skipped':
      return 'off'
  }
}

function searchDetail(search: SearchRow | undefined): string | null {
  if (!search) return null
  if (search.status === 'found')
    return 'You removed this listing, so it is not added again.'
  return search.detail
}

export function readKnifeStores(
  database: Database.Database,
  knifeIds: readonly string[],
  settings: PriceMonitoringSettings,
): Map<string, KnifeStoreEntry[]> {
  const result = new Map<string, KnifeStoreEntry[]>()
  if (!knifeIds.length) return result
  const ids = JSON.stringify([...new Set(knifeIds)])
  const sources = database
    .prepare(
      `SELECT id, knife_id, url, normalized_url, variant_search, lane_key,
              store_name, status, enabled, last_price_minor,
              last_currency, last_availability
       FROM price_sources
       WHERE removed_at IS NULL
         AND knife_id IN (SELECT value FROM json_each(?))`,
    )
    .all(ids) as SourceRow[]
  const stores = searchedStores(settings)
  const searches = stores.length
    ? (database
        .prepare(
          `SELECT knife_id, store, marketplace, status, source_id, detail,
                  last_attempt_at, next_attempt_at
           FROM price_discovery
           WHERE knife_id IN (SELECT value FROM json_each(?))`,
        )
        .all(ids) as SearchRow[])
    : []
  const variants = stores.length
    ? (database
        .prepare(
          `SELECT knife_id, store, marketplace, url, title, price_text, seen_at
           FROM price_discovery_variants
           WHERE knife_id IN (SELECT value FROM json_each(?))
           ORDER BY position`,
        )
        .all(ids) as VariantRow[])
    : []

  const key = (knifeId: string, store: string, marketplace: string) =>
    `${knifeId}\n${store}\n${marketplace}`
  const searchBy = new Map(
    searches.map((row) => [key(row.knife_id, row.store, row.marketplace), row]),
  )
  // Variant sources are listed with their search, not as the store's own.
  const variantSources = new Map(
    sources
      .filter((row) => row.variant_search !== null)
      .map((row) => [`${row.knife_id}\n${row.normalized_url}`, row]),
  )
  const variantsBy = new Map<string, KnifeStoreVariant[]>()
  for (const row of variants) {
    const list =
      variantsBy.get(key(row.knife_id, row.store, row.marketplace)) ?? []
    const monitored = variantSources.get(
      `${row.knife_id}\n${normalizeSourceUrl(row.url)}`,
    )
    list.push({
      url: row.url,
      title: row.title,
      price: row.price_text,
      seenAt: row.seen_at,
      ...(monitored
        ? {
            monitored: {
              sourceId: monitored.id,
              priceMinor: monitored.last_price_minor,
              currency: monitored.last_currency,
              availability: monitored.last_availability,
              enabled: monitored.enabled === 1,
            },
          }
        : {}),
    })
    variantsBy.set(key(row.knife_id, row.store, row.marketplace), list)
  }
  const sourcesBy = new Map<string, Map<string, SourceRow[]>>()
  for (const row of sources) {
    if (row.variant_search !== null) continue
    const lanes = sourcesBy.get(row.knife_id) ?? new Map<string, SourceRow[]>()
    lanes.set(row.lane_key, [...(lanes.get(row.lane_key) ?? []), row])
    sourcesBy.set(row.knife_id, lanes)
  }

  for (const knifeId of new Set(knifeIds)) {
    const lanes = sourcesBy.get(knifeId) ?? new Map<string, SourceRow[]>()
    const entries: KnifeStoreEntry[] = []
    for (const [laneKey, rows] of lanes) {
      const best = bestSource(rows)
      entries.push({
        laneKey,
        label: laneLabel(laneKey, best.store_name),
        state: 'listed',
        source: {
          id: best.id,
          url: best.url,
          status: best.status,
          priceMinor: best.last_price_minor,
          currency: best.last_currency,
          availability: best.last_availability,
          enabled: best.enabled === 1,
        },
        variants: [],
        detail: null,
        search: null,
      })
    }
    for (const id of stores) {
      const store = DISCOVERY_STORES[id]
      if (lanes.has(store.laneKey)) continue
      const searchKey = key(knifeId, id, store.marketplace)
      const search = searchBy.get(searchKey)
      const state = searchState(search)
      entries.push({
        laneKey: store.laneKey,
        label: store.label,
        state,
        source: null,
        variants: variantsBy.get(searchKey) ?? [],
        detail: searchDetail(search),
        search: {
          lastAt: search?.last_attempt_at ?? null,
          // Never searched: due at the store's next free slot.
          nextAt: search ? (search.next_attempt_at ?? null) : null,
        },
      })
    }
    entries.sort(
      (a, b) =>
        STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
        (a.source && b.source
          ? sourceRank(a.source) - sourceRank(b.source)
          : 0) ||
        (a.source?.priceMinor ?? Infinity) -
          (b.source?.priceMinor ?? Infinity) ||
        a.label.localeCompare(b.label),
    )
    result.set(knifeId, entries)
  }
  return result
}

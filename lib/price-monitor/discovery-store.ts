import type Database from 'better-sqlite3'
import { getLocalDb } from '@/lib/local-db'
import {
  getEligibility,
  type EligibilitySettings,
} from '@/lib/price-monitor/eligibility'
import { withMonitorScope } from '@/lib/price-monitor/scope'
import {
  MAX_PRICE_SOURCES_PER_KNIFE,
  normalizeSourceUrl,
  type PriceWatchMode,
} from '@/lib/price-monitor/shared'
import { insertSource, readActiveSources } from '@/lib/price-monitor/store'
import type { OtherStoreId } from '@/lib/settings-shared'
import { assertVaultGeneration, withVaultWrite } from '@/lib/vault-access'

/**
 * Other stores: what AI found (or did not) per knife and store. A found
 * product becomes an ordinary price source, so its checks, history and
 * notifications work like any other store's.
 */
export const DISCOVERY_STATUSES = [
  'found',
  'not_found',
  'rejected',
  'failed',
  'blocked',
  'skipped',
] as const
export type DiscoveryStatus = (typeof DISCOVERY_STATUSES)[number]

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
/** No match: the store may list it later. */
export const DISCOVERY_RETRY_NOT_FOUND_MS = 30 * DAY_MS
export const DISCOVERY_RETRY_BLOCKED_MS = 12 * HOUR_MS
const FAILED_BASE_MS = 6 * HOUR_MS
const FAILED_MAX_MS = 7 * DAY_MS

/** When to search again; null for found (a found product is never replaced). */
export function nextDiscoveryAttempt(
  status: DiscoveryStatus,
  attempts: number,
  now: number,
): string | null {
  switch (status) {
    case 'found':
      return null
    case 'not_found':
    case 'rejected':
    case 'skipped':
      return new Date(now + DISCOVERY_RETRY_NOT_FOUND_MS).toISOString()
    case 'blocked':
      return new Date(now + DISCOVERY_RETRY_BLOCKED_MS).toISOString()
    case 'failed':
      return new Date(
        now +
          Math.min(
            FAILED_BASE_MS * 2 ** Math.max(0, attempts - 1),
            FAILED_MAX_MS,
          ),
      ).toISOString()
  }
}

type QueueRow = {
  id: string
  specs: string
  sold: number
  mode: PriceWatchMode
  status: DiscoveryStatus | null
  next_attempt_at: string | null
  has_store_source: number
  source_count: number
}

function storedPrice(specs: string): string | undefined {
  try {
    return (JSON.parse(specs) as { price?: string }).price
  } catch {
    return undefined
  }
}

/**
 * Knives due for a search at a store, longest-waiting first: knives that
 * monitoring covers (a stored price in Auto, Always monitor, sold knives
 * per the setting; a product link is not needed), without an active source
 * at that store, with room for one more source, never searched there or due
 * again.
 */
export function readDiscoveryQueue(
  database: Database.Database,
  input: {
    settings: Pick<
      EligibilitySettings,
      'skipSoldKnives' | 'scope' | 'scopeKnifeIds'
    >
    store: OtherStoreId
    marketplace: string
    /** The store's price-source lane; a knife with a source there is skipped. */
    laneKey?: string
    now: number
    limit?: number
  },
): string[] {
  const rows = database
    .prepare(
      `SELECT k.id, k.specs, k.sold, COALESCE(w.mode, 'auto') AS mode,
              d.status, d.next_attempt_at,
              EXISTS (SELECT 1 FROM price_sources s
                      WHERE s.knife_id = k.id AND s.removed_at IS NULL
                        AND s.lane_key = ?) AS has_store_source,
              (SELECT COUNT(*) FROM price_sources s
               WHERE s.knife_id = k.id AND s.removed_at IS NULL) AS source_count
       FROM knives k
       LEFT JOIN price_watch w ON w.knife_id = k.id
       LEFT JOIN price_discovery d
         ON d.knife_id = k.id AND d.store = ? AND d.marketplace = ?
       ORDER BY d.next_attempt_at IS NOT NULL, d.next_attempt_at, k.added_at`,
    )
    .all(
      input.laneKey ?? input.store,
      input.store,
      input.marketplace,
    ) as QueueRow[]
  const scoped = withMonitorScope(database, input.settings)
  const due: string[] = []
  for (const row of rows) {
    if (row.has_store_source || row.source_count >= MAX_PRICE_SOURCES_PER_KNIFE)
      continue
    if (row.status !== null) {
      if (!row.next_attempt_at) continue
      const at = Date.parse(row.next_attempt_at)
      if (Number.isFinite(at) && at > input.now) continue
    }
    const eligibility = getEligibility(
      {
        id: row.id,
        sold: row.sold === 1,
        specs: { price: storedPrice(row.specs) },
      },
      row.mode,
      // A knife without a product link is exactly what Other stores is for.
      1,
      scoped,
    )
    if (!eligibility.monitored) continue
    due.push(row.id)
    if (due.length >= (input.limit ?? 1)) break
  }
  return due
}

export type DiscoveryRecord = {
  generation: string
  knifeId: string
  store: OtherStoreId
  marketplace: string
  status: DiscoveryStatus
  /** Product page to add as a source when found. */
  url?: string | null
  title?: string | null
  confidence?: number | null
  detail?: string | null
  now?: number
}

/**
 * Stores a search result and, when found, adds the product as a source of
 * the knife (checked at the store's normal pace). Returns the new source id.
 */
export async function recordDiscovery(
  record: DiscoveryRecord,
): Promise<{ status: DiscoveryStatus; sourceId: number | null }> {
  return withVaultWrite(async () => {
    assertVaultGeneration(record.generation)
    const database = getLocalDb()
    const now = record.now ?? Date.now()
    const nowIso = new Date(now).toISOString()
    return database.transaction(() => {
      const exists = database
        .prepare('SELECT 1 FROM knives WHERE id = ?')
        .get(record.knifeId)
      if (!exists) return { status: record.status, sourceId: null }
      const previous = database
        .prepare(
          `SELECT attempts FROM price_discovery
           WHERE knife_id = ? AND store = ? AND marketplace = ?`,
        )
        .get(record.knifeId, record.store, record.marketplace) as
        { attempts: number } | undefined
      const attempts = (previous?.attempts ?? 0) + 1
      let status = record.status
      let detail = record.detail ?? null
      let sourceId: number | null = null

      if (status === 'found') {
        const normalized = record.url ? normalizeSourceUrl(record.url) : null
        const active = readActiveSources(database, record.knifeId)
        const existing = active.find(
          (source) => source.normalized_url === normalized,
        )
        if (!record.url || !normalized) {
          status = 'failed'
          detail = 'AI returned no usable product link.'
        } else if (existing) {
          sourceId = existing.id
        } else if (active.length >= MAX_PRICE_SOURCES_PER_KNIFE) {
          status = 'skipped'
          detail = `The knife already has ${MAX_PRICE_SOURCES_PER_KNIFE} price sources.`
        } else {
          insertSource(
            database,
            record.knifeId,
            record.url,
            'manual',
            undefined,
            nowIso,
          )
          sourceId = (
            database.prepare('SELECT last_insert_rowid() AS id').get() as {
              id: number
            }
          ).id
        }
      }

      database
        .prepare(
          `INSERT INTO price_discovery
             (knife_id, store, marketplace, status, source_id, url, title,
              confidence, detail, attempts, last_attempt_at, next_attempt_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (knife_id, store, marketplace) DO UPDATE SET
             status = excluded.status,
             source_id = excluded.source_id,
             url = excluded.url,
             title = excluded.title,
             confidence = excluded.confidence,
             detail = excluded.detail,
             attempts = excluded.attempts,
             last_attempt_at = excluded.last_attempt_at,
             next_attempt_at = excluded.next_attempt_at`,
        )
        .run(
          record.knifeId,
          record.store,
          record.marketplace,
          status,
          sourceId,
          record.url ?? null,
          record.title ?? null,
          record.confidence ?? null,
          detail,
          // A found product resets the count for a later marketplace switch.
          status === 'found' ? 0 : attempts,
          nowIso,
          nextDiscoveryAttempt(status, attempts, now),
        )
      return { status, sourceId }
    })()
  })
}

export type DiscoveryItemView = {
  knifeId: string
  knifeName: string
  brand: string
  status: DiscoveryStatus
  url: string | null
  title: string | null
  confidence: number | null
  detail: string | null
  lastAttemptAt: string
  nextAttemptAt: string | null
  /** The source this search added, while it is still monitored. */
  sourceActive: boolean
}

export type DiscoveryOverview = {
  store: OtherStoreId
  marketplace: string
  counts: Record<DiscoveryStatus, number>
  /** Knives waiting for their first or next search. */
  waiting: number
  recent: DiscoveryItemView[]
}

export function readDiscoveryOverview(
  database: Database.Database,
  input: {
    settings: Pick<
      EligibilitySettings,
      'skipSoldKnives' | 'scope' | 'scopeKnifeIds'
    >
    store: OtherStoreId
    marketplace: string
    laneKey?: string
    now?: number
    limit?: number
  },
): DiscoveryOverview {
  const counts = Object.fromEntries(
    DISCOVERY_STATUSES.map((status) => [status, 0]),
  ) as Record<DiscoveryStatus, number>
  for (const row of database
    .prepare(
      `SELECT status, COUNT(*) AS n FROM price_discovery
       WHERE store = ? AND marketplace = ? GROUP BY status`,
    )
    .all(input.store, input.marketplace) as Array<{
    status: DiscoveryStatus
    n: number
  }>)
    if (row.status in counts) counts[row.status] = row.n
  const rows = database
    .prepare(
      `SELECT d.*, k.name AS knife_name, k.brand AS brand,
              EXISTS (SELECT 1 FROM price_sources s
                      WHERE s.id = d.source_id AND s.removed_at IS NULL)
                AS source_active
       FROM price_discovery d
       JOIN knives k ON k.id = d.knife_id
       WHERE d.store = ? AND d.marketplace = ?
       ORDER BY d.last_attempt_at DESC
       LIMIT ?`,
    )
    .all(input.store, input.marketplace, input.limit ?? 20) as Array<{
    knife_id: string
    knife_name: string
    brand: string
    status: DiscoveryStatus
    url: string | null
    title: string | null
    confidence: number | null
    detail: string | null
    last_attempt_at: string
    next_attempt_at: string | null
    source_active: number
  }>
  return {
    store: input.store,
    marketplace: input.marketplace,
    counts,
    waiting: readDiscoveryQueue(database, {
      settings: input.settings,
      store: input.store,
      marketplace: input.marketplace,
      laneKey: input.laneKey,
      now: input.now ?? Date.now(),
      limit: Number.MAX_SAFE_INTEGER,
    }).length,
    recent: rows.map((row) => ({
      knifeId: row.knife_id,
      knifeName: row.knife_name,
      brand: row.brand,
      status: row.status,
      url: row.url,
      title: row.title,
      confidence: row.confidence,
      detail: row.detail,
      lastAttemptAt: row.last_attempt_at,
      nextAttemptAt: row.next_attempt_at,
      sourceActive: row.source_active === 1,
    })),
  }
}

/** Search again: knives without a match become due now. Found ones stay. */
export async function retryDiscovery(input: {
  store: OtherStoreId
  marketplace: string
}): Promise<number> {
  return withVaultWrite(async () => {
    const now = new Date().toISOString()
    return getLocalDb()
      .prepare(
        `UPDATE price_discovery SET next_attempt_at = ?
         WHERE store = ? AND marketplace = ? AND status <> 'found'`,
      )
      .run(now, input.store, input.marketplace).changes
  })
}

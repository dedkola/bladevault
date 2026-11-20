import type Database from 'better-sqlite3'
import { getLocalDb } from '@/lib/local-db'
import { getEligibility } from '@/lib/price-monitor/eligibility'
import {
  knifeSubtitle,
  readChangeEventsById,
  type ChangeEvent,
} from '@/lib/price-monitor/insights'
import {
  planTargetNotification,
  type PriceNotificationChanges,
  type TargetPrice,
} from '@/lib/price-monitor/notifications'
import {
  readPriceNotifications,
  writePriceNotificationChanges,
} from '@/lib/price-monitor/notification-store'
import type { Availability, PriceWatchMode } from '@/lib/price-monitor/shared'
import type {
  Watchlist,
  WatchlistItem,
  WatchlistStock,
} from '@/lib/price-monitor/watchlist-shared'
import { withVaultWrite } from '@/lib/vault-access'

/**
 * Watchlist read model and target-price writes. Monitoring itself is the
 * regular Price Drops pipeline: wanted knives are knife rows, so their
 * sources, snapshots and events are stored like any other knife's.
 */

export class WatchlistError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'WatchlistError'
  }
}

type WantedRow = {
  id: string
  name: string
  brand: string
  images: string
  specs: string
  handle_material: string | null
  source_url: string
  added_at: string
  mode: PriceWatchMode
  target_price_minor: number | null
  target_currency: string | null
}

type SourceRow = {
  id: number
  knife_id: string
  url: string
  store_name: string
  enabled: number
  last_price_minor: number | null
  last_currency: string | null
  last_availability: Availability | null
  last_checked_at: string | null
}

function firstImage(images: string): string | null {
  try {
    const list = JSON.parse(images) as unknown
    return Array.isArray(list) && typeof list[0] === 'string' ? list[0] : null
  } catch {
    return null
  }
}

function toTarget(row: {
  target_price_minor: number | null
  target_currency: string | null
}): TargetPrice | null {
  return row.target_price_minor !== null && row.target_currency
    ? { minor: row.target_price_minor, currency: row.target_currency }
    : null
}

function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  let best: string | null = null
  for (const [value, count] of counts)
    if (best === null || count > (counts.get(best) ?? 0)) best = value
  return best
}

function stockOf(sources: SourceRow[]): WatchlistStock {
  const known = sources.filter(
    (source) =>
      source.last_availability && source.last_availability !== 'unknown',
  )
  if (
    sources.some(
      (source) =>
        source.last_availability !== 'out_of_stock' &&
        source.last_price_minor !== null,
    )
  )
    return 'in_stock'
  if (
    known.length &&
    known.every((source) => source.last_availability === 'out_of_stock')
  )
    return 'out_of_stock'
  return 'unknown'
}

/** Every wanted knife with its best price, gap to target and stock. */
export function buildWatchlist(database: Database.Database): Watchlist {
  const knives = database
    .prepare(
      `SELECT k.id, k.name, k.brand, k.images, k.specs, k.handle_material,
              k.source_url, k.added_at,
              COALESCE(w.mode, 'auto') AS mode, w.target_price_minor,
              w.target_currency
       FROM knives k LEFT JOIN price_watch w ON w.knife_id = k.id
       WHERE k.wanted = 1
       ORDER BY k.added_at DESC`,
    )
    .all() as WantedRow[]
  if (!knives.length) return { items: [] }

  const sources = database
    .prepare(
      `SELECT s.id, s.knife_id, s.url, s.store_name, s.enabled,
              s.last_price_minor, s.last_currency, s.last_availability,
              s.last_checked_at
       FROM price_sources s JOIN knives k ON k.id = s.knife_id
       WHERE s.removed_at IS NULL AND k.wanted = 1
       ORDER BY s.id`,
    )
    .all() as SourceRow[]
  const byKnife = new Map<string, SourceRow[]>()
  for (const source of sources) {
    const list = byKnife.get(source.knife_id) ?? []
    list.push(source)
    byKnife.set(source.knife_id, list)
  }

  // The newest price or stock event per wanted knife.
  const latest = database
    .prepare(
      `SELECT type, id, knife_id FROM (
         SELECT 'price' AS type, id, knife_id, occurred_at
         FROM price_change_events
         UNION ALL
         SELECT 'stock' AS type, id, knife_id, occurred_at FROM stock_events
       )
       WHERE knife_id IN (SELECT id FROM knives WHERE wanted = 1)
       ORDER BY occurred_at ASC, id ASC`,
    )
    .all() as Array<{ type: 'price' | 'stock'; id: number; knife_id: string }>
  const latestByKnife = new Map<string, { type: string; id: number }>()
  for (const row of latest) latestByKnife.set(row.knife_id, row)
  const events = readChangeEventsById(database, {
    price: [...latestByKnife.values()]
      .filter((row) => row.type === 'price')
      .map((row) => row.id),
    stock: [...latestByKnife.values()]
      .filter((row) => row.type === 'stock')
      .map((row) => row.id),
  })

  const items = knives.map((knife): WatchlistItem => {
    const list = byKnife.get(knife.id) ?? []
    const enabled = list.filter((source) => source.enabled === 1)
    const eligibility = getEligibility(
      { sold: false, wanted: true, specs: {} },
      knife.mode,
      enabled.length,
    )
    const target = toTarget(knife)
    const priced = enabled.filter(
      (source) =>
        source.last_price_minor !== null &&
        source.last_currency &&
        source.last_availability !== 'out_of_stock',
    )
    const currency =
      target && priced.some((s) => s.last_currency === target.currency)
        ? target.currency
        : mostCommon(priced.map((s) => s.last_currency!))
    const bestSource = priced
      .filter((source) => source.last_currency === currency)
      .sort((a, b) => a.last_price_minor! - b.last_price_minor!)[0]
    const best = bestSource
      ? {
          priceMinor: bestSource.last_price_minor!,
          currency: bestSource.last_currency!,
          storeName: bestSource.store_name,
          url: bestSource.url,
        }
      : null
    const gapMinor =
      best && target && best.currency === target.currency
        ? best.priceMinor - target.minor
        : null
    const last = latestByKnife.get(knife.id)
    const lastChange: ChangeEvent | null = last
      ? (events.get(`${last.type}-${last.id}`) ?? null)
      : null
    const checked = list
      .map((source) => source.last_checked_at)
      .filter((value): value is string => Boolean(value))
      .sort()
    return {
      knife: {
        id: knife.id,
        name: knife.name,
        brand: knife.brand,
        image: firstImage(knife.images),
        subtitle: knifeSubtitle(knife),
        wanted: true,
      },
      sourceUrl: knife.source_url,
      addedAt: knife.added_at,
      target,
      monitored: eligibility.monitored,
      reason: eligibility.reason,
      sources: list.length,
      best,
      gapMinor,
      atTarget: gapMinor !== null && gapMinor <= 0,
      stock: stockOf(enabled),
      lastCheckedAt: checked.at(-1) ?? null,
      lastChange,
    }
  })
  return { items }
}

export async function getWatchlist(): Promise<Watchlist> {
  return buildWatchlist(getLocalDb())
}

/**
 * Plans target notifications for every active source of a knife against its
 * latest trusted reading, so a new or changed target takes effect at once.
 */
function planTargetForKnife(
  database: Database.Database,
  knifeId: string,
  target: TargetPrice | null,
  now: Date,
): PriceNotificationChanges[] {
  const sources = database
    .prepare(
      `SELECT id FROM price_sources
       WHERE knife_id = ? AND removed_at IS NULL`,
    )
    .all(knifeId) as Array<{ id: number }>
  const latest = database.prepare(
    `SELECT id, price_minor, currency, availability FROM price_snapshots
     WHERE source_id = ? AND (ai_review IS NULL OR ai_review != 'unconfirmed')
     ORDER BY id DESC LIMIT 1`,
  )
  return sources.flatMap((source) => {
    const existing = readPriceNotifications(database, { sourceId: source.id })
    const snapshot = latest.get(source.id) as
      | {
          id: number
          price_minor: number | null
          currency: string | null
          availability: string
        }
      | undefined
    if (!snapshot) {
      // Nothing read yet: only a cleared target has anything to close.
      if (target !== null) return []
      return [
        planTargetNotification(
          {
            knifeId,
            sourceId: source.id,
            snapshotId: 0,
            reading: { priceMinor: null, currency: null, availability: '' },
            target: null,
          },
          existing,
          now,
        ),
      ]
    }
    return [
      planTargetNotification(
        {
          knifeId,
          sourceId: source.id,
          snapshotId: snapshot.id,
          reading: {
            priceMinor: snapshot.price_minor,
            currency: snapshot.currency,
            availability: snapshot.availability,
          },
          target,
        },
        existing,
        now,
      ),
    ]
  })
}

/** Sets or clears a wanted knife's target price. */
export async function setWatchTarget(
  knifeId: string,
  target: TargetPrice | null,
  now: Date = new Date(),
): Promise<void> {
  await withVaultWrite(async () => {
    const database = getLocalDb()
    database.transaction(() => {
      const knife = database
        .prepare('SELECT wanted FROM knives WHERE id = ?')
        .get(knifeId) as { wanted: number } | undefined
      if (!knife) throw new WatchlistError('Knife not found', 404)
      if (knife.wanted !== 1)
        throw new WatchlistError(
          'Target prices are for knives on the watchlist.',
        )
      const iso = now.toISOString()
      database
        .prepare(
          `INSERT INTO price_watch
             (knife_id, mode, updated_at, target_price_minor, target_currency)
           VALUES (?, 'auto', ?, ?, ?)
           ON CONFLICT(knife_id) DO UPDATE SET
             target_price_minor = excluded.target_price_minor,
             target_currency = excluded.target_currency,
             updated_at = excluded.updated_at`,
        )
        .run(knifeId, iso, target?.minor ?? null, target?.currency ?? null)
      for (const changes of planTargetForKnife(database, knifeId, target, now))
        writePriceNotificationChanges(database, changes)
    })()
  })
}

/** Closes a knife's open target notifications, e.g. once it is bought. */
export async function resolveTargetNotifications(
  knifeId: string,
  now: Date = new Date(),
): Promise<void> {
  await withVaultWrite(async () => {
    const database = getLocalDb()
    const iso = now.toISOString()
    database
      .prepare(
        `UPDATE price_notifications SET resolved_at = ?, updated_at = ?
         WHERE knife_id = ? AND kind = 'target_reached'
           AND resolved_at IS NULL`,
      )
      .run(iso, iso, knifeId)
  })
}

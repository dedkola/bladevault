import type Database from 'better-sqlite3'
import { getLocalDb } from '@/lib/local-db'
import { withVaultWrite } from '@/lib/vault-access'
import type { AchievementUnlock } from '@/lib/achievements/unlocks'

type UnlockRow = {
  id: string
  unlocked_at: string
  knife_id: string | null
  backfilled: number
  seen_at: string | null
}

const INITIALIZED_KEY = 'initialized_at'
/**
 * Price and stock events of the knives' own stores, not of the other-variant
 * listings Other stores monitors.
 */
const OWN_SOURCE_EVENT = `source_id NOT IN
  (SELECT id FROM price_sources WHERE variant_search IS NOT NULL)`

function toUnlock(row: UnlockRow): AchievementUnlock {
  return {
    id: row.id,
    unlockedAt: row.unlocked_at,
    knifeId: row.knife_id,
    backfilled: row.backfilled === 1,
    seenAt: row.seen_at,
  }
}

function readUnlocks(database: Database.Database): AchievementUnlock[] {
  const rows = database
    .prepare('SELECT * FROM achievement_unlocks ORDER BY unlocked_at, id')
    .all() as UnlockRow[]
  return rows.map(toUnlock)
}

function readInitializedAt(database: Database.Database): string | null {
  const row = database
    .prepare('SELECT value FROM achievement_meta WHERE key = ?')
    .get(INITIALIZED_KEY) as { value: string } | undefined
  return row?.value ?? null
}

export function getAchievementUnlocks(): AchievementUnlock[] {
  return readUnlocks(getLocalDb())
}

export type UnlockCandidate = { id: string; knifeId: string | null }

/**
 * Stores newly met achievements. The first save for a vault (or after a
 * reset) marks every unlock as backfilled and seen, so an existing collection
 * does not set off dozens of celebrations. Ids already stored are left alone,
 * so concurrent syncs cannot unlock the same badge twice.
 */
export async function saveAchievementUnlocks(
  candidates: readonly UnlockCandidate[],
  now: Date,
): Promise<{ inserted: AchievementUnlock[]; backfilled: boolean }> {
  const database = getLocalDb()
  const stored = new Set(readUnlocks(database).map((unlock) => unlock.id))
  const fresh = candidates.filter((candidate) => !stored.has(candidate.id))
  if (fresh.length === 0 && readInitializedAt(database)) {
    return { inserted: [], backfilled: false }
  }

  return withVaultWrite(async () =>
    database.transaction(() => {
      const at = now.toISOString()
      const backfilled = readInitializedAt(database) === null
      if (backfilled) {
        database
          .prepare('INSERT INTO achievement_meta (key, value) VALUES (?, ?)')
          .run(INITIALIZED_KEY, at)
      }
      const insert = database.prepare(
        `INSERT OR IGNORE INTO achievement_unlocks
           (id, unlocked_at, knife_id, backfilled, seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      const inserted: AchievementUnlock[] = []
      for (const candidate of fresh) {
        const unlock: AchievementUnlock = {
          id: candidate.id,
          unlockedAt: at,
          knifeId: backfilled ? null : candidate.knifeId,
          backfilled,
          seenAt: backfilled ? at : null,
        }
        const result = insert.run(
          unlock.id,
          unlock.unlockedAt,
          unlock.knifeId,
          unlock.backfilled ? 1 : 0,
          unlock.seenAt,
        )
        if (result.changes === 1) inserted.push(unlock)
      }
      return { inserted, backfilled }
    })(),
  )
}

/** Marks unlocks as celebrated; already seen ones keep their first time. */
export async function markAchievementsSeen(
  ids: readonly string[],
  now: Date,
): Promise<void> {
  const database = getLocalDb()
  await withVaultWrite(async () => {
    const update = database.prepare(
      'UPDATE achievement_unlocks SET seen_at = ? WHERE id = ? AND seen_at IS NULL',
    )
    database.transaction(() => {
      for (const id of ids) update.run(now.toISOString(), id)
    })()
  })
}

/**
 * Forgets when tracking started while keeping every unlock, so badges met
 * while achievements were switched off are backfilled silently. Runs inside
 * the caller's write.
 */
export function forgetAchievementBaseline(database: Database.Database): void {
  database
    .prepare('DELETE FROM achievement_meta WHERE key = ?')
    .run(INITIALIZED_KEY)
}

/** Forgets every unlock; the next sync backfills silently again. */
export async function resetAchievements(): Promise<void> {
  const database = getLocalDb()
  await withVaultWrite(async () => {
    database.transaction(() => {
      database.exec(
        'DELETE FROM achievement_unlocks; DELETE FROM achievement_meta;',
      )
    })()
  })
}

/**
 * Price-monitoring results the market badges read: knives with an active
 * store source that is not switched off, caught drops and restocks.
 */
export function readPriceAchievementInput(): {
  watchedKnives: number
  dropPercents: number[]
  backInStock: number
} {
  const database = getLocalDb()
  const watched = database
    .prepare(
      `SELECT COUNT(DISTINCT s.knife_id) AS count
       FROM price_sources s
       LEFT JOIN price_watch w ON w.knife_id = s.knife_id
       WHERE s.removed_at IS NULL AND s.enabled = 1
         AND s.variant_search IS NULL
         AND COALESCE(w.mode, 'auto') <> 'off'`,
    )
    .get() as { count: number }
  const drops = database
    .prepare(
      `SELECT delta_pct FROM price_change_events
       WHERE direction = 'drop' AND ${OWN_SOURCE_EVENT}`,
    )
    .all() as Array<{ delta_pct: number }>
  const restocks = database
    .prepare(
      `SELECT COUNT(*) AS count FROM stock_events
       WHERE kind = 'back_in_stock' AND ${OWN_SOURCE_EVENT}`,
    )
    .get() as { count: number }
  return {
    watchedKnives: watched.count,
    dropPercents: drops.map((row) => row.delta_pct),
    backInStock: restocks.count,
  }
}

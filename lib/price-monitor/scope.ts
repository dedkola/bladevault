import type Database from 'better-sqlite3'
import type { EligibilitySettings } from '@/lib/price-monitor/eligibility'
import type { PriceMonitorScope } from '@/lib/settings-shared'

/**
 * The knives a monitoring scope covers, or null for the whole collection.
 * Compare lists are read live, so knives added to a list later count and a
 * deleted list simply drops out.
 */
export function readMonitorScopeKnifeIds(
  database: Database.Database,
  scope: PriceMonitorScope | undefined,
): Set<string> | null {
  if (!scope || scope.kind === 'all') return null
  if (scope.kind === 'selected') return new Set(scope.knifeIds)
  if (!scope.comparisonIds.length) return new Set()
  const rows = database
    .prepare(
      `SELECT DISTINCT knife_id FROM comparison_items
       WHERE list_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(scope.comparisonIds)) as Array<{ knife_id: string }>
  return new Set(rows.map((row) => row.knife_id))
}

/** Existing knives a scope covers, or null for the whole collection. */
export function countMonitorScopeKnives(
  database: Database.Database,
  scope: PriceMonitorScope | undefined,
): number | null {
  const ids = readMonitorScopeKnifeIds(database, scope)
  if (!ids) return null
  if (!ids.size) return 0
  return (
    database
      .prepare(
        'SELECT COUNT(*) AS n FROM knives WHERE id IN (SELECT value FROM json_each(?))',
      )
      .get(JSON.stringify([...ids])) as { n: number }
  ).n
}

/** Settings with the scope resolved once, for many eligibility checks. */
export function withMonitorScope<T extends EligibilitySettings>(
  database: Database.Database,
  settings: T,
): T {
  if (settings.scopeKnifeIds !== undefined) return settings
  return {
    ...settings,
    scopeKnifeIds: readMonitorScopeKnifeIds(database, settings.scope),
  }
}

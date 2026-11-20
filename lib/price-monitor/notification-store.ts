import type Database from 'better-sqlite3'
import { getLocalDb } from '@/lib/local-db'
import { readChangeEventsById } from '@/lib/price-monitor/insights'
import {
  applyPriceNotificationAction,
  expiredPriceNotificationIds,
  isPriceNotificationKind,
  sortPriceNotifications,
  type PriceNotification,
  type PriceNotificationAction,
  type PriceNotificationChanges,
  type PriceNotificationView,
} from '@/lib/price-monitor/notifications'
import { withVaultWrite } from '@/lib/vault-access'

type PriceNotificationRow = {
  id: number
  knife_id: string
  source_id: number
  event_id: number
  kind: string
  occurrences: number
  occurred_at: string
  created_at: string
  updated_at: string
  read_at: string | null
  dismissed_at: string | null
  resolved_at: string | null
}

/** Stored notifications, all of them or one source's. */
export function readPriceNotifications(
  database: Database.Database,
  filter: { sourceId?: number } = {},
): PriceNotification[] {
  const rows = (
    filter.sourceId === undefined
      ? database.prepare('SELECT * FROM price_notifications ORDER BY id').all()
      : database
          .prepare(
            'SELECT * FROM price_notifications WHERE source_id = ? ORDER BY id',
          )
          .all(filter.sourceId)
  ) as PriceNotificationRow[]
  return rows.flatMap((row) =>
    isPriceNotificationKind(row.kind)
      ? [
          {
            id: row.id,
            knifeId: row.knife_id,
            sourceId: row.source_id,
            eventId: row.event_id,
            kind: row.kind,
            occurrences: row.occurrences,
            occurredAt: row.occurred_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            readAt: row.read_at,
            dismissedAt: row.dismissed_at,
            resolvedAt: row.resolved_at,
          },
        ]
      : [],
  )
}

/**
 * Writes a plan. Must run inside a transaction. Updates go first so a row
 * that is resolved frees its (source, kind) slot before a new one opens.
 */
export function writePriceNotificationChanges(
  database: Database.Database,
  changes: PriceNotificationChanges,
): void {
  const update = database.prepare(
    `UPDATE price_notifications
     SET knife_id = ?, event_id = ?, occurrences = ?, occurred_at = ?,
         updated_at = ?, read_at = ?, dismissed_at = ?, resolved_at = ?
     WHERE id = ?`,
  )
  const insert = database.prepare(
    `INSERT INTO price_notifications
       (knife_id, source_id, event_id, kind, occurrences, occurred_at,
        created_at, updated_at, read_at, dismissed_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const remove = database.prepare(
    'DELETE FROM price_notifications WHERE id = ?',
  )
  for (const id of changes.deleteIds) remove.run(id)
  for (const row of changes.update) {
    update.run(
      row.knifeId,
      row.eventId,
      row.occurrences,
      row.occurredAt,
      row.updatedAt,
      row.readAt,
      row.dismissedAt,
      row.resolvedAt,
      row.id,
    )
  }
  for (const row of changes.create) {
    insert.run(
      row.knifeId,
      row.sourceId,
      row.eventId,
      row.kind,
      row.occurrences,
      row.occurredAt,
      row.createdAt,
      row.updatedAt,
      row.readAt,
      row.dismissedAt,
      row.resolvedAt,
    )
  }
}

/** Notifications with their events, newest first. */
function readPriceNotificationViews(
  database: Database.Database,
): PriceNotificationView[] {
  const rows = readPriceNotifications(database)
  const events = readChangeEventsById(database, {
    price: rows
      .filter((row) => row.kind === 'drop' || row.kind === 'increase')
      .map((row) => row.eventId),
    stock: rows
      .filter(
        (row) => row.kind === 'out_of_stock' || row.kind === 'back_in_stock',
      )
      .map((row) => row.eventId),
    target: rows
      .filter((row) => row.kind === 'target_reached')
      .map((row) => row.eventId),
  })
  return sortPriceNotifications(
    rows.flatMap((row) => {
      const type =
        row.kind === 'target_reached'
          ? 'target'
          : row.kind === 'drop' || row.kind === 'increase'
            ? 'price'
            : 'stock'
      const event = events.get(`${type}-${row.eventId}`)
      return event ? [{ ...row, event }] : []
    }),
  )
}

export async function getPriceNotifications(): Promise<
  PriceNotificationView[]
> {
  return readPriceNotificationViews(getLocalDb())
}

/** Marks read, dismisses or restores, and purges expired closed rows. */
export async function updatePriceNotifications(
  action: PriceNotificationAction,
  now: Date = new Date(),
): Promise<PriceNotificationView[]> {
  const database = getLocalDb()
  return withVaultWrite(async () => {
    database.transaction(() => {
      const existing = readPriceNotifications(database)
      writePriceNotificationChanges(database, {
        create: [],
        update: applyPriceNotificationAction(existing, action, now),
        deleteIds: expiredPriceNotificationIds(existing, now),
      })
    })()
    return readPriceNotificationViews(database)
  })
}

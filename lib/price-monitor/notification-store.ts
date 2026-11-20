import type Database from 'better-sqlite3'
import { getLocalDb } from '@/lib/local-db'
import { readChangeEventsById } from '@/lib/price-monitor/insights'
import { parseStoredPrice, toMinorUnits } from '@/lib/price-monitor/money'
import {
  applyPriceNotificationAction,
  NO_PRICE_ALERT_RULES,
  expiredPriceNotificationIds,
  isPriceNotificationKind,
  sortPriceNotifications,
  type PriceNotification,
  type PriceAlertContext,
  type PriceAlertRules,
  type PriceNotificationAction,
  type PriceNotificationChanges,
  type PriceNotificationContext,
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
  snoozed_until: string | null
}

/** Excludes AI-unconfirmed readings, like store.ts does. */
const TRUSTED = "(ai_review IS NULL OR ai_review <> 'unconfirmed')"

/** A knife's alert rules; defaults when it has no price watch row. */
export function readPriceAlertRules(
  database: Database.Database,
  knifeId: string,
): PriceAlertRules {
  const row = database
    .prepare(
      `SELECT target_price_minor, target_currency, notify_below_paid,
              notify_muted
       FROM price_watch WHERE knife_id = ?`,
    )
    .get(knifeId) as
    | {
        target_price_minor: number | null
        target_currency: string | null
        notify_below_paid: number
        notify_muted: number
      }
    | undefined
  if (!row) return NO_PRICE_ALERT_RULES
  return {
    muted: row.notify_muted === 1,
    belowPaid: row.notify_below_paid === 1,
    targetPrice:
      row.target_price_minor !== null && row.target_currency
        ? { minor: row.target_price_minor, currency: row.target_currency }
        : null,
  }
}

/** The knife's stored purchase price, parsed. */
export function readKnifePaid(
  database: Database.Database,
  knifeId: string,
): { amount: number; currency: string } | null {
  const row = database
    .prepare('SELECT specs FROM knives WHERE id = ?')
    .get(knifeId) as { specs: string } | undefined
  if (!row) return null
  let price: string | undefined
  try {
    price = (JSON.parse(row.specs) as { price?: string }).price
  } catch {
    return null
  }
  return parseStoredPrice(price)
}

/** A purchase price in `currency`; one without a currency is taken as it. */
function paidMinorIn(
  paid: { amount: number; currency: string } | null,
  currency: string | null,
): number | null {
  if (!paid || !currency) return null
  return paid.currency === currency || !paid.currency
    ? toMinorUnits(paid.amount, currency)
    : null
}

/** Lowest trusted price a source has shown in one currency. */
function readLowestPrice(
  database: Database.Database,
  sourceId: number,
  currency: string,
  excludeSnapshotId: number | null = null,
): number | null {
  const row = database
    .prepare(
      `SELECT MIN(price_minor) AS low FROM price_snapshots
       WHERE source_id = ? AND currency = ? AND price_minor IS NOT NULL
         AND ${TRUSTED} AND id <> ?`,
    )
    .get(sourceId, currency, excludeSnapshotId ?? -1) as { low: number | null }
  return row.low
}

/**
 * The alert rules, purchase price, source mute and previous lowest price
 * the planner needs for one source's events. `excludeSnapshotId` leaves the
 * reading being recorded out of the lowest price.
 */
export function readPriceAlertContext(
  database: Database.Database,
  input: {
    knifeId: string
    sourceId: number
    currency: string | null
    excludeSnapshotId?: number | null
  },
): PriceAlertContext {
  const source = database
    .prepare('SELECT notify_muted_until FROM price_sources WHERE id = ?')
    .get(input.sourceId) as { notify_muted_until: string | null } | undefined
  return {
    rules: readPriceAlertRules(database, input.knifeId),
    paidMinor: paidMinorIn(
      readKnifePaid(database, input.knifeId),
      input.currency,
    ),
    sourceMutedUntil: source?.notify_muted_until ?? null,
    lowestBeforeMinor: input.currency
      ? readLowestPrice(
          database,
          input.sourceId,
          input.currency,
          input.excludeSnapshotId,
        )
      : null,
  }
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
            snoozedUntil: row.snoozed_until,
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
         updated_at = ?, read_at = ?, dismissed_at = ?, resolved_at = ?,
         snoozed_until = ?
     WHERE id = ?`,
  )
  const insert = database.prepare(
    `INSERT INTO price_notifications
       (knife_id, source_id, event_id, kind, occurrences, occurred_at,
        created_at, updated_at, read_at, dismissed_at, resolved_at,
        snoozed_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      row.snoozedUntil,
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
      row.snoozedUntil,
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
  const contexts = new Map<string, PriceNotificationContext>()
  const contextFor = (
    knifeId: string,
    sourceId: number,
    currency: string | null,
  ): PriceNotificationContext => {
    const key = `${knifeId}\u0000${sourceId}\u0000${currency ?? ''}`
    let context = contexts.get(key)
    if (!context) {
      const alert = readPriceAlertContext(database, {
        knifeId,
        sourceId,
        currency,
      })
      context = {
        paidMinor: alert.paidMinor,
        lowestMinor: alert.lowestBeforeMinor,
        sourceMutedUntil: alert.sourceMutedUntil,
        knifeMuted: alert.rules.muted,
      }
      contexts.set(key, context)
    }
    return context
  }
  return sortPriceNotifications(
    rows.flatMap((row) => {
      const type =
        row.kind === 'target_reached'
          ? 'target'
          : row.kind === 'drop' || row.kind === 'increase'
            ? 'price'
            : 'stock'
      const event = events.get(`${type}-${row.eventId}`)
      return event
        ? [
            {
              ...row,
              event,
              context: contextFor(row.knifeId, row.sourceId, event.currency),
            },
          ]
        : []
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

import type Database from 'better-sqlite3'
import { getLocalDb } from '@/lib/local-db'
import { withVaultWrite } from '@/lib/vault-access'
import {
  applySystemMessageAction,
  isSystemMessageKind,
  mergeSystemMessageChanges,
  planSystemMessageReport,
  planSystemMessageResolve,
  type SystemMessage,
  type SystemMessageAction,
  type SystemMessageChanges,
  type SystemMessageKind,
  type SystemMessageReport,
  readPriceAgentNote,
} from '@/lib/system-messages'

type SystemMessageRow = {
  id: number
  kind: string
  dedupe_key: string | null
  title: string
  detail: string
  occurrences: number
  occurred_at: string
  created_at: string
  updated_at: string
  read_at: string | null
  dismissed_at: string | null
  resolved_at: string | null
  payload: string | null
  answer: string | null
}

function readPayload(value: string | null) {
  if (!value) return null
  try {
    return readPriceAgentNote(JSON.parse(value))
  } catch {
    return null
  }
}

export function readSystemMessages(
  database: Database.Database,
): SystemMessage[] {
  const rows = database
    .prepare('SELECT * FROM system_messages ORDER BY id')
    .all() as SystemMessageRow[]
  return rows.flatMap((row) =>
    isSystemMessageKind(row.kind)
      ? [
          {
            id: row.id,
            kind: row.kind,
            key: row.dedupe_key,
            title: row.title,
            detail: row.detail,
            occurrences: row.occurrences,
            occurredAt: row.occurred_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            readAt: row.read_at,
            dismissedAt: row.dismissed_at,
            resolvedAt: row.resolved_at,
            payload: readPayload(row.payload),
            answer:
              row.answer === 'yes' || row.answer === 'no' ? row.answer : null,
          },
        ]
      : [],
  )
}

function hasChanges(changes: SystemMessageChanges) {
  return (
    changes.create.length > 0 ||
    changes.update.length > 0 ||
    changes.deleteIds.length > 0
  )
}

/** Must run inside a transaction. */
function writeSystemMessageChanges(
  database: Database.Database,
  changes: SystemMessageChanges,
) {
  const insert = database.prepare(
    `INSERT INTO system_messages
       (kind, dedupe_key, title, detail, occurrences, occurred_at, created_at,
        updated_at, read_at, dismissed_at, resolved_at, payload, answer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const update = database.prepare(
    `UPDATE system_messages
     SET title = ?, detail = ?, occurrences = ?, occurred_at = ?,
         updated_at = ?, read_at = ?, dismissed_at = ?, resolved_at = ?,
         answer = ?
     WHERE id = ?`,
  )
  const remove = database.prepare('DELETE FROM system_messages WHERE id = ?')
  for (const row of changes.create) {
    insert.run(
      row.kind,
      row.key,
      row.title,
      row.detail,
      row.occurrences,
      row.occurredAt,
      row.createdAt,
      row.updatedAt,
      row.readAt,
      row.dismissedAt,
      row.resolvedAt,
      row.payload ? JSON.stringify(row.payload) : null,
      row.answer ?? null,
    )
  }
  for (const row of changes.update) {
    update.run(
      row.title,
      row.detail,
      row.occurrences,
      row.occurredAt,
      row.updatedAt,
      row.readAt,
      row.dismissedAt,
      row.resolvedAt,
      row.answer ?? null,
      row.id,
    )
  }
  for (const id of changes.deleteIds) remove.run(id)
}

/** Plans against the stored rows inside the write so concurrent updates merge. */
async function writePlanned(
  plan: (existing: SystemMessage[]) => SystemMessageChanges,
): Promise<SystemMessage[]> {
  const database = getLocalDb()
  if (!hasChanges(plan(readSystemMessages(database)))) {
    return readSystemMessages(database)
  }
  return withVaultWrite(async () => {
    database.transaction(() => {
      writeSystemMessageChanges(database, plan(readSystemMessages(database)))
    })()
    return readSystemMessages(database)
  })
}

/**
 * Records several reports inside the caller's vault write and transaction,
 * e.g. the AI supervisor's notes of one run.
 */
export function writeSystemMessageReports(
  database: Database.Database,
  reports: readonly SystemMessageReport[],
  now: Date,
) {
  let list = readSystemMessages(database)
  const all: SystemMessageChanges = { create: [], update: [], deleteIds: [] }
  for (const report of reports) {
    const changes = planSystemMessageReport(list, report, now)
    list = mergeSystemMessageChanges(list, changes)
    all.create.push(...changes.create)
    all.update.push(...changes.update)
    for (const id of changes.deleteIds)
      if (!all.deleteIds.includes(id)) all.deleteIds.push(id)
  }
  writeSystemMessageChanges(database, all)
}

export async function getSystemMessages(): Promise<SystemMessage[]> {
  return readSystemMessages(getLocalDb())
}

export async function reportSystemMessage(
  report: SystemMessageReport,
  now: Date = new Date(),
): Promise<SystemMessage[]> {
  return writePlanned((existing) =>
    planSystemMessageReport(existing, report, now),
  )
}

export async function resolveSystemMessages(
  kind: SystemMessageKind,
  now: Date = new Date(),
): Promise<SystemMessage[]> {
  return writePlanned((existing) =>
    planSystemMessageResolve(existing, kind, now),
  )
}

/** Closes one message for good, e.g. a question that no longer applies. */
export async function resolveSystemMessage(
  id: number,
  now: Date = new Date(),
): Promise<SystemMessage[]> {
  const nowIso = now.toISOString()
  return writePlanned((existing) => ({
    create: [],
    update: existing
      .filter((row) => row.id === id && !row.resolvedAt)
      .map((row) => ({ ...row, resolvedAt: nowIso, updatedAt: nowIso })),
    deleteIds: [],
  }))
}

export async function updateSystemMessages(
  action: SystemMessageAction,
  now: Date = new Date(),
): Promise<SystemMessage[]> {
  return writePlanned((existing) => ({
    create: [],
    update: applySystemMessageAction(existing, action, now),
    deleteIds: [],
  }))
}

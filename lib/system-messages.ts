/**
 * App events that land in the Inbox next to care reminders, such as a failed
 * Google Drive backup or store pages price monitoring cannot read. Each kind
 * keeps at most one open message: a repeat of the same problem updates it
 * instead of piling up new ones.
 */
export type SystemMessageKind =
  | 'backup-failed'
  | 'price-attention'
  /** The daily AI summary of price monitoring; each day replaces the last. */
  | 'price-digest'
export type SystemMessageBox = 'open' | 'done'

export type SystemMessage = {
  id: number
  kind: SystemMessageKind
  title: string
  detail: string
  /** How many times the problem happened while this message stayed open. */
  occurrences: number
  /** When the problem last happened; repeats move the message to the top. */
  occurredAt: string
  createdAt: string
  updatedAt: string
  readAt: string | null
  dismissedAt: string | null
  /** Set when the problem went away on its own, e.g. a later backup worked. */
  resolvedAt: string | null
}

export type SystemMessageAction =
  | { action: 'read' | 'dismiss' | 'restore'; ids: number[] }
  | { action: 'read-all' }

export const SYSTEM_MESSAGE_KINDS: readonly SystemMessageKind[] = [
  'backup-failed',
  'price-attention',
  'price-digest',
]
export const SYSTEM_MESSAGE_RETENTION_DAYS = 90

const DAY_MS = 86_400_000

export function isSystemMessageKind(
  value: unknown,
): value is SystemMessageKind {
  return (SYSTEM_MESSAGE_KINDS as readonly unknown[]).includes(value)
}

export function getSystemMessageBox(message: SystemMessage): SystemMessageBox {
  return message.resolvedAt || message.dismissedAt ? 'done' : 'open'
}

export function isSystemMessageUnread(message: SystemMessage): boolean {
  return getSystemMessageBox(message) === 'open' && !message.readAt
}

/** When a message last changed in a way the reader cares about. */
export function systemMessageTime(message: SystemMessage): string {
  return message.resolvedAt ?? message.dismissedAt ?? message.occurredAt
}

/** Open messages newest first; done messages most recently closed first. */
export function sortSystemMessages(
  list: readonly SystemMessage[],
): SystemMessage[] {
  return [...list].sort(
    (left, right) =>
      systemMessageTime(right).localeCompare(systemMessageTime(left)) ||
      right.id - left.id,
  )
}

/** Done messages older than the retention window, ready to delete. */
export function expiredSystemMessageIds(
  list: readonly SystemMessage[],
  now: Date,
): number[] {
  const purgeBefore = now.getTime() - SYSTEM_MESSAGE_RETENTION_DAYS * DAY_MS
  return list.flatMap((row) => {
    const closedAt = row.resolvedAt ?? row.dismissedAt
    return closedAt && Date.parse(closedAt) < purgeBefore ? [row.id] : []
  })
}

export type SystemMessageReport = {
  kind: SystemMessageKind
  title: string
  detail: string
}

export type SystemMessageChanges = {
  create: Omit<SystemMessage, 'id'>[]
  update: SystemMessage[]
  deleteIds: number[]
}

/**
 * Records a problem: refreshes the open message of that kind, reopens a
 * dismissed one as unread, or starts a new message.
 */
export function planSystemMessageReport(
  existing: readonly SystemMessage[],
  report: SystemMessageReport,
  now: Date,
): SystemMessageChanges {
  const nowIso = now.toISOString()
  const deleteIds = expiredSystemMessageIds(existing, now)
  const current = existing.find(
    (row) => row.kind === report.kind && !row.resolvedAt,
  )
  if (current) {
    return {
      create: [],
      update: [
        {
          ...current,
          title: report.title,
          detail: report.detail,
          occurrences: current.occurrences + 1,
          occurredAt: nowIso,
          updatedAt: nowIso,
          readAt: null,
          dismissedAt: null,
        },
      ],
      deleteIds,
    }
  }
  return {
    create: [
      {
        kind: report.kind,
        title: report.title,
        detail: report.detail,
        occurrences: 1,
        occurredAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
        readAt: null,
        dismissedAt: null,
        resolvedAt: null,
      },
    ],
    update: [],
    deleteIds,
  }
}

/** Closes the unresolved message of a kind once its problem has gone away. */
export function planSystemMessageResolve(
  existing: readonly SystemMessage[],
  kind: SystemMessageKind,
  now: Date,
): SystemMessageChanges {
  const nowIso = now.toISOString()
  return {
    create: [],
    update: existing
      .filter((row) => row.kind === kind && !row.resolvedAt)
      .map((row) => ({ ...row, resolvedAt: nowIso, updatedAt: nowIso })),
    deleteIds: expiredSystemMessageIds(existing, now),
  }
}

/** Returns the messages an inbox action changes, already updated. */
export function applySystemMessageAction(
  existing: readonly SystemMessage[],
  request: SystemMessageAction,
  now: Date,
): SystemMessage[] {
  const nowIso = now.toISOString()
  if (request.action === 'read-all') {
    return existing
      .filter(isSystemMessageUnread)
      .map((row) => ({ ...row, readAt: nowIso, updatedAt: nowIso }))
  }
  const ids = new Set(request.ids)
  const changed: SystemMessage[] = []
  for (const row of existing) {
    if (!ids.has(row.id)) continue
    let next = row
    switch (request.action) {
      case 'read':
        if (!row.readAt) next = { ...row, readAt: nowIso }
        break
      case 'dismiss':
        if (!row.resolvedAt && !row.dismissedAt)
          next = { ...row, dismissedAt: nowIso, readAt: row.readAt ?? nowIso }
        break
      case 'restore':
        if (!row.resolvedAt && row.dismissedAt)
          next = { ...row, dismissedAt: null, readAt: null }
        break
    }
    if (next !== row) changed.push({ ...next, updatedAt: nowIso })
  }
  return changed
}

/** Applies planned changes to an in-memory list, mirroring SQLite ids. */
export function mergeSystemMessageChanges(
  list: readonly SystemMessage[],
  changes: SystemMessageChanges,
): SystemMessage[] {
  const deleted = new Set(changes.deleteIds)
  const updated = new Map(changes.update.map((row) => [row.id, row]))
  const result = list
    .filter((row) => !deleted.has(row.id))
    .map((row) => updated.get(row.id) ?? row)
  let nextId = list.reduce((max, row) => Math.max(max, row.id), 0) + 1
  for (const row of changes.create) result.push({ ...row, id: nextId++ })
  return result
}

/** Validates a PATCH body for system messages. */
export function parseSystemMessageAction(body: unknown): SystemMessageAction {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Request body must be an object')
  }
  const { action, ids } = body as Record<string, unknown>
  switch (action) {
    case 'read-all':
      return { action }
    case 'read':
    case 'dismiss':
    case 'restore':
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        ids.length > 1000 ||
        !ids.every((id) => Number.isSafeInteger(id) && id > 0)
      ) {
        throw new Error('ids must be a non-empty list of message ids')
      }
      return { action, ids: ids as number[] }
    default:
      throw new Error('Unknown inbox action')
  }
}

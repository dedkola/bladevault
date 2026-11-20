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
  /** An unlocked achievement; one message per badge, keyed by its id. */
  | 'achievement'
  /** Advice from the AI price supervisor about one knife. */
  | 'price-advice'
  /** A yes/no question from the AI price supervisor about one knife. */
  | 'price-question'
export type SystemMessageBox = 'open' | 'done'

export type PriceAdviceTopic = 'deal' | 'restock' | 'watch'
export const PRICE_ADVICE_TOPICS: readonly PriceAdviceTopic[] = [
  'deal',
  'restock',
  'watch',
]
export type PriceQuestionAsk = 'set_target' | 'watch_closely' | 'keep_listing'
export const PRICE_QUESTION_ASKS: readonly PriceQuestionAsk[] = [
  'set_target',
  'watch_closely',
  'keep_listing',
]
export type SystemMessageAnswer = 'yes' | 'no'

/**
 * What an AI supervisor message is about. For a question it is also what
 * Yes (or, for keep_listing, No) does.
 */
export type PriceAgentNote =
  | { type: 'advice'; knifeId: string; topic: PriceAdviceTopic }
  | {
      type: 'question'
      knifeId: string
      ask: 'set_target'
      /** The suggested target price in minor units. */
      priceMinor: number
      currency: string
    }
  | {
      type: 'question'
      knifeId: string
      ask: 'watch_closely'
      hours: number
      everyHours: number
    }
  | {
      type: 'question'
      knifeId: string
      ask: 'keep_listing'
      /** A listing Other stores found; No pauses it. */
      sourceId: number
      store: string
    }

export type SystemMessage = {
  id: number
  kind: SystemMessageKind
  /**
   * Separates messages of one kind, e.g. each achievement. Messages without a
   * key keep the one-open-message-per-kind rule.
   */
  key: string | null
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
  /** AI supervisor messages: the knife they are about, and what Yes does. */
  payload?: PriceAgentNote | null
  /** A question's answer; set when answered (the message is then resolved). */
  answer?: SystemMessageAnswer | null
}

export type SystemMessageAction =
  | { action: 'read' | 'dismiss' | 'restore'; ids: number[] }
  | { action: 'read-all' }
  | { action: 'answer'; id: number; answer: SystemMessageAnswer }

export const SYSTEM_MESSAGE_KINDS: readonly SystemMessageKind[] = [
  'backup-failed',
  'price-attention',
  'price-digest',
  'achievement',
  'price-advice',
  'price-question',
]
export const SYSTEM_MESSAGE_RETENTION_DAYS = 90

/** Asks the Inbox to reload system messages, e.g. after new achievements. */
export const SYSTEM_MESSAGES_REFRESH_EVENT =
  'bladevault:system-messages-refresh'

const DAY_MS = 86_400_000

export function isSystemMessageKind(
  value: unknown,
): value is SystemMessageKind {
  return (SYSTEM_MESSAGE_KINDS as readonly unknown[]).includes(value)
}

const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

/** A stored AI supervisor payload, or null when it is not one. */
export function readPriceAgentNote(value: unknown): PriceAgentNote | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const note = value as Record<string, unknown>
  if (typeof note.knifeId !== 'string' || !note.knifeId) return null
  const knifeId = note.knifeId
  if (note.type === 'advice')
    return (PRICE_ADVICE_TOPICS as readonly unknown[]).includes(note.topic)
      ? { type: 'advice', knifeId, topic: note.topic as PriceAdviceTopic }
      : null
  if (note.type !== 'question') return null
  switch (note.ask) {
    case 'set_target':
      return Number.isSafeInteger(note.priceMinor) &&
        positive(note.priceMinor) &&
        typeof note.currency === 'string' &&
        /^[A-Z]{3}$/.test(note.currency)
        ? {
            type: 'question',
            knifeId,
            ask: 'set_target',
            priceMinor: note.priceMinor,
            currency: note.currency,
          }
        : null
    case 'watch_closely':
      return positive(note.hours) && positive(note.everyHours)
        ? {
            type: 'question',
            knifeId,
            ask: 'watch_closely',
            hours: note.hours,
            everyHours: note.everyHours,
          }
        : null
    case 'keep_listing':
      return Number.isSafeInteger(note.sourceId) &&
        positive(note.sourceId) &&
        typeof note.store === 'string'
        ? {
            type: 'question',
            knifeId,
            ask: 'keep_listing',
            sourceId: note.sourceId,
            store: note.store,
          }
        : null
    default:
      return null
  }
}

/** An open AI question that still waits for Yes or No. */
export function isOpenPriceQuestion(message: SystemMessage): boolean {
  return (
    message.kind === 'price-question' &&
    getSystemMessageBox(message) === 'open' &&
    !message.answer &&
    message.payload?.type === 'question'
  )
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
  /** A keyed report is recorded once: repeats of the same key are ignored. */
  key?: string
  title: string
  detail: string
  payload?: PriceAgentNote
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
  const key = report.key ?? null
  if (
    key !== null &&
    existing.some((row) => row.kind === report.kind && row.key === key)
  ) {
    return { create: [], update: [], deleteIds }
  }
  const current =
    key === null
      ? existing.find(
          (row) =>
            row.kind === report.kind && row.key === null && !row.resolvedAt,
        )
      : undefined
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
        key,
        title: report.title,
        detail: report.detail,
        occurrences: 1,
        occurredAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
        readAt: null,
        dismissedAt: null,
        resolvedAt: null,
        payload: report.payload ?? null,
        answer: null,
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
      .filter((row) => row.kind === kind && row.key === null && !row.resolvedAt)
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
  if (request.action === 'answer') {
    // Answered questions close for good: no Move back to inbox.
    return existing
      .filter((row) => row.id === request.id && isOpenPriceQuestion(row))
      .map((row) => ({
        ...row,
        answer: request.answer,
        readAt: row.readAt ?? nowIso,
        resolvedAt: nowIso,
        updatedAt: nowIso,
      }))
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
  const { action, ids, id, answer } = body as Record<string, unknown>
  switch (action) {
    case 'read-all':
      return { action }
    case 'answer':
      if (!Number.isSafeInteger(id) || (id as number) <= 0)
        throw new Error('id must be a message id')
      if (answer !== 'yes' && answer !== 'no')
        throw new Error('answer must be yes or no')
      return { action, id: id as number, answer }
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

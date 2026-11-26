import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getLocalDb } from '@/lib/local-db'
import { withVaultWriteSync } from '@/lib/vault-access'
import {
  CHAT_TITLE_MAX_LENGTH,
  chatTitleFrom,
  type ChatConversationDetail,
  type ChatConversationSummary,
  type ChatMessageStatus,
  type ChatStoredMessage,
  type ChatToolStep,
} from '@/lib/chat/shared'

/**
 * Chat conversations in the vault database (backed up with it). Every write
 * is one short vault write, never held while a model answers, so a restore
 * is never blocked by a long chat.
 */

export class ChatNotFoundError extends Error {
  constructor() {
    super('This chat no longer exists.')
    this.name = 'ChatNotFoundError'
  }
}

type ConversationRow = {
  id: string
  title: string
  created_at: string
  updated_at: string
  archived_at: string | null
  prompt_tokens: number
  completion_tokens: number
}

type MessageRow = {
  id: number
  role: ChatStoredMessage['role']
  content: string
  tool_calls: string | null
  tool_call_id: string | null
  tool_name: string | null
  ui_data: string | null
  status: ChatMessageStatus
  created_at: string
}

function toSummary(row: ConversationRow): ChatConversationSummary {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
  }
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function toMessage(row: MessageRow): ChatStoredMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    toolCalls: parseJson(row.tool_calls),
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    step: parseJson<ChatToolStep>(row.ui_data),
    status: row.status,
    createdAt: row.created_at,
  }
}

function readConversation(
  database: Database.Database,
  id: string,
): ConversationRow | undefined {
  return database
    .prepare('SELECT * FROM chat_conversations WHERE id = ?')
    .get(id) as ConversationRow | undefined
}

/** LIKE pattern for a search term, with %, _ and \ taken literally. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}

export function listConversations(
  input: { archived?: boolean; query?: string; limit?: number } = {},
): ChatConversationSummary[] {
  const database = getLocalDb()
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500)
  const query = input.query?.trim()
  const archived = input.archived
    ? 'c.archived_at IS NOT NULL'
    : 'c.archived_at IS NULL'
  const rows = query
    ? (database
        .prepare(
          `SELECT c.* FROM chat_conversations c
           WHERE ${archived}
             AND (c.title LIKE @pattern ESCAPE '\\'
               OR EXISTS (SELECT 1 FROM chat_messages m
                          WHERE m.conversation_id = c.id
                            AND m.role IN ('user', 'assistant')
                            AND m.content LIKE @pattern ESCAPE '\\'))
           ORDER BY c.updated_at DESC LIMIT @limit`,
        )
        .all({ pattern: likePattern(query), limit }) as ConversationRow[])
    : (database
        .prepare(
          `SELECT c.* FROM chat_conversations c WHERE ${archived}
           ORDER BY c.updated_at DESC LIMIT ?`,
        )
        .all(limit) as ConversationRow[])
  return rows.map(toSummary)
}

export function getConversation(id: string): ChatConversationDetail {
  const database = getLocalDb()
  const row = readConversation(database, id)
  if (!row) throw new ChatNotFoundError()
  const messages = database
    .prepare(
      'SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY id',
    )
    .all(id) as MessageRow[]
  return { ...toSummary(row), messages: messages.map(toMessage) }
}

export function createConversation(
  firstMessage: string,
  now = new Date(),
): ChatConversationSummary {
  const at = now.toISOString()
  const row: ConversationRow = {
    id: randomUUID(),
    title: chatTitleFrom(firstMessage),
    created_at: at,
    updated_at: at,
    archived_at: null,
    prompt_tokens: 0,
    completion_tokens: 0,
  }
  withVaultWriteSync(() =>
    getLocalDb()
      .prepare(
        `INSERT INTO chat_conversations
          (id, title, created_at, updated_at, archived_at, prompt_tokens, completion_tokens)
         VALUES (@id, @title, @created_at, @updated_at, NULL, 0, 0)`,
      )
      .run(row),
  )
  return toSummary(row)
}

export type NewChatMessage = {
  role: ChatStoredMessage['role']
  content: string
  toolCalls?: ChatStoredMessage['toolCalls']
  toolCallId?: string | null
  toolName?: string | null
  step?: ChatToolStep | null
  status?: ChatMessageStatus
}

/** Adds a message and moves the conversation to the top of the list. */
export function appendMessage(
  conversationId: string,
  message: NewChatMessage,
  now = new Date(),
): ChatStoredMessage {
  const at = now.toISOString()
  return withVaultWriteSync(() => {
    const database = getLocalDb()
    return database.transaction(() => {
      if (!readConversation(database, conversationId))
        throw new ChatNotFoundError()
      const result = database
        .prepare(
          `INSERT INTO chat_messages
            (conversation_id, role, content, tool_calls, tool_call_id, tool_name,
             ui_data, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          conversationId,
          message.role,
          message.content,
          message.toolCalls?.length ? JSON.stringify(message.toolCalls) : null,
          message.toolCallId ?? null,
          message.toolName ?? null,
          message.step ? JSON.stringify(message.step) : null,
          message.status ?? 'done',
          at,
        )
      database
        .prepare('UPDATE chat_conversations SET updated_at = ? WHERE id = ?')
        .run(at, conversationId)
      const row = database
        .prepare('SELECT * FROM chat_messages WHERE id = ?')
        .get(result.lastInsertRowid) as MessageRow
      return toMessage(row)
    })()
  })
}

export function addConversationUsage(
  conversationId: string,
  promptTokens: number,
  completionTokens: number,
): void {
  if (!promptTokens && !completionTokens) return
  withVaultWriteSync(() =>
    getLocalDb()
      .prepare(
        `UPDATE chat_conversations
         SET prompt_tokens = prompt_tokens + ?,
             completion_tokens = completion_tokens + ?
         WHERE id = ?`,
      )
      .run(promptTokens, completionTokens, conversationId),
  )
}

export function updateConversation(
  id: string,
  changes: { title?: string; archived?: boolean },
  now = new Date(),
): ChatConversationSummary {
  return withVaultWriteSync(() => {
    const database = getLocalDb()
    const row = readConversation(database, id)
    if (!row) throw new ChatNotFoundError()
    const title =
      changes.title !== undefined
        ? changes.title
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, CHAT_TITLE_MAX_LENGTH) || row.title
        : row.title
    const archivedAt =
      changes.archived === undefined
        ? row.archived_at
        : changes.archived
          ? (row.archived_at ?? now.toISOString())
          : null
    database
      .prepare(
        'UPDATE chat_conversations SET title = ?, archived_at = ? WHERE id = ?',
      )
      .run(title, archivedAt, id)
    return toSummary({ ...row, title, archived_at: archivedAt })
  })
}

export function deleteConversation(id: string): void {
  withVaultWriteSync(() => {
    const database = getLocalDb()
    database.transaction(() => {
      database
        .prepare('DELETE FROM chat_messages WHERE conversation_id = ?')
        .run(id)
      const result = database
        .prepare('DELETE FROM chat_conversations WHERE id = ?')
        .run(id)
      if (!result.changes) throw new ChatNotFoundError()
    })()
  })
}

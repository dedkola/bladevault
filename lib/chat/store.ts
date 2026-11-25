import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getLocalDb } from '@/lib/local-db'
import { withVaultWriteSync } from '@/lib/vault-access'
import { isPriceAiChatReasoning } from '@/lib/settings-shared'
import {
  CHAT_TITLE_MAX_LENGTH,
  chatTitleFrom,
  type ChatChoice,
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
  /** '' until the chat has a model of its own (schema 18). */
  model: string
  reasoning: string
  choice_at: string | null
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
    choice: choiceOf(row),
  }
}

function choiceOf(row: {
  model: string
  reasoning: string
}): ChatChoice | null {
  if (!row.model || !isPriceAiChatReasoning(row.reasoning)) return null
  return { model: row.model, reasoning: row.reasoning }
}

/**
 * The model and reasoning picked last in any chat (also archived ones), or
 * null before any chat has one.
 */
export function lastChatChoice(): ChatChoice | null {
  const row = getLocalDb()
    .prepare(
      `SELECT model, reasoning FROM chat_conversations
       WHERE model != '' AND choice_at IS NOT NULL
       ORDER BY choice_at DESC LIMIT 1`,
    )
    .get() as { model: string; reasoning: string } | undefined
  return row ? choiceOf(row) : null
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
  choice: ChatChoice,
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
    model: choice.model,
    reasoning: choice.reasoning,
    choice_at: at,
  }
  withVaultWriteSync(() =>
    getLocalDb()
      .prepare(
        `INSERT INTO chat_conversations
          (id, title, created_at, updated_at, archived_at, prompt_tokens,
           completion_tokens, model, reasoning, choice_at)
         VALUES (@id, @title, @created_at, @updated_at, NULL, 0, 0,
                 @model, @reasoning, @choice_at)`,
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

/**
 * Renames, archives or restores a chat, or sets its model and reasoning
 * (which also makes them where the next new chat starts). The list order
 * (`updated_at`) does not change.
 */
export function updateConversation(
  id: string,
  changes: { title?: string; archived?: boolean; choice?: ChatChoice },
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
    const choice = changes.choice
      ? {
          model: changes.choice.model,
          reasoning: changes.choice.reasoning,
          choice_at: now.toISOString(),
        }
      : { model: row.model, reasoning: row.reasoning, choice_at: row.choice_at }
    database
      .prepare(
        `UPDATE chat_conversations
         SET title = ?, archived_at = ?, model = ?, reasoning = ?, choice_at = ?
         WHERE id = ?`,
      )
      .run(
        title,
        archivedAt,
        choice.model,
        choice.reasoning,
        choice.choice_at,
        id,
      )
    return toSummary({ ...row, title, archived_at: archivedAt, ...choice })
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

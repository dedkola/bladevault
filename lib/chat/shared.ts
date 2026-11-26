/**
 * Chat types shared by the server and the Chat page (no server imports).
 */

import type { PriceAiChatReasoning } from '@/lib/settings-shared'

/** The model and reasoning level a chat answers with. */
export type ChatChoice = { model: string; reasoning: PriceAiChatReasoning }

export type ChatConversationSummary = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  promptTokens: number
  completionTokens: number
  /**
   * The chat's own model and reasoning, or null for a chat saved before
   * chats had one (it answers with the start choice, ChatStatus.choice).
   */
  choice: ChatChoice | null
}

/** A knife as the Chat page draws it (a card linking to the knife). */
export type ChatKnifeCard = {
  id: string
  name: string
  brand: string
  image: string | null
  /** Steel, blade length and model number, joined. */
  subtitle: string | null
  price: string | null
  sold: boolean
}

export type ChatMoney = { amount: number; minor: number; currency: string }

export type ChatPriceChangeRow = {
  kind: 'drop' | 'increase' | 'out_of_stock' | 'back_in_stock'
  knife: ChatKnifeCard
  storeName: string
  price: ChatMoney | null
  previousPrice: ChatMoney | null
  deltaPct: number | null
  occurredAt: string
}

export type ChatPriceWatchRow = {
  knife: ChatKnifeCard
  state: string
  bestPrice: ChatMoney | null
  paid: ChatMoney | null
  outOfStock: boolean
  lastCheckedAt: string | null
}

/** What the page draws under a tool step; never sent to the model. */
export type ChatToolUi =
  | { kind: 'knives'; knives: ChatKnifeCard[]; total: number }
  | { kind: 'priceChanges'; rows: ChatPriceChangeRow[]; total: number }
  | { kind: 'priceWatches'; rows: ChatPriceWatchRow[]; total: number }

/** One tool call as the page shows it: a chip, optional cards or tables. */
export type ChatToolStep = {
  name: string
  /** "Searched knives: Spyderco" */
  label: string
  /** "12 results", or the error. */
  summary: string
  ok: boolean
  ui: ChatToolUi | null
}

export type ChatMessageStatus = 'done' | 'stopped' | 'error'

export type ChatStoredMessage = {
  id: number
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls: Array<{ id: string; name: string; arguments: string }> | null
  toolCallId: string | null
  toolName: string | null
  step: ChatToolStep | null
  status: ChatMessageStatus
  createdAt: string
}

export type ChatConversationDetail = ChatConversationSummary & {
  messages: ChatStoredMessage[]
}

/** NDJSON events of POST /api/chat, one per line. */
export type ChatStreamEvent =
  | { type: 'conversation'; conversation: ChatConversationSummary }
  | { type: 'user'; message: ChatStoredMessage }
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; callId: string; name: string; label: string }
  | { type: 'tool_result'; callId: string; step: ChatToolStep }
  | { type: 'message'; message: ChatStoredMessage }
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | { type: 'notice'; message: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export type ChatStatus = {
  configured: boolean
  /** What a new chat starts with: the Settings chat model. */
  choice: ChatChoice
  toolMode: 'auto' | 'native' | 'json'
  /** Limited mode: chat's daily caps (0 = none); null in Unlimited mode. */
  limit: { calls: number; tokens: number } | null
  usageToday: { calls: number; tokens: number }
  readOnly: boolean
}

export const CHAT_MESSAGE_MAX_LENGTH = 8000
export const CHAT_TITLE_MAX_LENGTH = 120

/** A conversation title from its first message: one line, at most 60 chars. */
export function chatTitleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (!line) return 'New chat'
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line
}

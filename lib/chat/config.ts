import { z } from 'zod/v4'
import type { AiEndpoint } from '@/lib/price-monitor/ai-client'
import { readAiUsageToday } from '@/lib/price-monitor/ai-journal'
import { readPriceAiKey } from '@/lib/price-monitor/secrets'
import { getLocalDb } from '@/lib/local-db'
import { getSettings } from '@/lib/settings'
import {
  normalizeAiModel,
  PRICE_AI_CHAT_REASONING,
  type PriceAiChatSettings,
} from '@/lib/settings-shared'
import { getVaultAccessState } from '@/lib/vault-access'
import type { ChatChoice, ChatStatus } from '@/lib/chat/shared'
import { lastChatChoice } from '@/lib/chat/store'

/**
 * The chat's AI connection: the saved base URL, key and headers, and what a
 * new chat starts with. Chat does not need price monitoring's AI switched
 * on, only a connection. Each chat then has its own model and reasoning.
 */
export type ChatConnection = {
  endpoint: AiEndpoint
  /** A new chat's model and reasoning; also for chats saved without one. */
  start: ChatChoice
  chat: PriceAiChatSettings
}

/** A chat model ID in a request body (same rules as Settings). */
export const chatModelSchema = z
  .string()
  .trim()
  .min(1, 'Choose a model.')
  .refine((value) => normalizeAiModel(value) !== null, {
    message: 'This is not a valid model ID.',
  })

export const chatReasoningSchema = z.enum(PRICE_AI_CHAT_REASONING)

export class ChatNotConfiguredError extends Error {
  constructor() {
    super('Set up an AI connection first: Settings → AI connection.')
    this.name = 'ChatNotConfiguredError'
  }
}

/**
 * Where a new chat starts: the model and reasoning picked last in any chat,
 * else Settings (the chat model, or the price-monitoring model).
 */
export function chatStartChoice(): ChatChoice {
  const last = lastChatChoice()
  if (last) return last
  const ai = getSettings().priceMonitoring.ai
  return { model: ai.chat.model || ai.model, reasoning: ai.chat.reasoning }
}

export async function readChatConnection(): Promise<ChatConnection> {
  const ai = getSettings().priceMonitoring.ai
  if (!ai.baseUrl) throw new ChatNotConfiguredError()
  return {
    endpoint: {
      baseUrl: ai.baseUrl,
      apiKey: await readPriceAiKey(),
      headers: ai.headers,
      maxAnswerTokens: ai.maxAnswerTokens,
    },
    start: chatStartChoice(),
    chat: ai.chat,
  }
}

export function readChatStatus(now = Date.now()): ChatStatus {
  const ai = getSettings().priceMonitoring.ai
  const choice = chatStartChoice()
  return {
    configured: Boolean(ai.baseUrl && choice.model),
    choice,
    toolMode: ai.chat.toolMode,
    limit:
      ai.usage.mode === 'unlimited'
        ? null
        : { calls: ai.chat.dailyCalls, tokens: ai.chat.dailyTokens },
    usageToday: readAiUsageToday(getLocalDb(), now, 'chat'),
    readOnly: getVaultAccessState().readOnly,
  }
}

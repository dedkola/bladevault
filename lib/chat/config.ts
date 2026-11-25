import type { AiEndpoint } from '@/lib/price-monitor/ai-client'
import { readAiUsageToday } from '@/lib/price-monitor/ai-journal'
import { readPriceAiKey } from '@/lib/price-monitor/secrets'
import { getLocalDb } from '@/lib/local-db'
import { getSettings } from '@/lib/settings'
import type { PriceAiChatSettings } from '@/lib/settings-shared'
import { getVaultAccessState } from '@/lib/vault-access'
import type { ChatStatus } from '@/lib/chat/shared'

/**
 * The chat's AI connection: the saved base URL, key and headers, and the
 * chat model (or the price-monitoring model). Chat does not need price
 * monitoring's AI switched on, only a connection.
 */
export type ChatConnection = {
  endpoint: AiEndpoint
  model: string
  chat: PriceAiChatSettings
}

export class ChatNotConfiguredError extends Error {
  constructor() {
    super('Set up an AI connection first: Settings → AI connection.')
    this.name = 'ChatNotConfiguredError'
  }
}

function chatModel(): string {
  const ai = getSettings().priceMonitoring.ai
  return ai.chat.model || ai.model
}

export async function readChatConnection(): Promise<ChatConnection> {
  const ai = getSettings().priceMonitoring.ai
  const model = chatModel()
  if (!ai.baseUrl || !model) throw new ChatNotConfiguredError()
  return {
    endpoint: {
      baseUrl: ai.baseUrl,
      apiKey: await readPriceAiKey(),
      headers: ai.headers,
      maxAnswerTokens: ai.maxAnswerTokens,
    },
    model,
    chat: ai.chat,
  }
}

export function readChatStatus(now = Date.now()): ChatStatus {
  const ai = getSettings().priceMonitoring.ai
  const model = chatModel()
  return {
    configured: Boolean(ai.baseUrl && model),
    model,
    toolMode: ai.chat.toolMode,
    limit:
      ai.usage.mode === 'unlimited'
        ? null
        : { calls: ai.chat.dailyCalls, tokens: ai.chat.dailyTokens },
    usageToday: readAiUsageToday(getLocalDb(), now, 'chat'),
    readOnly: getVaultAccessState().readOnly,
  }
}

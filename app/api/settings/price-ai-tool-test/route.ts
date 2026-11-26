import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import {
  AiClientError,
  requestChatCompletion,
} from '@/lib/price-monitor/ai-client'
import { NO_STORE, priceAiErrorResponse } from '@/lib/price-monitor/ai-route'
import { readPriceAiKey } from '@/lib/price-monitor/secrets'
import { getSettings } from '@/lib/settings'
import { normalizeAiModel } from '@/lib/settings-shared'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** A made-up tool; nothing from the vault is sent. */
const SAMPLE_TOOL = {
  name: 'count_knives',
  description: 'Count the knives of one brand in the collection.',
  parameters: {
    type: 'object',
    properties: { brand: { type: 'string', description: 'Brand name' } },
    required: ['brand'],
    additionalProperties: false,
  },
}

/**
 * Test tool calling: one request with a sample tool, to see whether the
 * chat model calls tools natively (or the chat must use its JSON mode).
 * Uses the chat model, or `{ model }` to try another.
 */
export async function POST(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  const body = (await request.json().catch(() => null)) as {
    model?: unknown
  } | null
  try {
    const ai = getSettings().priceMonitoring.ai
    const model =
      body?.model === undefined
        ? ai.chat.model || ai.model
        : (normalizeAiModel(body.model) ?? '')
    if (!ai.baseUrl)
      return NextResponse.json(
        { error: 'Set the AI base URL first.' },
        { status: 400 },
      )
    if (!model)
      return NextResponse.json(
        { error: 'Choose a model first.' },
        { status: 400 },
      )
    const endpoint = {
      baseUrl: ai.baseUrl,
      apiKey: await readPriceAiKey(),
      headers: ai.headers,
      maxAnswerTokens: ai.maxAnswerTokens,
    }
    const started = Date.now()
    try {
      const result = await requestChatCompletion(
        endpoint,
        {
          model,
          messages: [
            {
              role: 'system',
              content: 'Use the tools to answer. Do not guess.',
            },
            {
              role: 'user',
              content: 'How many Spyderco knives do I have?',
            },
          ],
          tools: [SAMPLE_TOOL],
          maxTokens: 512,
          purpose: 'test',
          allowThinking: ai.chat.allowThinking,
        },
        { timeoutMs: 60_000, signal: request.signal },
      )
      const latencyMs = Date.now() - started
      const call = result.toolCalls.find(
        (entry) => entry.name === SAMPLE_TOOL.name,
      )
      if (call)
        return NextResponse.json(
          {
            ok: true,
            mode: 'native',
            latencyMs,
            model,
            message: `Tool calling works: ${model} called the sample tool. The chat uses native tools.`,
          },
          { headers: NO_STORE },
        )
      return NextResponse.json(
        {
          ok: false,
          mode: 'none',
          latencyMs,
          model,
          message: `${model} answered without calling the sample tool. If chat answers are vague, set Tool mode to JSON.`,
        },
        { headers: NO_STORE },
      )
    } catch (error) {
      if (error instanceof AiClientError && error.code === 'tools_unsupported')
        return NextResponse.json(
          {
            ok: false,
            mode: 'json',
            latencyMs: Date.now() - started,
            model,
            message: `The endpoint does not take tools for ${model}. In Auto mode the chat switches to JSON mode by itself.`,
          },
          { headers: NO_STORE },
        )
      throw error
    }
  } catch (error) {
    return priceAiErrorResponse(error, '/api/settings/price-ai-tool-test')
  }
}

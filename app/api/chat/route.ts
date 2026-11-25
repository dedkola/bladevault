import { NextResponse } from 'next/server'
import { z } from 'zod/v4'
import { requireAppUnlock } from '@/lib/app-lock'
import {
  ChatNotConfiguredError,
  readChatConnection,
  type ChatConnection,
} from '@/lib/chat/config'
import { runChatTurn, type ChatTurnUsage } from '@/lib/chat/loop'
import {
  CHAT_MESSAGE_MAX_LENGTH,
  type ChatConversationSummary,
  type ChatStoredMessage,
  type ChatStreamEvent,
} from '@/lib/chat/shared'
import {
  addConversationUsage,
  appendMessage,
  ChatNotFoundError,
  createConversation,
  getConversation,
} from '@/lib/chat/store'
import { AiClientError, type ChatMessage } from '@/lib/price-monitor/ai-client'
import { PriceAiKeyError } from '@/lib/price-monitor/secrets'
import { reportServerError } from '@/lib/sentry/server'
import { vaultAccessErrorResponse } from '@/lib/vault-access'
import { withVaultMutationRequest } from '@/lib/vault-mutation-request'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  conversationId: z.string().min(1).max(100).optional(),
  message: z.string().trim().min(1).max(CHAT_MESSAGE_MAX_LENGTH),
})

/** Earlier user and assistant text of a chat, for the model. */
function historyOf(messages: ChatStoredMessage[]): ChatMessage[] {
  const history: ChatMessage[] = []
  for (const message of messages) {
    if (message.role === 'user')
      history.push({ role: 'user', content: message.content })
    else if (
      message.role === 'assistant' &&
      message.status !== 'error' &&
      message.content.trim()
    )
      history.push({ role: 'assistant', content: message.content })
  }
  return history
}

function chatErrorMessage(error: unknown): string {
  if (error instanceof AiClientError || error instanceof PriceAiKeyError)
    return error.message
  if (error instanceof ChatNotFoundError) return error.message
  if (vaultAccessErrorResponse(error))
    return 'The vault is busy (a restore is running). Try again in a moment.'
  reportServerError(error, '/api/chat')
  return 'The chat failed. Try again.'
}

/**
 * Sends one message and streams the answer as NDJSON (ChatStreamEvent per
 * line): text deltas, tool steps with their cards, and the saved messages.
 * Closing the request (Stop) ends the turn; the partial answer is kept.
 */
export async function POST(request: Request) {
  let connection: ChatConnection
  let conversation: ChatConversationSummary
  let history: ChatMessage[]
  let userMessage: ChatStoredMessage
  let userText: string
  // Returned by the setup step when the turn may start.
  const ready = new Response(null, { status: 204 })

  const prepared = await withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked
    const parsed = bodySchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success)
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid message.' },
        { status: 400 },
      )
    userText = parsed.data.message
    try {
      connection = await readChatConnection()
      if (parsed.data.conversationId) {
        const existing = getConversation(parsed.data.conversationId)
        history = historyOf(existing.messages)
        conversation = existing
      } else {
        history = []
        conversation = createConversation(userText)
      }
      userMessage = appendMessage(conversation.id, {
        role: 'user',
        content: userText,
      })
    } catch (error) {
      if (error instanceof ChatNotConfiguredError)
        return NextResponse.json({ error: error.message }, { status: 400 })
      if (error instanceof ChatNotFoundError)
        return NextResponse.json({ error: error.message }, { status: 404 })
      if (error instanceof PriceAiKeyError)
        return NextResponse.json({ error: error.message }, { status: 400 })
      if (vaultAccessErrorResponse(error)) throw error
      reportServerError(error, '/api/chat')
      return NextResponse.json(
        { error: 'Could not start the chat.' },
        { status: 500 },
      )
    }
    return ready
  })
  if (prepared !== ready) return prepared

  const encoder = new TextEncoder()
  const abort = new AbortController()
  const onClientGone = () => abort.abort()
  request.signal.addEventListener('abort', onClientGone)

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true
      const send = (event: ChatStreamEvent) => {
        if (!open) return
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        } catch {
          open = false
        }
      }
      const conversationId = conversation.id
      // Text of the current model step, saved when the step ends.
      let pending = ''
      const usage: ChatTurnUsage = { promptTokens: 0, completionTokens: 0 }
      const save = (
        message: Parameters<typeof appendMessage>[1],
      ): ChatStoredMessage | null => {
        try {
          return appendMessage(conversationId, message)
        } catch {
          // A restore or a deleted chat: the stream still finishes.
          return null
        }
      }

      send({ type: 'conversation', conversation })
      send({ type: 'user', message: userMessage })
      try {
        const result = await runChatTurn({
          endpoint: connection.endpoint,
          model: connection.model,
          toolMode: connection.chat.toolMode,
          allowThinking: connection.chat.allowThinking,
          history,
          userText,
          signal: abort.signal,
          usage,
          emit: (event) => {
            switch (event.type) {
              case 'text':
                pending += event.delta
                send({ type: 'text', delta: event.delta })
                break
              case 'tool_calls': {
                save({
                  role: 'assistant',
                  content: event.text,
                  toolCalls: event.toolCalls,
                })
                pending = ''
                break
              }
              case 'tool_start':
                send({
                  type: 'tool_start',
                  callId: event.callId,
                  name: event.name,
                  label: event.label,
                })
                break
              case 'tool_result':
                save({
                  role: 'tool',
                  content: event.content,
                  toolCallId: event.callId,
                  toolName: event.name,
                  step: event.step,
                })
                send({
                  type: 'tool_result',
                  callId: event.callId,
                  step: event.step,
                })
                break
            }
          },
        })
        const saved = save({ role: 'assistant', content: result.text })
        if (saved) send({ type: 'message', message: saved })
        send({ type: 'done' })
      } catch (error) {
        const stopped =
          abort.signal.aborted ||
          (error instanceof AiClientError && error.code === 'cancelled')
        if (stopped) {
          save({ role: 'assistant', content: pending, status: 'stopped' })
        } else {
          const message = chatErrorMessage(error)
          const saved = save({
            role: 'assistant',
            content: pending.trim() ? pending : message,
            status: 'error',
          })
          if (saved) send({ type: 'message', message: saved })
          send({ type: 'error', message })
        }
      } finally {
        try {
          addConversationUsage(
            conversationId,
            usage.promptTokens,
            usage.completionTokens,
          )
        } catch {
          // Usage totals are informational.
        }
        send({
          type: 'usage',
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
        })
        request.signal.removeEventListener('abort', onClientGone)
        if (open) {
          open = false
          try {
            controller.close()
          } catch {
            // Already closed by the client.
          }
        }
      }
    },
    cancel() {
      abort.abort()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}

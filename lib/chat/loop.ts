import { z } from 'zod/v4'
import {
  AiClientError,
  chatToolsRejected,
  parseJsonAnswer,
  requestChatCompletion,
  type AiEndpoint,
  type ChatMessage,
  type ChatToolCall,
  type ChatToolDefinition,
  type FetchLike,
} from '@/lib/price-monitor/ai-client'
import type {
  PriceAiChatReasoning,
  PriceAiChatToolMode,
} from '@/lib/settings-shared'
import { READ_TOOLS, type ReadTool } from '@/lib/tools/read-tools'
import {
  buildToolStep,
  describeToolCall,
  failedToolStep,
  toModelContent,
} from '@/lib/chat/tool-results'
import type { ChatToolStep } from '@/lib/chat/shared'

/**
 * One chat turn: the model answers the user's message, calling the vault's
 * read tools as it needs them. Native mode sends the tools as function
 * calls; JSON mode (models without function calling) asks for one JSON
 * action per step and runs the same tools. Read-only: the chat has no tool
 * that changes data.
 */

const FIRST_BYTE_TIMEOUT_MS = 90_000

/** The tools the chat offers: every read tool but proposal validation. */
export const CHAT_TOOLS: readonly ReadTool[] = READ_TOOLS.filter(
  (tool) => tool.name !== 'propose_changes',
)

export type ChatLoopEvent =
  | { type: 'text'; delta: string }
  /** The model asked for tools (with any text it wrote first). */
  | { type: 'tool_calls'; text: string; toolCalls: ChatToolCall[] }
  | { type: 'tool_start'; callId: string; name: string; label: string }
  | {
      type: 'tool_result'
      callId: string
      name: string
      /** What the model read. */
      content: string
      step: ChatToolStep
    }
  /** Something about the turn the user should know; shown once. */
  | { type: 'notice'; message: string }

export type ChatTurnInput = {
  endpoint: AiEndpoint
  model: string
  toolMode: PriceAiChatToolMode
  reasoning: PriceAiChatReasoning
  /** Earlier user and assistant messages, oldest first. */
  history: ChatMessage[]
  userText: string
  signal?: AbortSignal
  fetchImpl?: FetchLike
  now?: Date
  tools?: readonly ReadTool[]
  emit: (event: ChatLoopEvent) => void
  /** Filled in as calls finish. */
  usage?: ChatTurnUsage
}

export type ChatTurnResult = {
  text: string
  mode: 'native' | 'json'
  steps: number
}

/** Tokens the turn used so far (also when it fails or is stopped). */
export type ChatTurnUsage = { promptTokens: number; completionTokens: number }

export function chatToolDefinitions(
  tools: readonly ReadTool[] = CHAT_TOOLS,
): ChatToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.inputSchema, {
      io: 'input',
      unrepresentable: 'any',
    }) as Record<string, unknown>,
  }))
}

function systemPrompt(now: Date): string {
  const date = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
  return [
    `You are the assistant inside BladeVault, the user's personal knife collection app. Today is ${date}.`,
    'Answer questions about the collection, price monitoring, maintenance and achievements with the tools.',
    'Rules:',
    '- Every fact about the collection comes from a tool result. Never invent knives, prices, dates or counts; if the tools return nothing, say so.',
    '- To find one knife, call search_knives, then get_knife with its id. Knife ids look like opaque strings; never guess one.',
    '- Discounts, sales or deals are price drops: list_price_changes with kinds ["drop"] and days for the period (a week = 7). For one brand pass brand (for example "Vosteed"); for one knife pass knife_id. Do not fetch every change and filter it yourself.',
    '- Missing data: find_missing_fields with field names such as steel, designer, country, blade_length, handle_material.',
    '- The app shows each tool result to the user as knife cards or tables right under your answer. Do not repeat long lists: summarize, give counts and point out what matters.',
    '- Use short Markdown answers. Reply in the language of the user.',
    '- You can only read data. If the user asks to change something, say that the chat cannot change data yet and where in the app to do it.',
  ].join('\n')
}

function jsonModePrompt(tools: readonly ReadTool[]): string {
  const catalog = tools
    .map((tool) => {
      const schema = z.toJSONSchema(tool.inputSchema, {
        io: 'input',
        unrepresentable: 'any',
      }) as { properties?: unknown }
      return `- ${tool.name}: ${tool.description} Arguments: ${JSON.stringify(schema.properties ?? {})}`
    })
    .join('\n')
  return [
    'You cannot call functions directly. Each reply is exactly one JSON object and nothing else:',
    '{"tool": "<tool name>", "args": {…}} to run a tool (its result comes back in the next message), or',
    '{"answer": "<your Markdown answer for the user>"} when you can answer.',
    'Tools:',
    catalog,
  ].join('\n')
}

/** Native tool messages of this turn, rewritten for JSON mode. */
function asJsonModeMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const call = message.toolCalls[0]
      let args: unknown = {}
      try {
        args = JSON.parse(call.arguments)
      } catch {
        // Keep {}.
      }
      return {
        role: 'assistant',
        content: JSON.stringify({ tool: call.name, args }),
      }
    }
    if (message.role === 'tool')
      return { role: 'user', content: `Tool result:\n${message.content}` }
    return message
  })
}

export const REASONING_IGNORED_NOTICE =
  'This endpoint does not take a reasoning level, so the model reasons as it does by default.'

/** Turns that already showed the reasoning notice. */
const noticed = new WeakSet<ChatTurnInput>()

/** Counts a finished call's tokens and reports an ignored reasoning level. */
function countUsage(
  input: ChatTurnInput,
  completion: {
    promptTokens?: number | null
    completionTokens?: number | null
    reasoningIgnored?: boolean
  },
) {
  if (completion.reasoningIgnored && !noticed.has(input)) {
    noticed.add(input)
    input.emit({ type: 'notice', message: REASONING_IGNORED_NOTICE })
  }
  if (!input.usage) return
  input.usage.promptTokens += completion.promptTokens ?? 0
  input.usage.completionTokens += completion.completionTokens ?? 0
}

function parseArguments(text: string): unknown {
  if (!text.trim()) return {}
  return JSON.parse(text)
}

function toolErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError)
    return `Invalid arguments: ${error.issues
      .slice(0, 4)
      .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
      .join('; ')}`
  return error instanceof Error ? error.message : String(error)
}

export const REPEAT_NOTICE =
  'The model kept repeating the same lookup, so it answered with what it had found.'

/** Same JSON for the same arguments, whatever the key order or spacing. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/**
 * Catches a model stuck in a loop without capping how many tools it calls:
 * a call identical to an earlier one in the same turn (same tool, same
 * arguments) is not run again; the model is told it already has the
 * result. A third identical call means it is stuck, and it must answer.
 */
class RepeatGuard {
  private readonly seen = new Map<string, number>()

  check(call: ChatToolCall): 'new' | 'repeat' | 'stuck' {
    let key: string
    try {
      key = `${call.name} ${stableJson(parseArguments(call.arguments))}`
    } catch {
      key = `${call.name} ${call.arguments.trim()}`
    }
    const count = this.seen.get(key) ?? 0
    this.seen.set(key, count + 1)
    return count === 0 ? 'new' : count === 1 ? 'repeat' : 'stuck'
  }
}

/** Reports a repeated call without running it; returns what the model reads. */
function skipRepeatedCall(
  call: ChatToolCall,
  emit: ChatTurnInput['emit'],
  stuck: boolean,
): string {
  let args: unknown = {}
  try {
    args = parseArguments(call.arguments)
  } catch {
    // Label it without arguments.
  }
  const label = describeToolCall(call.name, args)
  emit({ type: 'tool_start', callId: call.id, name: call.name, label })
  const content = stuck
    ? `Not run: you called ${call.name} with these arguments again. Stop calling tools and answer with the results you have.`
    : `Not run: you already called ${call.name} with these exact arguments in this answer, and its result is above. Use that result, or call a different tool or different arguments.`
  emit({
    type: 'tool_result',
    callId: call.id,
    name: call.name,
    content,
    step: {
      name: call.name,
      label,
      summary: 'Same call as before, skipped',
      ok: true,
      ui: null,
    },
  })
  return content
}

/** Runs one tool call and reports it; returns what the model reads. */
async function runToolCall(
  call: ChatToolCall,
  tools: readonly ReadTool[],
  emit: ChatTurnInput['emit'],
): Promise<string> {
  let args: unknown = {}
  let argsError: string | null = null
  try {
    args = parseArguments(call.arguments)
  } catch {
    argsError = 'The arguments were not valid JSON.'
  }
  emit({
    type: 'tool_start',
    callId: call.id,
    name: call.name,
    label: describeToolCall(call.name, args),
  })
  const tool = tools.find((entry) => entry.name === call.name)
  const fail = (message: string) => {
    const content = `Error: ${message}`
    emit({
      type: 'tool_result',
      callId: call.id,
      name: call.name,
      content,
      step: failedToolStep(call.name, args, message),
    })
    return content
  }
  if (!tool)
    return fail(
      `Unknown tool "${call.name}". Available: ${tools.map((entry) => entry.name).join(', ')}.`,
    )
  if (argsError) return fail(argsError)
  try {
    const result = await tool.run(args)
    const content = toModelContent(call.name, result)
    let step: ChatToolStep
    try {
      step = await buildToolStep(call.name, args, result)
    } catch {
      // The cards are a bonus; the model still has the result.
      step = {
        name: call.name,
        label: describeToolCall(call.name, args),
        summary: 'Done',
        ok: true,
        ui: null,
      }
    }
    emit({
      type: 'tool_result',
      callId: call.id,
      name: call.name,
      content,
      step,
    })
    return content
  } catch (error) {
    return fail(toolErrorMessage(error))
  }
}

export async function runChatTurn(
  input: ChatTurnInput,
): Promise<ChatTurnResult> {
  const tools = input.tools ?? CHAT_TOOLS
  const system: ChatMessage = {
    role: 'system',
    content: systemPrompt(input.now ?? new Date()),
  }
  // This turn's messages: the user's, then tool calls and results.
  const turn: ChatMessage[] = [{ role: 'user', content: input.userText }]
  const useJson =
    input.toolMode === 'json' ||
    (input.toolMode === 'auto' &&
      chatToolsRejected(input.endpoint, input.model, input.reasoning))
  if (!useJson) {
    try {
      return await nativeTurn(input, tools, system, input.history, turn)
    } catch (error) {
      if (
        !(error instanceof AiClientError) ||
        error.code !== 'tools_unsupported' ||
        input.toolMode !== 'auto'
      )
        throw error
      // The endpoint refused tools: same turn in JSON mode.
    }
  }
  return jsonTurn(input, tools, system, input.history, asJsonModeMessages(turn))
}

async function nativeTurn(
  input: ChatTurnInput,
  tools: readonly ReadTool[],
  system: ChatMessage,
  history: ChatMessage[],
  turn: ChatMessage[],
): Promise<ChatTurnResult> {
  const definitions = chatToolDefinitions(tools)
  const guard = new RepeatGuard()
  let steps = 0
  let stuck = false
  for (;;) {
    const messages: ChatMessage[] = [system, ...history, ...turn]
    if (stuck)
      messages.push({
        role: 'system',
        content:
          'You keep repeating the same tool call. Answer now with the results you have.',
      })
    const completion = await requestChatCompletion(
      input.endpoint,
      {
        model: input.model,
        messages,
        tools: stuck ? undefined : definitions,
        purpose: 'chat',
        reasoning: input.reasoning,
      },
      {
        timeoutMs: FIRST_BYTE_TIMEOUT_MS,
        signal: input.signal,
        fetchImpl: input.fetchImpl,
        onTextDelta: (delta) => input.emit({ type: 'text', delta }),
      },
    )
    countUsage(input, completion)
    if (!completion.toolCalls.length || stuck)
      return { text: completion.text, mode: 'native', steps }
    steps++
    input.emit({
      type: 'tool_calls',
      text: completion.text,
      toolCalls: completion.toolCalls,
    })
    turn.push({
      role: 'assistant',
      content: completion.text,
      toolCalls: completion.toolCalls,
    })
    for (const call of completion.toolCalls) {
      if (input.signal?.aborted)
        throw new AiClientError('cancelled', 'The AI request was cancelled.')
      const seen = guard.check(call)
      const content =
        seen === 'new'
          ? await runToolCall(call, tools, input.emit)
          : skipRepeatedCall(call, input.emit, seen === 'stuck')
      turn.push({ role: 'tool', toolCallId: call.id, content })
      if (seen === 'stuck' && !stuck) {
        stuck = true
        input.emit({ type: 'notice', message: REPEAT_NOTICE })
      }
    }
  }
}

type JsonAction =
  | { kind: 'tool'; name: string; args: unknown }
  | { kind: 'answer'; text: string }

function readJsonAction(text: string): JsonAction | null {
  let parsed: unknown
  try {
    parsed = parseJsonAnswer(text)
  } catch {
    return null
  }
  const record =
    parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {}
  if (typeof record.tool === 'string' && record.tool)
    return { kind: 'tool', name: record.tool, args: record.args ?? {} }
  if (typeof record.answer === 'string')
    return { kind: 'answer', text: record.answer }
  return null
}

async function jsonTurn(
  input: ChatTurnInput,
  tools: readonly ReadTool[],
  system: ChatMessage,
  history: ChatMessage[],
  turn: ChatMessage[],
): Promise<ChatTurnResult> {
  const instructions: ChatMessage = {
    role: 'system',
    content: `${system.content}\n\n${jsonModePrompt(tools)}`,
  }
  const guard = new RepeatGuard()
  let steps = 0
  let repaired = false
  let stuck = false
  for (;;) {
    const messages: ChatMessage[] = [instructions, ...history, ...turn]
    if (stuck)
      messages.push({
        role: 'user',
        content:
          'You keep repeating the same tool call. Reply now with {"answer": "…"} using the results you have.',
      })
    const completion = await requestChatCompletion(
      input.endpoint,
      {
        model: input.model,
        messages,
        purpose: 'chat',
        reasoning: input.reasoning,
      },
      {
        timeoutMs: FIRST_BYTE_TIMEOUT_MS,
        signal: input.signal,
        fetchImpl: input.fetchImpl,
      },
    )
    countUsage(input, completion)
    const action = readJsonAction(completion.text)
    if (!action) {
      // It looks like a broken action: ask once more for valid JSON.
      if (!repaired && !stuck && /"tool"\s*:/.test(completion.text)) {
        repaired = true
        turn.push(
          { role: 'assistant', content: completion.text },
          {
            role: 'user',
            content:
              'That was not one valid JSON object. Reply with exactly one JSON object.',
          },
        )
        continue
      }
      // A model that just answered in prose: show the prose.
      input.emit({ type: 'text', delta: completion.text })
      return { text: completion.text, mode: 'json', steps }
    }
    if (action.kind === 'answer' || stuck) {
      const text =
        action.kind === 'answer'
          ? action.text
          : 'I kept repeating the same lookup instead of answering. Ask again, maybe more narrowly.'
      input.emit({ type: 'text', delta: text })
      return { text, mode: 'json', steps }
    }
    steps++
    const call: ChatToolCall = {
      id: `json_${steps}`,
      name: action.name,
      arguments: JSON.stringify(action.args ?? {}),
    }
    input.emit({ type: 'tool_calls', text: '', toolCalls: [call] })
    const seen = guard.check(call)
    const content =
      seen === 'new'
        ? await runToolCall(call, tools, input.emit)
        : skipRepeatedCall(call, input.emit, seen === 'stuck')
    if (seen === 'stuck') {
      stuck = true
      input.emit({ type: 'notice', message: REPEAT_NOTICE })
    }
    turn.push(
      {
        role: 'assistant',
        content: JSON.stringify({ tool: action.name, args: action.args }),
      },
      { role: 'user', content: `Tool result:\n${content}` },
    )
    if (input.signal?.aborted)
      throw new AiClientError('cancelled', 'The AI request was cancelled.')
  }
}

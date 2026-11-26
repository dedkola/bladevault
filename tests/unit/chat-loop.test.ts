import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'
import {
  resetAiModelProfiles,
  type AiEndpoint,
} from '@/lib/price-monitor/ai-client'
import {
  chatToolDefinitions,
  CHAT_TOOLS,
  REASONING_IGNORED_NOTICE,
  REPEAT_NOTICE,
  runChatTurn,
  type ChatLoopEvent,
  type ChatTurnInput,
} from '@/lib/chat/loop'
import type { ReadTool } from '@/lib/tools/read-tools'
import { toModelContent, describeToolCall } from '@/lib/chat/tool-results'
import { sseResponse, textChunk, toolCallChunk } from '../helpers/chat-sse'

const endpoint: AiEndpoint = {
  baseUrl: 'http://localhost:1234/v1',
  apiKey: null,
}

function fakeTool(run = vi.fn(async (input: unknown) => ({ echo: input }))) {
  const tool: ReadTool = {
    name: 'echo_tool',
    title: 'Echo',
    description: 'Returns its input.',
    inputSchema: z.object({ word: z.string().min(1) }),
    run: async (input) =>
      run(z.object({ word: z.string().min(1) }).parse(input)),
  }
  return { tool, run }
}

function turn(
  fetchImpl: typeof fetch,
  tools: ReadTool[],
  toolMode: 'auto' | 'native' | 'json' = 'auto',
  reasoning: 'off' | 'low' | 'medium' | 'high' = 'off',
  extra: Partial<ChatTurnInput> = {},
) {
  const events: ChatLoopEvent[] = []
  const usage = { promptTokens: 0, completionTokens: 0 }
  const promise = runChatTurn({
    endpoint,
    model: 'm',
    toolMode,
    reasoning,
    history: [],
    userText: 'question',
    fetchImpl,
    tools,
    usage,
    emit: (event) => events.push(event),
    ...extra,
  })
  return { promise, events, usage }
}

const bodyOf = (fetchImpl: ReturnType<typeof vi.fn>, call: number) =>
  JSON.parse(String(fetchImpl.mock.calls[call][1]?.body))

afterEach(() => {
  resetAiModelProfiles()
})

describe('chat tools', () => {
  it('offers every read tool but proposals, with JSON schemas', () => {
    const names = CHAT_TOOLS.map((tool) => tool.name)
    expect(names).toContain('list_price_changes')
    expect(names).toContain('search_knives')
    expect(names).not.toContain('propose_changes')
    for (const definition of chatToolDefinitions())
      expect(definition.parameters).toMatchObject({ type: 'object' })
    const changes = chatToolDefinitions().find(
      (tool) => tool.name === 'list_price_changes',
    )!
    // Defaults are optional for the model.
    expect(changes.parameters.required ?? []).not.toContain('days')
  })

  it('labels tool calls for the page', () => {
    expect(
      describeToolCall('list_price_changes', { days: 7, kinds: ['drop'] }),
    ).toBe('Listed drop · last 7 days')
    expect(
      describeToolCall('list_price_changes', {
        days: 30,
        kinds: ['drop'],
        brand: 'Vosteed',
      }),
    ).toBe('Listed Vosteed drop · last 30 days')
    expect(describeToolCall('search_knives', { query: 'Spyderco' })).toBe(
      'Searched knives: “Spyderco”',
    )
  })

  it('sends whole results to the model', () => {
    const result = {
      knives: Array.from({ length: 400 }, (_, index) => ({ id: `k${index}` })),
    }
    const parsed = JSON.parse(toModelContent('search_knives', result))
    expect(parsed.knives).toHaveLength(400)
    expect(parsed._truncated).toBeUndefined()
  })

  it('drops URLs, source ids and minor units from price changes', () => {
    const event = {
      kind: 'drop',
      knifeId: 'raccoon',
      knife: 'Vosteed Raccoon',
      sourceId: 7,
      storeName: 'amazon.com',
      url: 'https://www.amazon.com/dp/X',
      price: { amount: 48.99, minor: 4899, currency: 'USD' },
      previousPrice: { amount: 69, minor: 6900, currency: 'USD' },
      deltaPct: -29,
      occurredAt: '2026-11-25T10:00:00.000Z',
    }
    const parsed = JSON.parse(
      toModelContent('list_price_changes', {
        days: 30,
        counts: { drop: 1 },
        events: [event],
        outOfStockNow: [],
      }),
    )
    expect(parsed.events).toEqual([
      {
        kind: 'drop',
        knifeId: 'raccoon',
        knife: 'Vosteed Raccoon',
        store: 'amazon.com',
        price: '48.99 USD',
        was: '69.00 USD',
        deltaPct: -29,
        at: '2026-11-25T10:00:00.000Z',
      },
    ])
  })
})

describe('runChatTurn (native tools)', () => {
  it('runs a tool call, sends its result back, then answers', async () => {
    const { tool, run } = fakeTool()
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sseResponse([toolCallChunk('c1', 'echo_tool', { word: 'hi' })]),
      )
      .mockResolvedValueOnce(sseResponse([textChunk('The word is hi.')]))
    const { promise, events } = turn(fetchImpl, [tool])
    const result = await promise
    expect(result).toMatchObject({
      text: 'The word is hi.',
      mode: 'native',
      steps: 1,
    })
    expect(run).toHaveBeenCalledWith({ word: 'hi' })
    expect(events.map((event) => event.type)).toEqual([
      'tool_calls',
      'tool_start',
      'tool_result',
      'text',
    ])
    const second = bodyOf(fetchImpl, 1)
    expect(second.messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'c1',
    })
    expect(JSON.parse(second.messages.at(-1).content)).toEqual({
      echo: { word: 'hi' },
    })
  })

  it('reports invalid arguments to the model instead of running the tool', async () => {
    const { tool, run } = fakeTool()
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sseResponse([toolCallChunk('c1', 'echo_tool', { word: '' })]),
      )
      .mockResolvedValueOnce(sseResponse([textChunk('Sorry.')]))
    const { promise, events } = turn(fetchImpl, [tool])
    await promise
    expect(run).not.toHaveBeenCalled()
    const result = events.find((event) => event.type === 'tool_result')
    expect(result).toMatchObject({
      content: expect.stringMatching(/^Error: Invalid arguments/),
      step: { ok: false },
    })
  })

  it('lets the model call tools as often as it needs', async () => {
    const { tool } = fakeTool()
    const fetchImpl = vi.fn<typeof fetch>()
    for (let index = 0; index < 10; index++)
      fetchImpl.mockResolvedValueOnce(
        sseResponse([
          toolCallChunk(`c${index}`, 'echo_tool', { word: `w${index}` }),
        ]),
      )
    fetchImpl.mockResolvedValueOnce(sseResponse([textChunk('Done.')]))
    const result = await turn(fetchImpl, [tool]).promise
    expect(result).toMatchObject({ text: 'Done.', steps: 10 })
  })

  it('does not run a repeated call again, but runs new arguments', async () => {
    const { tool, run } = fakeTool()
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sseResponse([toolCallChunk('c1', 'echo_tool', { word: 'a', n: 1 })]),
      )
      // Same arguments in another key order: a repeat.
      .mockResolvedValueOnce(
        sseResponse([toolCallChunk('c2', 'echo_tool', { n: 1, word: 'a' })]),
      )
      .mockResolvedValueOnce(
        sseResponse([toolCallChunk('c3', 'echo_tool', { word: 'b' })]),
      )
      .mockResolvedValueOnce(sseResponse([textChunk('Done.')]))
    const { promise, events } = turn(fetchImpl, [tool])
    const result = await promise
    expect(result).toMatchObject({ text: 'Done.', steps: 3 })
    expect(run).toHaveBeenCalledTimes(2)
    const results = events.filter((event) => event.type === 'tool_result')
    expect(results[1]).toMatchObject({
      content: expect.stringMatching(/^Not run: you already called echo_tool/),
      step: { summary: 'Same call as before, skipped', ok: true },
    })
    expect(events.some((event) => event.type === 'notice')).toBe(false)
    // Every request still offers tools.
    for (let call = 0; call < 4; call++)
      expect(bodyOf(fetchImpl, call).tools).toBeDefined()
  })

  it('makes a model stuck on one call answer without tools', async () => {
    const { tool, run } = fakeTool()
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        return body.tools
          ? sseResponse([toolCallChunk('c', 'echo_tool', { word: 'same' })])
          : sseResponse([textChunk('Final.')])
      })
    const { promise, events } = turn(fetchImpl, [tool])
    const result = await promise
    expect(result).toMatchObject({ text: 'Final.', steps: 3 })
    expect(run).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    const last = bodyOf(fetchImpl, 3)
    expect(last.tools).toBeUndefined()
    expect(last.messages.at(-1).content).toMatch(/repeating the same tool/)
    expect(events).toContainEqual({ type: 'notice', message: REPEAT_NOTICE })
  })

  it('sends the whole history', async () => {
    const history = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 ? ('assistant' as const) : ('user' as const),
      content: `${index} ${'h'.repeat(1000)}`,
    }))
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(sseResponse([textChunk('Ok.')]))
    await turn(fetchImpl, [], 'native', 'off', { history }).promise
    expect(bodyOf(fetchImpl, 0).messages).toHaveLength(42)
  })

  it('switches to JSON mode when the endpoint refuses tools', async () => {
    const { tool, run } = fakeTool()
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"error":{"message":"tools are not supported"}}', {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        sseResponse([textChunk('{"tool":"echo_tool","args":{"word":"yo"}}')]),
      )
      .mockResolvedValueOnce(sseResponse([textChunk('{"answer":"It is yo."}')]))
    const { promise, events } = turn(fetchImpl, [tool])
    const result = await promise
    expect(result).toMatchObject({ text: 'It is yo.', mode: 'json', steps: 1 })
    expect(run).toHaveBeenCalledWith({ word: 'yo' })
    expect(bodyOf(fetchImpl, 1).tools).toBeUndefined()
    expect(bodyOf(fetchImpl, 1).messages[0].content).toContain('echo_tool')
    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', delta: 'It is yo.' },
    ])
  })
})

describe('runChatTurn (reasoning)', () => {
  it('sends the level on every step and notes a refusal once', async () => {
    const { tool } = fakeTool()
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"error":{"message":"unknown field reasoning_effort"}}', {
          status: 422,
        }),
      )
      .mockResolvedValueOnce(
        sseResponse([toolCallChunk('c1', 'echo_tool', { word: 'hi' })]),
      )
      .mockResolvedValueOnce(sseResponse([textChunk('Done.')]))
    const { promise, events } = turn(fetchImpl, [tool], 'auto', 'high')
    await expect(promise).resolves.toMatchObject({ mode: 'native', steps: 1 })
    expect(bodyOf(fetchImpl, 0).reasoning_effort).toBe('high')
    expect(bodyOf(fetchImpl, 1).reasoning_effort).toBeUndefined()
    expect(bodyOf(fetchImpl, 2).reasoning_effort).toBeUndefined()
    const notices = events.filter((event) => event.type === 'notice')
    expect(notices).toEqual([
      { type: 'notice', message: REASONING_IGNORED_NOTICE },
    ])
  })
})

describe('runChatTurn (JSON mode)', () => {
  it('shows a plain prose answer as is', async () => {
    const { tool } = fakeTool()
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sseResponse([textChunk('Just prose.')]))
    const result = await turn(fetchImpl, [tool], 'json').promise
    expect(result.text).toBe('Just prose.')
  })

  it('asks once more for a broken action', async () => {
    const { tool, run } = fakeTool()
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sseResponse([textChunk('{"tool": "echo_tool", args')]),
      )
      .mockResolvedValueOnce(
        sseResponse([textChunk('{"tool":"echo_tool","args":{"word":"ok"}}')]),
      )
      .mockResolvedValueOnce(sseResponse([textChunk('{"answer":"Done."}')]))
    const result = await turn(fetchImpl, [tool], 'json').promise
    expect(run).toHaveBeenCalledTimes(1)
    expect(result.text).toBe('Done.')
  })

  it('makes a model stuck on one call answer', async () => {
    const { tool, run } = fakeTool()
    const repeat = '{"tool":"echo_tool","args":{"word":"same"}}'
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sseResponse([textChunk(repeat)]))
      .mockResolvedValueOnce(sseResponse([textChunk(repeat)]))
      .mockResolvedValueOnce(sseResponse([textChunk(repeat)]))
      .mockResolvedValueOnce(sseResponse([textChunk('{"answer":"Final."}')]))
    const { promise, events } = turn(fetchImpl, [tool], 'json')
    const result = await promise
    expect(result.text).toBe('Final.')
    expect(run).toHaveBeenCalledTimes(1)
    expect(bodyOf(fetchImpl, 3).messages.at(-1).content).toMatch(
      /repeating the same tool/,
    )
    expect(events).toContainEqual({ type: 'notice', message: REPEAT_NOTICE })
  })

  it('stops a model that still repeats after being told to answer', async () => {
    const { tool } = fakeTool()
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        sseResponse([textChunk('{"tool":"echo_tool","args":{"word":"same"}}')]),
      )
    const result = await turn(fetchImpl, [tool], 'json').promise
    expect(result.text).toMatch(/kept repeating the same lookup/)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })
})

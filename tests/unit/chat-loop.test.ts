import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'
import {
  resetAiModelProfiles,
  type AiEndpoint,
} from '@/lib/price-monitor/ai-client'
import {
  chatToolDefinitions,
  CHAT_TOOLS,
  MAX_TOOL_STEPS,
  runChatTurn,
  type ChatLoopEvent,
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
) {
  const events: ChatLoopEvent[] = []
  const usage = { promptTokens: 0, completionTokens: 0 }
  const promise = runChatTurn({
    endpoint,
    model: 'm',
    toolMode,
    allowThinking: false,
    history: [],
    userText: 'question',
    fetchImpl,
    tools,
    usage,
    emit: (event) => events.push(event),
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
    expect(describeToolCall('search_knives', { query: 'Spyderco' })).toBe(
      'Searched knives: “Spyderco”',
    )
  })

  it('cuts long results for the model and says so', () => {
    const result = {
      total: 400,
      knives: Array.from({ length: 400 }, (_, index) => ({
        id: `k${index}`,
        name: `Knife number ${index}`,
      })),
    }
    const text = toModelContent('search_knives', result, 2000)
    expect(text.length).toBeLessThanOrEqual(2000)
    const parsed = JSON.parse(text)
    expect(parsed.knives.length).toBeLessThan(400)
    expect(parsed._truncated).toMatch(/knives: showing \d+ of 400/)
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

  it('makes the model answer without tools after the step cap', async () => {
    const { tool } = fakeTool()
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        return body.tools
          ? sseResponse([toolCallChunk('c', 'echo_tool', { word: 'again' })])
          : sseResponse([textChunk('Final.')])
      })
    const { promise } = turn(fetchImpl, [tool])
    const result = await promise
    expect(result.steps).toBe(MAX_TOOL_STEPS)
    expect(result.text).toBe('Final.')
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_TOOL_STEPS + 1)
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
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AiClientError,
  chatToolsRejected,
  readChatStream,
  requestChatCompletion,
  resetAiModelProfiles,
  visibleAnswer,
  type AiEndpoint,
} from '@/lib/price-monitor/ai-client'
import { sseResponse, textChunk } from '../helpers/chat-sse'

const endpoint: AiEndpoint = {
  baseUrl: 'http://localhost:11434/v1',
  apiKey: 'sk-test',
}

const delta = textChunk

afterEach(() => {
  resetAiModelProfiles()
})

describe('readChatStream', () => {
  it('joins text deltas, tool call pieces and usage', async () => {
    const shown: string[] = []
    let usage: Array<number | null> = []
    const response = sseResponse([
      delta('Let me '),
      delta('look.'),
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  function: { name: 'search_', arguments: '{"que' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { name: 'knives', arguments: 'ry":"Spyderco"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } },
    ])
    const result = await readChatStream(response.body!, {
      onTextDelta: (text) => shown.push(text),
      onUsage: (prompt, completion) => {
        usage = [prompt, completion]
      },
    })
    expect(shown.join('')).toBe('Let me look.')
    expect(result.text).toBe('Let me look.')
    expect(result.finishReason).toBe('tool_calls')
    expect(result.toolCalls).toEqual([
      {
        id: 'call_1',
        name: 'search_knives',
        arguments: '{"query":"Spyderco"}',
      },
    ])
    expect(usage).toEqual([120, 30])
  })

  it('never shows inline thinking, even split across chunks', async () => {
    const shown: string[] = []
    const result = await readChatStream(
      sseResponse([
        delta('<thi'),
        delta('nk>secret plan</th'),
        delta('ink>Answer'),
        delta(' here'),
      ]).body!,
      { onTextDelta: (text) => shown.push(text) },
    )
    expect(shown.join('')).toBe('Answer here')
    expect(result.text).toBe('Answer here')
  })

  it('holds back a tag cut in half', () => {
    expect(visibleAnswer('Hello <th')).toBe('Hello ')
    expect(visibleAnswer('a < b')).toBe('a < b')
  })
})

describe('requestChatCompletion', () => {
  it('streams with tools and reports text as it arrives', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(sseResponse([delta('Hi'), delta(' there')]))
    const deltas: string[] = []
    const result = await requestChatCompletion(
      endpoint,
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [
          {
            name: 't',
            description: 'd',
            parameters: { type: 'object', properties: {} },
          },
        ],
        purpose: 'chat',
      },
      { timeoutMs: 1000, fetchImpl, onTextDelta: (d) => deltas.push(d) },
    )
    expect(result.text).toBe('Hi there')
    expect(deltas.join('')).toBe('Hi there')
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    expect(body).toMatchObject({
      model: 'm',
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: 'auto',
      tools: [{ type: 'function', function: { name: 't' } }],
    })
    expect(fetchImpl.mock.calls[0][1]?.redirect).toBe('error')
  })

  it('sends assistant tool calls and tool results in OpenAI shape', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(sseResponse([delta('ok')]))
    await requestChatCompletion(
      endpoint,
      {
        model: 'm',
        messages: [
          { role: 'user', content: 'q' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'get_knife', arguments: '{}' }],
          },
          { role: 'tool', toolCallId: 'c1', content: '{"x":1}' },
        ],
        purpose: 'chat',
      },
      { timeoutMs: 1000, fetchImpl },
    )
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'get_knife', arguments: '{}' },
        },
      ],
    })
    expect(body.messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: '{"x":1}',
    })
  })

  it('falls back to a plain request when streaming is refused', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"error":{"message":"stream is not supported"}}', {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'x',
                      function: { name: 'get_knife', arguments: '{"a":1}' },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }),
          { status: 200 },
        ),
      )
    const result = await requestChatCompletion(
      endpoint,
      {
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
        purpose: 'chat',
      },
      { timeoutMs: 1000, fetchImpl },
    )
    expect(result.toolCalls).toEqual([
      { id: 'x', name: 'get_knife', arguments: '{"a":1}' },
    ])
    expect(result.promptTokens).toBe(10)
    const second = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))
    expect(second.stream).toBeUndefined()
  })

  it('throws tools_unsupported and remembers it when tools are refused', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          '{"error":{"message":"This model does not support tools"}}',
          { status: 400 },
        ),
      )
    const request = {
      model: 'tiny',
      messages: [{ role: 'user' as const, content: 'q' }],
      tools: [
        {
          name: 't',
          description: 'd',
          parameters: { type: 'object' },
        },
      ],
      purpose: 'chat' as const,
    }
    await expect(
      requestChatCompletion(endpoint, request, { timeoutMs: 1000, fetchImpl }),
    ).rejects.toMatchObject({ code: 'tools_unsupported' })
    expect(chatToolsRejected(endpoint, 'tiny')).toBe(true)
    // Known now: no request is sent with tools again.
    await expect(
      requestChatCompletion(endpoint, request, { timeoutMs: 1000, fetchImpl }),
    ).rejects.toBeInstanceOf(AiClientError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('stops with cancelled when the caller aborts', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    )
    const pending = requestChatCompletion(
      endpoint,
      {
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
        purpose: 'chat',
      },
      { timeoutMs: 5000, fetchImpl, signal: controller.signal },
    )
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  })
})

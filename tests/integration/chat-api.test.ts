import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'
import { createKnife } from '@/tests/fixtures/knife'
import { sseResponse, textChunk, toolCallChunk } from '@/tests/helpers/chat-sse'
import { LocalStorage } from '@/lib/storage/local'
import { closeLocalDb, getLocalDb } from '@/lib/local-db'
import { getSettings, saveSettings } from '@/lib/settings'
import {
  appendMessage,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  updateConversation,
} from '@/lib/chat/store'
import { resetAiModelProfiles } from '@/lib/price-monitor/ai-client'
import type { ChatStreamEvent } from '@/lib/chat/shared'
import * as chatRoute from '@/app/api/chat/route'
import * as conversationRoute from '@/app/api/chat/conversations/[id]/route'
import * as listRoute from '@/app/api/chat/conversations/route'

let vault: TempVault
beforeEach(async () => {
  vault = await createTempVault()
})
afterEach(async () => {
  vi.unstubAllGlobals()
  resetAiModelProfiles()
  await vault.cleanup()
})

function configureAi() {
  const priceMonitoring = getSettings().priceMonitoring
  saveSettings({
    priceMonitoring: {
      ...priceMonitoring,
      ai: {
        ...priceMonitoring.ai,
        baseUrl: 'http://localhost:11434/v1',
        model: 'local-model',
      },
    },
  })
}

async function readEvents(response: Response): Promise<ChatStreamEvent[]> {
  const text = await response.text()
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ChatStreamEvent)
}

describe('chat storage', () => {
  it('creates, lists, searches, archives and deletes chats', () => {
    const first = createConversation('Which knives are missing a steel?')
    appendMessage(first.id, { role: 'user', content: 'Steel please' })
    appendMessage(first.id, {
      role: 'assistant',
      content: 'Two knives have no 100% steel.',
    })
    const second = createConversation('Drops this week')
    expect(listConversations().map((chat) => chat.id)).toEqual([
      second.id,
      first.id,
    ])
    // Searches titles and message text; % is literal.
    expect(listConversations({ query: 'drops' }).map((c) => c.id)).toEqual([
      second.id,
    ])
    expect(listConversations({ query: '100%' }).map((c) => c.id)).toEqual([
      first.id,
    ])
    expect(listConversations({ query: '50%' })).toEqual([])

    updateConversation(first.id, { title: '  Steel  check ', archived: true })
    expect(listConversations().map((c) => c.id)).toEqual([second.id])
    expect(listConversations({ archived: true })).toMatchObject([
      { id: first.id, title: 'Steel check' },
    ])
    updateConversation(first.id, { archived: false })
    expect(listConversations({ archived: true })).toEqual([])

    deleteConversation(first.id)
    expect(() => getConversation(first.id)).toThrow('no longer exists')
    expect(
      getLocalDb()
        .prepare(
          'SELECT COUNT(*) AS n FROM chat_messages WHERE conversation_id = ?',
        )
        .get(first.id),
    ).toEqual({ n: 0 })
  })

  it('keeps chats when the database opens again', () => {
    const chat = createConversation('hello')
    closeLocalDb()
    expect(getConversation(chat.id).title).toBe('hello')
  })
})

describe('chat routes', () => {
  it('refuses to start without an AI connection', async () => {
    const response = await chatRoute.POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        body: JSON.stringify({ message: 'hi' }),
      }),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('AI connection'),
    })
  })

  it('streams a turn with a vault tool and saves every message', async () => {
    configureAi()
    await new LocalStorage().migrateKnife(
      createKnife({ id: 'para3', name: 'Para 3', brand: 'Spyderco' }),
      [],
    )
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sseResponse([
          toolCallChunk('c1', 'search_knives', { query: 'Spyderco' }),
        ]),
      )
      .mockResolvedValueOnce(
        sseResponse([textChunk('You have **one** Spyderco.')]),
      )
    vi.stubGlobal('fetch', fetchMock)

    const response = await chatRoute.POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        body: JSON.stringify({ message: 'Show my Spydercos' }),
      }),
    )
    expect(response.headers.get('content-type')).toContain('ndjson')
    const events = await readEvents(response)
    expect(events.map((event) => event.type)).toEqual([
      'conversation',
      'user',
      'tool_start',
      'tool_result',
      'text',
      'message',
      'done',
      'usage',
    ])
    const toolResult = events.find((event) => event.type === 'tool_result')
    expect(toolResult).toMatchObject({
      step: {
        name: 'search_knives',
        ok: true,
        summary: '1 result',
        ui: {
          kind: 'knives',
          knives: [{ id: 'para3', name: 'Para 3', brand: 'Spyderco' }],
        },
      },
    })
    // The model got the vault result.
    const second = JSON.parse(String(fetchMock.mock.calls[1][1]?.body))
    expect(second.messages.at(-1).content).toContain('Para 3')

    const conversation = events[0]
    if (conversation.type !== 'conversation') throw new Error('no chat')
    const saved = getConversation(conversation.conversation.id)
    expect(saved.title).toBe('Show my Spydercos')
    expect(saved.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
    expect(saved.messages[1].toolCalls).toMatchObject([
      { id: 'c1', name: 'search_knives' },
    ])
    expect(saved.messages[2].step?.ui?.kind).toBe('knives')
    expect(saved.messages[3].content).toBe('You have **one** Spyderco.')

    // A follow-up sends the earlier text but not the earlier tool results.
    fetchMock.mockResolvedValueOnce(sseResponse([textChunk('Sure.')]))
    await readEvents(
      await chatRoute.POST(
        new Request('http://localhost/api/chat', {
          method: 'POST',
          body: JSON.stringify({
            conversationId: saved.id,
            message: 'Thanks',
          }),
        }),
      ),
    )
    const third = JSON.parse(String(fetchMock.mock.calls[2][1]?.body))
    expect(
      third.messages.map((message: { role: string }) => message.role),
    ).toEqual(['system', 'user', 'assistant', 'user'])
  })

  it('saves the failure when the model is unreachable', async () => {
    configureAi()
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response('{"error":{"message":"bad key"}}', { status: 401 }),
        ),
    )
    const events = await readEvents(
      await chatRoute.POST(
        new Request('http://localhost/api/chat', {
          method: 'POST',
          body: JSON.stringify({ message: 'hi' }),
        }),
      ),
    )
    const error = events.find((event) => event.type === 'error')
    expect(error).toMatchObject({ message: expect.stringContaining('401') })
    const conversation = events[0]
    if (conversation.type !== 'conversation') throw new Error('no chat')
    expect(
      getConversation(conversation.conversation.id).messages.at(-1),
    ).toMatchObject({
      role: 'assistant',
      status: 'error',
    })
  })

  it('lists, renames and deletes chats over HTTP', async () => {
    const chat = createConversation('Old title')
    const context = { params: Promise.resolve({ id: chat.id }) }
    const renamed = await conversationRoute.PATCH(
      new Request(`http://localhost/api/chat/conversations/${chat.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: 'New title' }),
      }),
      context,
    )
    expect(renamed.status).toBe(200)
    const list = listRoute.GET(
      new Request('http://localhost/api/chat/conversations?q=new'),
    )
    expect(await list.json()).toMatchObject({
      conversations: [{ id: chat.id, title: 'New title' }],
    })
    const removed = await conversationRoute.DELETE(
      new Request(`http://localhost/api/chat/conversations/${chat.id}`, {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: chat.id }) },
    )
    expect(removed.status).toBe(200)
    const missing = await conversationRoute.GET(
      new Request(`http://localhost/api/chat/conversations/${chat.id}`),
      { params: Promise.resolve({ id: chat.id }) },
    )
    expect(missing.status).toBe(404)
  })
})

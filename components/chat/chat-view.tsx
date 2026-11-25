'use client'

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  ArrowUp,
  Check,
  ChevronRight,
  Loader2,
  MessageSquare,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  Square,
  Trash2,
  Wrench,
  X,
} from 'lucide-react'
import { NoteMarkdown } from '@/components/note-markdown'
import { money, relativeTime } from '@/components/price-drops/price-format'
import { ChangePill, KnifeThumb } from '@/components/price-drops/price-ui'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'
import {
  CHAT_MESSAGE_MAX_LENGTH,
  type ChatConversationDetail,
  type ChatConversationSummary,
  type ChatKnifeCard,
  type ChatMoney,
  type ChatPriceChangeRow,
  type ChatStatus,
  type ChatStoredMessage,
  type ChatStreamEvent,
  type ChatToolStep,
} from '@/lib/chat/shared'
import type { ChangeEvent } from '@/lib/price-monitor/insights'
import { cn } from '@/lib/utils'
import '@/components/price-drops/price-drops.css'
import './chat.css'

const SUGGESTIONS = [
  'Show me all price drops from the last week',
  'What needs attention in price monitoring?',
  'Which knives are missing a steel?',
  'Give me a short summary of my collection',
]

function fetchConversation(id: string) {
  return callJson<ChatConversationDetail>(
    `/api/chat/conversations/${encodeURIComponent(id)}`,
    { method: 'GET' },
    'Could not load the chat.',
  )
}

async function callJson<T>(
  url: string,
  init: RequestInit,
  fallback: string,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: 'no-store',
    headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
  })
  const data = await readJsonResponse<T & { error?: string }>(response)
  if (!response.ok) throw new Error(getApiErrorMessage(data, fallback))
  return data
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

// ------------------------------------------------------------ turn model

/** One piece of an assistant answer: text, or a tool step with its cards. */
type AnswerItem =
  | {
      kind: 'text'
      key: string
      text: string
      status: ChatStoredMessage['status']
    }
  | {
      kind: 'tool'
      key: string
      label: string
      step: ChatToolStep | null
    }

type Turn = {
  key: string
  user: string | null
  items: AnswerItem[]
}

/** Stored messages grouped into turns: a user message and its answer. */
function toTurns(messages: ChatStoredMessage[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | null = null
  for (const message of messages) {
    if (message.role === 'user' || !current) {
      current = {
        key: `m${message.id}`,
        user: message.role === 'user' ? message.content : null,
        items: [],
      }
      turns.push(current)
      if (message.role === 'user') continue
    }
    if (message.role === 'tool') {
      current.items.push({
        kind: 'tool',
        key: `m${message.id}`,
        label: message.step?.label ?? message.toolName ?? 'Tool',
        step: message.step,
      })
    } else if (message.content.trim() || message.status !== 'done') {
      current.items.push({
        kind: 'text',
        key: `m${message.id}`,
        text: message.content,
        status: message.status,
      })
    }
  }
  return turns
}

// ------------------------------------------------------------- the view

export function ChatView({
  initialConversation,
}: {
  initialConversation?: string
}) {
  const [status, setStatus] = useState<ChatStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [archived, setArchived] = useState(false)
  const [query, setQuery] = useState('')
  const [conversations, setConversations] = useState<ChatConversationSummary[]>(
    [],
  )
  const [listError, setListError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(
    initialConversation ?? null,
  )
  const [active, setActive] = useState<ChatConversationDetail | null>(null)
  const [loadingChat, setLoadingChat] = useState(Boolean(initialConversation))
  const [live, setLive] = useState<Turn | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [panelOpen, setPanelOpen] = useState(false)
  const [pendingDelete, setPendingDelete] =
    useState<ChatConversationSummary | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const stickRef = useRef(true)

  const loadStatus = useCallback(() => {
    callJson<ChatStatus>(
      '/api/chat/status',
      { method: 'GET' },
      'Could not read the chat status.',
    )
      .then((data) => {
        setStatus(data)
        setStatusError(null)
      })
      .catch((reason: unknown) => setStatusError(errorText(reason)))
  }, [])

  const loadList = useCallback(() => {
    const params = new URLSearchParams()
    if (archived) params.set('archived', '1')
    if (query.trim()) params.set('q', query.trim())
    callJson<{ conversations: ChatConversationSummary[] }>(
      `/api/chat/conversations?${params}`,
      { method: 'GET' },
      'Could not load the chats.',
    )
      .then((data) => {
        setConversations(data.conversations)
        setListError(null)
      })
      .catch((reason: unknown) => setListError(errorText(reason)))
  }, [archived, query])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  useEffect(() => {
    const timer = setTimeout(loadList, query ? 250 : 0)
    return () => clearTimeout(timer)
  }, [loadList, query])

  const applyConversation = useCallback(
    (result: ChatConversationDetail | Error) => {
      if (result instanceof Error) {
        setActive(null)
        setActiveId(null)
        setError(result.message)
      } else {
        setActive(result)
        setError(null)
      }
      setLoadingChat(false)
    },
    [],
  )

  // Callers set loadingChat first when the user should see a spinner.
  const loadConversation = useCallback(
    (id: string) =>
      fetchConversation(id).then(applyConversation, (reason: unknown) =>
        applyConversation(new Error(errorText(reason))),
      ),
    [applyConversation],
  )

  // Keep the open chat in the address bar (?c=) without a navigation.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (activeId) url.searchParams.set('c', activeId)
    else url.searchParams.delete('c')
    window.history.replaceState(window.history.state, '', url)
  }, [activeId])

  useEffect(() => {
    if (initialConversation) void loadConversation(initialConversation)
  }, [initialConversation, loadConversation])

  const turns = active ? toTurns(active.messages) : []
  const shownTurns = live ? [...turns, live] : turns

  // Follow the answer while it streams, unless the user scrolled up.
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element && stickRef.current) element.scrollTop = element.scrollHeight
  })

  const openChat = (id: string) => {
    if (sending) return
    setPanelOpen(false)
    setActiveId(id)
    setLive(null)
    setLoadingChat(true)
    stickRef.current = true
    void loadConversation(id)
  }

  const newChat = () => {
    if (sending) return
    setPanelOpen(false)
    setActiveId(null)
    setActive(null)
    setLive(null)
    setError(null)
    inputRef.current?.focus()
  }

  const send = async (text: string) => {
    const message = text.trim()
    if (!message || sending) return
    setSending(true)
    setError(null)
    setDraft('')
    stickRef.current = true
    const controller = new AbortController()
    abortRef.current = controller
    let conversationId = activeId
    let turn: Turn = { key: 'live', user: message, items: [] }
    const update = (next: Turn) => {
      turn = next
      setLive(next)
    }
    update(turn)
    let failed = false
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          ...(conversationId ? { conversationId } : {}),
        }),
        signal: controller.signal,
      })
      if (!response.ok || !response.body) {
        const data = await readJsonResponse<{ error?: string }>(response)
        throw new Error(getApiErrorMessage(data, 'The chat failed.'))
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const handle = (event: ChatStreamEvent) => {
        switch (event.type) {
          case 'conversation':
            if (!conversationId) {
              conversationId = event.conversation.id
              setActiveId(event.conversation.id)
              setActive({ ...event.conversation, messages: [] })
              // Show the new chat in the list while the answer streams.
              if (!archived) loadList()
            }
            break
          case 'text': {
            const items = [...turn.items]
            const last = items.at(-1)
            if (last?.kind === 'text')
              items[items.length - 1] = {
                ...last,
                text: last.text + event.delta,
              }
            else
              items.push({
                kind: 'text',
                key: `t${items.length}`,
                text: event.delta,
                status: 'done',
              })
            update({ ...turn, items })
            break
          }
          case 'tool_start':
            update({
              ...turn,
              items: [
                ...turn.items,
                {
                  kind: 'tool',
                  key: event.callId,
                  label: event.label,
                  step: null,
                },
              ],
            })
            break
          case 'tool_result':
            update({
              ...turn,
              items: turn.items.map((item) =>
                item.kind === 'tool' && item.key === event.callId
                  ? { ...item, label: event.step.label, step: event.step }
                  : item,
              ),
            })
            break
          case 'error':
            failed = true
            setError(event.message)
            break
          default:
            break
        }
      }
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line) {
            try {
              handle(JSON.parse(line) as ChatStreamEvent)
            } catch {
              // Skip a malformed line.
            }
          }
          newline = buffer.indexOf('\n')
        }
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        failed = true
        setError(errorText(reason))
      }
    } finally {
      abortRef.current = null
      // The saved messages replace the live view (Stop saves the partial answer).
      if (conversationId) {
        // Give the server a moment to save a stopped answer.
        if (controller.signal.aborted)
          await new Promise((resolve) => setTimeout(resolve, 300))
        await loadConversation(conversationId)
      } else if (!failed) setActive(null)
      setLive(null)
      setSending(false)
      loadList()
      loadStatus()
      inputRef.current?.focus()
    }
  }

  const stop = () => abortRef.current?.abort()

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault()
      void send(draft)
    }
  }

  const rename = async (id: string, title: string) => {
    try {
      await callJson(
        `/api/chat/conversations/${encodeURIComponent(id)}`,
        { method: 'PATCH', body: JSON.stringify({ title }) },
        'Could not rename the chat.',
      )
      if (active?.id === id) setActive({ ...active, title })
      loadList()
    } catch (reason) {
      setListError(errorText(reason))
    }
  }

  const setArchivedFor = async (id: string, value: boolean) => {
    try {
      await callJson(
        `/api/chat/conversations/${encodeURIComponent(id)}`,
        { method: 'PATCH', body: JSON.stringify({ archived: value }) },
        value ? 'Could not archive the chat.' : 'Could not restore the chat.',
      )
      if (active?.id === id)
        setActive({
          ...active,
          archivedAt: value ? new Date().toISOString() : null,
        })
      loadList()
    } catch (reason) {
      setListError(errorText(reason))
    }
  }

  const remove = async (conversation: ChatConversationSummary) => {
    setPendingDelete(null)
    try {
      await callJson(
        `/api/chat/conversations/${encodeURIComponent(conversation.id)}`,
        { method: 'DELETE' },
        'Could not delete the chat.',
      )
      if (activeId === conversation.id) newChat()
      loadList()
    } catch (reason) {
      setListError(errorText(reason))
    }
  }

  const configured = status?.configured ?? true
  const blocked = !configured || Boolean(status?.readOnly)

  return (
    <div data-chat-page className="chat-layout">
      <aside
        data-open={panelOpen ? 'true' : 'false'}
        className="chat-panel"
        aria-label="Chats"
      >
        <div className="flex items-center gap-2">
          <Button
            type="button"
            className="flex-1 justify-start"
            variant="outline"
            onClick={newChat}
            disabled={sending}
          >
            <Plus aria-hidden="true" />
            New chat
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="chat-panel-close"
            aria-label="Close the chat list"
            onClick={() => setPanelOpen(false)}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        <label className="relative block">
          <span className="sr-only">Search chats</span>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={query}
            placeholder="Search chats"
            className="h-8 pl-8 text-sm"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="chat-tabs" role="tablist" aria-label="Chat list">
          <button
            type="button"
            role="tab"
            aria-selected={!archived}
            onClick={() => setArchived(false)}
          >
            Active
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={archived}
            onClick={() => setArchived(true)}
          >
            Archived
          </button>
        </div>
        {listError ? (
          <p role="alert" className="text-xs text-destructive">
            {listError}
          </p>
        ) : null}
        <ul className="chat-list">
          {conversations.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              active={conversation.id === activeId}
              disabled={sending}
              onOpen={() => openChat(conversation.id)}
              onRename={(title) => void rename(conversation.id, title)}
              onArchive={(value) => void setArchivedFor(conversation.id, value)}
              onDelete={() => setPendingDelete(conversation)}
            />
          ))}
          {!conversations.length && !listError ? (
            <li className="px-2 py-6 text-center text-xs text-muted-foreground">
              {query.trim()
                ? 'No chats match.'
                : archived
                  ? 'No archived chats.'
                  : 'No chats yet.'}
            </li>
          ) : null}
        </ul>
      </aside>
      {panelOpen ? (
        <button
          type="button"
          className="chat-scrim"
          aria-label="Close the chat list"
          onClick={() => setPanelOpen(false)}
        />
      ) : null}

      <section className="chat-main" aria-label="Conversation">
        <header className="chat-header">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="chat-panel-toggle"
            aria-label="Show chats"
            onClick={() => setPanelOpen(true)}
          >
            <PanelLeft aria-hidden="true" />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold text-[var(--bladevault-title)]">
              {active?.title ?? 'Chat'}
            </h1>
            <p className="truncate text-xs text-muted-foreground">
              {status?.model ? `${status.model} · ` : ''}
              reads your vault; changes nothing
              {active?.archivedAt ? ' · archived' : ''}
            </p>
          </div>
          {status ? <UsageBadge status={status} /> : null}
        </header>

        <div
          ref={scrollRef}
          className="chat-scroll"
          onScroll={(event) => {
            const element = event.currentTarget
            stickRef.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              80
          }}
        >
          {!configured ? (
            <SetupCard />
          ) : loadingChat && !live ? (
            <div className="grid flex-1 place-items-center text-muted-foreground">
              <Loader2
                className="size-5 animate-spin"
                aria-label="Loading the chat"
              />
            </div>
          ) : shownTurns.length === 0 ? (
            <EmptyChat
              disabled={blocked || sending}
              onPick={(text) => void send(text)}
            />
          ) : (
            <ol className="chat-turns">
              {shownTurns.map((turn) => (
                <TurnView
                  key={turn.key}
                  turn={turn}
                  streaming={live === turn && sending}
                />
              ))}
            </ol>
          )}
        </div>

        <form
          className="chat-composer"
          onSubmit={(event) => {
            event.preventDefault()
            void send(draft)
          }}
        >
          {error ? (
            <p role="alert" className="chat-error">
              <AlertCircle aria-hidden="true" className="size-4 shrink-0" />
              {error}
            </p>
          ) : null}
          {statusError ? (
            <p role="alert" className="chat-error">
              {statusError}
            </p>
          ) : null}
          {status?.readOnly ? (
            <p className="text-xs text-muted-foreground">
              The vault is read-only while a restore runs; chat is paused.
            </p>
          ) : null}
          <div className="chat-input">
            <Textarea
              ref={inputRef}
              value={draft}
              rows={1}
              maxLength={CHAT_MESSAGE_MAX_LENGTH}
              placeholder={
                configured
                  ? 'Ask about your knives, prices or maintenance…'
                  : 'Set up an AI connection to start chatting'
              }
              aria-label="Message"
              disabled={blocked}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
            />
            {sending ? (
              <Button
                type="button"
                size="icon"
                variant="secondary"
                aria-label="Stop the answer"
                onClick={stop}
              >
                <Square aria-hidden="true" className="fill-current" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                aria-label="Send"
                disabled={blocked || !draft.trim()}
              >
                <ArrowUp aria-hidden="true" />
              </Button>
            )}
          </div>
          <p className="chat-notice">
            Knife records the chat looks up are sent to your AI provider. Enter
            sends, Shift+Enter adds a line.
          </p>
        </form>
      </section>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this chat?</DialogTitle>
            <DialogDescription>
              “{pendingDelete?.title}” and all its messages are deleted for
              good. Archive it instead to keep it out of the list.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPendingDelete(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => pendingDelete && void remove(pendingDelete)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// --------------------------------------------------------------- pieces

function UsageBadge({ status }: { status: ChatStatus }) {
  const { calls, tokens } = status.usageToday
  const tokenText = new Intl.NumberFormat(undefined, {
    notation: 'compact',
  }).format(tokens)
  const limit = status.limit
  const capText = limit?.calls ? ` of ${limit.calls}` : ''
  return (
    <span
      className="hidden shrink-0 text-xs text-muted-foreground tabular-nums sm:inline"
      title="Chat requests and tokens today; chat has its own daily limit."
    >
      Today {calls}
      {capText} {calls === 1 && !capText ? 'request' : 'requests'} · {tokenText}{' '}
      tokens
    </span>
  )
}

function SetupCard() {
  return (
    <div className="chat-empty">
      <MessageSquare
        aria-hidden="true"
        className="size-8 text-muted-foreground"
      />
      <h2 className="text-base font-semibold text-[var(--bladevault-title)]">
        Connect an AI model to chat
      </h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        Chat uses the AI connection from Settings: any OpenAI-compatible
        endpoint, such as OpenCode Go, OpenAI or a local Ollama.
      </p>
      <Button render={<Link href="/settings?tab=mcp" />} nativeButton={false}>
        Set up AI
      </Button>
    </div>
  )
}

function EmptyChat({
  disabled,
  onPick,
}: {
  disabled: boolean
  onPick: (text: string) => void
}) {
  return (
    <div className="chat-empty">
      <MessageSquare
        aria-hidden="true"
        className="size-8 text-muted-foreground"
      />
      <h2 className="text-base font-semibold text-[var(--bladevault-title)]">
        Ask about your vault
      </h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        Knives, collection stats, price watches, drops and maintenance. Answers
        come with the knife cards and tables they are based on.
      </p>
      <div className="chat-suggestions">
        {SUGGESTIONS.map((text) => (
          <button
            key={text}
            type="button"
            disabled={disabled}
            onClick={() => onPick(text)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  )
}

function ConversationRow({
  conversation,
  active,
  disabled,
  onOpen,
  onRename,
  onArchive,
  onDelete,
}: {
  conversation: ChatConversationSummary
  active: boolean
  disabled: boolean
  onOpen: () => void
  onRename: (title: string) => void
  onArchive: (archived: boolean) => void
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(conversation.title)
  const archived = conversation.archivedAt !== null

  if (editing)
    return (
      <li className="chat-row" data-active={active ? 'true' : 'false'}>
        <form
          className="flex w-full items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault()
            const next = title.trim()
            if (next && next !== conversation.title) onRename(next)
            setEditing(false)
          }}
        >
          <Input
            autoFocus
            value={title}
            maxLength={120}
            aria-label="Chat title"
            className="h-7 text-sm"
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setTitle(conversation.title)
                setEditing(false)
              }
            }}
          />
          <Button
            type="submit"
            size="icon-sm"
            variant="ghost"
            aria-label="Save title"
          >
            <Check aria-hidden="true" />
          </Button>
        </form>
      </li>
    )

  return (
    <li className="chat-row" data-active={active ? 'true' : 'false'}>
      <button
        type="button"
        className="chat-row-open"
        disabled={disabled}
        aria-current={active ? 'page' : undefined}
        onClick={onOpen}
      >
        <span className="truncate">{conversation.title}</span>
        <span className="text-[11px] text-muted-foreground">
          {relativeTime(conversation.updatedAt)}
        </span>
      </button>
      <span className="chat-row-actions">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={`Rename “${conversation.title}”`}
          onClick={() => {
            setTitle(conversation.title)
            setEditing(true)
          }}
        >
          <Pencil aria-hidden="true" />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={
            archived
              ? `Restore “${conversation.title}”`
              : `Archive “${conversation.title}”`
          }
          onClick={() => onArchive(!archived)}
        >
          {archived ? (
            <ArchiveRestore aria-hidden="true" />
          ) : (
            <Archive aria-hidden="true" />
          )}
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={`Delete “${conversation.title}”`}
          onClick={onDelete}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </span>
    </li>
  )
}

function TurnView({ turn, streaming }: { turn: Turn; streaming: boolean }) {
  const last = turn.items.at(-1)
  const waiting =
    streaming && (!last || (last.kind === 'tool' && last.step !== null))
  return (
    <li className="chat-turn">
      {turn.user !== null ? (
        <div className="chat-user">
          <p>{turn.user}</p>
        </div>
      ) : null}
      <div className="chat-answer">
        {turn.items.map((item) =>
          item.kind === 'tool' ? (
            <ToolStepView key={item.key} label={item.label} step={item.step} />
          ) : (
            <AnswerText key={item.key} item={item} />
          ),
        )}
        {waiting ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
            Thinking…
          </p>
        ) : null}
      </div>
    </li>
  )
}

function AnswerText({ item }: { item: Extract<AnswerItem, { kind: 'text' }> }) {
  if (item.status === 'error')
    return (
      <div className="chat-error">
        <AlertCircle aria-hidden="true" className="size-4 shrink-0" />
        <span>{item.text || 'The answer failed.'}</span>
      </div>
    )
  return (
    <div>
      {item.text.trim() ? (
        <NoteMarkdown
          body={item.text}
          className="text-sm leading-relaxed text-foreground xl:text-sm"
        />
      ) : null}
      {item.status === 'stopped' ? (
        <p className="mt-1 text-xs text-muted-foreground">Stopped.</p>
      ) : null}
    </div>
  )
}

function ToolStepView({
  label,
  step,
}: {
  label: string
  step: ChatToolStep | null
}) {
  const [open, setOpen] = useState(true)
  const running = step === null
  const hasUi = Boolean(step?.ui)
  return (
    <div className="chat-tool" data-ok={step ? String(step.ok) : undefined}>
      <button
        type="button"
        className="chat-tool-chip"
        aria-expanded={hasUi ? open : undefined}
        disabled={!hasUi}
        onClick={() => setOpen((value) => !value)}
      >
        {running ? (
          <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
        ) : step.ok ? (
          <Wrench aria-hidden="true" className="size-3.5" />
        ) : (
          <AlertCircle aria-hidden="true" className="size-3.5" />
        )}
        <span className="truncate">{label}</span>
        {step ? (
          <span className="shrink-0 text-muted-foreground">
            · {step.summary}
          </span>
        ) : null}
        {hasUi ? (
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'size-3.5 shrink-0 transition-transform',
              open && 'rotate-90',
            )}
          />
        ) : null}
      </button>
      {step?.ui && open ? <ToolUiView ui={step.ui} /> : null}
    </div>
  )
}

function ToolUiView({ ui }: { ui: NonNullable<ChatToolStep['ui']> }) {
  const more = (shown: number) =>
    ui.total > shown ? (
      <p className="text-xs text-muted-foreground">
        Showing {shown} of {ui.total}.
      </p>
    ) : null
  if (ui.kind === 'knives')
    return (
      <div className="flex flex-col gap-2">
        <ul className="chat-cards">
          {ui.knives.map((knife) => (
            <li key={knife.id}>
              <KnifeCardLink knife={knife} />
            </li>
          ))}
        </ul>
        {more(ui.knives.length)}
      </div>
    )
  if (ui.kind === 'priceChanges')
    return (
      <div className="flex flex-col gap-2">
        <div className="chat-table-wrap">
          <table className="chat-table">
            <thead>
              <tr>
                <th scope="col">Knife</th>
                <th scope="col">Change</th>
                <th scope="col">Price</th>
                <th scope="col">Store</th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {ui.rows.map((row, index) => (
                <tr key={`${row.knife.id}-${row.occurredAt}-${index}`}>
                  <td>
                    <KnifeInline knife={row.knife} />
                  </td>
                  <td>
                    <ChangePill event={changeEventOf(row)} />
                  </td>
                  <td className="tabular-nums">
                    {formatMoney(row.price)}
                    {row.previousPrice ? (
                      <span className="ml-1 text-xs text-muted-foreground line-through">
                        {formatMoney(row.previousPrice)}
                      </span>
                    ) : null}
                  </td>
                  <td>{row.storeName}</td>
                  <td className="whitespace-nowrap text-muted-foreground">
                    {relativeTime(row.occurredAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {more(ui.rows.length)}
      </div>
    )
  return (
    <div className="flex flex-col gap-2">
      <div className="chat-table-wrap">
        <table className="chat-table">
          <thead>
            <tr>
              <th scope="col">Knife</th>
              <th scope="col">State</th>
              <th scope="col">Best price</th>
              <th scope="col">Regular</th>
              <th scope="col">Checked</th>
            </tr>
          </thead>
          <tbody>
            {ui.rows.map((row) => (
              <tr key={row.knife.id}>
                <td>
                  <KnifeInline knife={row.knife} />
                </td>
                <td>
                  <span data-result={row.state} className="chat-state">
                    {row.outOfStock
                      ? 'out of stock'
                      : row.state.replace(/_/g, ' ')}
                  </span>
                </td>
                <td className="tabular-nums">{formatMoney(row.bestPrice)}</td>
                <td className="tabular-nums text-muted-foreground">
                  {formatMoney(row.paid)}
                </td>
                <td className="whitespace-nowrap text-muted-foreground">
                  {row.lastCheckedAt ? relativeTime(row.lastCheckedAt) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more(ui.rows.length)}
    </div>
  )
}

function formatMoney(value: ChatMoney | null): string {
  return value ? money(value.minor, value.currency) : '—'
}

function changeEventOf(row: ChatPriceChangeRow): ChangeEvent {
  const priceMinor = row.price?.minor ?? null
  const previousPriceMinor = row.previousPrice?.minor ?? null
  return {
    id: `${row.knife.id}-${row.occurredAt}`,
    type: row.kind === 'drop' || row.kind === 'increase' ? 'price' : 'stock',
    kind: row.kind,
    knife: knifeRef(row.knife),
    sourceId: 0,
    storeName: row.storeName,
    sourceUrl: '',
    previousPriceMinor,
    priceMinor,
    currency: row.price?.currency ?? row.previousPrice?.currency ?? null,
    deltaMinor:
      priceMinor !== null && previousPriceMinor !== null
        ? priceMinor - previousPriceMinor
        : null,
    deltaPct: row.deltaPct,
    occurredAt: row.occurredAt,
  }
}

function knifeRef(knife: ChatKnifeCard) {
  return {
    id: knife.id,
    name: knife.name,
    brand: knife.brand,
    image: knife.image,
    subtitle: knife.subtitle,
  }
}

function KnifeInline({ knife }: { knife: ChatKnifeCard }) {
  return (
    <Link
      href={`/collection/${encodeURIComponent(knife.id)}`}
      className="chat-knife-inline"
    >
      <KnifeThumb knife={knifeRef(knife)} className="size-8" />
      <span className="min-w-0">
        <span className="block truncate font-medium text-foreground">
          {knife.name}
        </span>
        {knife.brand ? (
          <span className="block truncate text-xs text-muted-foreground">
            {knife.brand}
          </span>
        ) : null}
      </span>
    </Link>
  )
}

function KnifeCardLink({ knife }: { knife: ChatKnifeCard }) {
  return (
    <Link
      href={`/collection/${encodeURIComponent(knife.id)}`}
      className="chat-card"
    >
      <KnifeThumb knife={knifeRef(knife)} className="size-12" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {knife.name}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {[knife.brand, knife.subtitle].filter(Boolean).join(' · ') || '—'}
        </span>
        {knife.price || knife.sold ? (
          <span className="block truncate text-xs text-muted-foreground tabular-nums">
            {[knife.price, knife.sold ? 'sold' : null]
              .filter(Boolean)
              .join(' · ')}
          </span>
        ) : null}
      </span>
    </Link>
  )
}

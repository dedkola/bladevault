'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  COMPARISONS_REFRESH_EVENT,
  type Comparison,
  type ComparisonCommand,
  type ComparisonResponse,
} from '@/lib/comparisons'
import { readJsonResponse } from '@/lib/api-response'
import { useKnives } from '@/components/providers/knives-provider'
import { ComparisonDialogs } from '@/components/comparison-dialogs'
import { Button } from '@/components/ui/button'

export type ComparisonDialog = {
  kind: 'create' | 'rename' | 'choose' | 'options' | 'delete' | 'clear' | 'add'
  id?: string
  knifeIds?: string[]
  bulk?: boolean
}
type ContextValue = {
  lists: Comparison[]
  active: Comparison | undefined
  loading: boolean
  error: string
  busy: boolean
  refresh: () => Promise<void>
  mutate: (
    command: ComparisonCommand,
    message?: string,
  ) => Promise<ComparisonResponse>
  open: (dialog: ComparisonDialog) => void
  dialog: ComparisonDialog | null
  setDialog: (dialog: ComparisonDialog | null) => void
  navigate: (id: string) => void
  choose: (ids: string[], bulk?: boolean) => Promise<void>
  membershipCount: (id: string) => number
  returnFocus: React.RefObject<HTMLElement | null>
}
const Context = createContext<ContextValue | null>(null)
const LAST_LIST = 'bladevault:last-comparison:v1'
function readLastList() {
  try {
    return localStorage.getItem(LAST_LIST)
  } catch {
    return null
  }
}
function subscribeLastList(notify: () => void) {
  window.addEventListener('storage', notify)
  window.addEventListener(LAST_LIST, notify)
  return () => {
    window.removeEventListener('storage', notify)
    window.removeEventListener(LAST_LIST, notify)
  }
}

export function ComparisonsProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const { showFeedback } = useKnives()
  const router = useRouter(),
    pathname = usePathname(),
    params = useSearchParams()
  const [lists, setLists] = useState<Comparison[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('')
  const lastId = useSyncExternalStore(
    subscribeLastList,
    readLastList,
    () => null,
  )
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<ComparisonDialog | null>(null)
  const [undo, setUndo] = useState<{
    command: ComparisonCommand
    message: string
  } | null>(null)
  const sequence = useRef(0),
    pending = useRef(0),
    queue = useRef<Promise<unknown>>(Promise.resolve()),
    channel = useRef<BroadcastChannel | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const requested = pathname === '/compare' ? params.get('list') : null
  const active = lists.find((l) => l.id === (requested || lastId)) ?? lists[0]
  const refresh = useCallback((): Promise<void> => {
    if (pending.current) return Promise.resolve()
    const request = ++sequence.current
    return fetch('/api/comparisons', { cache: 'no-store' })
      .then(async (response) => {
        const data = await readJsonResponse<
          ComparisonResponse & { error?: string }
        >(response)
        if (!response.ok)
          throw new Error(data.error || 'Could not load comparisons.')
        if (request === sequence.current) {
          setLists(data.lists)
          setError('')
        }
      })
      .catch((err) => {
        if (request === sequence.current)
          setError(
            err instanceof Error ? err.message : 'Could not load comparisons.',
          )
      })
      .finally(() => {
        if (request === sequence.current) setLoading(false)
      })
  }, [])
  useEffect(() => {
    void refresh()
    const onRefresh = () => void refresh()
    window.addEventListener('focus', onRefresh)
    window.addEventListener(COMPARISONS_REFRESH_EVENT, onRefresh)
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 30_000)
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel('bladevault-comparisons')
      channel.current.onmessage = onRefresh
    }
    const requestSequence = sequence
    return () => {
      ++requestSequence.current
      window.removeEventListener('focus', onRefresh)
      window.removeEventListener(COMPARISONS_REFRESH_EVENT, onRefresh)
      window.clearInterval(interval)
      channel.current?.close()
    }
  }, [refresh])
  useEffect(() => {
    if (pathname === '/compare' && active) {
      try {
        if (readLastList() !== active.id) {
          localStorage.setItem(LAST_LIST, active.id)
          window.dispatchEvent(new Event(LAST_LIST))
        }
      } catch {}
    }
  }, [active, pathname])
  useEffect(() => {
    if (!undo) return
    const timer = window.setTimeout(() => setUndo(null), 10_000)
    return () => window.clearTimeout(timer)
  }, [undo])
  const mutate = useCallback(
    (
      command: ComparisonCommand,
      message?: string,
    ): Promise<ComparisonResponse> => {
      ++pending.current
      ++sequence.current
      setBusy(true)
      const task = queue.current
        .catch(() => {})
        .then(async () => {
          try {
            const response = await fetch('/api/comparisons', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(command),
            })
            const data = await readJsonResponse<
              ComparisonResponse & { error?: string }
            >(response)
            if (!response.ok)
              throw new Error(data.error || 'Could not save comparison.')
            setLists(data.lists)
            setError('')
            setLoading(false)
            channel.current?.postMessage('refresh')
            if (data.undo)
              setUndo({
                command: data.undo,
                message: message || 'Comparison updated',
              })
            else if (message) showFeedback(message)
            return data
          } finally {
            --pending.current
            if (!pending.current) {
              setBusy(false)
              void refresh()
            }
          }
        })
      queue.current = task
      return task
    },
    [refresh, showFeedback],
  )
  const navigate = useCallback(
    (id: string) => router.push(`/compare?list=${encodeURIComponent(id)}`),
    [router],
  )
  const open = useCallback((next: ComparisonDialog) => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    setDialog(next)
  }, [])
  const choose = useCallback(
    async (ids: string[], bulk = false) => {
      if (loading || error)
        throw new Error(
          error || 'Comparisons are still loading. Try again in a moment.',
        )
      const unique = [...new Set(ids)]
      if (!unique.length) return
      if (!lists.length) {
        open({ kind: 'create', knifeIds: unique, bulk })
        return
      }
      if (lists.length > 1) {
        open({ kind: 'choose', knifeIds: unique, bulk })
        return
      }
      const list = lists[0],
        remove = !bulk && unique.length === 1 && list.ids.includes(unique[0])
      await mutate(
        {
          action: remove ? 'remove' : 'add',
          id: list.id,
          ids: unique,
          expectedRevision: list.revision,
        },
        `${remove ? 'Removed from' : 'Added to'} ${list.name}`,
      )
    },
    [lists, loading, error, open, mutate],
  )
  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const list of lists)
      for (const id of list.ids) map.set(id, (map.get(id) ?? 0) + 1)
    return map
  }, [lists])
  const membershipCount = useCallback(
    (id: string) => counts.get(id) ?? 0,
    [counts],
  )
  return (
    <Context.Provider
      value={{
        lists,
        active,
        loading,
        error,
        busy,
        refresh,
        mutate,
        open,
        dialog,
        setDialog,
        navigate,
        choose,
        membershipCount,
        returnFocus,
      }}
    >
      {children}
      <ComparisonDialogs />
      {undo && (
        <div
          role="status"
          className="fixed bottom-5 left-1/2 z-50 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-4 rounded-lg border bg-popover px-4 py-3 text-sm shadow-lg"
        >
          <span className="min-w-0 break-words">{undo.message}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              try {
                const data = await mutate(undo.command)
                setUndo(null)
                if (
                  undo.command.action === 'restore' &&
                  undo.command.expectedRevision === null &&
                  data.listId
                )
                  navigate(data.listId)
              } catch (err) {
                showFeedback(
                  err instanceof Error ? err.message : 'Could not undo.',
                  'error',
                )
              }
            }}
          >
            Undo
          </Button>
        </div>
      )}
    </Context.Provider>
  )
}
export function useComparisons() {
  const value = useContext(Context)
  if (!value) throw new Error('ComparisonsProvider is required')
  return value
}

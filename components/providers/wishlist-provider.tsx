'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useKnives } from '@/components/providers/knives-provider'
import { Button } from '@/components/ui/button'
import { readJsonResponse } from '@/lib/api-response'
import type { KnifeStoreEntry } from '@/lib/price-monitor/shared'
import { hasServerRuntime } from '@/lib/runtime-capabilities'
import { VAULT_EXTERNAL_CHANGE_EVENT } from '@/lib/vault-client-state'
import {
  WISHLIST_REFRESH_EVENT,
  type WishlistBudget,
  type WishlistCommand,
  type WishlistItem,
  type WishlistResponse,
  type WishlistTrend,
} from '@/lib/wishlist'

type WishlistContextValue = {
  /** False where there is no server API (the static app). */
  available: boolean
  items: WishlistItem[]
  trends: Record<string, WishlistTrend>
  budget: WishlistBudget
  /** Where each knife is sold, store by store. */
  stores: Record<string, KnifeStoreEntry[]>
  loading: boolean
  error: string
  busy: boolean
  has: (knifeId: string) => boolean
  refresh: () => Promise<void>
  mutate: (
    command: WishlistCommand,
    message?: string,
  ) => Promise<WishlistResponse>
}

const EMPTY_BUDGET: WishlistBudget = { amountMinor: null, currency: null }

const UNAVAILABLE: WishlistContextValue = {
  available: false,
  items: [],
  trends: {},
  budget: EMPTY_BUDGET,
  stores: {},
  loading: false,
  error: '',
  busy: false,
  has: () => false,
  refresh: () => Promise.resolve(),
  mutate: () =>
    Promise.reject(new Error('The wishlist needs the BladeVault app.')),
}

const Context = createContext<WishlistContextValue | null>(null)

export function WishlistProvider({ children }: { children: React.ReactNode }) {
  const { showFeedback } = useKnives()
  const available = hasServerRuntime()
  const [items, setItems] = useState<WishlistItem[]>([])
  const [trends, setTrends] = useState<Record<string, WishlistTrend>>({})
  const [budget, setBudget] = useState<WishlistBudget>(EMPTY_BUDGET)
  const [stores, setStores] = useState<Record<string, KnifeStoreEntry[]>>({})
  const [loading, setLoading] = useState(available)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [undo, setUndo] = useState<{
    command: WishlistCommand
    message: string
  } | null>(null)
  const sequence = useRef(0),
    pending = useRef(0),
    queue = useRef<Promise<unknown>>(Promise.resolve()),
    channel = useRef<BroadcastChannel | null>(null)

  const apply = useCallback((data: WishlistResponse) => {
    setItems(data.items)
    setTrends(data.trends)
    setBudget(data.budget)
    setStores(data.stores ?? {})
    setError('')
  }, [])

  const refresh = useCallback((): Promise<void> => {
    if (!available || pending.current) return Promise.resolve()
    const request = ++sequence.current
    return fetch('/api/wishlist', { cache: 'no-store' })
      .then(async (response) => {
        const data = await readJsonResponse<
          WishlistResponse & { error?: string }
        >(response)
        if (!response.ok)
          throw new Error(data.error || 'Could not load the wishlist.')
        if (request === sequence.current) apply(data)
      })
      .catch((err) => {
        if (request === sequence.current)
          setError(
            err instanceof Error ? err.message : 'Could not load the wishlist.',
          )
      })
      .finally(() => {
        if (request === sequence.current) setLoading(false)
      })
  }, [apply, available])

  useEffect(() => {
    if (!available) return
    void refresh()
    const onRefresh = () => void refresh()
    window.addEventListener('focus', onRefresh)
    window.addEventListener(WISHLIST_REFRESH_EVENT, onRefresh)
    window.addEventListener(VAULT_EXTERNAL_CHANGE_EVENT, onRefresh)
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel('bladevault-wishlist')
      channel.current.onmessage = onRefresh
    }
    const requestSequence = sequence
    return () => {
      ++requestSequence.current
      window.removeEventListener('focus', onRefresh)
      window.removeEventListener(WISHLIST_REFRESH_EVENT, onRefresh)
      window.removeEventListener(VAULT_EXTERNAL_CHANGE_EVENT, onRefresh)
      channel.current?.close()
    }
  }, [available, refresh])

  useEffect(() => {
    if (!undo) return
    const timer = window.setTimeout(() => setUndo(null), 10_000)
    return () => window.clearTimeout(timer)
  }, [undo])

  const mutate = useCallback(
    (command: WishlistCommand, message?: string) => {
      ++pending.current
      ++sequence.current
      setBusy(true)
      const task = queue.current
        .catch(() => {})
        .then(async () => {
          try {
            const response = await fetch('/api/wishlist', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(command),
            })
            const data = await readJsonResponse<
              WishlistResponse & { error?: string }
            >(response)
            if (!response.ok)
              throw new Error(data.error || 'Could not save the wishlist.')
            apply(data)
            setLoading(false)
            channel.current?.postMessage('refresh')
            if (data.undo && message) setUndo({ command: data.undo, message })
            else if (message) showFeedback(message)
            return data
          } finally {
            --pending.current
            if (!pending.current) setBusy(false)
          }
        })
      queue.current = task
      return task
    },
    [apply, showFeedback],
  )

  const ids = useMemo(() => new Set(items.map((item) => item.knifeId)), [items])
  const has = useCallback((knifeId: string) => ids.has(knifeId), [ids])

  const value = useMemo<WishlistContextValue>(
    () =>
      available
        ? {
            available,
            items,
            trends,
            budget,
            stores,
            loading,
            error,
            busy,
            has,
            refresh,
            mutate,
          }
        : UNAVAILABLE,
    [
      available,
      items,
      trends,
      budget,
      stores,
      loading,
      error,
      busy,
      has,
      refresh,
      mutate,
    ],
  )

  return (
    <Context.Provider value={value}>
      {children}
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
                await mutate(undo.command)
                setUndo(null)
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

/** Wishlist state; a disabled stand-in outside the provider (static app). */
export function useWishlist(): WishlistContextValue {
  return useContext(Context) ?? UNAVAILABLE
}

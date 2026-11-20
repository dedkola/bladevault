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
import { readJsonResponse } from '@/lib/api-response'
import {
  PRICE_DATA_UPDATED_EVENT,
  toMarketSummaryMap,
  type MarketSummaryMap,
} from '@/lib/market-status'
import { hasServerRuntime } from '@/lib/runtime-capabilities'
import {
  getVaultClientState,
  subscribeVaultClientState,
  VAULT_EXTERNAL_CHANGE_EVENT,
} from '@/lib/vault-client-state'

type MarketContextValue = {
  /** False where price monitoring does not exist (the static app). */
  available: boolean
  /** Market summary per knife id; knives without store links are absent. */
  byId: MarketSummaryMap
  isLoading: boolean
}

/** Background checks land without a client event, so look again now and then. */
const REFRESH_MS = 5 * 60_000
/** Focus and tab switches refresh at most this often. */
const FOCUS_REFRESH_MS = 60_000
/** Knife edits can change eligibility and the regular price compared. */
const KNIFE_CHANGE_DELAY_MS = 600

const MarketContext = createContext<MarketContextValue | null>(null)

/**
 * Loads the collection's market summaries once and keeps them current: after
 * price checks and store-link changes (`PRICE_DATA_UPDATED_EVENT`), knife
 * edits, vault restores and outside changes, on focus, and every few minutes
 * while the window is visible. Every card, cell and filter reads this map.
 */
export function MarketProvider({ children }: { children: React.ReactNode }) {
  const { knives, isLoading: knivesLoading } = useKnives()
  const available = hasServerRuntime()
  const [byId, setById] = useState<MarketSummaryMap>(() => new Map())
  const [isLoading, setIsLoading] = useState(available)
  const [refreshKey, setRefreshKey] = useState(0)
  const lastLoadRef = useRef(0)

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), [])

  useEffect(() => {
    if (!available) return
    const controller = new AbortController()
    lastLoadRef.current = Date.now()
    void (async () => {
      try {
        const response = await fetch('/api/prices/market', {
          cache: 'no-store',
          signal: controller.signal,
        })
        const data = await readJsonResponse<{ summaries?: unknown }>(response)
        if (controller.signal.aborted || !response.ok) return
        setById(toMarketSummaryMap(data.summaries))
      } catch {
        // Keep the last summaries until a later refresh succeeds.
      } finally {
        if (!controller.signal.aborted) setIsLoading(false)
      }
    })()
    return () => controller.abort()
  }, [available, refreshKey])

  useEffect(() => {
    if (!available) return
    const onFocus = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastLoadRef.current >= FOCUS_REFRESH_MS) refresh()
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, REFRESH_MS)
    window.addEventListener(PRICE_DATA_UPDATED_EVENT, refresh)
    window.addEventListener(VAULT_EXTERNAL_CHANGE_EVENT, refresh)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    let lastGeneration = getVaultClientState().generation
    const unsubscribe = subscribeVaultClientState(() => {
      const generation = getVaultClientState().generation
      if (generation !== lastGeneration) {
        lastGeneration = generation
        refresh()
      }
    })
    return () => {
      window.clearInterval(timer)
      window.removeEventListener(PRICE_DATA_UPDATED_EVENT, refresh)
      window.removeEventListener(VAULT_EXTERNAL_CHANGE_EVENT, refresh)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      unsubscribe()
    }
  }, [available, refresh])

  // Regular price, sold state and product links decide what is monitored
  // and what "below regular price" compares with, so reload after edits.
  const knifeSignature = useMemo(
    () =>
      knives
        .map(
          (knife) =>
            `${knife.id}:${knife.updatedAt}:${knife.sold ? 1 : 0}:${knife.specs.price ?? ''}`,
        )
        .join('|'),
    [knives],
  )
  const firstSignatureRef = useRef<string | null>(null)
  useEffect(() => {
    if (!available || knivesLoading) return
    if (firstSignatureRef.current === null) {
      firstSignatureRef.current = knifeSignature
      return
    }
    if (firstSignatureRef.current === knifeSignature) return
    firstSignatureRef.current = knifeSignature
    const timer = window.setTimeout(refresh, KNIFE_CHANGE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [available, knivesLoading, knifeSignature, refresh])

  const value = useMemo<MarketContextValue>(
    () => ({ available, byId, isLoading }),
    [available, byId, isLoading],
  )
  return (
    <MarketContext.Provider value={value}>{children}</MarketContext.Provider>
  )
}

/** Outside a MarketProvider (the static app) every market surface hides. */
const UNAVAILABLE_MARKET: MarketContextValue = {
  available: false,
  byId: new Map(),
  isLoading: false,
}

export function useMarket(): MarketContextValue {
  return useContext(MarketContext) ?? UNAVAILABLE_MARKET
}

/** The summary map for filtering, or undefined where market data is absent. */
export function useMarketFilter(): MarketSummaryMap | undefined {
  const { available, byId } = useMarket()
  return available ? byId : undefined
}

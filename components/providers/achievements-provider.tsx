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
  ACHIEVEMENTS_REFRESH_EVENT,
  pendingCelebrations,
  type AchievementState,
  type AchievementSyncResult,
  type AchievementUnlock,
} from '@/lib/achievements/unlocks'
import { COMPARISONS_REFRESH_EVENT } from '@/lib/comparisons'
import { MAINTENANCE_UPDATED_EVENT } from '@/lib/maintenance-due'
import { PRICE_DATA_UPDATED_EVENT } from '@/lib/market-status'
import {
  DEFAULT_ACHIEVEMENTS,
  normalizeAchievementSettings,
  SETTINGS_UPDATED_EVENT,
  type AchievementSettings,
  type AppSettings,
} from '@/lib/settings-shared'
import { SYSTEM_MESSAGES_REFRESH_EVENT } from '@/lib/system-messages'
import { VAULT_EXTERNAL_CHANGE_EVENT } from '@/lib/vault-client-state'

/** Changes settle for this long before one sync runs (e.g. during imports). */
const SYNC_DEBOUNCE_MS = 1200

type AchievementsContextValue = {
  settings: AchievementSettings
  /** The latest evaluation; null until the first sync or while switched off. */
  state: AchievementState | null
  /** Unlocks to celebrate on screen, oldest first. */
  celebrations: AchievementUnlock[]
  /** Marks celebrations shown so they never replay. */
  markCelebrated: (ids: string[]) => void
}

const AchievementsContext = createContext<AchievementsContextValue>({
  settings: { ...DEFAULT_ACHIEVEMENTS, enabled: false },
  state: null,
  celebrations: [],
  markCelebrated: () => {},
})

export function useAchievements(): AchievementsContextValue {
  return useContext(AchievementsContext)
}

async function patchSeen(ids: string[]) {
  await fetch('/api/achievements', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'seen', ids }),
  })
}

/**
 * Keeps achievements in step with the vault: syncs on start, after knife,
 * care, comparison and price changes, and when the window regains focus
 * (picking up MCP or CLI edits). New unlocks are queued for celebration;
 * with celebrations off they are marked seen straight away.
 */
export function AchievementsProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const { knives, isLoading } = useKnives()
  const [settings, setSettings] = useState<AchievementSettings | null>(null)
  const [celebrations, setCelebrations] = useState<AchievementUnlock[]>([])
  const [state, setState] = useState<AchievementState | null>(null)
  const settingsRef = useRef(settings)
  const timerRef = useRef<number | null>(null)
  const syncingRef = useRef(false)
  const queuedRef = useRef(false)

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  // Settings come from the server once, then from Settings saves.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch('/api/settings', { cache: 'no-store' })
        const data = await readJsonResponse<{
          settings?: Partial<AppSettings>
        }>(response)
        if (!cancelled && response.ok) {
          setSettings(normalizeAchievementSettings(data.settings?.achievements))
        }
      } catch {
        // Stay idle; a settings change or reload retries.
      }
    }
    const onSettings = (event: Event) => {
      const detail = (event as CustomEvent<Partial<AppSettings>>).detail
      if (detail?.achievements) {
        setSettings(normalizeAchievementSettings(detail.achievements))
      }
    }
    void load()
    window.addEventListener(SETTINGS_UPDATED_EVENT, onSettings)
    return () => {
      cancelled = true
      window.removeEventListener(SETTINGS_UPDATED_EVENT, onSettings)
    }
  }, [])

  const sync = useCallback(async () => {
    if (syncingRef.current) {
      queuedRef.current = true
      return
    }
    syncingRef.current = true
    try {
      do {
        queuedRef.current = false
        const response = await fetch('/api/achievements', { method: 'POST' })
        if (!response.ok) return
        const result = await readJsonResponse<AchievementSyncResult>(response)
        if (!result.enabled) {
          setCelebrations([])
          setState(null)
          continue
        }
        setState({
          enabled: result.enabled,
          unlocks: result.unlocks,
          progress: result.progress,
          summary: result.summary,
        })
        if (result.newlyUnlocked.length > 0 || result.backfilledCount > 0) {
          window.dispatchEvent(new Event(SYSTEM_MESSAGES_REFRESH_EVENT))
        }
        const pending = pendingCelebrations(result.unlocks)
        if (settingsRef.current?.celebrate) {
          setCelebrations((current) => {
            const known = new Set(current.map((unlock) => unlock.id))
            const added = pending.filter((unlock) => !known.has(unlock.id))
            return added.length ? [...current, ...added] : current
          })
        } else if (pending.length > 0) {
          await patchSeen(pending.map((unlock) => unlock.id))
        }
      } while (queuedRef.current)
    } catch {
      // Keep quiet; the next change or focus retries.
    } finally {
      syncingRef.current = false
    }
  }, [])

  const enabled = Boolean(settings?.enabled)

  const scheduleSync = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      void sync()
    }, SYNC_DEBOUNCE_MS)
  }, [sync])

  // Any knife change (add, edit, delete, pin, sold, refresh) and the
  // settings switch itself schedule a sync.
  useEffect(() => {
    if (!enabled || isLoading) return
    scheduleSync()
  }, [enabled, isLoading, knives, settings?.celebrate, scheduleSync])

  useEffect(() => {
    if (!enabled) return
    const events = [
      MAINTENANCE_UPDATED_EVENT,
      COMPARISONS_REFRESH_EVENT,
      PRICE_DATA_UPDATED_EVENT,
      VAULT_EXTERNAL_CHANGE_EVENT,
      ACHIEVEMENTS_REFRESH_EVENT,
      'focus',
    ]
    for (const name of events) window.addEventListener(name, scheduleSync)
    return () => {
      for (const name of events) window.removeEventListener(name, scheduleSync)
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [enabled, scheduleSync])

  const markCelebrated = useCallback((ids: string[]) => {
    if (ids.length === 0) return
    const shown = new Set(ids)
    setCelebrations((current) => current.filter((u) => !shown.has(u.id)))
    void patchSeen(ids).catch(() => {
      // The next sync offers them again; better a repeat than a loss.
    })
  }, [])

  const value = useMemo<AchievementsContextValue>(
    () => ({
      settings: settings ?? { ...DEFAULT_ACHIEVEMENTS, enabled: false },
      state: enabled ? state : null,
      celebrations: enabled && settings?.celebrate ? celebrations : [],
      markCelebrated,
    }),
    [settings, enabled, state, celebrations, markCelebrated],
  )

  return (
    <AchievementsContext.Provider value={value}>
      {children}
    </AchievementsContext.Provider>
  )
}

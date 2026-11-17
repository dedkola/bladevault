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
import { readJsonResponse } from '@/lib/api-response'
import {
  buildLatestByKnife,
  getCareStatuses,
  MAINTENANCE_UPDATED_EVENT,
  type KnifeCareStatus,
  type LatestByType,
  type MaintenanceLatestEntry,
} from '@/lib/maintenance-due'
import {
  DEFAULT_MAINTENANCE_REMINDERS,
  normalizeCareIntervalOverrides,
  normalizeMaintenanceReminders,
  SETTINGS_UPDATED_EVENT,
  type CareIntervalOverrides,
  type CareTrack,
  type MaintenanceReminderSettings,
} from '@/lib/settings-shared'
import {
  getVaultClientState,
  subscribeVaultClientState,
} from '@/lib/vault-client-state'
import { useKnives } from '@/components/providers/knives-provider'

type CareContextValue = {
  /** Reminder preferences; care UI hides itself while `enabled` is false. */
  reminders: MaintenanceReminderSettings
  overrides: CareIntervalOverrides
  /** Latest maintenance dates per knife; empty until loaded. */
  latestByKnife: ReadonlyMap<string, LatestByType>
  /** Derived care status per knife (sold knives may be skipped). */
  statusById: ReadonlyMap<string, KnifeCareStatus>
  isLoading: boolean
  /** Saves per-knife interval overrides; null clears the knife's entry. */
  setKnifeCareIntervals: (
    knifeId: string,
    tracks: Partial<Record<CareTrack, number | null>> | null,
  ) => Promise<void>
}

const CareContext = createContext<CareContextValue | null>(null)

export function CareProvider({ children }: { children: React.ReactNode }) {
  const { knives } = useKnives()
  const [reminders, setReminders] = useState(DEFAULT_MAINTENANCE_REMINDERS)
  const [overrides, setOverrides] = useState<CareIntervalOverrides>({})
  const [latestByKnife, setLatestByKnife] = useState<Map<string, LatestByType>>(
    () => new Map(),
  )
  const [isLoading, setIsLoading] = useState(true)
  const [now, setNow] = useState(() => new Date())
  const [refreshKey, setRefreshKey] = useState(0)
  const overridesRef = useRef(overrides)

  useEffect(() => {
    overridesRef.current = overrides
  }, [overrides])

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [settingsResponse, latestResponse] = await Promise.all([
          fetch('/api/settings', { cache: 'no-store' }),
          fetch('/api/maintenance', { cache: 'no-store' }),
        ])
        const settingsData = await readJsonResponse<{
          settings?: {
            maintenanceReminders?: unknown
            careIntervalOverrides?: unknown
          }
        }>(settingsResponse)
        const latestData = await readJsonResponse<{
          latest?: MaintenanceLatestEntry[]
        }>(latestResponse)
        if (cancelled) return
        if (settingsResponse.ok) {
          setReminders(
            normalizeMaintenanceReminders(
              settingsData.settings?.maintenanceReminders,
            ),
          )
          setOverrides(
            normalizeCareIntervalOverrides(
              settingsData.settings?.careIntervalOverrides,
            ),
          )
        }
        if (latestResponse.ok && Array.isArray(latestData.latest)) {
          setLatestByKnife(buildLatestByKnife(latestData.latest))
        }
        setNow(new Date())
      } catch {
        // Care badges keep their last state until a later refresh succeeds.
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  // Maintenance edits and vault restores change the underlying history.
  useEffect(() => {
    const refresh = () => setRefreshKey((key) => key + 1)
    window.addEventListener(MAINTENANCE_UPDATED_EVENT, refresh)
    let lastGeneration = getVaultClientState().generation
    const unsubscribe = subscribeVaultClientState(() => {
      const generation = getVaultClientState().generation
      if (generation !== lastGeneration) {
        lastGeneration = generation
        refresh()
      }
    })
    return () => {
      window.removeEventListener(MAINTENANCE_UPDATED_EVENT, refresh)
      unsubscribe()
    }
  }, [])

  // Keep day counts current when the app stays open past midnight.
  useEffect(() => {
    const checkDay = () =>
      setNow((current) => {
        const next = new Date()
        return next.toDateString() === current.toDateString() ? current : next
      })
    const timer = window.setInterval(checkDay, 5 * 60_000)
    window.addEventListener('focus', checkDay)
    document.addEventListener('visibilitychange', checkDay)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', checkDay)
      document.removeEventListener('visibilitychange', checkDay)
    }
  }, [])

  // The Settings page announces reminder changes through the shared event.
  useEffect(() => {
    const onSettingsUpdated = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          maintenanceReminders?: unknown
          careIntervalOverrides?: unknown
        }>
      ).detail
      if (detail?.maintenanceReminders !== undefined) {
        setReminders(normalizeMaintenanceReminders(detail.maintenanceReminders))
      }
      if (detail?.careIntervalOverrides !== undefined) {
        setOverrides(
          normalizeCareIntervalOverrides(detail.careIntervalOverrides),
        )
      }
    }
    window.addEventListener(
      SETTINGS_UPDATED_EVENT,
      onSettingsUpdated as EventListener,
    )
    return () =>
      window.removeEventListener(
        SETTINGS_UPDATED_EVENT,
        onSettingsUpdated as EventListener,
      )
  }, [])

  const setKnifeCareIntervals = useCallback(
    async (
      knifeId: string,
      tracks: Partial<Record<CareTrack, number | null>> | null,
    ) => {
      const next: CareIntervalOverrides = { ...overridesRef.current }
      if (tracks && Object.keys(tracks).length > 0) {
        next[knifeId] = tracks
      } else {
        delete next[knifeId]
      }
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ careIntervalOverrides: next }),
      })
      if (!response.ok) {
        const data = await readJsonResponse<{ error?: string }>(response)
        throw new Error(data.error || 'Failed to save care intervals')
      }
      setOverrides(next)
    },
    [],
  )

  const statusById = useMemo(
    () => getCareStatuses(knives, latestByKnife, reminders, overrides, now),
    [knives, latestByKnife, reminders, overrides, now],
  )

  const value = useMemo<CareContextValue>(
    () => ({
      reminders,
      overrides,
      latestByKnife,
      statusById,
      isLoading,
      setKnifeCareIntervals,
    }),
    [
      reminders,
      overrides,
      latestByKnife,
      statusById,
      isLoading,
      setKnifeCareIntervals,
    ],
  )

  return <CareContext.Provider value={value}>{children}</CareContext.Provider>
}

/** Outside a CareProvider every care surface stays hidden. */
const DISABLED_CARE_CONTEXT: CareContextValue = {
  reminders: { ...DEFAULT_MAINTENANCE_REMINDERS, enabled: false },
  overrides: {},
  latestByKnife: new Map(),
  statusById: new Map(),
  isLoading: false,
  setKnifeCareIntervals: async () => {
    throw new Error('Care reminders are unavailable here.')
  },
}

export function useCare(): CareContextValue {
  return useContext(CareContext) ?? DISABLED_CARE_CONTEXT
}

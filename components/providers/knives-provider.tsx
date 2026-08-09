'use client'

import { AlertCircle, CheckCircle2, Cloud } from 'lucide-react'
import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Knife, KnifeDraft, KnifeUpdates } from '@/lib/data'
import type { BulkEditFieldKey } from '@/lib/bulk-edit'
import { CLOUD_AUTH_STATE_EVENT, getCloudAuthState } from '@/lib/cloud-backup'
import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'
import {
  type CardField,
  type CustomField,
  DEFAULT_SETTINGS,
  normalizeCardFields,
  SETTINGS_UPDATED_EVENT,
} from '@/lib/settings-shared'
import {
  canAttemptSilentCloudBackup,
  uploadCloudBackupArchive,
} from '@/lib/cloud-backup-client'

type KnivesDataContextValue = {
  knives: Knife[]
  isLoading: boolean
  compareIds: string[]
  isCloudSyncEnabled: boolean
  isAutoBackupEnabled: boolean
  isAutoBackupActive: boolean
  pinnedItemsFirst: boolean
  cardFields: CardField[]
  customFieldDefinitions: CustomField[]
}

type KnivesActionsContextValue = {
  refreshVault: () => Promise<void>
  addKnife: (draft: KnifeDraft) => Promise<Knife>
  updateKnife: (id: string, updates: KnifeUpdates) => Promise<Knife>
  bulkUpdateKnives: (
    ids: string[],
    field: BulkEditFieldKey,
    value: string,
  ) => Promise<Knife[]>
  deleteKnife: (id: string) => Promise<void>
  addToCompare: (id: string) => Promise<void>
  addManyToCompare: (ids: string[]) => Promise<void>
  removeFromCompare: (id: string) => Promise<void>
  clearCompare: () => Promise<void>
  showFeedback: (message: string, tone?: FeedbackTone) => void
}

type KnivesContextValue = KnivesDataContextValue & KnivesActionsContextValue

type FeedbackTone = 'success' | 'error'

const KnivesDataContext = createContext<KnivesDataContextValue | null>(null)
const KnivesActionsContext = createContext<KnivesActionsContextValue | null>(
  null,
)
const BACKUP_NOTICE_DURATION_MS = 3200
const FEEDBACK_DURATION_MS = 3200

function toImageUrls(draft: KnifeDraft): string[] {
  return draft.images.filter(
    (src): src is string =>
      typeof src === 'string' &&
      (src.startsWith('http') || src.startsWith('data:image')),
  )
}

export function KnivesProvider({ children }: { children: React.ReactNode }) {
  const [knives, setKnives] = useState<Knife[]>([])
  const [compareIds, setCompareIds] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [backupNotice, setBackupNotice] = useState<{
    id: number
    message: string
  } | null>(null)
  const [feedback, setFeedback] = useState<{
    id: number
    message: string
    tone: FeedbackTone
  } | null>(null)
  const [isCloudSyncEnabled, setIsCloudSyncEnabled] = useState(() =>
    Boolean(getCloudAuthState()?.sessionToken),
  )
  const [isAutoBackupEnabled, setIsAutoBackupEnabled] = useState(
    DEFAULT_SETTINGS.cloudAutoBackupEnabled,
  )
  const [pinnedItemsFirst, setPinnedItemsFirst] = useState(
    DEFAULT_SETTINGS.pinnedItemsFirst,
  )
  const [cardFields, setCardFields] = useState<CardField[]>(
    DEFAULT_SETTINGS.cardFields,
  )
  const [customFieldDefinitions, setCustomFieldDefinitions] = useState<
    CustomField[]
  >(DEFAULT_SETTINGS.customFields)
  const backupInFlightRef = useRef(false)
  const pendingBackupRef = useRef(false)
  const runAutoBackupRef = useRef<
    (reason: 'mutation' | 'queued') => Promise<void>
  >(async () => {})

  useEffect(() => {
    let cancelled = false

    const syncCollectionSettings = async () => {
      try {
        const response = await fetch('/api/settings', { cache: 'no-store' })
        const data = await readJsonResponse<{
          error?: string
          settings?: {
            cloudAutoBackupEnabled?: boolean
            pinnedItemsFirst?: boolean
            cardFields?: CardField[]
            customFields?: CustomField[]
          }
        }>(response)
        if (!response.ok) {
          throw new Error(getApiErrorMessage(data, 'Failed to load settings'))
        }

        if (!cancelled) {
          setIsAutoBackupEnabled(Boolean(data.settings?.cloudAutoBackupEnabled))
          setPinnedItemsFirst(Boolean(data.settings?.pinnedItemsFirst))
          setCardFields(normalizeCardFields(data.settings?.cardFields))
          setCustomFieldDefinitions(
            Array.isArray(data.settings?.customFields)
              ? data.settings.customFields
              : DEFAULT_SETTINGS.customFields,
          )
        }
      } catch {
        if (!cancelled) {
          setIsAutoBackupEnabled(DEFAULT_SETTINGS.cloudAutoBackupEnabled)
          setPinnedItemsFirst(DEFAULT_SETTINGS.pinnedItemsFirst)
          setCardFields(DEFAULT_SETTINGS.cardFields)
          setCustomFieldDefinitions(DEFAULT_SETTINGS.customFields)
        }
      }
    }

    const onSettingsUpdated = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          cloudAutoBackupEnabled?: boolean
          pinnedItemsFirst?: boolean
          cardFields?: CardField[]
          customFields?: CustomField[]
        }>
      ).detail
      let didUpdate = false

      if (typeof detail?.cloudAutoBackupEnabled === 'boolean') {
        setIsAutoBackupEnabled(detail.cloudAutoBackupEnabled)
        didUpdate = true
      }

      if (typeof detail?.pinnedItemsFirst === 'boolean') {
        setPinnedItemsFirst(detail.pinnedItemsFirst)
        didUpdate = true
      }

      if (Array.isArray(detail?.cardFields)) {
        setCardFields(normalizeCardFields(detail.cardFields))
        didUpdate = true
      }

      if (Array.isArray(detail?.customFields)) {
        setCustomFieldDefinitions(detail.customFields)
        didUpdate = true
      }

      if (!didUpdate) void syncCollectionSettings()
    }

    void syncCollectionSettings()
    window.addEventListener(
      SETTINGS_UPDATED_EVENT,
      onSettingsUpdated as EventListener,
    )

    return () => {
      cancelled = true
      window.removeEventListener(
        SETTINGS_UPDATED_EVENT,
        onSettingsUpdated as EventListener,
      )
    }
  }, [])

  useEffect(() => {
    const syncCloudAuthState = () => {
      setIsCloudSyncEnabled(Boolean(getCloudAuthState()?.sessionToken))
    }

    syncCloudAuthState()
    window.addEventListener(CLOUD_AUTH_STATE_EVENT, syncCloudAuthState)
    window.addEventListener('storage', syncCloudAuthState)

    return () => {
      window.removeEventListener(CLOUD_AUTH_STATE_EVENT, syncCloudAuthState)
      window.removeEventListener('storage', syncCloudAuthState)
    }
  }, [])

  const showBackupNotice = useCallback((message: string) => {
    startTransition(() => {
      setBackupNotice({
        id: Date.now(),
        message,
      })
    })
  }, [])

  const showFeedback = useCallback(
    (message: string, tone: FeedbackTone = 'success') => {
      startTransition(() => {
        setFeedback({
          id: Date.now(),
          message,
          tone,
        })
      })
    },
    [],
  )

  const runAutoBackup = useCallback(
    async (_reason: 'mutation' | 'queued') => {
      if (!canAttemptSilentCloudBackup()) {
        return
      }

      if (backupInFlightRef.current) {
        pendingBackupRef.current = true
        return
      }

      backupInFlightRef.current = true

      try {
        await uploadCloudBackupArchive()
        showBackupNotice('Backup complete')
      } catch (error) {
        console.error('Automatic cloud backup failed', error)
      } finally {
        backupInFlightRef.current = false

        if (pendingBackupRef.current) {
          pendingBackupRef.current = false
          window.setTimeout(() => {
            void runAutoBackupRef.current('queued')
          }, 0)
        }
      }
    },
    [showBackupNotice],
  )

  useEffect(() => {
    runAutoBackupRef.current = runAutoBackup
  }, [runAutoBackup])

  const scheduleAutoBackup = useCallback(
    (reason: 'mutation') => {
      window.setTimeout(() => {
        void runAutoBackup(reason)
      }, 0)
    },
    [runAutoBackup],
  )

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const [knivesResponse, compareResponse] = await Promise.all([
          fetch('/api/knives'),
          fetch('/api/compare'),
        ])
        const knivesData = await knivesResponse.json()
        const compareData = await compareResponse.json()
        if (!cancelled) {
          if (Array.isArray(knivesData.knives)) {
            setKnives(knivesData.knives)
          }
          if (Array.isArray(compareData.compareIds)) {
            setCompareIds(compareData.compareIds)
          }
        }
      } catch {
        // keep empty state on error
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [])

  const refreshVault = useCallback(async () => {
    const [knivesResponse, compareResponse] = await Promise.all([
      fetch('/api/knives', { cache: 'no-store' }),
      fetch('/api/compare', { cache: 'no-store' }),
    ])
    const knivesData = await knivesResponse.json()
    const compareData = await compareResponse.json()

    if (!knivesResponse.ok) {
      throw new Error(knivesData.error ?? 'Failed to refresh knives')
    }
    if (!compareResponse.ok) {
      throw new Error(compareData.error ?? 'Failed to refresh compare list')
    }

    setKnives(Array.isArray(knivesData.knives) ? knivesData.knives : [])
    setCompareIds(
      Array.isArray(compareData.compareIds) ? compareData.compareIds : [],
    )
  }, [])

  useEffect(() => {
    if (!backupNotice) return

    const timeout = window.setTimeout(() => {
      startTransition(() => {
        setBackupNotice((current) =>
          current?.id === backupNotice.id ? null : current,
        )
      })
    }, BACKUP_NOTICE_DURATION_MS)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [backupNotice])

  useEffect(() => {
    if (!feedback) return

    const timeout = window.setTimeout(() => {
      startTransition(() => {
        setFeedback((current) => (current?.id === feedback.id ? null : current))
      })
    }, FEEDBACK_DURATION_MS)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [feedback])

  const addKnife = useCallback(
    async (draft: KnifeDraft): Promise<Knife> => {
      const response = await fetch('/api/knives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: draft.name,
          brand: draft.brand,
          bladeStyle: draft.bladeStyle,
          handleMaterial: draft.handleMaterial,
          description: draft.description,
          specs: draft.specs,
          customFields: draft.customFields,
          imageUrls: toImageUrls(draft),
          sourceUrl: draft.sourceUrl,
          pinned: draft.pinned,
        }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error ?? 'Failed to save knife')
      }

      const data = await response.json()
      const knife = data.knife as Knife
      setKnives((prev) => [knife, ...prev])
      if (isCloudSyncEnabled && isAutoBackupEnabled) {
        scheduleAutoBackup('mutation')
      }
      return knife
    },
    [isAutoBackupEnabled, isCloudSyncEnabled, scheduleAutoBackup],
  )

  const updateKnife = useCallback(
    async (id: string, updates: KnifeUpdates): Promise<Knife> => {
      const response = await fetch(`/api/knives/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error ?? 'Failed to update knife')
      }

      const data = await response.json()
      const knife = data.knife as Knife
      setKnives((prev) => prev.map((k) => (k.id === id ? knife : k)))
      const hasBackupWorthyUpdate = Object.keys(updates).some(
        (field) => field !== 'pinned',
      )
      if (hasBackupWorthyUpdate && isCloudSyncEnabled && isAutoBackupEnabled) {
        scheduleAutoBackup('mutation')
      }
      return knife
    },
    [isAutoBackupEnabled, isCloudSyncEnabled, scheduleAutoBackup],
  )

  const bulkUpdateKnives = useCallback(
    async (
      ids: string[],
      field: BulkEditFieldKey,
      value: string,
    ): Promise<Knife[]> => {
      const response = await fetch('/api/knives/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, field, value }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error ?? 'Failed to update selected knives')
      }

      const data = await response.json()
      const updatedKnives = data.knives as Knife[]
      const updatedById = new Map(
        updatedKnives.map((knife) => [knife.id, knife]),
      )
      setKnives((prev) =>
        prev.map((knife) => updatedById.get(knife.id) ?? knife),
      )
      if (isCloudSyncEnabled && isAutoBackupEnabled) {
        scheduleAutoBackup('mutation')
      }
      return updatedKnives
    },
    [isAutoBackupEnabled, isCloudSyncEnabled, scheduleAutoBackup],
  )

  const deleteKnife = useCallback(
    async (id: string): Promise<void> => {
      const response = await fetch(`/api/knives/${id}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error ?? 'Failed to delete knife')
      }

      setKnives((prev) => prev.filter((k) => k.id !== id))
      setCompareIds((prev) => prev.filter((cid) => cid !== id))
      if (isCloudSyncEnabled && isAutoBackupEnabled) {
        scheduleAutoBackup('mutation')
      }
    },
    [isAutoBackupEnabled, isCloudSyncEnabled, scheduleAutoBackup],
  )

  // Comparison is transient UI state and intentionally never triggers backup.
  const addToCompare = useCallback(async (id: string): Promise<void> => {
    const response = await fetch('/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })

    if (!response.ok) {
      const data = await response.json()
      throw new Error(data.error ?? 'Failed to add to compare')
    }

    const data = await response.json()
    if (Array.isArray(data.compareIds)) {
      setCompareIds(data.compareIds)
    }
  }, [])

  const addManyToCompare = useCallback(async (ids: string[]): Promise<void> => {
    const response = await fetch('/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })

    if (!response.ok) {
      const data = await response.json()
      throw new Error(data.error ?? 'Failed to add knives to compare')
    }

    const data = await response.json()
    if (Array.isArray(data.compareIds)) {
      setCompareIds(data.compareIds)
    }
  }, [])

  const removeFromCompare = useCallback(async (id: string): Promise<void> => {
    const response = await fetch('/api/compare', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })

    if (!response.ok) {
      const data = await response.json()
      throw new Error(data.error ?? 'Failed to remove from compare')
    }

    const data = await response.json()
    if (Array.isArray(data.compareIds)) {
      setCompareIds(data.compareIds)
    }
  }, [])

  const clearCompare = useCallback(async (): Promise<void> => {
    const response = await fetch('/api/compare', {
      method: 'DELETE',
    })

    if (!response.ok) {
      const data = await response.json()
      throw new Error(data.error ?? 'Failed to clear compare list')
    }

    const data = await response.json()
    if (Array.isArray(data.compareIds)) {
      setCompareIds(data.compareIds)
    }
  }, [])

  const dataValue = useMemo(
    () => ({
      knives,
      isLoading,
      compareIds,
      isCloudSyncEnabled,
      isAutoBackupEnabled,
      isAutoBackupActive: isCloudSyncEnabled && isAutoBackupEnabled,
      pinnedItemsFirst,
      cardFields,
      customFieldDefinitions,
    }),
    [
      knives,
      isLoading,
      compareIds,
      isCloudSyncEnabled,
      isAutoBackupEnabled,
      pinnedItemsFirst,
      cardFields,
      customFieldDefinitions,
    ],
  )

  const actionsValue = useMemo(
    () => ({
      refreshVault,
      addKnife,
      updateKnife,
      bulkUpdateKnives,
      deleteKnife,
      addToCompare,
      addManyToCompare,
      removeFromCompare,
      clearCompare,
      showFeedback,
    }),
    [
      refreshVault,
      addKnife,
      updateKnife,
      bulkUpdateKnives,
      deleteKnife,
      addToCompare,
      addManyToCompare,
      removeFromCompare,
      clearCompare,
      showFeedback,
    ],
  )

  return (
    <KnivesDataContext.Provider value={dataValue}>
      <KnivesActionsContext.Provider value={actionsValue}>
        {children}
        <div
          aria-live="polite"
          className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-3"
        >
          {feedback && (
            <div
              role={feedback.tone === 'error' ? 'alert' : 'status'}
              className={
                feedback.tone === 'error'
                  ? 'flex items-center gap-3 rounded-xl border border-destructive/40 bg-background/95 px-3 py-2.5 text-sm text-destructive shadow-md backdrop-blur'
                  : 'flex items-center gap-3 rounded-xl border border-[var(--bladevault-line)] bg-background/95 px-3 py-2.5 text-sm text-foreground shadow-md backdrop-blur'
              }
            >
              <div
                className={
                  feedback.tone === 'error'
                    ? 'flex h-8 w-8 items-center justify-center rounded-lg bg-destructive/10 text-destructive'
                    : 'flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--bladevault-surface-soft)] text-[var(--bladevault-local)] dark:text-[var(--bladevault-gold)]'
                }
              >
                {feedback.tone === 'error' ? (
                  <AlertCircle className="h-4 w-4" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
              </div>
              <span className="font-medium">{feedback.message}</span>
            </div>
          )}
          {backupNotice && (
            <div className="flex items-center gap-3 rounded-xl border border-[var(--bladevault-line)] bg-background/95 px-3 py-2.5 text-sm text-foreground shadow-md backdrop-blur">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--bladevault-surface-soft)] text-[var(--bladevault-local)] dark:text-[var(--bladevault-gold)]">
                <CheckCircle2 className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 font-medium">
                  <Cloud className="h-4 w-4 text-[var(--bladevault-local)] dark:text-[var(--bladevault-gold)]" />
                  <span>{backupNotice.message}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Your vault was synced in the background.
                </p>
              </div>
            </div>
          )}
        </div>
      </KnivesActionsContext.Provider>
    </KnivesDataContext.Provider>
  )
}

export function useKnivesData(): KnivesDataContextValue {
  const context = useContext(KnivesDataContext)
  if (!context) {
    throw new Error('useKnivesData must be used within a KnivesProvider')
  }
  return context
}

export function useKnivesActions(): KnivesActionsContextValue {
  const context = useContext(KnivesActionsContext)
  if (!context) {
    throw new Error('useKnivesActions must be used within a KnivesProvider')
  }
  return context
}

export function useKnives(): KnivesContextValue {
  return { ...useKnivesData(), ...useKnivesActions() }
}

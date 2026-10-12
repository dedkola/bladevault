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
import { AlertCircle, CloudDownload, Loader2 } from 'lucide-react'
import {
  createVaultFetchGuard,
  getCloudRestoreJob,
  getVaultStatus,
  startCloudRestore,
} from '@/lib/cloud-restore-client'
import {
  IDLE_CLOUD_RESTORE_JOB,
  type CloudRestoreJobState,
} from '@/lib/cloud-restore-shared'
import {
  INITIAL_VAULT_CLIENT_STATE,
  VAULT_CLIENT_STATE_EVENT,
  getVaultClientState,
  setVaultClientState,
  subscribeVaultClientState,
  type VaultClientState,
} from '@/lib/vault-client-state'

type RestoreContextValue = {
  job: CloudRestoreJobState
  readOnly: boolean
  startRestore: () => Promise<void>
}

const RestoreContext = createContext<RestoreContextValue | null>(null)
const RECOVERY_MESSAGE =
  'Restart BladeVault to retry recovery. Your existing data is protected.'

export function VaultRestoreProvider({
  children,
  initialStatus,
}: {
  children: React.ReactNode
  initialStatus: VaultClientState
}) {
  const [job, setJob] = useState(IDLE_CLOUD_RESTORE_JOB)
  const [refreshing, setRefreshing] = useState(false)
  const status = useSyncExternalStore(
    subscribeVaultClientState,
    getVaultClientState,
    () => INITIAL_VAULT_CLIENT_STATE,
  )
  const ready = status.generation !== null
  const startingRef = useRef(false)
  const reloadingRef = useRef(false)
  const originalFetchRef = useRef<typeof fetch | null>(null)
  const startupStatusRef = useRef(initialStatus)

  const reloadRestoredVault = useCallback(async (generation: string | null) => {
    if (reloadingRef.current) return
    reloadingRef.current = true
    setVaultClientState({
      ...getVaultClientState(),
      generation,
      phase: 'switching',
      readOnly: true,
    })
    setRefreshing(true)
    const detail = window.location.pathname.match(/^\/collection\/([^/]+)\/?$/)
    if (detail) {
      const controller = new AbortController()
      const timeout = window.setTimeout(() => controller.abort(), 3_000)
      try {
        const response = await (originalFetchRef.current ?? window.fetch)(
          `/api/knives/${detail[1]}`,
          { cache: 'no-store', signal: controller.signal },
        )
        if (response.status === 404) {
          window.location.replace('/collection')
          return
        }
      } catch {
        // Reloading lets the current route retry once the server is reachable.
      } finally {
        window.clearTimeout(timeout)
      }
    }
    window.location.reload()
  }, [])

  useEffect(() => {
    let active = true
    let timer: number | undefined
    let checking = false
    setVaultClientState(startupStatusRef.current)
    const originalFetch = window.fetch
    originalFetchRef.current = originalFetch
    const guardedFetch = createVaultFetchGuard(originalFetch, {
      origin: window.location.origin,
      isActive: () => active,
      onGenerationChange: (generation) => void reloadRestoredVault(generation),
    })
    window.fetch = guardedFetch
    const check = async () => {
      if (checking || !active || reloadingRef.current || startingRef.current)
        return
      checking = true
      try {
        const next = await getVaultStatus()
        if (!active || startingRef.current) return
        const previous = getVaultClientState()
        if (previous.generation && next.generation !== previous.generation) {
          void reloadRestoredVault(next.generation)
          return
        }
        setVaultClientState(next)
        const nextJob = await getCloudRestoreJob()
        if (!active || startingRef.current) return
        setJob((current) =>
          (current.status === 'error' &&
            current.id === null &&
            nextJob.status !== 'running') ||
          (current.id === nextJob.id &&
            current.status === nextJob.status &&
            current.phase === nextJob.phase &&
            current.message === nextJob.message &&
            current.restoredAt === nextJob.restoredAt)
            ? current
            : nextJob,
        )
      } catch {
        // Temporary disconnection does not cancel a server-owned restore. App
        // lock responses are handled by the existing unlock-session guard.
      } finally {
        checking = false
      }
    }
    const poll = async () => {
      await check()
      if (!active || reloadingRef.current) return
      window.clearTimeout(timer)
      timer = window.setTimeout(
        () => void poll(),
        getVaultClientState().readOnly ? 1_000 : 5_000,
      )
    }
    const onFocus = () => void check()
    const onVaultState = () => {
      if (!getVaultClientState().readOnly || !active) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void poll(), 1_000)
    }
    void poll()
    window.addEventListener('focus', onFocus)
    window.addEventListener(VAULT_CLIENT_STATE_EVENT, onVaultState)
    return () => {
      active = false
      window.clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener(VAULT_CLIENT_STATE_EVENT, onVaultState)
      if (window.fetch === guardedFetch) window.fetch = originalFetch
    }
  }, [reloadRestoredVault])

  const startRestore = useCallback(async () => {
    if (startingRef.current || getVaultClientState().readOnly) return
    startingRef.current = true
    const previous = getVaultClientState()
    setVaultClientState({ ...previous, phase: 'preparing', readOnly: true })
    const preparing: CloudRestoreJobState = {
      ...IDLE_CLOUD_RESTORE_JOB,
      status: 'running',
      phase: 'downloading',
    }
    setJob(preparing)
    try {
      const { job: nextJob } = await startCloudRestore()
      setJob(nextJob)
      if (nextJob.status !== 'running') {
        const next = await getVaultStatus()
        if (previous.generation && next.generation !== previous.generation) {
          void reloadRestoredVault(next.generation)
        } else {
          setVaultClientState(next)
        }
      }
    } catch (error) {
      const failure: CloudRestoreJobState = {
        ...IDLE_CLOUD_RESTORE_JOB,
        status: 'error',
        message:
          error instanceof Error ? error.message : 'Could not start restore.',
      }
      setJob(failure)
      try {
        const next = await getVaultStatus()
        if (previous.generation && next.generation !== previous.generation) {
          void reloadRestoredVault(next.generation)
        } else {
          setVaultClientState(next)
        }
      } catch {
        // Preserve read-only protection until the server can confirm its state.
      }
    } finally {
      startingRef.current = false
    }
  }, [reloadRestoredVault])

  const context = useMemo(
    () => ({ job, readOnly: status.readOnly, startRestore }),
    [job, status.readOnly, startRestore],
  )
  const applying = status.phase === 'switching' || refreshing

  return (
    <RestoreContext.Provider value={context}>
      {ready ? (
        <>
          <div className="contents" inert={applying} aria-busy={applying}>
            {children}
          </div>
          {status.readOnly && !applying ? (
            <div
              role="status"
              className="fixed bottom-4 left-1/2 z-40 flex w-[min(30rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-2 rounded-lg border bg-background px-3 py-2 text-xs text-muted-foreground shadow-sm"
            >
              <CloudDownload className="size-4 shrink-0" />
              <span>
                {status.recoveryRequired
                  ? RECOVERY_MESSAGE
                  : 'Restoring cloud backup. You can browse; editing is paused.'}
              </span>
            </div>
          ) : null}
          {applying ? (
            <div
              role="status"
              aria-live="polite"
              className="fixed inset-0 z-[100] flex items-center justify-center bg-background/85 backdrop-blur-sm"
            >
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                {status.recoveryRequired ? (
                  <>
                    <AlertCircle className="size-4 shrink-0" />
                    <span>{RECOVERY_MESSAGE}</span>
                  </>
                ) : (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Applying restored vault…
                  </>
                )}
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <div
          role="status"
          className="flex min-h-dvh flex-1 items-center justify-center text-sm text-muted-foreground"
        >
          Loading your vault…
        </div>
      )}
    </RestoreContext.Provider>
  )
}

export function useVaultRestore(): RestoreContextValue {
  const context = useContext(RestoreContext)
  if (!context)
    throw new Error('useVaultRestore must be used inside VaultRestoreProvider')
  return context
}

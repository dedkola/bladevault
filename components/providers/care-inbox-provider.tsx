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
  applyCareNotificationAction,
  getCareNotificationBox,
  isCareNotificationUnread,
  mergeCareNotificationChanges,
  type CareNotification,
  type CareNotificationAction,
  type CareNotificationBox,
} from '@/lib/care-notifications'
import { MAINTENANCE_UPDATED_EVENT } from '@/lib/maintenance-due'
import type { MaintenanceEventInput } from '@/lib/data'
import type { CareTrack } from '@/lib/settings-shared'
import { useCare } from '@/components/providers/care-provider'

type CareInboxContextValue = {
  /** False while reminders are off; inbox surfaces hide themselves. */
  enabled: boolean
  isLoading: boolean
  notifications: readonly CareNotification[]
  /** Clock used to decide which messages are snoozed; ticks every minute. */
  now: Date
  unreadCount: number
  counts: Record<CareNotificationBox, number>
  act: (action: CareNotificationAction) => Promise<void>
  /** Logs the care for today, which resolves the message on the next sync. */
  logCare: (knifeId: string, track: CareTrack) => Promise<void>
}

const CareInboxContext = createContext<CareInboxContextValue | null>(null)

async function requestInbox(init: RequestInit): Promise<CareNotification[]> {
  const response = await fetch('/api/care-inbox', {
    cache: 'no-store',
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  })
  const data = await readJsonResponse<{
    notifications?: CareNotification[]
    error?: string
  }>(response)
  if (!response.ok || !Array.isArray(data.notifications)) {
    throw new Error(data.error || 'Could not update the care inbox')
  }
  return data.notifications
}

export function CareInboxProvider({ children }: { children: React.ReactNode }) {
  const { reminders, statusById, isLoading: careLoading } = useCare()
  const enabled = reminders.enabled
  const [notifications, setNotifications] = useState<CareNotification[]>([])
  const [hasSynced, setHasSynced] = useState(false)
  const [now, setNow] = useState(() => new Date())
  const notificationsRef = useRef(notifications)

  useEffect(() => {
    notificationsRef.current = notifications
  }, [notifications])

  // Care status changes on load, after maintenance edits, settings changes and
  // at midnight; each change syncs the stored inbox on the server.
  useEffect(() => {
    if (careLoading || !enabled) return
    let cancelled = false
    const timer = window.setTimeout(async () => {
      try {
        const next = await requestInbox({ method: 'POST' })
        if (cancelled) return
        setNotifications(next)
        setNow(new Date())
      } catch {
        // Keep the last inbox; the next status change retries.
      } finally {
        if (!cancelled) setHasSynced(true)
      }
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [careLoading, enabled, statusById])

  // Snoozed messages come back on their own; a minute tick is precise enough.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const act = useCallback(async (action: CareNotificationAction) => {
    const at = new Date()
    const previous = notificationsRef.current
    setNotifications(
      mergeCareNotificationChanges(
        previous,
        {
          create: [],
          update: applyCareNotificationAction(previous, action, at),
          deleteIds: [],
        },
        new Set(previous.map((row) => row.knifeId)),
      ),
    )
    setNow(at)
    try {
      setNotifications(
        await requestInbox({ method: 'PATCH', body: JSON.stringify(action) }),
      )
    } catch (error) {
      setNotifications(previous)
      throw error
    }
  }, [])

  const logCare = useCallback(async (knifeId: string, track: CareTrack) => {
    const input: MaintenanceEventInput = {
      type: track,
      occurredAt: new Date().toISOString(),
      notes: '',
    }
    const response = await fetch(
      `/api/knives/${encodeURIComponent(knifeId)}/maintenance`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    )
    if (!response.ok) {
      const data = await readJsonResponse<{ error?: string }>(response)
      throw new Error(data.error || 'Could not log the care')
    }
    // Care status refreshes, which syncs the inbox and resolves the message.
    window.dispatchEvent(new Event(MAINTENANCE_UPDATED_EVENT))
  }, [])

  const value = useMemo<CareInboxContextValue>(() => {
    const counts: Record<CareNotificationBox, number> = {
      open: 0,
      snoozed: 0,
      done: 0,
    }
    let unreadCount = 0
    for (const row of notifications) {
      counts[getCareNotificationBox(row, now)] += 1
      if (isCareNotificationUnread(row, now)) unreadCount += 1
    }
    return {
      enabled,
      isLoading: enabled && !hasSynced,
      notifications,
      now,
      unreadCount: enabled ? unreadCount : 0,
      counts,
      act,
      logCare,
    }
  }, [enabled, hasSynced, notifications, now, act, logCare])

  return (
    <CareInboxContext.Provider value={value}>
      {children}
    </CareInboxContext.Provider>
  )
}

const DISABLED_INBOX: CareInboxContextValue = {
  enabled: false,
  isLoading: false,
  notifications: [],
  now: new Date(0),
  unreadCount: 0,
  counts: { open: 0, snoozed: 0, done: 0 },
  act: async () => {
    throw new Error('The care inbox is unavailable here.')
  },
  logCare: async () => {
    throw new Error('The care inbox is unavailable here.')
  },
}

export function useCareInbox(): CareInboxContextValue {
  return useContext(CareInboxContext) ?? DISABLED_INBOX
}

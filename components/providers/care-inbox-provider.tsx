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
import {
  applySystemMessageAction,
  getSystemMessageBox,
  isSystemMessageUnread,
  mergeSystemMessageChanges,
  type SystemMessage,
  type SystemMessageAction,
  type SystemMessageBox,
} from '@/lib/system-messages'
import type { MaintenanceEventInput } from '@/lib/data'
import type { CareTrack } from '@/lib/settings-shared'
import { useCare } from '@/components/providers/care-provider'
import { useKnives } from '@/components/providers/knives-provider'

type CareInboxContextValue = {
  /** False while care reminders are off; care messages hide themselves. */
  enabled: boolean
  /** True when there is anything to show: care reminders or system messages. */
  visible: boolean
  isLoading: boolean
  notifications: readonly CareNotification[]
  /** App events such as failed backups, independent of care reminders. */
  systemMessages: readonly SystemMessage[]
  /** Clock used to decide which messages are snoozed; ticks every minute. */
  now: Date
  /** Unread care and system messages together. */
  unreadCount: number
  careUnreadCount: number
  systemUnreadCount: number
  counts: Record<CareNotificationBox, number>
  systemCounts: Record<SystemMessageBox, number>
  act: (action: CareNotificationAction) => Promise<void>
  actSystem: (action: SystemMessageAction) => Promise<void>
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

async function requestSystemMessages(
  init: RequestInit = {},
): Promise<SystemMessage[]> {
  const response = await fetch('/api/system-messages', {
    cache: 'no-store',
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  })
  const data = await readJsonResponse<{
    messages?: SystemMessage[]
    error?: string
  }>(response)
  if (!response.ok || !Array.isArray(data.messages)) {
    throw new Error(data.error || 'Could not update the inbox')
  }
  return data.messages
}

export function CareInboxProvider({ children }: { children: React.ReactNode }) {
  const { reminders, statusById, isLoading: careLoading } = useCare()
  const enabled = reminders.enabled
  const [notifications, setNotifications] = useState<CareNotification[]>([])
  const [hasSynced, setHasSynced] = useState(false)
  const [now, setNow] = useState(() => new Date())
  const notificationsRef = useRef(notifications)
  const { cloudBackupJob } = useKnives()
  const [systemMessages, setSystemMessages] = useState<SystemMessage[]>([])
  const systemMessagesRef = useRef(systemMessages)

  useEffect(() => {
    notificationsRef.current = notifications
  }, [notifications])

  useEffect(() => {
    systemMessagesRef.current = systemMessages
  }, [systemMessages])

  // System messages come from the server's background work (backups), so
  // reload them on start, when a backup ends and when the window regains focus.
  const backupSettled = cloudBackupJob.status !== 'running'
  useEffect(() => {
    if (!backupSettled) return
    let cancelled = false
    const load = async () => {
      try {
        const next = await requestSystemMessages()
        if (!cancelled) setSystemMessages(next)
      } catch {
        // Keep the last messages; the next focus or backup retries.
      }
    }
    void load()
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
    }
  }, [backupSettled, cloudBackupJob.id])

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

  const actSystem = useCallback(async (action: SystemMessageAction) => {
    const previous = systemMessagesRef.current
    setSystemMessages(
      mergeSystemMessageChanges(previous, {
        create: [],
        update: applySystemMessageAction(previous, action, new Date()),
        deleteIds: [],
      }),
    )
    try {
      setSystemMessages(
        await requestSystemMessages({
          method: 'PATCH',
          body: JSON.stringify(action),
        }),
      )
    } catch (error) {
      setSystemMessages(previous)
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
    let careUnreadCount = 0
    for (const row of notifications) {
      counts[getCareNotificationBox(row, now)] += 1
      if (isCareNotificationUnread(row, now)) careUnreadCount += 1
    }
    const systemCounts: Record<SystemMessageBox, number> = { open: 0, done: 0 }
    let systemUnreadCount = 0
    for (const row of systemMessages) {
      systemCounts[getSystemMessageBox(row)] += 1
      if (isSystemMessageUnread(row)) systemUnreadCount += 1
    }
    if (!enabled) careUnreadCount = 0
    return {
      enabled,
      visible: enabled || systemMessages.length > 0,
      isLoading: enabled && !hasSynced,
      notifications,
      systemMessages,
      now,
      unreadCount: careUnreadCount + systemUnreadCount,
      careUnreadCount,
      systemUnreadCount,
      counts,
      systemCounts,
      act,
      actSystem,
      logCare,
    }
  }, [
    enabled,
    hasSynced,
    notifications,
    systemMessages,
    now,
    act,
    actSystem,
    logCare,
  ])

  return (
    <CareInboxContext.Provider value={value}>
      {children}
    </CareInboxContext.Provider>
  )
}

const DISABLED_INBOX: CareInboxContextValue = {
  enabled: false,
  visible: false,
  isLoading: false,
  notifications: [],
  systemMessages: [],
  now: new Date(0),
  unreadCount: 0,
  careUnreadCount: 0,
  systemUnreadCount: 0,
  counts: { open: 0, snoozed: 0, done: 0 },
  systemCounts: { open: 0, done: 0 },
  act: async () => {
    throw new Error('The care inbox is unavailable here.')
  },
  actSystem: async () => {
    throw new Error('The inbox is unavailable here.')
  },
  logCare: async () => {
    throw new Error('The care inbox is unavailable here.')
  },
}

export function useCareInbox(): CareInboxContextValue {
  return useContext(CareInboxContext) ?? DISABLED_INBOX
}

'use client'

import { useCallback, useEffect, useState } from 'react'
import { AuditLogEvent } from '@/lib/data'
import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'

const AUDIT_LOG_CHANGED_EVENT = 'bladevault:audit-log-changed'

async function fetchAuditLog(): Promise<AuditLogEvent[]> {
  const response = await fetch('/api/logs', { cache: 'no-store' })
  const data = await readJsonResponse<{
    events?: AuditLogEvent[]
    error?: string
  }>(response)
  if (!response.ok) {
    throw new Error(getApiErrorMessage(data, 'Failed to load logs'))
  }
  return data.events ?? []
}

export function useAuditLog() {
  const [events, setEvents] = useState<AuditLogEvent[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const loaded = await fetchAuditLog()
    setEvents(loaded)
  }, [])

  const clear = useCallback(async () => {
    const response = await fetch('/api/logs', { method: 'DELETE' })
    const data = await readJsonResponse<{ error?: string }>(response)
    if (!response.ok) {
      throw new Error(getApiErrorMessage(data, 'Failed to clear logs'))
    }
    window.dispatchEvent(new Event(AUDIT_LOG_CHANGED_EVENT))
    const loaded = await fetchAuditLog()
    setEvents(loaded)
  }, [])

  useEffect(() => {
    let cancelled = false

    fetchAuditLog()
      .then((loaded) => {
        if (!cancelled) setEvents(loaded)
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : 'Failed to load logs',
          )
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const handleChange = () => {
      void load()
    }
    window.addEventListener(AUDIT_LOG_CHANGED_EVENT, handleChange)
    return () => {
      window.removeEventListener(AUDIT_LOG_CHANGED_EVENT, handleChange)
    }
  }, [load])

  return {
    events,
    count: events.length,
    isLoading,
    error,
    refetch: load,
    clear,
  }
}

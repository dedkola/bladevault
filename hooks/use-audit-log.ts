'use client'

import { useEffect, useState } from 'react'
import { AuditLogEvent } from '@/lib/data'
import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'

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

  return {
    events,
    count: events.length,
    isLoading,
    error,
  }
}

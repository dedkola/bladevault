'use client'

import { useEffect, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import {
  MaintenanceEvent,
  MaintenanceEventInput,
  MaintenanceType,
  maintenanceTypeLabel,
} from '@/lib/data'
import { readJsonResponse } from '@/lib/api-response'
import { MaintenanceForm } from '@/components/maintenance/maintenance-form'
import { MaintenanceQuickActions } from '@/components/maintenance/quick-actions'
import {
  MaintenanceSummary,
  MaintenanceSummarySkeleton,
} from '@/components/maintenance/maintenance-summary'
import { MaintenanceTimeline } from '@/components/maintenance/maintenance-timeline'
import { useKnives } from '@/components/providers/knives-provider'

function upsertMaintenanceEvent(
  events: MaintenanceEvent[],
  event: MaintenanceEvent,
): MaintenanceEvent[] {
  return [...events.filter((item) => item.id !== event.id), event].sort(
    (left, right) =>
      right.occurredAt.localeCompare(left.occurredAt) || right.id - left.id,
  )
}

export function MaintenanceSection({ knifeId }: { knifeId: string }) {
  const { scheduleVaultBackup } = useKnives()
  const [events, setEvents] = useState<MaintenanceEvent[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [editingEvent, setEditingEvent] = useState<
    MaintenanceEvent | undefined
  >()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState('')

  useEffect(() => {
    let cancelled = false

    async function fetchEvents() {
      setIsLoading(true)
      setError(null)
      try {
        const response = await fetch(`/api/knives/${knifeId}/maintenance`, {
          cache: 'no-store',
        })
        const data = await readJsonResponse<{
          error?: string
          events?: MaintenanceEvent[]
        }>(response)
        if (cancelled) return
        if (!response.ok) {
          throw new Error(data.error || 'Failed to load maintenance history')
        }
        setEvents(data.events ?? [])
      } catch (err) {
        if (cancelled) return
        setError(
          err instanceof Error
            ? err.message
            : 'Failed to load maintenance history',
        )
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    fetchEvents()
    return () => {
      cancelled = true
    }
  }, [knifeId])

  const handleQuickAdd = async (type: MaintenanceType) => {
    setError(null)
    setStatusMessage('')
    try {
      const input: MaintenanceEventInput = {
        type,
        occurredAt: new Date().toISOString(),
        notes: '',
      }

      const response = await fetch(`/api/knives/${knifeId}/maintenance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      const data = await readJsonResponse<{
        error?: string
        event?: MaintenanceEvent
      }>(response)
      if (!response.ok) {
        throw new Error(data.error || 'Failed to log maintenance')
      }
      if (!data.event) {
        throw new Error('Maintenance was saved but no entry was returned')
      }
      setEvents((current) => upsertMaintenanceEvent(current, data.event!))
      scheduleVaultBackup()
      setStatusMessage(`${maintenanceTypeLabel(type)} today`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to log maintenance')
    }
  }

  const handleSubmit = async (input: MaintenanceEventInput) => {
    setIsSubmitting(true)
    setSubmitError(null)
    try {
      if (editingEvent) {
        const response = await fetch(
          `/api/knives/${knifeId}/maintenance/${editingEvent.id}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...input,
              sharpeningDetails: input.sharpeningDetails ?? null,
            }),
          },
        )
        const data = await readJsonResponse<{
          error?: string
          event?: MaintenanceEvent
        }>(response)
        if (!response.ok) {
          throw new Error(data.error || 'Failed to update maintenance')
        }
        if (!data.event) {
          throw new Error('Maintenance was updated but no entry was returned')
        }
        setEvents((current) => upsertMaintenanceEvent(current, data.event!))
        scheduleVaultBackup()
      } else {
        const response = await fetch(`/api/knives/${knifeId}/maintenance`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        })
        const data = await readJsonResponse<{
          error?: string
          event?: MaintenanceEvent
        }>(response)
        if (!response.ok) {
          throw new Error(data.error || 'Failed to add maintenance')
        }
        if (!data.event) {
          throw new Error('Maintenance was saved but no entry was returned')
        }
        setEvents((current) => upsertMaintenanceEvent(current, data.event!))
        scheduleVaultBackup()
      }

      setIsFormOpen(false)
      setEditingEvent(undefined)
      setStatusMessage(
        editingEvent ? 'Maintenance entry updated' : 'Maintenance entry added',
      )
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : 'Failed to save maintenance',
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleEdit = (event: MaintenanceEvent) => {
    setEditingEvent(event)
    setIsFormOpen(true)
  }

  const handleDelete = async (event: MaintenanceEvent) => {
    setError(null)
    setStatusMessage('')
    try {
      const response = await fetch(
        `/api/knives/${knifeId}/maintenance/${event.id}`,
        {
          method: 'DELETE',
        },
      )
      if (!response.ok) {
        const data = await readJsonResponse<{ error?: string }>(response)
        throw new Error(data.error || 'Failed to delete maintenance')
      }
      setEvents((current) => current.filter((item) => item.id !== event.id))
      scheduleVaultBackup()
      setStatusMessage('Maintenance entry deleted')
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to delete maintenance',
      )
    }
  }

  const handleOpenForm = () => {
    setEditingEvent(undefined)
    setIsFormOpen(true)
  }

  const handleFormOpenChange = (open: boolean) => {
    setIsFormOpen(open)
    if (!open) {
      setEditingEvent(undefined)
      setSubmitError(null)
    }
  }

  return (
    <section className="overflow-hidden rounded-xl border border-[var(--bladevault-line)] bg-background shadow-none">
      <p className="sr-only" role="status" aria-live="polite">
        {statusMessage}
      </p>
      <div className="border-b border-[var(--bladevault-line)] bg-[color:var(--bladevault-surface-soft)]/70 px-4 py-3 dark:border-[#d3c097]/30">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <div className="text-sm font-medium">Maintenance</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              Care history and quick logging
            </div>
          </div>
          <MaintenanceQuickActions
            onQuickAdd={handleQuickAdd}
            onOpenForm={handleOpenForm}
          />
        </div>
      </div>

      <div className="p-4 space-y-6">
        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {isLoading ? (
          <MaintenanceSummarySkeleton />
        ) : (
          <>
            <MaintenanceSummary events={events} />
            <MaintenanceTimeline
              events={events}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          </>
        )}
      </div>

      <MaintenanceForm
        key={editingEvent?.id ?? 'new'}
        open={isFormOpen}
        onOpenChange={handleFormOpenChange}
        event={editingEvent}
        onSubmit={handleSubmit}
        isSubmitting={isSubmitting}
        error={submitError}
      />
    </section>
  )
}

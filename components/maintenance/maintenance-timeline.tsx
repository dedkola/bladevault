'use client'

import { useState } from 'react'
import { Check, Loader2, Pencil, Trash2 } from 'lucide-react'
import {
  MaintenanceEvent,
  MaintenanceType,
  maintenanceTypeLabel,
} from '@/lib/data'
import { Button } from '@/components/ui/button'

function formatDate(isoString: string): string {
  try {
    return new Date(isoString).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return isoString
  }
}

function groupEventsByDate(events: MaintenanceEvent[]) {
  const groups = new Map<string, MaintenanceEvent[]>()
  for (const event of events) {
    const key = formatDate(event.occurredAt)
    const existing = groups.get(key) ?? []
    existing.push(event)
    groups.set(key, existing)
  }
  return [...groups.entries()]
}

function formatSharpeningDetails(event: MaintenanceEvent): string | null {
  if (!event.sharpeningDetails) return null
  const details = event.sharpeningDetails
  const parts: string[] = []
  if (details.grit) parts.push(`${details.grit} grit`)
  if (details.system) parts.push(details.system)
  if (details.ceramic) parts.push(`ceramic: ${details.ceramic}`)
  if (details.strop) parts.push(`strop: ${details.strop}`)
  if (details.compound) parts.push(`compound: ${details.compound}`)
  if (details.angle) parts.push(`${details.angle}`)
  if (details.passes !== undefined) parts.push(`${details.passes} passes`)
  if (details.notes) parts.push(details.notes)
  return parts.length > 0 ? parts.join(' · ') : null
}

export function MaintenanceTimeline({
  events,
  onEdit,
  onDelete,
}: {
  events: MaintenanceEvent[]
  onEdit: (event: MaintenanceEvent) => void
  onDelete: (event: MaintenanceEvent) => Promise<void>
}) {
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const grouped = groupEventsByDate(events)

  const handleDelete = async (event: MaintenanceEvent) => {
    if (!window.confirm('Delete this maintenance entry?')) return
    setDeletingId(event.id)
    try {
      await onDelete(event)
    } finally {
      setDeletingId(null)
    }
  }

  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center text-center py-8">
        <div className="w-12 h-12 rounded-full bg-[color:var(--bladevault-surface-soft)] border border-[var(--bladevault-line)] flex items-center justify-center mb-3">
          <svg
            className="w-6 h-6 text-muted-foreground"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
            />
          </svg>
        </div>
        <h3 className="text-sm font-medium">No maintenance recorded yet</h3>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          Keep track of cleaning, lubrication, sharpening, and more so you
          always know when this knife was last cared for.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        History
      </h4>

      {grouped.map(([date, dateEvents]) => (
        <div key={date} className="flex gap-4">
          <div className="flex flex-col items-center">
            <div className="w-2 h-2 rounded-full bg-[var(--bladevault-gold)]" />
            <div className="w-px flex-1 bg-[var(--bladevault-line)]/60 my-1" />
          </div>
          <div className="flex-1 pb-5">
            <div className="flex items-baseline justify-between gap-2">
              <div className="text-sm font-medium">{date}</div>
            </div>
            <ul className="mt-1.5 space-y-1">
              {dateEvents.map((event) => {
                const details = formatSharpeningDetails(event)
                const isDeleting = deletingId === event.id
                return (
                  <li
                    key={event.id}
                    className="flex items-start justify-between gap-2 group"
                  >
                    <div className="flex items-start gap-2 text-sm text-foreground min-w-0">
                      <Check className="w-4 h-4 text-[var(--bladevault-local)] shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <span>{maintenanceTypeLabel(event.type)}</span>
                        {event.notes && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {event.notes}
                          </p>
                        )}
                        {details && (
                          <p className="text-xs text-muted-foreground mt-0.5 bg-[color:var(--bladevault-surface-soft)]/40 rounded-md px-2 py-1.5 border border-[var(--bladevault-line)]/50">
                            {details}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => onEdit(event)}
                        aria-label="Edit maintenance entry"
                        className="size-8 sm:size-6"
                      >
                        <Pencil className="size-3.5 sm:size-3" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => handleDelete(event)}
                        disabled={isDeleting}
                        aria-label="Delete maintenance entry"
                        className="size-8 text-destructive hover:text-destructive sm:size-6"
                      >
                        {isDeleting ? (
                          <Loader2 className="size-3.5 animate-spin sm:size-3" />
                        ) : (
                          <Trash2 className="size-3.5 sm:size-3" />
                        )}
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      ))}
    </div>
  )
}

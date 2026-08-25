'use client'

import {
  MaintenanceEvent,
  MaintenanceType,
  maintenanceTypeLabel,
} from '@/lib/data'

const summaryItems: {
  type: MaintenanceType
  key: 'cleaned' | 'lubricated' | 'sharpened' | 'disassembled'
  label: string
}[] = [
  { type: 'cleaning', key: 'cleaned', label: 'Last cleaned' },
  { type: 'lubrication', key: 'lubricated', label: 'Last lubricated' },
  { type: 'sharpening', key: 'sharpened', label: 'Last sharpened' },
  { type: 'disassembly', key: 'disassembled', label: 'Last disassembled' },
]

function formatDate(isoString: string | null | undefined): string {
  if (!isoString) return 'Never'
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

export function MaintenanceSummary({ events }: { events: MaintenanceEvent[] }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {summaryItems.map(({ type, key, label }) => {
        const event = events.find((e) => e.type === type)
        return (
          <div
            key={key}
            className="rounded-lg border border-[var(--bladevault-line)]/70 bg-[color:var(--bladevault-surface-soft)]/40 px-3 py-2.5"
          >
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              {label}
            </div>
            <div className="text-sm font-medium mt-0.5">
              {formatDate(event?.occurredAt)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function getLastDoneDates(events: MaintenanceEvent[]) {
  return {
    cleaned: events.find((e) => e.type === 'cleaning')?.occurredAt ?? null,
    lubricated:
      events.find((e) => e.type === 'lubrication')?.occurredAt ?? null,
    sharpened: events.find((e) => e.type === 'sharpening')?.occurredAt ?? null,
    disassembled:
      events.find((e) => e.type === 'disassembly')?.occurredAt ?? null,
  }
}

export function MaintenanceSummarySkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3">
      {summaryItems.map(({ key }) => (
        <div
          key={key}
          className="rounded-lg border border-[var(--bladevault-line)]/70 bg-[color:var(--bladevault-surface-soft)]/40 px-3 py-2.5 animate-pulse"
        >
          <div className="h-3 w-20 bg-muted rounded" />
          <div className="mt-1.5 h-4 w-24 bg-muted rounded" />
        </div>
      ))}
    </div>
  )
}

export { maintenanceTypeLabel }

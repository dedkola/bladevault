'use client'

import type { MaintenanceEvent, MaintenanceType } from '@/lib/data'
import { useCare } from '@/components/providers/care-provider'
import { useKnives } from '@/components/providers/knives-provider'
import { careToneTextClass } from '@/components/care-badge'
import {
  formatDaysAgo,
  formatTrackDueLine,
  getKnifeCareStatus,
  type LatestByType,
} from '@/lib/maintenance-due'
import { cn } from '@/lib/utils'

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

export function MaintenanceSummary({
  knifeId,
  events,
}: {
  knifeId: string
  events: MaintenanceEvent[]
}) {
  const { reminders, overrides } = useCare()
  const { knives } = useKnives()
  const isSkipped =
    reminders.skipSoldKnives &&
    Boolean(knives.find((knife) => knife.id === knifeId)?.sold)

  // Compute from the section's own events so fresh entries show immediately.
  const latestByType: LatestByType = {}
  for (const event of events) {
    const previous = latestByType[event.type]
    if (!previous || event.occurredAt > previous) {
      latestByType[event.type] = event.occurredAt
    }
  }
  const careStatus =
    reminders.enabled && !isSkipped
      ? getKnifeCareStatus(
          knifeId,
          latestByType,
          reminders,
          overrides[knifeId],
          new Date(),
        )
      : null

  return (
    <div className="grid grid-cols-2 gap-3">
      {summaryItems.map(({ type, key, label }) => {
        const event = events.find((e) => e.type === type)
        const track = careStatus?.tracks.find((item) => item.track === type)
        const exactDate = formatDate(event?.occurredAt)
        return (
          <div
            key={key}
            data-care-tile={track?.level}
            className={cn(
              'rounded-lg border border-[var(--bladevault-line)]/70 bg-[color:var(--bladevault-surface-soft)]/40 px-3 py-2.5',
              track?.level === 'due-soon' && 'border-amber-500/50',
              track?.level === 'overdue' && 'border-red-500/60',
            )}
          >
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              {label}
            </div>
            <div className="text-sm font-medium mt-0.5" title={exactDate}>
              {track && track.daysSince !== null
                ? formatDaysAgo(track.daysSince)
                : exactDate}
            </div>
            {track ? (
              <div
                className={cn(
                  'mt-0.5 text-xs',
                  track.daysSince === null
                    ? 'text-muted-foreground'
                    : careToneTextClass(track.level),
                )}
              >
                {track.daysSince === null
                  ? `Reminder every ${track.intervalDays} days`
                  : formatTrackDueLine(track)}
              </div>
            ) : careStatus ? (
              <div className="mt-0.5 text-xs text-muted-foreground">
                No reminder
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
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
          <div className="mt-2 h-4 w-24 bg-muted rounded" />
        </div>
      ))}
    </div>
  )
}

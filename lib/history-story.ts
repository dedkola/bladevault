import type { AuditLogEvent, KnifeNote, MaintenanceEvent } from '@/lib/data'
import {
  buildTimelineEntries,
  type TimelineEntry,
  type TimelineKnifeSource,
} from '@/lib/timeline'

export type HistoryStory = {
  /**
   * Milestones, plus an addition for every knife whose creation History never
   * recorded (knives added before the audit log existed).
   */
  entries: TimelineEntry[]
  /** Knives that were the first from their brand. */
  firstOfBrand: Set<string>
}

/** The collection-story entries History shows alongside its recorded events. */
export function buildHistoryStory(
  events: Pick<AuditLogEvent, 'type' | 'knifeId'>[],
  knives: TimelineKnifeSource[],
  maintenanceEvents: MaintenanceEvent[] = [],
  notes: KnifeNote[] = [],
): HistoryStory {
  const recorded = new Set<string>()
  for (const event of events) {
    if (event.type === 'created' && event.knifeId) recorded.add(event.knifeId)
  }

  const entries: TimelineEntry[] = []
  const firstOfBrand = new Set<string>()
  for (const entry of buildTimelineEntries(knives, maintenanceEvents, notes)) {
    if (entry.type === 'milestone') {
      entries.push(entry)
    } else if (entry.type === 'added' && entry.knife) {
      if (entry.firstOfBrand) firstOfBrand.add(entry.knife.id)
      if (!recorded.has(entry.knife.id)) entries.push(entry)
    }
  }
  return { entries, firstOfBrand }
}

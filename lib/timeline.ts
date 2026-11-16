import {
  maintenanceTypeName,
  type Knife,
  type KnifeNote,
  type MaintenanceEvent,
  type MaintenanceType,
} from '@/lib/data'
import { getOrdinalDay as formatOrdinal } from '@/lib/activity-format'
import { markdownToPlainText } from '@/lib/note-markdown'

/** The knife fields the timeline reads; full knives and list items both fit. */
export type TimelineKnifeSource = Pick<
  Knife,
  'id' | 'name' | 'brand' | 'addedAt' | 'sold' | 'images'
>

export type TimelineKnifeRef = {
  id: string
  name: string
  brand: string
  image?: string
  sold: boolean
}

export type TimelineEntryType = 'added' | 'maintenance' | 'note' | 'milestone'

export type TimelineMilestoneKind =
  'first-knife' | 'knife-count' | 'maintenance-count'

export type TimelineEntry = {
  /** Stable across rebuilds: `${type}:${sourceId}`. */
  id: string
  type: TimelineEntryType
  occurredAt: string
  /** `occurredAt` as epoch milliseconds, for sorting and grouping. */
  time: number
  knife?: TimelineKnifeRef
  title: string
  detail?: string
  maintenanceType?: MaintenanceType
  milestone?: TimelineMilestoneKind
  /** Added entries only: this was the first knife from its brand. */
  firstOfBrand?: boolean
}

export type TimelineOrder = 'newest' | 'oldest'

export type TimelineGroup = {
  /** Local calendar month, `YYYY-MM`. */
  key: string
  year: number
  /** 0-based month index. */
  month: number
  label: string
  entries: TimelineEntry[]
}

export const NOTE_EXCERPT_LENGTH = 220

/** Collection sizes worth a milestone: 10, 25, 50, then every 25. */
export function isKnifeCountMilestone(count: number): boolean {
  return count === 10 || count === 25 || (count >= 50 && count % 25 === 0)
}

/** Maintenance totals worth a milestone: 1, 50, 100, 250, 500, then every 500. */
export function isMaintenanceCountMilestone(count: number): boolean {
  return (
    count === 1 ||
    count === 50 ||
    count === 100 ||
    count === 250 ||
    (count >= 500 && count % 500 === 0)
  )
}

/** Case- and space-insensitive brand identity; empty for an unknown brand. */
export function brandKey(brand: string): string {
  return brand.trim().replace(/\s+/g, ' ').toLowerCase()
}

export function formatKnifeName(
  knife: Pick<TimelineKnifeRef, 'brand' | 'name'>,
) {
  const brand = knife.brand.trim()
  const name = knife.name.trim()
  if (!brand) return name
  if (!name) return brand
  return name.toLowerCase().startsWith(brand.toLowerCase())
    ? name
    : `${brand} ${name}`
}

export function toTimelineKnifeRef(
  knife: TimelineKnifeSource,
): TimelineKnifeRef {
  return {
    id: knife.id,
    name: knife.name,
    brand: knife.brand,
    ...(knife.images[0] ? { image: knife.images[0] } : {}),
    sold: knife.sold,
  }
}

export function parseTime(value: string): number | null {
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? null : time
}

function excerpt(text: string, length = NOTE_EXCERPT_LENGTH): string {
  if (text.length <= length) return text
  return `${text.slice(0, length - 1).trimEnd()}…`
}

// Same-moment entries read as "this happened, then the milestone it reached".
const TYPE_ORDER: Record<TimelineEntryType, number> = {
  added: 0,
  maintenance: 1,
  note: 2,
  milestone: 3,
}

function compareOldestFirst(left: TimelineEntry, right: TimelineEntry) {
  return (
    left.time - right.time ||
    TYPE_ORDER[left.type] - TYPE_ORDER[right.type] ||
    left.id.localeCompare(right.id)
  )
}

export function sortTimelineEntries(
  entries: TimelineEntry[],
  order: TimelineOrder,
): TimelineEntry[] {
  const sorted = [...entries].sort(compareOldestFirst)
  return order === 'newest' ? sorted.reverse() : sorted
}

/**
 * Assembles the collection story from knives, maintenance events, and notes.
 * Entries tied to a knife that is no longer in the list are skipped. Returned
 * oldest first; use `sortTimelineEntries` or `groupTimelineByMonth` to reorder.
 */
export function buildTimelineEntries(
  knives: TimelineKnifeSource[],
  maintenanceEvents: MaintenanceEvent[] = [],
  notes: KnifeNote[] = [],
): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  const refs = new Map<string, TimelineKnifeRef>()
  for (const knife of knives) refs.set(knife.id, toTimelineKnifeRef(knife))

  const additions = knives
    .map((knife) => ({ knife, time: parseTime(knife.addedAt) }))
    .filter(
      (item): item is { knife: TimelineKnifeSource; time: number } =>
        item.time !== null,
    )
    .sort(
      (left, right) =>
        left.time - right.time || left.knife.id.localeCompare(right.knife.id),
    )

  const seenBrands = new Set<string>()
  additions.forEach(({ knife, time }, index) => {
    const ref = refs.get(knife.id)!
    const count = index + 1
    const brand = brandKey(knife.brand)
    const firstOfBrand = brand !== '' && !seenBrands.has(brand) && count > 1
    if (brand) seenBrands.add(brand)

    entries.push({
      id: `added:${knife.id}`,
      type: 'added',
      occurredAt: knife.addedAt,
      time,
      knife: ref,
      title: 'Added to the collection',
      ...(firstOfBrand ? { firstOfBrand: true } : {}),
    })

    if (count === 1) {
      entries.push({
        id: 'milestone:first-knife',
        type: 'milestone',
        occurredAt: knife.addedAt,
        time,
        knife: ref,
        title: 'The collection begins',
        detail: `${formatKnifeName(ref)} started it all.`,
        milestone: 'first-knife',
      })
    } else if (isKnifeCountMilestone(count)) {
      entries.push({
        id: `milestone:knife-count-${count}`,
        type: 'milestone',
        occurredAt: knife.addedAt,
        time,
        knife: ref,
        title: `${formatOrdinal(count)} knife`,
        detail: `${formatKnifeName(ref)} brought the collection to ${count} knives.`,
        milestone: 'knife-count',
      })
    }
  })

  const maintenance = maintenanceEvents
    .map((event) => ({ event, time: parseTime(event.occurredAt) }))
    .filter(
      (item): item is { event: MaintenanceEvent; time: number } =>
        item.time !== null && refs.has(item.event.knifeId),
    )
    .sort(
      (left, right) => left.time - right.time || left.event.id - right.event.id,
    )

  maintenance.forEach(({ event, time }, index) => {
    const ref = refs.get(event.knifeId)!
    const count = index + 1
    const notesText = markdownToPlainText(event.notes ?? '')

    entries.push({
      id: `maintenance:${event.id}`,
      type: 'maintenance',
      occurredAt: event.occurredAt,
      time,
      knife: ref,
      title: maintenanceTypeName(event.type),
      ...(notesText ? { detail: excerpt(notesText) } : {}),
      maintenanceType: event.type,
    })

    if (isMaintenanceCountMilestone(count)) {
      entries.push({
        id: `milestone:maintenance-count-${count}`,
        type: 'milestone',
        occurredAt: event.occurredAt,
        time,
        knife: ref,
        title:
          count === 1
            ? 'First maintenance logged'
            : `${formatOrdinal(count)} maintenance session`,
        detail:
          count === 1
            ? `${maintenanceTypeName(event.type)} on the ${formatKnifeName(ref)}.`
            : `${count} sessions of care logged across the collection.`,
        milestone: 'maintenance-count',
      })
    }
  })

  for (const note of notes) {
    const ref = refs.get(note.knifeId)
    const time = parseTime(note.notedAt)
    if (!ref || time === null) continue
    const text = markdownToPlainText(note.body ?? '')
    entries.push({
      id: `note:${note.id}`,
      type: 'note',
      occurredAt: note.notedAt,
      time,
      knife: ref,
      title: 'Note',
      ...(text ? { detail: excerpt(text) } : {}),
    })
  }

  return entries.sort(compareOldestFirst)
}

export function getEntryYear(entry: Pick<TimelineEntry, 'time'>): number {
  return new Date(entry.time).getFullYear()
}

export function filterTimelineByYear(
  entries: TimelineEntry[],
  year: number | 'all',
): TimelineEntry[] {
  if (year === 'all') return entries
  return entries.filter((entry) => getEntryYear(entry) === year)
}

/** Years that have at least one entry, newest first. */
export function listTimelineYears(entries: TimelineEntry[]): number[] {
  return [...new Set(entries.map(getEntryYear))].sort((a, b) => b - a)
}

export function formatMonthLabel(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  })
}

/** Groups entries by local calendar month, ordered within and across months. */
export function groupTimelineByMonth(
  entries: TimelineEntry[],
  order: TimelineOrder = 'newest',
): TimelineGroup[] {
  const groups: TimelineGroup[] = []
  let current: TimelineGroup | undefined

  for (const entry of sortTimelineEntries(entries, order)) {
    const date = new Date(entry.time)
    const year = date.getFullYear()
    const month = date.getMonth()
    const key = `${year}-${String(month + 1).padStart(2, '0')}`
    if (!current || current.key !== key) {
      current = {
        key,
        year,
        month,
        label: formatMonthLabel(year, month),
        entries: [],
      }
      groups.push(current)
    }
    current.entries.push(entry)
  }

  return groups
}

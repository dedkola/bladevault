import type { KnifeNote, MaintenanceEvent, MaintenanceType } from '@/lib/data'
import {
  brandKey,
  parseTime,
  toTimelineKnifeRef,
  type TimelineKnifeRef,
  type TimelineKnifeSource,
} from '@/lib/timeline'

export type YearRecap = {
  year: number
  knivesAdded: number
  /** Collection size at the end of the year (or now, for the current year). */
  collectionSize: number
  /** Distinct brands among the knives added this year. */
  brandCount: number
  /** Brands whose first knife in the collection arrived this year. */
  newBrands: string[]
  topBrand?: { name: string; count: number }
  firstAddition?: TimelineKnifeRef
  totalMaintenance: number
  maintenanceByType: { type: MaintenanceType; count: number }[]
  mostMaintained?: { knife: TimelineKnifeRef; count: number }
  maintainedKnives: number
  notesWritten: number
  /** The month with the most added, maintenance, and note events combined. */
  busiestMonth?: { month: number; count: number }
}

function inYear(time: number | null, year: number): time is number {
  return time !== null && new Date(time).getFullYear() === year
}

function rankByCount<T extends { count: number; label: string }>(
  items: Iterable<T>,
): T[] {
  return [...items].sort(
    (left, right) =>
      right.count - left.count || left.label.localeCompare(right.label),
  )
}

/**
 * Summarizes one calendar year (local time) of the collection. Maintenance
 * and notes for knives that are no longer in the list are ignored, matching
 * the timeline itself.
 */
export function buildYearRecap(
  knives: TimelineKnifeSource[],
  maintenanceEvents: MaintenanceEvent[],
  notes: KnifeNote[],
  year: number,
): YearRecap {
  const knivesById = new Map(knives.map((knife) => [knife.id, knife]))
  const monthCounts = new Array<number>(12).fill(0)
  const countMonth = (time: number) => {
    monthCounts[new Date(time).getMonth()] += 1
  }

  const timedKnives = knives
    .map((knife) => ({ knife, time: parseTime(knife.addedAt) }))
    .filter(
      (item): item is { knife: TimelineKnifeSource; time: number } =>
        item.time !== null,
    )
    .sort(
      (left, right) =>
        left.time - right.time || left.knife.id.localeCompare(right.knife.id),
    )

  const yearEnd = new Date(year + 1, 0, 1).getTime()
  const brandsBeforeYear = new Set<string>()
  const brandCounts = new Map<string, { label: string; count: number }>()
  const newBrands = new Map<string, string>()
  let knivesAdded = 0
  let collectionSize = 0
  let firstAddition: TimelineKnifeRef | undefined

  for (const { knife, time } of timedKnives) {
    if (time < yearEnd) collectionSize += 1
    const key = brandKey(knife.brand)
    if (!inYear(time, year)) {
      if (key && time < yearEnd) brandsBeforeYear.add(key)
      continue
    }

    knivesAdded += 1
    countMonth(time)
    firstAddition ??= toTimelineKnifeRef(knife)
    if (!key) continue

    const label = knife.brand.trim()
    const brand = brandCounts.get(key)
    if (brand) brand.count += 1
    else brandCounts.set(key, { label, count: 1 })
    if (!brandsBeforeYear.has(key) && !newBrands.has(key)) {
      newBrands.set(key, label)
    }
  }

  const typeCounts = new Map<MaintenanceType, number>()
  const knifeCounts = new Map<string, number>()
  let totalMaintenance = 0
  for (const event of maintenanceEvents) {
    const time = parseTime(event.occurredAt)
    if (!knivesById.has(event.knifeId) || !inYear(time, year)) continue
    totalMaintenance += 1
    countMonth(time)
    typeCounts.set(event.type, (typeCounts.get(event.type) ?? 0) + 1)
    knifeCounts.set(event.knifeId, (knifeCounts.get(event.knifeId) ?? 0) + 1)
  }

  let notesWritten = 0
  for (const note of notes) {
    const time = parseTime(note.notedAt)
    if (!knivesById.has(note.knifeId) || !inYear(time, year)) continue
    notesWritten += 1
    countMonth(time)
  }

  const [topBrand] = rankByCount(brandCounts.values())
  const [mostMaintained] = rankByCount(
    [...knifeCounts].map(([knifeId, count]) => {
      const knife = knivesById.get(knifeId)!
      return { knife, count, label: `${knife.brand} ${knife.name}` }
    }),
  )
  const busiestCount = Math.max(...monthCounts)

  return {
    year,
    knivesAdded,
    collectionSize,
    brandCount: brandCounts.size,
    newBrands: [...newBrands.values()],
    ...(topBrand
      ? { topBrand: { name: topBrand.label, count: topBrand.count } }
      : {}),
    ...(firstAddition ? { firstAddition } : {}),
    totalMaintenance,
    maintenanceByType: [...typeCounts]
      .map(([type, count]) => ({ type, count }))
      .sort(
        (left, right) =>
          right.count - left.count || left.type.localeCompare(right.type),
      ),
    ...(mostMaintained
      ? {
          mostMaintained: {
            knife: toTimelineKnifeRef(mostMaintained.knife),
            count: mostMaintained.count,
          },
        }
      : {}),
    maintainedKnives: knifeCounts.size,
    notesWritten,
    ...(busiestCount > 0
      ? {
          busiestMonth: {
            month: monthCounts.indexOf(busiestCount),
            count: busiestCount,
          },
        }
      : {}),
  }
}

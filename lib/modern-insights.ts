import type { Knife } from '@/lib/data'
import {
  parseLengthToInches,
  parseWeightToOunces,
} from '@/lib/collection-stats'

export type ModernInsightsRange = '6m' | '12m' | 'all'

export type CataloguePoint = {
  monthKey: string
  label: string
  added: number
  total: number
}

export type CarryPoint = {
  id: string
  name: string
  brand: string
  bladeLength: number
  weight: number
}

function monthIndex(date: Date): number {
  return date.getFullYear() * 12 + date.getMonth()
}

/** Current catalogue records over time, rather than a purchase or ownership history. */
export function buildCatalogueSeries(
  knives: Knife[],
  range: ModernInsightsRange,
  now: Date,
): {
  points: CataloguePoint[]
  datedCount: number
  excludedCount: number
  addedInRange: number
} {
  const nowTime = now.getTime()
  const currentMonth = monthIndex(now)
  const additions = new Map<number, number>()
  let datedCount = 0
  let firstMonth = currentMonth

  for (const knife of knives) {
    const date = new Date(knife.addedAt)
    const time = date.getTime()
    if (!Number.isFinite(time) || time > nowTime) continue
    const month = monthIndex(date)
    firstMonth = Math.min(firstMonth, month)
    additions.set(month, (additions.get(month) ?? 0) + 1)
    datedCount += 1
  }

  const startMonth =
    range === 'all' ? firstMonth : currentMonth - (range === '6m' ? 5 : 11)
  let total = 0
  for (const [month, count] of additions) {
    if (month < startMonth) total += count
  }

  const points: CataloguePoint[] = []
  let addedInRange = 0
  for (let month = startMonth; month <= currentMonth; month += 1) {
    const year = Math.floor(month / 12)
    const monthOfYear = month - year * 12
    const date = new Date(0)
    date.setFullYear(year, monthOfYear, 1)
    date.setHours(0, 0, 0, 0)
    const added = additions.get(month) ?? 0
    total += added
    addedInRange += added
    points.push({
      monthKey: `${year}-${String(monthOfYear + 1).padStart(2, '0')}`,
      label: date.toLocaleDateString('en-US', {
        month: 'short',
        year: 'numeric',
      }),
      added,
      total,
    })
  }

  return {
    points,
    datedCount,
    excludedCount: knives.length - datedCount,
    addedInRange,
  }
}

/** Only paired, positive measurements can describe a knife on the carry chart. */
export function buildCarryPoints(knives: Knife[]): CarryPoint[] {
  return knives.flatMap((knife) => {
    const bladeLength = parseLengthToInches(knife.specs.bladeLength)
    const weight = parseWeightToOunces(knife.specs.weight)
    if (
      bladeLength === undefined ||
      weight === undefined ||
      !Number.isFinite(bladeLength) ||
      !Number.isFinite(weight) ||
      bladeLength <= 0 ||
      weight <= 0
    )
      return []

    return [
      {
        id: knife.id,
        name: knife.name,
        brand: knife.brand,
        bladeLength,
        weight,
      },
    ]
  })
}

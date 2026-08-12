import type { Knife } from '@/lib/data'

export type StatsPeriod = 'all' | 'year' | 'twelve-months'

export type CategoryKey =
  | 'brand'
  | 'bladeMaterial'
  | 'bladeStyle'
  | 'lockingMechanism'
  | 'handleMaterial'
  | 'designer'

export type MeasurementKey =
  'bladeLength' | 'overallLength' | 'weight' | 'bladeThickness'

export type CategoryStat = {
  name: string
  count: number
  percent: number
  knifeIds: string[]
}

export type MeasurementBin = {
  label: string
  count: number
  knifeIds: string[]
}

export type MeasurementStats = {
  key: MeasurementKey
  label: string
  unit: 'in' | 'oz' | 'mm'
  knownCount: number
  missingCount: number
  min?: number
  q1?: number
  median?: number
  q3?: number
  max?: number
  bins: MeasurementBin[]
}

export type MissingFieldStat = {
  key: CategoryKey | MeasurementKey
  label: string
  count: number
  knifeIds: string[]
}

export type ActivityDay = {
  date: Date
  dateKey: string
  count: number
  knifeIds: string[]
}

export type CollectionStats = {
  knives: Knife[]
  total: number
  pinnedCount: number
  addedThisYear: number
  categories: Record<CategoryKey, CategoryStat[]>
  measurements: Record<MeasurementKey, MeasurementStats>
  completeness: number
  missingFields: MissingFieldStat[]
  activity: ActivityDay[]
  activeDays: number
  additionsInActivityRange: number
  recent: Knife[]
}

type CategoryDefinition = {
  key: CategoryKey
  label: string
  getValue: (knife: Knife) => string | undefined
}

type MeasurementDefinition = {
  key: MeasurementKey
  label: string
  unit: MeasurementStats['unit']
  getValue: (knife: Knife) => string | undefined
  parse: (value: string) => number | undefined
  boundaries: number[]
  labels: string[]
}

const CATEGORY_DEFINITIONS: CategoryDefinition[] = [
  { key: 'brand', label: 'Brand', getValue: (knife) => knife.brand },
  {
    key: 'bladeMaterial',
    label: 'Blade material',
    getValue: (knife) => knife.specs.bladeMaterial,
  },
  {
    key: 'bladeStyle',
    label: 'Blade style',
    getValue: (knife) => knife.bladeStyle,
  },
  {
    key: 'lockingMechanism',
    label: 'Locking mechanism',
    getValue: (knife) => knife.specs.lockingMechanism,
  },
  {
    key: 'handleMaterial',
    label: 'Handle material',
    getValue: (knife) => knife.handleMaterial,
  },
  {
    key: 'designer',
    label: 'Designer',
    getValue: (knife) => knife.specs.designer,
  },
]

const IMPORTANT_FIELDS: Array<
  CategoryDefinition | Pick<MeasurementDefinition, 'key' | 'label' | 'getValue'>
> = [
  ...CATEGORY_DEFINITIONS,
  {
    key: 'bladeLength',
    label: 'Blade length',
    getValue: (knife) => knife.specs.bladeLength,
  },
  {
    key: 'overallLength',
    label: 'Overall length',
    getValue: (knife) => knife.specs.overallLength,
  },
  {
    key: 'bladeThickness',
    label: 'Blade thickness',
    getValue: (knife) => knife.specs.bladeThickness,
  },
  {
    key: 'weight',
    label: 'Weight',
    getValue: (knife) => knife.specs.weight,
  },
]

function parseNumber(value: string): number | undefined {
  const parsed = Number.parseFloat(value.replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : undefined
}

function matchMeasurement(value: string, pattern: RegExp): number | undefined {
  const match = value.match(pattern)
  return match?.[1] ? parseNumber(match[1]) : undefined
}

export function parseLengthToInches(value: string): number | undefined {
  const inches = matchMeasurement(
    value,
    /(-?\d+(?:[.,]\d+)?)\s*(?:in(?:ch(?:es)?)?\.?|["″])/i,
  )
  if (inches !== undefined) return inches

  const millimeters = matchMeasurement(value, /(-?\d+(?:[.,]\d+)?)\s*mm\b/i)
  if (millimeters !== undefined) return millimeters / 25.4

  const centimeters = matchMeasurement(value, /(-?\d+(?:[.,]\d+)?)\s*cm\b/i)
  return centimeters === undefined ? undefined : centimeters / 2.54
}

export function parseLengthToMillimeters(value: string): number | undefined {
  const millimeters = matchMeasurement(value, /(-?\d+(?:[.,]\d+)?)\s*mm\b/i)
  if (millimeters !== undefined) return millimeters

  const centimeters = matchMeasurement(value, /(-?\d+(?:[.,]\d+)?)\s*cm\b/i)
  if (centimeters !== undefined) return centimeters * 10

  const inches = parseLengthToInches(value)
  return inches === undefined ? undefined : inches * 25.4
}

export function parseWeightToOunces(value: string): number | undefined {
  const ounces = matchMeasurement(
    value,
    /(-?\d+(?:[.,]\d+)?)\s*(?:oz|ounces?)\b/i,
  )
  if (ounces !== undefined) return ounces

  const kilograms = matchMeasurement(value, /(-?\d+(?:[.,]\d+)?)\s*kg\b/i)
  if (kilograms !== undefined) return kilograms * 35.27396195

  const pounds = matchMeasurement(
    value,
    /(-?\d+(?:[.,]\d+)?)\s*(?:lb|lbs|pounds?)\b/i,
  )
  if (pounds !== undefined) return pounds * 16

  const grams = matchMeasurement(value, /(-?\d+(?:[.,]\d+)?)\s*(?:g|grams?)\b/i)
  return grams === undefined ? undefined : grams / 28.349523125
}

const MEASUREMENT_DEFINITIONS: MeasurementDefinition[] = [
  {
    key: 'bladeLength',
    label: 'Blade length',
    unit: 'in',
    getValue: (knife) => knife.specs.bladeLength,
    parse: parseLengthToInches,
    boundaries: [2.75, 3, 3.5, 4],
    labels: ['< 2.75″', '2.75–3.0″', '3.0–3.5″', '3.5–4.0″', '4.0″+'],
  },
  {
    key: 'overallLength',
    label: 'Overall length',
    unit: 'in',
    getValue: (knife) => knife.specs.overallLength,
    parse: parseLengthToInches,
    boundaries: [6.5, 7, 8, 9],
    labels: ['< 6.5″', '6.5–7.0″', '7.0–8.0″', '8.0–9.0″', '9.0″+'],
  },
  {
    key: 'weight',
    label: 'Weight',
    unit: 'oz',
    getValue: (knife) => knife.specs.weight,
    parse: parseWeightToOunces,
    boundaries: [2.5, 3.5, 4.5, 6],
    labels: ['< 2.5 oz', '2.5–3.5 oz', '3.5–4.5 oz', '4.5–6.0 oz', '6.0 oz+'],
  },
  {
    key: 'bladeThickness',
    label: 'Blade thickness',
    unit: 'mm',
    getValue: (knife) => knife.specs.bladeThickness,
    parse: parseLengthToMillimeters,
    boundaries: [2, 2.5, 3, 3.5],
    labels: ['< 2.0 mm', '2.0–2.5 mm', '2.5–3.0 mm', '3.0–3.5 mm', '3.5 mm+'],
  },
]

function getDate(value: string): Date | undefined {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate())
}

function getDateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function getPeriodStart(period: StatsPeriod, now: Date): Date | undefined {
  if (period === 'all') return undefined
  if (period === 'year') return new Date(now.getFullYear(), 0, 1)
  return new Date(now.getFullYear() - 1, now.getMonth(), now.getDate() + 1)
}

export function filterKnivesByStatsPeriod(
  knives: Knife[],
  period: StatsPeriod,
  now = new Date(),
): Knife[] {
  const periodStart = getPeriodStart(period, now)
  if (!periodStart) return knives

  const end = startOfDay(now).getTime()
  const start = startOfDay(periodStart).getTime()
  return knives.filter((knife) => {
    const addedAt = getDate(knife.addedAt)
    if (!addedAt) return false
    const time = startOfDay(addedAt).getTime()
    return time >= start && time <= end
  })
}

function quantile(sorted: number[], percentile: number): number | undefined {
  if (sorted.length === 0) return undefined
  const position = (sorted.length - 1) * percentile
  const lowerIndex = Math.floor(position)
  const upperIndex = Math.ceil(position)
  const lower = sorted[lowerIndex]
  const upper = sorted[upperIndex]
  if (lower === undefined || upper === undefined) return undefined
  return lower + (upper - lower) * (position - lowerIndex)
}

function buildCategoryStats(
  knives: Knife[],
  definition: CategoryDefinition,
): CategoryStat[] {
  const groups = new Map<string, { name: string; knifeIds: string[] }>()

  for (const knife of knives) {
    const value = definition.getValue(knife)?.trim()
    if (!value) continue
    const normalized = value.toLocaleLowerCase()
    const group = groups.get(normalized)
    if (group) {
      group.knifeIds.push(knife.id)
    } else {
      groups.set(normalized, { name: value, knifeIds: [knife.id] })
    }
  }

  return [...groups.values()]
    .map(({ name, knifeIds }) => ({
      name,
      count: knifeIds.length,
      percent:
        knives.length === 0
          ? 0
          : Math.round((knifeIds.length / knives.length) * 100),
      knifeIds,
    }))
    .sort(
      (left, right) =>
        right.count - left.count || left.name.localeCompare(right.name),
    )
}

function buildMeasurementStats(
  knives: Knife[],
  definition: MeasurementDefinition,
): MeasurementStats {
  const values: Array<{ value: number; knifeId: string }> = []

  for (const knife of knives) {
    const rawValue = definition.getValue(knife)?.trim()
    if (!rawValue) continue
    const value = definition.parse(rawValue)
    if (value !== undefined && value >= 0)
      values.push({ value, knifeId: knife.id })
  }

  values.sort((left, right) => left.value - right.value)
  const sortedValues = values.map(({ value }) => value)
  const bins = definition.labels.map((label) => ({
    label,
    count: 0,
    knifeIds: [] as string[],
  }))

  for (const entry of values) {
    const binIndex = definition.boundaries.findIndex(
      (boundary) => entry.value < boundary,
    )
    const target = bins[binIndex === -1 ? bins.length - 1 : binIndex]
    if (!target) continue
    target.count += 1
    target.knifeIds.push(entry.knifeId)
  }

  return {
    key: definition.key,
    label: definition.label,
    unit: definition.unit,
    knownCount: values.length,
    missingCount: knives.length - values.length,
    min: sortedValues[0],
    q1: quantile(sortedValues, 0.25),
    median: quantile(sortedValues, 0.5),
    q3: quantile(sortedValues, 0.75),
    max: sortedValues.at(-1),
    bins,
  }
}

function buildCompleteness(knives: Knife[]) {
  if (knives.length === 0) {
    return { completeness: 0, missingFields: [] as MissingFieldStat[] }
  }

  let populatedCount = 0
  const missingFields = IMPORTANT_FIELDS.map((definition) => {
    const knifeIds: string[] = []
    for (const knife of knives) {
      if (definition.getValue(knife)?.trim()) {
        populatedCount += 1
      } else {
        knifeIds.push(knife.id)
      }
    }
    return {
      key: definition.key,
      label: definition.label,
      count: knifeIds.length,
      knifeIds,
    }
  })
    .filter(({ count }) => count > 0)
    .sort(
      (left, right) =>
        right.count - left.count || left.label.localeCompare(right.label),
    )

  return {
    completeness: Math.round(
      (populatedCount / (knives.length * IMPORTANT_FIELDS.length)) * 100,
    ),
    missingFields,
  }
}

function buildActivity(knives: Knife[], now: Date): ActivityDay[] {
  const end = startOfDay(now)
  const mondayOffset = (end.getDay() + 6) % 7
  const start = new Date(end)
  start.setDate(end.getDate() - mondayOffset - 51 * 7)

  const knivesByDate = new Map<string, string[]>()
  for (const knife of knives) {
    const addedAt = getDate(knife.addedAt)
    if (!addedAt) continue
    const key = getDateKey(addedAt)
    const ids = knivesByDate.get(key)
    if (ids) ids.push(knife.id)
    else knivesByDate.set(key, [knife.id])
  }

  return Array.from({ length: 52 * 7 }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    const dateKey = getDateKey(date)
    const knifeIds = knivesByDate.get(dateKey) ?? []
    return { date, dateKey, count: knifeIds.length, knifeIds }
  })
}

export function collapseCategories(
  categories: CategoryStat[],
  visibleCount = 5,
  totalCount = categories.reduce((sum, category) => sum + category.count, 0),
): CategoryStat[] {
  if (categories.length <= visibleCount) return categories
  const leaders = categories.slice(0, visibleCount - 1)
  const remaining = categories.slice(visibleCount - 1)
  const knifeIds = remaining.flatMap((category) => category.knifeIds)
  return [
    ...leaders,
    {
      name: 'Other',
      count: knifeIds.length,
      percent:
        totalCount === 0 ? 0 : Math.round((knifeIds.length / totalCount) * 100),
      knifeIds,
    },
  ]
}

export function createCollectionStats(
  allKnives: Knife[],
  period: StatsPeriod,
  now = new Date(),
): CollectionStats {
  const knives = filterKnivesByStatsPeriod(allKnives, period, now)
  const categories = Object.fromEntries(
    CATEGORY_DEFINITIONS.map((definition) => [
      definition.key,
      buildCategoryStats(knives, definition),
    ]),
  ) as Record<CategoryKey, CategoryStat[]>
  const measurements = Object.fromEntries(
    MEASUREMENT_DEFINITIONS.map((definition) => [
      definition.key,
      buildMeasurementStats(knives, definition),
    ]),
  ) as Record<MeasurementKey, MeasurementStats>
  const { completeness, missingFields } = buildCompleteness(knives)
  const activity = buildActivity(knives, now)
  const additionsInActivityRange = activity.reduce(
    (sum, day) => sum + day.count,
    0,
  )
  const activeDays = activity.reduce(
    (sum, day) => sum + Number(day.count > 0),
    0,
  )
  const recent = [...knives]
    .sort((left, right) => {
      const leftTime = getDate(left.addedAt)?.getTime() ?? 0
      const rightTime = getDate(right.addedAt)?.getTime() ?? 0
      return rightTime - leftTime
    })
    .slice(0, 4)

  return {
    knives,
    total: knives.length,
    pinnedCount: knives.reduce((sum, knife) => sum + Number(knife.pinned), 0),
    addedThisYear: knives.reduce((sum, knife) => {
      const addedAt = getDate(knife.addedAt)
      return sum + Number(addedAt?.getFullYear() === now.getFullYear())
    }, 0),
    categories,
    measurements,
    completeness,
    missingFields,
    activity,
    activeDays,
    additionsInActivityRange,
    recent,
  }
}

export function getStatsPeriodLabel(period: StatsPeriod): string {
  if (period === 'year') return 'Added this year'
  if (period === 'twelve-months') return 'Last 12 months'
  return 'All time'
}

import type { Knife, KnifeActivityEvent } from '@/lib/data'
import type { DimensionUnit } from '@/lib/settings-shared'
import { formatDimension, formatWeight } from '@/lib/measurements'
import {
  GRAMS_PER_OUNCE,
  parseLengthToInches,
  parseLengthToMillimeters,
  parseWeightToGrams,
  parseWeightToOunces,
} from '@/lib/measurement-parser'

export {
  parseLengthToInches,
  parseLengthToMillimeters,
  parseWeightToGrams,
  parseWeightToOunces,
} from '@/lib/measurement-parser'

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
  unit: 'in' | 'oz' | 'mm' | 'g'
  dimensionUnit?: DimensionUnit
  knownCount: number
  missingCount: number
  uninterpretableCount: number
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
  addedCount: number
  editedCount: number
  maintainedCount: number
  knifeIds: string[]
  addedKnifeIds: string[]
  editedKnifeIds: string[]
  maintainedKnifeIds: string[]
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
  editsInActivityRange: number
  maintainedKnivesInActivityRange: number
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

const MEASUREMENT_DEFINITIONS: MeasurementDefinition[] = [
  {
    key: 'bladeLength',
    label: 'Blade length',
    unit: 'in',
    getValue: (knife) => knife.specs.bladeLength,
    parse: parseLengthToInches,
    boundaries: [2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4],
    labels: [
      '< 2.0″',
      '2.0–2.25″',
      '2.25–2.5″',
      '2.5–2.75″',
      '2.75–3.0″',
      '3.0–3.25″',
      '3.25–3.5″',
      '3.5–3.75″',
      '3.75–4.0″',
      '4.0″+',
    ],
  },
  {
    key: 'overallLength',
    label: 'Overall length',
    unit: 'in',
    getValue: (knife) => knife.specs.overallLength,
    parse: parseLengthToInches,
    boundaries: [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10],
    labels: [
      '< 6.0″',
      '6.0–6.5″',
      '6.5–7.0″',
      '7.0–7.5″',
      '7.5–8.0″',
      '8.0–8.5″',
      '8.5–9.0″',
      '9.0–9.5″',
      '9.5–10.0″',
      '10.0″+',
    ],
  },
  {
    key: 'weight',
    label: 'Weight',
    unit: 'oz',
    getValue: (knife) => knife.specs.weight,
    parse: parseWeightToOunces,
    boundaries: [2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6],
    labels: [
      '< 2.0 oz',
      '2.0–2.5 oz',
      '2.5–3.0 oz',
      '3.0–3.5 oz',
      '3.5–4.0 oz',
      '4.0–4.5 oz',
      '4.5–5.0 oz',
      '5.0–5.5 oz',
      '5.5–6.0 oz',
      '6.0 oz+',
    ],
  },
  {
    key: 'bladeThickness',
    label: 'Blade thickness',
    unit: 'mm',
    getValue: (knife) => knife.specs.bladeThickness,
    parse: parseLengthToMillimeters,
    boundaries: [2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4],
    labels: [
      '< 2.0 mm',
      '2.0–2.25 mm',
      '2.25–2.5 mm',
      '2.5–2.75 mm',
      '2.75–3.0 mm',
      '3.0–3.25 mm',
      '3.25–3.5 mm',
      '3.5–3.75 mm',
      '3.75–4.0 mm',
      '4.0 mm+',
    ],
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
    const normalized = value.toLowerCase()
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

function measurementConversionFactor(
  from: MeasurementStats['unit'],
  to: MeasurementStats['unit'],
): number {
  if (from === to) return 1
  if (from === 'oz' && to === 'g') return GRAMS_PER_OUNCE
  if (from === 'g' && to === 'oz') return 1 / GRAMS_PER_OUNCE
  return to === 'mm' ? 25.4 : 1 / 25.4
}

function formatMeasurementBin(
  definition: MeasurementDefinition,
  index: number,
  dimensionUnit: DimensionUnit,
): string {
  const isWeight = definition.key === 'weight'
  const primaryUnit = isWeight ? 'g' : 'mm'
  const secondaryUnit = isWeight ? 'oz' : 'in'
  const range = (unit: MeasurementStats['unit']) => {
    const factor = measurementConversionFactor(definition.unit, unit)
    const amount = (value: number) => Number((value * factor).toFixed(4))
    const lower = definition.boundaries[index - 1]
    const upper = definition.boundaries[index]
    return lower === undefined
      ? `< ${amount(upper)} ${unit}`
      : upper === undefined
        ? `${amount(lower)} ${unit}+`
        : `${amount(lower)}–${amount(upper)} ${unit}`
  }
  if (dimensionUnit === 'both')
    return `${range(primaryUnit)} / ${range(secondaryUnit)}`
  const unit = dimensionUnit === 'mm' ? primaryUnit : secondaryUnit
  // Keep familiar labels when the chosen unit matches the original chart.
  return definition.unit === unit ? definition.labels[index] : range(unit)
}

export function formatStatsMeasurement(
  value: number | undefined,
  measurement: Pick<MeasurementStats, 'unit' | 'dimensionUnit'>,
): string {
  if (value === undefined) return '—'
  if (measurement.unit === 'oz' || measurement.unit === 'g')
    return formatWeight(
      `${value} ${measurement.unit}`,
      measurement.dimensionUnit ?? (measurement.unit === 'g' ? 'mm' : 'in'),
    )
  return formatDimension(
    `${value} ${measurement.unit}`,
    measurement.dimensionUnit ?? measurement.unit,
  )
}

function buildMeasurementStats(
  knives: Knife[],
  definition: MeasurementDefinition,
  dimensionUnit?: DimensionUnit,
): MeasurementStats {
  const unit = !dimensionUnit
    ? definition.unit
    : definition.key === 'weight'
      ? dimensionUnit === 'in'
        ? 'oz'
        : 'g'
      : dimensionUnit === 'in'
        ? 'in'
        : 'mm'
  const factor = measurementConversionFactor(definition.unit, unit)
  const boundaries = definition.boundaries.map((boundary) => boundary * factor)
  const parse =
    unit === 'oz'
      ? parseWeightToOunces
      : unit === 'g'
        ? parseWeightToGrams
        : unit === 'in'
          ? parseLengthToInches
          : parseLengthToMillimeters
  const values: Array<{ value: number; knifeId: string }> = []
  let missingCount = 0
  let uninterpretableCount = 0

  for (const knife of knives) {
    const rawValue = definition.getValue(knife)?.trim()
    if (!rawValue) {
      missingCount += 1
      continue
    }
    const value = parse(rawValue)
    if (value !== undefined && Number.isFinite(value) && value >= 0)
      values.push({ value, knifeId: knife.id })
    else uninterpretableCount += 1
  }

  values.sort((left, right) => left.value - right.value)
  const sortedValues = values.map(({ value }) => value)
  const bins = definition.labels.map((label) => ({
    label,
    count: 0,
    knifeIds: [] as string[],
  }))

  for (const entry of values) {
    const binIndex = boundaries.findIndex((boundary) => entry.value < boundary)
    const target = bins[binIndex === -1 ? bins.length - 1 : binIndex]
    if (!target) continue
    target.count += 1
    target.knifeIds.push(entry.knifeId)
  }

  return {
    key: definition.key,
    label: definition.label,
    unit,
    dimensionUnit,
    knownCount: values.length,
    missingCount,
    uninterpretableCount,
    min: sortedValues[0],
    q1: quantile(sortedValues, 0.25),
    median: quantile(sortedValues, 0.5),
    q3: quantile(sortedValues, 0.75),
    max: sortedValues.at(-1),
    bins: bins.map((bin, index) => ({
      ...bin,
      label: !dimensionUnit
        ? bin.label
        : formatMeasurementBin(definition, index, dimensionUnit),
    })),
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

function buildActivity(
  knives: Knife[],
  activityEvents: KnifeActivityEvent[],
  now: Date,
): ActivityDay[] {
  const end = startOfDay(now)
  const mondayOffset = (end.getDay() + 6) % 7
  const start = new Date(end)
  start.setDate(end.getDate() - mondayOffset - 51 * 7)
  const visibleDayCount = 51 * 7 + mondayOffset + 1

  const visibleKnifeIds = new Set(knives.map(({ id }) => id))
  const activityByDate = new Map<
    string,
    {
      addedKnifeIds: Set<string>
      editedKnifeIds: Set<string>
      maintainedKnifeIds: Set<string>
    }
  >()
  for (const event of activityEvents) {
    if (!visibleKnifeIds.has(event.knifeId)) continue
    const occurredAt = getDate(event.occurredAt)
    if (!occurredAt) continue
    const key = getDateKey(occurredAt)
    const bucket = activityByDate.get(key) ?? {
      addedKnifeIds: new Set<string>(),
      editedKnifeIds: new Set<string>(),
      maintainedKnifeIds: new Set<string>(),
    }
    if (event.type === 'created') bucket.addedKnifeIds.add(event.knifeId)
    else if (event.type === 'updated') bucket.editedKnifeIds.add(event.knifeId)
    else bucket.maintainedKnifeIds.add(event.knifeId)
    activityByDate.set(key, bucket)
  }

  return Array.from({ length: visibleDayCount }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    const dateKey = getDateKey(date)
    const bucket = activityByDate.get(dateKey)
    const addedKnifeIds = Array.from(bucket?.addedKnifeIds ?? [])
    const editedKnifeIds = Array.from(bucket?.editedKnifeIds ?? [])
    const maintainedKnifeIds = Array.from(bucket?.maintainedKnifeIds ?? [])
    const knifeIds = Array.from(
      new Set([...addedKnifeIds, ...editedKnifeIds, ...maintainedKnifeIds]),
    )
    const addedCount = addedKnifeIds.length
    const editedCount = editedKnifeIds.length
    const maintainedCount = maintainedKnifeIds.length
    return {
      date,
      dateKey,
      count: addedCount + editedCount + maintainedCount,
      addedCount,
      editedCount,
      maintainedCount,
      knifeIds,
      addedKnifeIds,
      editedKnifeIds,
      maintainedKnifeIds,
    }
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
  recordedActivity?: KnifeActivityEvent[],
  dimensionUnit?: DimensionUnit,
): CollectionStats {
  const knives = filterKnivesByStatsPeriod(allKnives, period, now)
  const activityEvents =
    recordedActivity ??
    allKnives.map((knife) => ({
      knifeId: knife.id,
      type: 'created' as const,
      occurredAt: knife.addedAt,
    }))
  const categories = Object.fromEntries(
    CATEGORY_DEFINITIONS.map((definition) => [
      definition.key,
      buildCategoryStats(knives, definition),
    ]),
  ) as Record<CategoryKey, CategoryStat[]>
  const measurements = Object.fromEntries(
    MEASUREMENT_DEFINITIONS.map((definition) => [
      definition.key,
      buildMeasurementStats(knives, definition, dimensionUnit),
    ]),
  ) as Record<MeasurementKey, MeasurementStats>
  const { completeness, missingFields } = buildCompleteness(knives)
  const activity = buildActivity(knives, activityEvents, now)
  const additionsInActivityRange = activity.reduce(
    (sum, day) => sum + day.addedCount,
    0,
  )
  const activeDays = activity.reduce(
    (sum, day) => sum + Number(day.count > 0),
    0,
  )
  const editsInActivityRange = activity.reduce(
    (sum, day) => sum + day.editedCount,
    0,
  )
  const maintainedKnivesInActivityRange = activity.reduce(
    (sum, day) => sum + day.maintainedCount,
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
    editsInActivityRange,
    maintainedKnivesInActivityRange,
    recent,
  }
}

import type { Knife } from '@/lib/data'
import {
  createCollectionStats,
  type CategoryKey,
  type MeasurementKey,
} from '@/lib/collection-stats'
import {
  getKnifeFieldDefinitions,
  getKnifeFieldValue,
  isMissingKnifeField,
  resolveKnifeField,
} from '@/lib/knife-fields'
import { getSettings } from '@/lib/settings'
import { getStorage } from '@/lib/storage'

export type KnifeSummary = {
  id: string
  name: string
  brand: string
  modelNumber: string
  bladeMaterial: string
  designer: string
  country: string
  pinned: boolean
  updatedAt: string
}

export type SearchKnifeFilter = {
  field: string
  value: string | boolean
}

export type DuplicateCandidate = {
  score: number
  signals: string[]
  knives: KnifeSummary[]
}

export function summarizeKnife(knife: Knife): KnifeSummary {
  return {
    id: knife.id,
    name: knife.name,
    brand: knife.brand,
    modelNumber: knife.specs.modelNumber ?? '',
    bladeMaterial: knife.specs.bladeMaterial ?? '',
    designer: knife.specs.designer ?? '',
    country: knife.specs.country,
    pinned: knife.pinned,
    updatedAt: knife.updatedAt,
  }
}

function searchableText(knife: Knife): string {
  return [
    knife.id,
    knife.name,
    knife.brand,
    knife.bladeStyle,
    knife.handleMaterial,
    knife.description,
    knife.sourceUrl,
    ...Object.values(knife.specs),
    ...Object.values(knife.customFields),
  ]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLocaleLowerCase()
}

function normalizeMatchValue(value: string): string {
  return value.trim().toLocaleLowerCase()
}

export async function searchKnives({
  query = '',
  filters = [],
  limit = 50,
  offset = 0,
}: {
  query?: string
  filters?: SearchKnifeFilter[]
  limit?: number
  offset?: number
}) {
  const storage = getStorage()
  const knives = await storage.getAllKnives()
  const customFields = getSettings().customFields
  const normalizedQuery = normalizeMatchValue(query)
  const resolvedFilters = filters.map((filter) => {
    const definition = resolveKnifeField(filter.field, customFields)
    if (!definition) throw new Error(`Unsupported field: ${filter.field}`)
    return { ...filter, field: definition.path }
  })

  const matches = knives
    .filter((knife) => {
      if (normalizedQuery && !searchableText(knife).includes(normalizedQuery)) {
        return false
      }
      return resolvedFilters.every((filter) => {
        const current = getKnifeFieldValue(knife, filter.field)
        if (typeof filter.value === 'boolean') return current === filter.value
        return (
          typeof current === 'string' &&
          normalizeMatchValue(current) === normalizeMatchValue(filter.value)
        )
      })
    })
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.name.localeCompare(right.name),
    )

  const safeLimit = Math.min(Math.max(limit, 1), 200)
  const safeOffset = Math.max(offset, 0)
  const page = matches.slice(safeOffset, safeOffset + safeLimit)

  return {
    total: matches.length,
    offset: safeOffset,
    limit: safeLimit,
    hasMore: safeOffset + page.length < matches.length,
    knives: page.map(summarizeKnife),
  }
}

export async function getKnifeDetails(id: string) {
  const knife = await getStorage().getKnifeById(id)
  if (!knife) throw new Error(`Knife with id "${id}" not found`)
  const customFieldDefinitions = getSettings().customFields
  return {
    knife: {
      ...knife,
      images: knife.images.map((reference, index) => ({
        index,
        reference,
        kind:
          reference.startsWith('http://') || reference.startsWith('https://')
            ? ('external' as const)
            : ('managed' as const),
      })),
    },
    customFieldDefinitions,
  }
}

function compactCategories(
  categories: Record<CategoryKey, Array<{ name: string; count: number }>>,
) {
  return Object.fromEntries(
    Object.entries(categories).map(([key, values]) => [
      key,
      values.slice(0, 20).map(({ name, count }) => ({ name, count })),
    ]),
  )
}

function compactMeasurements(
  measurements: Record<
    MeasurementKey,
    {
      knownCount: number
      missingCount: number
      min?: number
      median?: number
      max?: number
      unit: string
    }
  >,
) {
  return Object.fromEntries(
    Object.entries(measurements).map(([key, measurement]) => [
      key,
      {
        knownCount: measurement.knownCount,
        missingCount: measurement.missingCount,
        min: measurement.min,
        median: measurement.median,
        max: measurement.max,
        unit: measurement.unit,
      },
    ]),
  )
}

function canonicalStatsField(key: CategoryKey | MeasurementKey): string {
  if (key === 'brand' || key === 'bladeStyle' || key === 'handleMaterial') {
    return key
  }
  return `specs.${key}`
}

export async function getCollectionStats({ includeSchema = false } = {}) {
  const storage = getStorage()
  const [knives, activity] = await Promise.all([
    storage.getAllKnives(),
    storage.getKnifeActivity(),
  ])
  const stats = createCollectionStats(knives, 'all', new Date(), activity)
  const duplicates = findDuplicateCandidates(knives)
  const customFields = getSettings().customFields

  return {
    total: stats.total,
    pinnedCount: stats.pinnedCount,
    completeness: stats.completeness,
    categories: compactCategories(stats.categories),
    measurements: compactMeasurements(stats.measurements),
    missingFields: stats.missingFields.map(({ key, label, count }) => ({
      field: canonicalStatsField(key),
      label,
      count,
    })),
    duplicateCandidateCount: duplicates.length,
    recent: stats.recent.slice(0, 10).map(summarizeKnife),
    ...(includeSchema
      ? {
          fields: getKnifeFieldDefinitions(customFields).map(
            ({ path, label, type, aliases, writable }) => ({
              path,
              label,
              type,
              aliases,
              writable,
            }),
          ),
        }
      : {}),
  }
}

export async function findMissingFields({
  fields,
  limit = 100,
}: {
  fields: string[]
  limit?: number
}) {
  if (fields.length === 0) throw new Error('Provide at least one field')
  const customFields = getSettings().customFields
  const resolved = Array.from(
    new Set(
      fields.map((field) => {
        const definition = resolveKnifeField(field, customFields)
        if (!definition) throw new Error(`Unsupported field: ${field}`)
        return definition.path
      }),
    ),
  )
  const knives = await getStorage().getAllKnives()
  const safeLimit = Math.min(Math.max(limit, 1), 500)

  return {
    fields: resolved.map((field) => {
      const missing = knives.filter((knife) =>
        isMissingKnifeField(knife, field),
      )
      return {
        field,
        total: missing.length,
        truncated: missing.length > safeLimit,
        knives: missing.slice(0, safeLimit).map(summarizeKnife),
      }
    }),
  }
}

function duplicateKey(value: string | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function canonicalSourceUrl(value: string): string {
  if (!value) return ''
  try {
    const url = new URL(value)
    url.hash = ''
    url.searchParams.sort()
    return url.toString().replace(/\/$/, '').toLocaleLowerCase()
  } catch {
    return ''
  }
}

export function findDuplicateCandidates(knives: Knife[]): DuplicateCandidate[] {
  const pairs = new Map<string, DuplicateCandidate>()
  for (let leftIndex = 0; leftIndex < knives.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < knives.length;
      rightIndex += 1
    ) {
      const left = knives[leftIndex]
      const right = knives[rightIndex]
      if (!left || !right) continue

      let score = 0
      const signals: string[] = []
      const leftBrand = duplicateKey(left.brand)
      const rightBrand = duplicateKey(right.brand)
      const leftName = duplicateKey(left.name)
      const rightName = duplicateKey(right.name)
      const sameBrand = Boolean(leftBrand && leftBrand === rightBrand)
      const sameName = Boolean(leftName && leftName === rightName)
      const leftModelNumber = duplicateKey(left.specs.modelNumber)
      const rightModelNumber = duplicateKey(right.specs.modelNumber)
      const leftSource = canonicalSourceUrl(left.sourceUrl)
      const rightSource = canonicalSourceUrl(right.sourceUrl)

      if (leftSource && leftSource === rightSource) {
        score += 70
        signals.push('same source URL')
      }
      if (
        sameBrand &&
        leftModelNumber &&
        leftModelNumber === rightModelNumber
      ) {
        score += 70
        signals.push('same brand and model number')
      }
      if (sameBrand && sameName) {
        score += 60
        signals.push('same brand and model')
      } else if (sameName) {
        score += 35
        signals.push('same model')
      }
      if (
        duplicateKey(left.specs.bladeMaterial) &&
        duplicateKey(left.specs.bladeMaterial) ===
          duplicateKey(right.specs.bladeMaterial)
      ) {
        score += 10
        signals.push('same blade material')
      }
      if (
        duplicateKey(left.specs.bladeLength) &&
        duplicateKey(left.specs.bladeLength) ===
          duplicateKey(right.specs.bladeLength)
      ) {
        score += 5
        signals.push('same blade length')
      }

      if (score < 60) continue
      const ids = [left.id, right.id].sort()
      pairs.set(ids.join('\u0000'), {
        score: Math.min(score, 100),
        signals,
        knives: [left, right].map(summarizeKnife),
      })
    }
  }

  return [...pairs.values()].sort(
    (left, right) =>
      right.score - left.score ||
      left.knives[0]!.name.localeCompare(right.knives[0]!.name),
  )
}

export async function findDuplicates({ limit = 100 } = {}) {
  const candidates = findDuplicateCandidates(await getStorage().getAllKnives())
  const safeLimit = Math.min(Math.max(limit, 1), 500)
  return {
    total: candidates.length,
    truncated: candidates.length > safeLimit,
    candidates: candidates.slice(0, safeLimit),
  }
}

export type Knife = {
  id: string
  name: string
  brand: string
  bladeStyle: string
  handleMaterial: string
  images: string[]
  specs: {
    weight: string
    overallLength: string
    bladeLength: string
    bladeThickness?: string
    bladeCoating?: string
    bladeMaterial?: string
    lockingMechanism?: string
    designer?: string
    modelNumber?: string
    handleLength?: string
    hardness?: string
    price?: string
    country: string
  }
  customFields: Record<string, string>
  addedAt: string
  updatedAt: string
  description: string
  sourceUrl: string
  pinned: boolean
}

export type KnifeListItem = Omit<
  Knife,
  'description' | 'sourceUrl' | 'images'
> & {
  images: string[]
  imageCount: number
}

export function toKnifeListItem(knife: Knife): KnifeListItem {
  return {
    id: knife.id,
    name: knife.name,
    brand: knife.brand,
    bladeStyle: knife.bladeStyle,
    handleMaterial: knife.handleMaterial,
    images: knife.images.slice(0, 1),
    imageCount: knife.images.length,
    specs: knife.specs,
    customFields: knife.customFields,
    addedAt: knife.addedAt,
    updatedAt: knife.updatedAt,
    pinned: knife.pinned,
  }
}

export function hydrateKnifeListItem(knife: KnifeListItem): Knife {
  return {
    ...knife,
    description: '',
    sourceUrl: '',
  }
}

export function getKnifeImageCount(
  knife: Pick<Knife, 'images'> & { imageCount?: number },
): number {
  return knife.imageCount ?? knife.images.length
}

export type KnifeActivityType = 'created' | 'updated' | 'maintained'

export type KnifeActivityEvent = {
  knifeId: string
  type: KnifeActivityType
  occurredAt: string
}

export type AuditLogEventType = 'created' | 'updated' | 'deleted' | 'system'

export type AuditLogEventChange = {
  field: string
  before: string
  after: string
}

export type AuditLogEvent = {
  id: number
  operationId: string
  type: AuditLogEventType
  knifeId: string | null
  subject: string
  actor: string
  source: string
  summary: string
  changes: AuditLogEventChange[]
  occurredAt: string
}

export type KnifeDraft = Omit<Knife, 'id' | 'addedAt' | 'updatedAt'>

export type KnifeUpdates = Partial<
  Omit<
    Knife,
    | 'id'
    | 'addedAt'
    | 'updatedAt'
    | 'images'
    | 'specs'
    | 'pinned'
    | 'customFields'
  >
> & {
  specs?: Partial<Knife['specs']>
  customFields?: Partial<Knife['customFields']>
  images?: string[]
  pinned?: boolean
}

export function getImageUrl(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) return path
  if (path.startsWith('data:image')) return path
  return `/api/images/${path}`
}

export function getKnifeSearchableText(knife: Knife): string {
  return knife.name.toLowerCase()
}

export function matchesKnifeSearch(knife: Knife, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true

  return getKnifeSearchableText(knife).includes(q)
}

export type GlobalKnifeSearchQuery =
  | { mode: 'model-name'; value: string }
  | { mode: 'model-number'; value: string }

export function parseGlobalKnifeSearchQuery(
  query: string,
): GlobalKnifeSearchQuery {
  const value = query.trim()
  const modelNumberCommand = /^\/model(?:\s+(.*))?$/i.exec(value)

  if (modelNumberCommand) {
    return {
      mode: 'model-number',
      value: (modelNumberCommand[1] ?? '').trim(),
    }
  }

  return { mode: 'model-name', value }
}

export function matchesGlobalKnifeSearch(knife: Knife, query: string): boolean {
  const parsedQuery = parseGlobalKnifeSearchQuery(query)

  if (parsedQuery.mode === 'model-number') {
    if (!parsedQuery.value) return false

    return (knife.specs.modelNumber ?? '')
      .toLowerCase()
      .includes(parsedQuery.value.toLowerCase())
  }

  return matchesKnifeSearch(knife, parsedQuery.value)
}

export type MaintenanceType =
  | 'cleaning'
  | 'lubrication'
  | 'sharpening'
  | 'stropping'
  | 'disassembly'
  | 'reassembly'
  | 'hardware_replacement'
  | 'part_replacement'
  | 'other'

export const MAINTENANCE_TYPES: MaintenanceType[] = [
  'cleaning',
  'lubrication',
  'sharpening',
  'stropping',
  'disassembly',
  'reassembly',
  'hardware_replacement',
  'part_replacement',
  'other',
]

export type SharpeningDetails = {
  grit?: string
  angle?: string
  system?: string
  passes?: number
  ceramic?: string
  strop?: string
  compound?: string
  notes?: string
}

export type MaintenanceEvent = {
  id: number
  knifeId: string
  type: MaintenanceType
  occurredAt: string
  notes: string
  sharpeningDetails?: SharpeningDetails
  createdAt: string
}

export type MaintenanceEventInput = {
  type: MaintenanceType
  occurredAt: string
  notes?: string
  sharpeningDetails?: SharpeningDetails
}

export type MaintenanceEventUpdate = Partial<
  Omit<MaintenanceEventInput, 'sharpeningDetails'>
> & {
  sharpeningDetails?: SharpeningDetails | null
}

export function isMaintenanceType(value: string): value is MaintenanceType {
  return (MAINTENANCE_TYPES as string[]).includes(value)
}

export function maintenanceTypeLabel(type: MaintenanceType): string {
  const labels: Record<MaintenanceType, string> = {
    cleaning: 'Cleaned',
    lubrication: 'Lubricated',
    sharpening: 'Sharpened',
    stropping: 'Stropped',
    disassembly: 'Disassembled',
    reassembly: 'Reassembled',
    hardware_replacement: 'Hardware replaced',
    part_replacement: 'Part replaced',
    other: 'Other',
  }
  return labels[type]
}

export function maintenanceTypeName(type: MaintenanceType): string {
  const names: Record<MaintenanceType, string> = {
    cleaning: 'Cleaning',
    lubrication: 'Lubrication',
    sharpening: 'Sharpening',
    stropping: 'Stropping',
    disassembly: 'Disassembly',
    reassembly: 'Reassembly',
    hardware_replacement: 'Hardware replacement',
    part_replacement: 'Part replacement',
    other: 'Other maintenance',
  }
  return names[type]
}

export function prioritizePinnedKnives(
  knives: Knife[],
  pinnedItemsFirst: boolean,
): Knife[] {
  if (!pinnedItemsFirst) return [...knives]

  return [...knives].sort(
    (left, right) => Number(right.pinned) - Number(left.pinned),
  )
}

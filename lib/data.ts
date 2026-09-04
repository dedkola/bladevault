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

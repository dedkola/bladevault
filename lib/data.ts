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

const searchableTextCache = new WeakMap<Knife, string>()

export function getKnifeSearchableText(knife: Knife): string {
  const cachedText = searchableTextCache.get(knife)
  if (cachedText) return cachedText

  const searchableValues = [
    knife.brand,
    knife.name,
    knife.bladeStyle,
    knife.handleMaterial,
    knife.description,
    ...Object.values(knife.specs),
    ...Object.values(knife.customFields),
  ]

  const searchableText = searchableValues.join('\0').toLowerCase()
  searchableTextCache.set(knife, searchableText)
  return searchableText
}

export function matchesKnifeSearch(knife: Knife, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true

  return getKnifeSearchableText(knife).includes(q)
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

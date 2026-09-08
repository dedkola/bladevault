import type { Knife } from '@/lib/data'

export type KnifeFamily = {
  key: string
  brand: string
  name: string
  knives: Knife[]
}

function normalizeIdentity(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

// Keep generations, sizes, and punctuation distinct. Missing identities must
// not turn unrelated records into a family.
export function getKnifeFamilyKey(knife: Knife): string {
  const brand = normalizeIdentity(knife.brand)
  const name = normalizeIdentity(knife.name)
  return JSON.stringify(brand && name ? [brand, name] : [knife.id])
}

export function groupKnifeFamilies(knives: Knife[]): KnifeFamily[] {
  const families = new Map<string, KnifeFamily>()
  for (const knife of knives) {
    const key = getKnifeFamilyKey(knife)
    const existing = families.get(key)
    if (existing) {
      existing.knives.push(knife)
    } else {
      families.set(key, {
        key,
        brand: knife.brand,
        name: knife.name,
        knives: [knife],
      })
    }
  }
  return [...families.values()]
}

function variantDescription(knife: Knife): string {
  return [
    knife.specs.modelNumber,
    knife.specs.bladeMaterial,
    knife.handleMaterial,
    knife.specs.bladeCoating,
  ]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join(' · ')
}

export function getKnifeVariantLabel(knife: Knife, siblings: Knife[]): string {
  const description = variantDescription(knife)
  const ambiguous = siblings.some(
    (sibling) =>
      sibling.id !== knife.id &&
      normalizeIdentity(variantDescription(sibling)) ===
        normalizeIdentity(description),
  )
  // Identical or incomplete specifications still represent separate records.
  return ambiguous || !description
    ? [description, knife.id].filter(Boolean).join(' · ')
    : description
}

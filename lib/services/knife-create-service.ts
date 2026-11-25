import { createHash } from 'node:crypto'
import { withVaultWrite } from '@/lib/vault-access'
import type { Knife } from '@/lib/data'
import { getStorage } from '@/lib/storage'
import type { CreateKnifeInput } from '@/lib/storage/types'
import type { McpTransport } from '@/lib/services/knife-service'

const SPEC_KEYS = [
  'weight',
  'overallLength',
  'bladeLength',
  'bladeThickness',
  'bladeCoating',
  'bladeMaterial',
  'lockingMechanism',
  'designer',
  'modelNumber',
  'handleLength',
  'hardness',
  'price',
  'country',
] as const

export type McpNewKnifeInput = {
  name: string
  brand?: string
  bladeStyle?: string
  handleMaterial?: string
  description?: string
  sourceUrl?: string
  specs?: Partial<Record<(typeof SPEC_KEYS)[number], string>>
}

function clean(value: string | undefined): string {
  return (value ?? '').trim()
}

function normalize(input: McpNewKnifeInput): CreateKnifeInput {
  const specs = Object.fromEntries(
    SPEC_KEYS.map((key) => [key, clean(input.specs?.[key])]),
  ) as Knife['specs']
  return {
    name: clean(input.name),
    brand: clean(input.brand),
    bladeStyle: clean(input.bladeStyle),
    handleMaterial: clean(input.handleMaterial),
    description: clean(input.description),
    sourceUrl: clean(input.sourceUrl),
    specs,
    customFields: {},
    // MCP never downloads or attaches images; add photos in the app.
    imageUrls: [],
    pinned: false,
    sold: false,
  }
}

function matchKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

async function findPossibleDuplicates(knife: CreateKnifeInput) {
  const name = matchKey(knife.name)
  const brand = matchKey(knife.brand)
  const model = matchKey(knife.specs.modelNumber ?? '')
  const all = await getStorage().getAllKnives()
  return all
    .filter((existing) => {
      const sameName = matchKey(existing.name) === name
      const sameBrand = !brand || matchKey(existing.brand) === brand
      const sameModel =
        model !== '' && matchKey(existing.specs.modelNumber ?? '') === model
      return (sameName && sameBrand) || sameModel
    })
    .map((existing) => ({
      id: existing.id,
      name: existing.name,
      brand: existing.brand,
      modelNumber: existing.specs.modelNumber ?? '',
      sold: existing.sold,
    }))
}

function previewHashFor(knife: CreateKnifeInput, duplicateIds: string[]) {
  return createHash('sha256')
    .update(JSON.stringify({ knife, duplicateIds }))
    .digest('hex')
}

/**
 * Preview (default) or create one knife. Applying requires the exact fresh
 * preview_hash; a duplicate that appears after the preview makes it stale.
 */
export async function addKnifeFromMcp({
  knife: input,
  apply = false,
  previewHash,
  allowDuplicate = false,
}: {
  knife: McpNewKnifeInput
  apply?: boolean
  previewHash?: string
  allowDuplicate?: boolean
  transport: McpTransport
}) {
  const run = async () => {
    const knife = normalize(input)
    if (!knife.name) throw new Error('Name is required')
    if (knife.sourceUrl && !/^https?:\/\//i.test(knife.sourceUrl))
      throw new Error('source_url must start with http:// or https://')
    const duplicates = await findPossibleDuplicates(knife)
    const hash = previewHashFor(
      knife,
      duplicates.map((entry) => entry.id),
    )

    if (!apply) {
      return {
        applied: false,
        previewHash: hash,
        knife: { ...knife, imageUrls: undefined },
        possibleDuplicates: duplicates,
        note:
          duplicates.length > 0
            ? 'Possible duplicates found. Ask the user before applying; applying then needs allow_duplicate: true.'
            : 'Nothing was saved. Show this preview to the user, then call add_knife again with apply: true and this preview_hash.',
      }
    }

    if (!previewHash || previewHash !== hash) {
      throw new Error(
        'Add preview is missing or stale; preview the exact knife again',
      )
    }
    if (duplicates.length > 0 && !allowDuplicate) {
      throw new Error(
        'Possible duplicate exists; confirm with the user and pass allow_duplicate: true',
      )
    }
    const created = await getStorage().createKnife(knife)
    return { applied: true, knife: created }
  }
  return apply ? withVaultWrite(run) : run()
}

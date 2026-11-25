import { createHash, randomUUID } from 'node:crypto'
import { withVaultWrite } from '@/lib/vault-access'
import type { Knife } from '@/lib/data'
import { getStorage } from '@/lib/storage'
import type { CreateKnifeInput } from '@/lib/storage/types'
import type { McpTransport } from '@/lib/services/knife-service'
import {
  downloadImages,
  normalizeImageUrls,
} from '@/lib/services/knife-image-service'

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
  /** Photo URLs to download and attach when the knife is created. */
  imageUrls?: string[]
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
    // Image URLs are checked and downloaded separately (see addKnifeFromMcp).
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

function previewHashFor(
  knife: CreateKnifeInput,
  duplicateIds: string[],
  imageUrls: string[],
) {
  return createHash('sha256')
    .update(JSON.stringify({ knife, duplicateIds, imageUrls }))
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
  transport,
}: {
  knife: McpNewKnifeInput
  apply?: boolean
  previewHash?: string
  allowDuplicate?: boolean
  transport: McpTransport
}) {
  const knife = normalize(input)
  if (!knife.name) throw new Error('Name is required')
  if (knife.sourceUrl && !/^https?:\/\//i.test(knife.sourceUrl))
    throw new Error('source_url must start with http:// or https://')
  const imageUrls = normalizeImageUrls(input.imageUrls ?? [])

  const check = async () => {
    const duplicates = await findPossibleDuplicates(knife)
    const hash = previewHashFor(
      knife,
      duplicates.map((entry) => entry.id),
      imageUrls,
    )
    return { duplicates, hash }
  }

  const verify = ({ duplicates, hash }: Awaited<ReturnType<typeof check>>) => {
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
  }

  const first = await check()
  if (apply) verify(first)

  // Downloads happen outside the vault write lease; the lease re-checks.
  const downloaded = imageUrls.length
    ? await downloadImages(imageUrls)
    : { checks: [], images: [] }

  if (!apply) {
    const { duplicates, hash } = first
    const imageNote =
      imageUrls.length > 0
        ? ` ${downloaded.images.length} of ${imageUrls.length} image URL(s) can be added; problem URLs are skipped.`
        : ''
    return {
      applied: false,
      previewHash: hash,
      knife: { ...knife, imageUrls: undefined },
      possibleDuplicates: duplicates,
      ...(imageUrls.length ? { images: downloaded.checks } : {}),
      note:
        (duplicates.length > 0
          ? 'Possible duplicates found. Ask the user before applying; applying then needs allow_duplicate: true.'
          : 'Nothing was saved. Show this preview to the user, then call add_knife again with apply: true and this preview_hash.') +
        imageNote,
    }
  }

  return withVaultWrite(async () => {
    verify(await check())
    const imageCount = downloaded.images.length
    const created = await getStorage().createKnife(
      {
        ...knife,
        imageUrls: downloaded.images.map(({ dataUrl }) => dataUrl),
      },
      {
        mutation: {
          operationId: randomUUID(),
          source: 'mcp',
          transport,
          tool: 'add_knife',
          summary:
            imageCount > 0
              ? `Created a new record via MCP with ${imageCount} photo(s) from ${downloaded.images
                  .map(({ url }) => url)
                  .join(', ')}.`
              : 'Created a new record via MCP.',
        },
      },
    )
    return {
      applied: true,
      knife: created,
      ...(imageUrls.length ? { images: downloaded.checks } : {}),
    }
  })
}

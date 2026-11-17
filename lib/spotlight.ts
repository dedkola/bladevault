import { getKnifeImageCount } from '@/lib/data'
import { createRandom } from '@/lib/studio'

export type SpotlightCandidate = {
  id: string
  sold: boolean
  images: string[]
  imageCount?: number
}

/** The local calendar day as YYYY-MM-DD, so "today" follows the user's clock. */
export function spotlightDateKey(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function hashString(value: string): number {
  // FNV-1a, 32-bit.
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Knives eligible for the spotlight, in canonical id order. Prefers unsold
 * knives with a photo, then any unsold knife, then the whole collection.
 */
export function spotlightPool<T extends SpotlightCandidate>(
  knives: readonly T[],
): T[] {
  const ordered = [...knives].sort((first, second) =>
    first.id.localeCompare(second.id),
  )
  const unsold = ordered.filter((knife) => !knife.sold)
  const photographed = unsold.filter((knife) => getKnifeImageCount(knife) > 0)
  if (photographed.length) return photographed
  return unsold.length ? unsold : ordered
}

/** The same knife for the same day and shuffle count, whatever the input order. */
export function pickSpotlight<T extends SpotlightCandidate>(
  knives: readonly T[],
  dateKey: string,
  nonce = 0,
): T | undefined {
  const pool = spotlightPool(knives)
  if (!pool.length) return undefined
  const random = createRandom(hashString(`${dateKey}#${nonce}`))
  return pool[Math.floor(random() * pool.length)]
}

export type StudioTileSize = 'regular' | 'tall' | 'wide'

export type StudioLayoutItem<T> = {
  knife: T
  size: StudioTileSize
}

function createRandom(seed: number) {
  let value = seed >>> 0
  return () => {
    value += 0x6d2b79f5
    let next = Math.imul(value ^ (value >>> 15), value | 1)
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61)
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(items: T[], random: () => number) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1))
    ;[items[index], items[target]] = [items[target], items[index]]
  }
  return items
}

/** Build from the complete collection, then filter entries to keep tile sizes stable. */
export function createStudioLayout<T extends { id: string }>(
  knives: readonly T[],
  seed: number,
): StudioLayoutItem<T>[] {
  const random = createRandom(seed)
  // Canonical input order keeps pinning and provider refreshes from reshuffling tiles.
  const ordered = shuffle(
    [...knives].sort((first, second) => first.id.localeCompare(second.id)),
    random,
  )
  const sizes: StudioTileSize[] = ordered.map(() => 'regular')

  if (sizes.length >= 4) {
    const tallCount = Math.max(1, Math.floor(sizes.length / 7))
    const wideCount = Math.max(1, Math.floor(sizes.length / 9))
    sizes.fill('tall', 0, tallCount)
    sizes.fill('wide', tallCount, tallCount + wideCount)
    shuffle(sizes, random)
  }

  return ordered.map((knife, index) => ({ knife, size: sizes[index] }))
}

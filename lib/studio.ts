export type StudioTileSize = 'regular' | 'tall' | 'wide' | 'hero'

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
  const sizes: StudioTileSize[] = []

  // Spread featured objects throughout a long collection, rather than leaving
  // whole stretches of the showcase with the same small tile size.
  for (let start = 0; start < ordered.length; start += 12) {
    const count = Math.min(12, ordered.length - start)
    const group: StudioTileSize[] = Array.from(
      { length: count },
      () => 'regular',
    )
    if (count >= 4) {
      group[0] = 'tall'
      group[1] = 'wide'
    }
    if (count >= 8) group[2] = 'tall'
    if (count >= 12) group[3] = 'hero'
    sizes.push(...shuffle(group, random))
  }

  return ordered.map((knife, index) => ({ knife, size: sizes[index] }))
}

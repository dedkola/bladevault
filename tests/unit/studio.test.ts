import { describe, expect, it } from 'vitest'
import { createStudioLayout } from '@/lib/studio'
import { createKnife } from '@/tests/fixtures/knife'

const knives = Array.from({ length: 14 }, (_, index) =>
  createKnife({ id: `knife-${index}`, name: `Knife ${index}` }),
)

function placements(seed: number) {
  return createStudioLayout(knives, seed).map(({ knife, size }) => ({
    id: knife.id,
    size,
  }))
}

describe('Studio layout', () => {
  it('reproduces a layout within a visit and changes it with a new seed', () => {
    expect(placements(123)).toEqual(placements(123))
    expect(placements(124)).not.toEqual(placements(123))
  })

  it('shows every collection item exactly once without changing records or input order', () => {
    const original = structuredClone(knives)
    const layout = createStudioLayout(knives, 42)

    expect(layout).toHaveLength(knives.length)
    expect(new Set(layout.map(({ knife }) => knife.id))).toEqual(
      new Set(knives.map(({ id }) => id)),
    )
    expect(knives).toEqual(original)
    expect(layout.every(({ knife }) => knives.includes(knife))).toBe(true)
  })

  it('keeps placement and tile sizes when pinning or provider order changes', () => {
    const changed = knives
      .map((knife) => ({ ...knife, pinned: !knife.pinned }))
      .reverse()
    const layout = createStudioLayout(changed, 123).map(({ knife, size }) => ({
      id: knife.id,
      size,
    }))

    expect(layout).toEqual(placements(123))
  })

  it('provides regular, tall, and wide tiles for collections of four or more items', () => {
    for (const count of [4, 5, 14, 100]) {
      const collection = Array.from({ length: count }, (_, index) => ({
        id: String(index),
      }))
      for (const seed of [0, 1, 123, 4294967295]) {
        const layout = createStudioLayout(collection, seed)
        expect(new Set(layout.map(({ size }) => size))).toEqual(
          new Set(['regular', 'tall', 'wide']),
        )
        expect(
          layout.filter(({ size }) => size === 'regular').length,
        ).toBeGreaterThanOrEqual(count / 2)
      }
    }
  })

  it('keeps sparse collections compact and handles an empty vault', () => {
    expect(createStudioLayout([], 42)).toEqual([])
    for (const count of [1, 2, 3]) {
      expect(
        createStudioLayout(knives.slice(0, count), 42).every(
          ({ size }) => size === 'regular',
        ),
      ).toBe(true)
    }
  })
})

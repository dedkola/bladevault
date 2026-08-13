import { describe, expect, it } from 'vitest'
import {
  collapseCategories,
  createCollectionStats,
  filterKnivesByStatsPeriod,
  parseLengthToInches,
  parseLengthToMillimeters,
  parseWeightToOunces,
} from '@/lib/collection-stats'
import { createKnife } from '@/tests/fixtures/knife'

describe('collection statistics', () => {
  it('normalizes imperial, metric, and dual-unit measurements', () => {
    expect(parseLengthToInches('3.5 in')).toBeCloseTo(3.5)
    expect(parseLengthToInches('88.9 mm')).toBeCloseTo(3.5)
    expect(parseLengthToInches('8.18" / 207.7 mm')).toBeCloseTo(8.18)
    expect(parseLengthToMillimeters('0.12 in')).toBeCloseTo(3.048)
    expect(parseLengthToMillimeters('3 mm')).toBeCloseTo(3)
    expect(parseWeightToOunces('4.50 oz / 127.5 g')).toBeCloseTo(4.5)
    expect(parseWeightToOunces('100 g')).toBeCloseTo(3.5274, 3)
    expect(parseLengthToInches('unknown')).toBeUndefined()
    expect(parseWeightToOunces('')).toBeUndefined()
  })

  it('filters entries by the selected addition period', () => {
    const knives = [
      createKnife({ id: 'old', addedAt: '2024-10-01T12:00:00.000Z' }),
      createKnife({ id: 'recent', addedAt: '2026-05-01T12:00:00.000Z' }),
    ]
    const now = new Date('2026-08-12T12:00:00.000Z')

    expect(filterKnivesByStatsPeriod(knives, 'all', now)).toHaveLength(2)
    expect(
      filterKnivesByStatsPeriod(knives, 'year', now).map(({ id }) => id),
    ).toEqual(['recent'])
    expect(
      filterKnivesByStatsPeriod(knives, 'twelve-months', now).map(
        ({ id }) => id,
      ),
    ).toEqual(['recent'])
  })

  it('aggregates categories, distributions, completeness, and activity', () => {
    const knives = [
      createKnife({
        id: 'one',
        brand: 'Benchmade',
        addedAt: '2026-08-10T12:00:00.000Z',
        pinned: true,
      }),
      createKnife({
        id: 'two',
        brand: 'benchmade',
        bladeStyle: 'Tanto',
        handleMaterial: '',
        addedAt: '2026-08-10T18:00:00.000Z',
        specs: {
          ...createKnife().specs,
          bladeLength: '88.9 mm',
          bladeThickness: '',
          weight: '100 g',
          bladeMaterial: 'M390',
          designer: 'Mel Pardue',
        },
      }),
      createKnife({
        id: 'three',
        brand: 'Spyderco',
        addedAt: '2026-06-01T12:00:00.000Z',
        specs: {
          ...createKnife().specs,
          bladeLength: '',
          bladeMaterial: 'M390',
        },
      }),
    ]

    const stats = createCollectionStats(
      knives,
      'all',
      new Date('2026-08-12T12:00:00.000Z'),
      [
        {
          knifeId: 'one',
          type: 'created',
          occurredAt: '2026-08-10T12:00:00.000Z',
        },
        {
          knifeId: 'two',
          type: 'created',
          occurredAt: '2026-08-10T18:00:00.000Z',
        },
        {
          knifeId: 'three',
          type: 'created',
          occurredAt: '2026-06-01T12:00:00.000Z',
        },
        {
          knifeId: 'one',
          type: 'updated',
          occurredAt: '2026-08-11T12:00:00.000Z',
        },
        {
          knifeId: 'one',
          type: 'updated',
          occurredAt: '2026-08-11T18:00:00.000Z',
        },
        {
          knifeId: 'two',
          type: 'updated',
          occurredAt: '2026-08-11T20:00:00.000Z',
        },
      ],
    )

    expect(stats.total).toBe(3)
    expect(stats.pinnedCount).toBe(1)
    expect(stats.categories.brand[0]).toMatchObject({
      name: 'Benchmade',
      count: 2,
      percent: 67,
    })
    expect(stats.categories.bladeMaterial[0]).toMatchObject({
      name: 'M390',
      count: 2,
    })
    expect(stats.measurements.bladeLength.knownCount).toBe(2)
    expect(stats.measurements.bladeLength.median).toBeCloseTo(3.37, 1)
    expect(stats.measurements.weight.knownCount).toBe(3)
    expect(stats.completeness).toBeLessThan(100)
    expect(stats.missingFields.map(({ label }) => label)).toEqual(
      expect.arrayContaining(['Blade thickness', 'Handle material']),
    )
    expect(stats.activeDays).toBe(3)
    expect(stats.additionsInActivityRange).toBe(3)
    expect(stats.editsInActivityRange).toBe(2)
    expect(
      stats.activity.find(({ dateKey }) => dateKey === '2026-08-10'),
    ).toMatchObject({
      count: 2,
      addedCount: 2,
      editedCount: 0,
      knifeIds: ['one', 'two'],
      addedKnifeIds: ['one', 'two'],
      editedKnifeIds: [],
    })
    expect(
      stats.activity.find(({ dateKey }) => dateKey === '2026-08-11'),
    ).toMatchObject({
      count: 2,
      addedCount: 0,
      editedCount: 2,
      knifeIds: ['one', 'two'],
      addedKnifeIds: [],
      editedKnifeIds: ['one', 'two'],
    })
  })

  it('uses ten fine-grained measurement bins around common blade lengths', () => {
    const bladeLengths = [
      '2.99 in',
      '3.0 in',
      '3.12 in',
      '3.24 in',
      '3.25 in',
      '3.49 in',
      '3.5 in',
    ]
    const knives = bladeLengths.map((bladeLength, index) =>
      createKnife({
        id: `blade-${index}`,
        specs: { ...createKnife().specs, bladeLength },
      }),
    )

    const measurements = createCollectionStats(knives, 'all').measurements
    const measurement = measurements.bladeLength

    expect(Object.values(measurements).map(({ bins }) => bins.length)).toEqual([
      10, 10, 10, 10,
    ])
    expect(measurement.bins).toHaveLength(10)
    expect(measurement.bins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '2.75–3.0″', count: 1 }),
        expect.objectContaining({ label: '3.0–3.25″', count: 3 }),
        expect.objectContaining({ label: '3.25–3.5″', count: 2 }),
        expect.objectContaining({ label: '3.5–3.75″', count: 1 }),
      ]),
    )
  })

  it('collapses long category lists into an Other group', () => {
    const categories = ['A', 'B', 'C', 'D', 'E', 'F'].map((name, index) => ({
      name,
      count: 6 - index,
      percent: 0,
      knifeIds: [`${index}`],
    }))

    expect(collapseCategories(categories, 5).map(({ name }) => name)).toEqual([
      'A',
      'B',
      'C',
      'D',
      'Other',
    ])
    expect(collapseCategories(categories, 5).at(-1)?.knifeIds).toEqual([
      '4',
      '5',
    ])
  })

  it('keeps collapsed percentages relative to the whole collection', () => {
    const collapsed = collapseCategories(
      [
        { name: 'A', count: 4, percent: 40, knifeIds: ['1', '2', '3', '4'] },
        { name: 'B', count: 2, percent: 20, knifeIds: ['5', '6'] },
        { name: 'C', count: 1, percent: 10, knifeIds: ['7'] },
      ],
      2,
      10,
    )

    expect(collapsed[1]).toMatchObject({ name: 'Other', count: 3, percent: 30 })
  })
})

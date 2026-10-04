import { describe, expect, it } from 'vitest'
import {
  affectedMaterialCollections,
  formatInterpretedMeasurement,
  getMaterialAliasGroups,
  measurementIssue,
  readCleanupQueue,
} from '@/lib/collection-cleanup'
import { createKnife } from '@/tests/fixtures/knife'
import { createCollectionStats } from '@/lib/collection-stats'

describe('collection cleanup', () => {
  it('keeps chart counts aligned with missing and uninterpretable review states', () => {
    const values = ['', 'unknown', '-3 mm', '.090 inches']
    const knives = values.map((bladeThickness, index) =>
      createKnife({
        id: `${index}`,
        specs: { ...createKnife().specs, bladeThickness },
      }),
    )
    const measurement = createCollectionStats(knives, 'all').measurements
      .bladeThickness
    expect(measurement).toMatchObject({
      knownCount: 1,
      missingCount: 1,
      uninterpretableCount: 2,
    })
    expect(measurement.min).toBeCloseTo(2.286)
    expect(measurement.max).toBeCloseTo(2.286)
    expect(
      measurement.knownCount +
        measurement.missingCount +
        measurement.uninterpretableCount,
    ).toBe(knives.length)
  })
  it('separates empty, unsupported, and understood measurements without changing source text', () => {
    const knife = createKnife({
      specs: { ...createKnife().specs, bladeThickness: '.090 inches' },
    })
    expect(measurementIssue('bladeThickness', '  ')).toBe('missing')
    expect(measurementIssue('bladeThickness', '3-ish mm')).toBe(
      'uninterpretable',
    )
    expect(measurementIssue('bladeThickness', '-3 mm')).toBe('uninterpretable')
    expect(measurementIssue('bladeThickness', '1/0 in')).toBe('uninterpretable')
    expect(
      measurementIssue('bladeThickness', knife.specs.bladeThickness!),
    ).toBeUndefined()
    expect(
      formatInterpretedMeasurement(
        'bladeThickness',
        knife.specs.bladeThickness!,
      ),
    ).toBe('2.286 mm — understood')
    expect(formatInterpretedMeasurement('bladeLength', '3 1/2 in')).toBe(
      '88.9 mm — understood',
    )
    expect(formatInterpretedMeasurement('weight', '120 g')).toBe(
      '120 g — understood',
    )
    expect(knife.specs.bladeThickness).toBe('.090 inches')
  })

  it('groups known material spellings and case variants but leaves composites and similar names separate', () => {
    const materials = [
      'G10',
      'G-10',
      'g10',
      'Carbon Fiber / G-10',
      'Carbon Fiber',
      'Titanium',
      'titanium',
      'Micarta',
      'Canvas Micarta',
    ]
    const groups = getMaterialAliasGroups(
      materials.map((handleMaterial, index) =>
        createKnife({ id: `${index}`, handleMaterial }),
      ),
    )
    expect(groups).toHaveLength(2)
    expect(groups[0].suggestedValue).toBe('G-10')
    expect(
      groups[0].values.flatMap((value) =>
        value.knives.map((knife) => knife.id),
      ),
    ).toEqual(expect.arrayContaining(['0', '1', '2']))
    expect(groups[1].values.map((value) => value.value)).toEqual(
      expect.arrayContaining(['Titanium', 'titanium']),
    )
    expect(
      getMaterialAliasGroups([createKnife({ handleMaterial: 'G10' })]),
    ).toEqual([])
  })

  it('identifies only saved filters using labels that will change, including multi-value filters', () => {
    const collections = [
      { id: 'a', name: 'Old label', query: 'handleMaterial=G10&brand=Vosteed' },
      {
        id: 'b',
        name: 'Either',
        query: 'handleMaterial=Titanium&handleMaterial=G10',
      },
      { id: 'c', name: 'Keep', query: 'handleMaterial=G-10' },
      { id: 'd', name: 'Search', query: 'q=G10' },
      {
        id: 'e',
        name: 'Composite',
        query: 'handleMaterial=Carbon+Fiber+%2F+G10',
      },
    ]
    expect(
      affectedMaterialCollections(collections, ['G10']).map(
        (collection) => collection.id,
      ),
    ).toEqual(['a', 'b'])
  })

  it('rejects damaged session queues and preserves valid progress', () => {
    const queue = {
      field: 'bladeThickness',
      issue: 'missing',
      entries: [{ id: 'knife', addedAt: '2026-01-01' }],
      index: 1,
      saved: 1,
      skipped: 0,
    }
    expect(readCleanupQueue(JSON.stringify(queue))).toEqual(queue)
    for (const invalid of [
      null,
      '{',
      '{}',
      JSON.stringify({ ...queue, field: 'country' }),
      JSON.stringify({ ...queue, index: 2 }),
      JSON.stringify({ ...queue, saved: 4 }),
      JSON.stringify({ ...queue, entries: [null] }),
    ]) {
      expect(readCleanupQueue(invalid)).toBeNull()
    }
  })
})

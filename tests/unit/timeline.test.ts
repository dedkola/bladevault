import { describe, expect, it } from 'vitest'
import type { KnifeNote, MaintenanceEvent, MaintenanceType } from '@/lib/data'
import {
  buildTimelineEntries,
  isKnifeCountMilestone,
  isMaintenanceCountMilestone,
} from '@/lib/timeline'
import { createKnife } from '../fixtures/knife'

// Local noon keeps month/year assertions stable in any test timezone.
const at = (year: number, month: number, day: number) =>
  new Date(year, month, day, 12).toISOString()

const knife = (id: string, brand: string, addedAt: string, name = id) =>
  createKnife({ id, brand, name, addedAt, images: [`${id}.jpg`] })

let nextId = 1
const maintenance = (
  knifeId: string,
  occurredAt: string,
  type: MaintenanceType = 'sharpening',
  notes = '',
): MaintenanceEvent => ({
  id: nextId++,
  knifeId,
  type,
  occurredAt,
  notes,
  createdAt: occurredAt,
})

const note = (knifeId: string, notedAt: string, body: string): KnifeNote => ({
  id: nextId++,
  knifeId,
  body,
  images: [],
  notedAt,
  createdAt: notedAt,
  updatedAt: notedAt,
})

describe('timeline milestones', () => {
  it('marks 10, 25, 50, then every 25 knives', () => {
    const hits = Array.from({ length: 150 }, (_, i) => i + 1).filter(
      isKnifeCountMilestone,
    )
    expect(hits).toEqual([10, 25, 50, 75, 100, 125, 150])
  })

  it('marks the first, 50th, 100th, 250th, then every 500th maintenance', () => {
    const hits = Array.from({ length: 1500 }, (_, i) => i + 1).filter(
      isMaintenanceCountMilestone,
    )
    expect(hits).toEqual([1, 50, 100, 250, 500, 1000, 1500])
  })
})

describe('buildTimelineEntries', () => {
  it('starts the story with the first knife and flags each new brand after it', () => {
    const entries = buildTimelineEntries([
      knife('pm2', 'Spyderco', at(2024, 4, 2), 'Paramilitary 2'),
      knife('bugout', 'Benchmade', at(2023, 0, 5), 'Bugout'),
      knife('mini', 'benchmade ', at(2024, 6, 1), 'Mini Bugout'),
    ])

    expect(entries.map((entry) => entry.id)).toEqual([
      'added:bugout',
      'milestone:first-knife',
      'added:pm2',
      'added:mini',
    ])
    expect(entries[1]).toMatchObject({
      title: 'The collection begins',
      detail: 'Benchmade Bugout started it all.',
      knife: { id: 'bugout', image: 'bugout.jpg', sold: false },
    })
    expect(entries[0].firstOfBrand).toBeUndefined()
    expect(entries[2].firstOfBrand).toBe(true)
    expect(entries[3].firstOfBrand).toBeUndefined()
  })

  it('adds count milestones right after the knife that reached them', () => {
    const knives = Array.from({ length: 10 }, (_, i) =>
      knife(`k${i + 1}`, 'Brand', at(2024, 0, i + 1)),
    )
    const entries = buildTimelineEntries(knives)
    const tenth = entries.findIndex(
      (entry) => entry.id === 'milestone:knife-count-10',
    )
    expect(entries[tenth - 1].id).toBe('added:k10')
    expect(entries[tenth]).toMatchObject({
      title: '10th knife',
      knife: { id: 'k10' },
      milestone: 'knife-count',
    })
  })

  it('turns maintenance and notes into readable entries for known knives only', () => {
    const entries = buildTimelineEntries(
      [knife('bugout', 'Benchmade', at(2024, 0, 1), 'Bugout')],
      [
        maintenance(
          'bugout',
          at(2024, 1, 1),
          'lubrication',
          '**Nano-Oil** on the pivot',
        ),
        maintenance('deleted', at(2024, 1, 2)),
        maintenance('bugout', 'not a date'),
      ],
      [
        note('bugout', at(2024, 2, 1), `# Carry log\n\n${'x'.repeat(300)}`),
        note('deleted', at(2024, 2, 2), 'gone'),
      ],
    )

    expect(entries.map((entry) => entry.type)).toEqual([
      'added',
      'milestone',
      'maintenance',
      'milestone',
      'note',
    ])
    expect(entries[2]).toMatchObject({
      title: 'Lubrication',
      detail: 'Nano-Oil on the pivot',
      maintenanceType: 'lubrication',
    })
    expect(entries[3]).toMatchObject({
      id: 'milestone:maintenance-count-1',
      title: 'First maintenance logged',
      detail: 'Lubrication on the Benchmade Bugout.',
    })
    expect(entries[4].detail).toMatch(/^Carry log x+…$/)
    expect(entries[4].detail).toHaveLength(220)
  })

  it('skips knives with an unreadable added date', () => {
    expect(
      buildTimelineEntries([knife('broken', 'Brand', 'not a date')]),
    ).toEqual([])
  })
})

describe('empty collection', () => {
  it('has no entries', () => {
    expect(buildTimelineEntries([])).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import type { KnifeNote, MaintenanceEvent, MaintenanceType } from '@/lib/data'
import { buildYearRecap } from '@/lib/timeline-stats'
import { createKnife } from '../fixtures/knife'

const at = (year: number, month: number, day: number) =>
  new Date(year, month, day, 12).toISOString()

const knife = (id: string, brand: string, addedAt: string, name = id) =>
  createKnife({ id, brand, name, addedAt })

let nextId = 1
const maintenance = (
  knifeId: string,
  occurredAt: string,
  type: MaintenanceType = 'sharpening',
): MaintenanceEvent => ({
  id: nextId++,
  knifeId,
  type,
  occurredAt,
  notes: '',
  createdAt: occurredAt,
})

const note = (knifeId: string, notedAt: string): KnifeNote => ({
  id: nextId++,
  knifeId,
  body: 'note',
  images: [],
  notedAt,
  createdAt: notedAt,
  updatedAt: notedAt,
})

describe('buildYearRecap', () => {
  const knives = [
    knife('old', 'Benchmade', at(2024, 5, 1), 'Bugout'),
    knife('pm2', 'Spyderco', at(2025, 1, 10), 'Paramilitary 2'),
    knife('para3', 'spyderco', at(2025, 1, 20), 'Para 3'),
    knife('mini', 'Benchmade', at(2025, 6, 4), 'Mini Bugout'),
    knife('nameless', '', at(2025, 8, 1), 'Mystery'),
    knife('next', 'Chris Reeve', at(2026, 0, 3), 'Sebenza'),
  ]
  const events = [
    maintenance('old', at(2025, 1, 2), 'cleaning'),
    maintenance('pm2', at(2025, 1, 15)),
    maintenance('pm2', at(2025, 3, 1)),
    maintenance('pm2', at(2025, 4, 1), 'lubrication'),
    maintenance('old', at(2024, 8, 1)),
    maintenance('deleted', at(2025, 1, 3)),
  ]
  const notes = [note('pm2', at(2025, 1, 25)), note('deleted', at(2025, 1, 26))]

  it('summarizes additions, brands, maintenance, and notes for one year', () => {
    const recap = buildYearRecap(knives, events, notes, 2025)

    expect(recap).toMatchObject({
      year: 2025,
      knivesAdded: 4,
      collectionSize: 5,
      brandCount: 2,
      newBrands: ['Spyderco'],
      topBrand: { name: 'Spyderco', count: 2 },
      firstAddition: { id: 'pm2', name: 'Paramilitary 2' },
      totalMaintenance: 4,
      maintenanceByType: [
        { type: 'sharpening', count: 2 },
        { type: 'cleaning', count: 1 },
        { type: 'lubrication', count: 1 },
      ],
      mostMaintained: { knife: { id: 'pm2' }, count: 3 },
      maintainedKnives: 2,
      notesWritten: 1,
      // Feb: two additions, two maintenance sessions, one note.
      busiestMonth: { month: 1, count: 5 },
    })
  })

  it('returns an empty recap for a year with no activity', () => {
    const recap = buildYearRecap(knives, events, notes, 2020)
    expect(recap).toEqual({
      year: 2020,
      knivesAdded: 0,
      collectionSize: 0,
      brandCount: 0,
      newBrands: [],
      totalMaintenance: 0,
      maintenanceByType: [],
      maintainedKnives: 0,
      notesWritten: 0,
    })
  })

  it('counts a brand as new only in the year its first knife arrived', () => {
    expect(buildYearRecap(knives, [], [], 2024).newBrands).toEqual([
      'Benchmade',
    ])
    expect(buildYearRecap(knives, [], [], 2026)).toMatchObject({
      newBrands: ['Chris Reeve'],
      collectionSize: 6,
    })
  })
})

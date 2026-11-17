import { describe, expect, it } from 'vitest'
import type { MaintenanceEvent } from '@/lib/data'
import { buildHistoryStory } from '@/lib/history-story'
import { createKnife } from '../fixtures/knife'

const at = (month: number, day: number) =>
  new Date(2026, month, day, 12).toISOString()

describe('buildHistoryStory', () => {
  const knives = [
    createKnife({ id: 'old', brand: 'Benchmade', addedAt: at(5, 1) }),
    createKnife({ id: 'pm2', brand: 'Spyderco', addedAt: at(7, 1) }),
    createKnife({ id: 'new', brand: 'Spyderco', addedAt: at(8, 1) }),
  ]

  it('adds knives History never saw created, and keeps milestones', () => {
    const story = buildHistoryStory(
      [
        { type: 'created', knifeId: 'new' },
        { type: 'updated', knifeId: 'old' },
      ],
      knives,
    )
    expect(story.entries.map((entry) => entry.id)).toEqual([
      'added:old',
      'milestone:first-knife',
      'added:pm2',
    ])
    expect([...story.firstOfBrand]).toEqual(['pm2'])
  })

  it('includes maintenance milestones and nothing for recorded maintenance', () => {
    const event: MaintenanceEvent = {
      id: 1,
      knifeId: 'old',
      type: 'sharpening',
      occurredAt: at(6, 1),
      notes: '',
      createdAt: at(6, 1),
    }
    const story = buildHistoryStory(
      knives.map((knife) => ({ type: 'created', knifeId: knife.id })),
      knives,
      [event],
    )
    expect(story.entries.map((entry) => entry.id)).toEqual([
      'milestone:first-knife',
      'milestone:maintenance-count-1',
    ])
  })
})

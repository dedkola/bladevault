import { describe, expect, it } from 'vitest'
import { showcaseUnlocks } from '@/components/achievement-share-card'

const unlock = (id: string, unlockedAt: string) => ({
  id,
  unlockedAt,
  knifeId: null,
  backfilled: false,
  seenAt: unlockedAt,
})

describe('trophy card showcase', () => {
  it('leads with the highest tiers, then the newest, and skips unknown ids', () => {
    expect(
      showcaseUnlocks(
        [
          unlock('first-blade', '2026-01-01T00:00:00.000Z'),
          unlock('perfectionist', '2026-01-02T00:00:00.000Z'),
          unlock('pocketful', '2026-03-01T00:00:00.000Z'),
          unlock('retired-badge', '2026-04-01T00:00:00.000Z'),
        ],
        3,
      ),
    ).toEqual(['perfectionist', 'pocketful', 'first-blade'])
  })
})

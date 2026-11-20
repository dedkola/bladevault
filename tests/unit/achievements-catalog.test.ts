import { describe, expect, it } from 'vitest'
import {
  ACHIEVEMENT_RANKS,
  ACHIEVEMENTS,
  MAX_ACHIEVEMENT_SCORE,
  evaluateAchievements,
  nextAchievements,
  summarizeAchievements,
  type AchievementProgress,
} from '@/lib/achievements/catalog'
import {
  longestDayStreak,
  resolveCountry,
  type AchievementInput,
} from '@/lib/achievements/snapshot'
import type { Knife } from '@/lib/data'
import { createKnife } from '@/tests/fixtures/knife'

const NOW = new Date(2026, 10, 20, 12)

/** Local-time ISO string, so day and hour checks hold in any time zone. */
function at(year: number, month: number, day: number, hour = 12): string {
  return new Date(year, month - 1, day, hour).toISOString()
}

function knives(
  count: number,
  make: (index: number) => Partial<Knife> = () => ({}),
) {
  return Array.from({ length: count }, (_, index) =>
    createKnife({
      id: `knife-${index}`,
      addedAt: at(2026, 3, 2),
      ...make(index),
    }),
  )
}

function evaluate(input: Partial<AchievementInput>) {
  const progress = evaluateAchievements({ knives: [], now: NOW, ...input })
  const byId = new Map(progress.map((entry) => [entry.id, entry]))
  return (id: string): AchievementProgress => {
    const entry = byId.get(id)
    if (!entry) throw new Error(`Unknown achievement ${id}`)
    return entry
  }
}

function unlocked(input: Partial<AchievementInput>): string[] {
  return evaluateAchievements({ knives: [], now: NOW, ...input })
    .filter((entry) => entry.done)
    .map((entry) => entry.id)
}

describe('achievement catalog', () => {
  it('has exactly 100 achievements with unique ids and positive targets', () => {
    expect(ACHIEVEMENTS).toHaveLength(100)
    expect(new Set(ACHIEVEMENTS.map((a) => a.id)).size).toBe(100)
    for (const achievement of ACHIEVEMENTS) {
      expect(achievement.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(achievement.target).toBeGreaterThan(0)
    }
  })

  it('keeps the top rank reachable', () => {
    expect(MAX_ACHIEVEMENT_SCORE).toBe(2895)
    expect(ACHIEVEMENT_RANKS.at(-1)!.minScore).toBeLessThanOrEqual(
      MAX_ACHIEVEMENT_SCORE,
    )
  })

  it('unlocks nothing for an empty vault', () => {
    expect(unlocked({})).toEqual([])
  })
})

describe('collection badges', () => {
  it('counts owned knives towards size badges and sold ones towards rotation', () => {
    const vault = knives(12, (index) => ({ sold: index < 2 }))
    const get = evaluate({ knives: vault })
    expect(get('drawer-starter')).toMatchObject({ current: 10, done: true })
    expect(get('quarter-century')).toMatchObject({ current: 10, done: false })
    expect(get('moving-on').done).toBe(true)
    expect(get('rotation').current).toBe(2)
  })

  it('treats brand and steel spellings as the same label', () => {
    const get = evaluate({
      knives: [
        createKnife({
          id: 'a',
          brand: 'Spyderco',
          specs: { ...createKnife().specs, bladeMaterial: 'CPM-MagnaCut' },
        }),
        createKnife({
          id: 'b',
          brand: 'spyderco ',
          specs: { ...createKnife().specs, bladeMaterial: 'MagnaCut' },
        }),
        createKnife({
          id: 'c',
          brand: 'Unknown',
          specs: { ...createKnife().specs, bladeMaterial: 'cpm magnacut' },
        }),
      ],
    })
    expect(get('brand-curious').current).toBe(1)
    expect(get('steel-curious').current).toBe(1)
    expect(get('super-steel').done).toBe(true)
    expect(get('magna-cult').current).toBe(3)
  })

  it('reads materials, shapes and locks', () => {
    const base = createKnife().specs
    const done = unlocked({
      knives: [
        createKnife({
          id: 'a',
          handleMaterial: 'Carbon Fiber',
          bladeStyle: 'Tanto',
          specs: {
            ...base,
            bladeMaterial: '1095',
            lockingMechanism: 'Slip Joint',
          },
        }),
        createKnife({
          id: 'b',
          handleMaterial: 'Desert Ironwood',
          bladeStyle: "Sheep's Foot",
          specs: {
            ...base,
            bladeMaterial: 'Damascus',
            lockingMechanism: 'Frame Lock',
          },
        }),
        createKnife({
          id: 'c',
          handleMaterial: 'FRN',
          specs: { ...base, bladeMaterial: '8Cr13MoV' },
        }),
      ],
    })
    expect(done).toEqual(
      expect.arrayContaining([
        'carbon-copy',
        'natural-born',
        'plastic-fantastic',
        'tanto-time',
        'straight-edge',
        'gentlemans-carry',
        'old-school',
        'damascus-dreams',
        'budget-hero',
      ]),
    )
  })

  it('parses measurements in either unit', () => {
    const base = createKnife().specs
    const done = unlocked({
      knives: [
        createKnife({
          id: 'light',
          specs: {
            ...base,
            weight: '30 g',
            bladeLength: '1.8 in',
            bladeThickness: '2 mm',
          },
        }),
        createKnife({
          id: 'big',
          specs: {
            ...base,
            weight: '12 oz',
            bladeLength: '140 mm',
            overallLength: '13 in',
            bladeThickness: '0.25 in',
          },
        }),
      ],
    })
    expect(done).toEqual(
      expect.arrayContaining([
        'featherweight',
        'heavyweight',
        'tiny-titan',
        'big-stick',
        'sword-adjacent',
        'pry-bar',
        'laser-beam',
      ]),
    )
  })

  it('adds blade lengths up in centimetres', () => {
    const vault = knives(13, () => ({
      specs: { ...createKnife().specs, bladeLength: '3 in' },
    }))
    const get = evaluate({ knives: vault })
    expect(get('metre-of-edge')).toMatchObject({ current: 99, done: false })
    const more = evaluate({
      knives: knives(14, () => ({
        specs: { ...createKnife().specs, bladeLength: '3 in' },
      })),
    })
    expect(more('metre-of-edge').done).toBe(true)
  })

  it('resolves countries and continents', () => {
    expect(resolveCountry('Made in USA')).toEqual({
      key: 'usa',
      continent: 'NA',
    })
    expect(resolveCountry('Seki, Japan')).toEqual({
      key: 'japan',
      continent: 'AS',
    })
    expect(resolveCountry('Solingen Germany')?.continent).toBe('EU')
    expect(resolveCountry('n/a')).toBeUndefined()
    expect(resolveCountry('Atlantis')).toEqual({ key: 'atlantis' })

    const base = createKnife().specs
    const get = evaluate({
      knives: ['USA', 'Japan', 'Italy', 'Australia', 'Atlantis'].map(
        (country, index) =>
          createKnife({ id: `k${index}`, specs: { ...base, country } }),
      ),
    })
    expect(get('passport').current).toBe(5)
    expect(get('continental')).toMatchObject({ current: 4, done: true })
    expect(get('seki-spirit').done).toBe(true)
  })
})

describe('catalogue and care badges', () => {
  it('requires a minimum vault size for whole-collection badges', () => {
    const small = evaluate({ knives: knives(5, () => ({ images: ['a.jpg'] })) })
    expect(small('every-face-counts')).toMatchObject({
      current: 0,
      done: false,
    })
    const large = evaluate({
      knives: knives(10, () => ({ images: ['a.jpg'] })),
    })
    expect(large('every-face-counts')).toMatchObject({
      current: 100,
      done: true,
    })
  })

  it('uses imageCount from list summaries', () => {
    const vault = [{ ...createKnife({ images: ['a.jpg'] }), imageCount: 6 }]
    expect(evaluate({ knives: vault })('shutterbug').done).toBe(true)
  })

  it('counts care by type, same-day rebuilds and streaks', () => {
    const events = [
      {
        knifeId: 'knife-0',
        type: 'disassembly' as const,
        occurredAt: at(2026, 5, 1, 9),
      },
      {
        knifeId: 'knife-0',
        type: 'reassembly' as const,
        occurredAt: at(2026, 5, 1, 18),
      },
      ...Array.from({ length: 7 }, (_, day) => ({
        knifeId: 'knife-1',
        type: 'sharpening' as const,
        occurredAt: at(2026, 5, 28 + day),
      })),
    ]
    const get = evaluate({ knives: knives(2), maintenance: events })
    expect(get('surgeon').done).toBe(true)
    expect(get('sharp-dressed').done).toBe(true)
    expect(get('whetstone-monk').current).toBe(7)
    // 28 May → 3 June crosses a month boundary.
    expect(get('caretaker')).toMatchObject({ current: 7, done: true })
  })

  it('only clears Inbox Zero after clearing reminders with enough knives', () => {
    const inboxZero = (input: Partial<AchievementInput>) =>
      evaluate(input)('inbox-zero').done
    expect(inboxZero({ knives: knives(10) })).toBe(false)
    // A vault that never had a reminder has nothing to clear.
    expect(inboxZero({ knives: knives(10), openCareReminders: 0 })).toBe(false)
    expect(
      inboxZero({
        knives: knives(10),
        openCareReminders: 0,
        clearedCareReminders: 2,
      }),
    ).toBe(true)
    expect(
      inboxZero({
        knives: knives(10),
        openCareReminders: 1,
        clearedCareReminders: 2,
      }),
    ).toBe(false)
    expect(
      inboxZero({
        knives: knives(9),
        openCareReminders: 0,
        clearedCareReminders: 2,
      }),
    ).toBe(false)
  })
})

describe('habit badges', () => {
  it('reads local dates and times of additions', () => {
    const dates = [
      at(2025, 12, 25), // Christmas, Thursday
      at(2026, 2, 13), // Friday the 13th
      at(2026, 3, 1, 2), // night owl, Sunday
      at(2026, 3, 7), // Saturday
    ]
    const done = unlocked({
      knives: dates.map((addedAt, index) =>
        createKnife({ id: `k${index}`, addedAt }),
      ),
    })
    expect(done).toEqual(
      expect.arrayContaining([
        'christmas-blade',
        'friday-the-13th',
        'night-owl',
      ]),
    )
    expect(evaluate({ knives: [] })('weekend-warrior').current).toBe(0)
  })

  it('measures vault age from the earliest addition', () => {
    const get = evaluate({
      knives: [createKnife({ addedAt: at(2025, 11, 1) })],
    })
    expect(get('anniversary')).toMatchObject({ current: 1, done: true })
    expect(get('veteran').done).toBe(false)
  })

  it('finds the longest run of consecutive days', () => {
    expect(longestDayStreak(new Set())).toBe(0)
    expect(
      longestDayStreak(
        new Set(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-03']),
      ),
    ).toBe(3)
  })

  it('unlocks The Answer at exactly 42 owned knives', () => {
    expect(evaluate({ knives: knives(42) })('the-answer').done).toBe(true)
    expect(evaluate({ knives: knives(43) })('the-answer').done).toBe(false)
  })
})

describe('market badges', () => {
  it('marks monitoring badges unavailable while price monitoring is off', () => {
    const get = evaluate({ knives: knives(1) })
    expect(get('price-watcher')).toMatchObject({
      available: false,
      done: false,
      current: 0,
    })
    // Price badges from stored prices do not need monitoring.
    expect(get('grail').available).toBe(true)
  })

  it('reads price monitoring results', () => {
    const get = evaluate({
      knives: knives(1),
      priceMonitoring: {
        watchedKnives: 3,
        dropPercents: [-12, -31.5],
        backInStock: 1,
      },
    })
    expect(get('price-watcher').done).toBe(true)
    expect(get('deal-hunter').done).toBe(true)
    expect(get('bargain-bin')).toMatchObject({ current: 31, done: true })
    expect(get('restock-radar').done).toBe(true)
    expect(get('market-analyst').current).toBe(3)
  })

  it('sums stored prices per currency and ignores unknown currencies', () => {
    const base = createKnife().specs
    const get = evaluate({
      knives: [
        createKnife({ id: 'a', specs: { ...base, price: '$1,250' } }),
        createKnife({ id: 'b', specs: { ...base, price: '15 USD' } }),
        createKnife({ id: 'c', specs: { ...base, price: '¥200,000' } }),
      ],
    })
    expect(get('grail').done).toBe(true)
    expect(get('gas-station-special').done).toBe(true)
    expect(get('big-spender').current).toBe(1265)
  })
})

describe('summary and next up', () => {
  it('scores unlocked ids and ignores unknown ones', () => {
    const summary = summarizeAchievements([
      'first-blade',
      'collector',
      'curator',
      'gone',
    ])
    expect(summary).toMatchObject({ unlockedCount: 3, score: 160, total: 100 })
    expect(summary.rank.title).toBe('Pocket Carrier')
    expect(summary.nextRank?.title).toBe('Enthusiast')
  })

  it('has no next rank at the top', () => {
    const all = ACHIEVEMENTS.map((achievement) => achievement.id)
    const summary = summarizeAchievements(all)
    expect(summary.rank.title).toBe('Jedi Collector')
    expect(summary.nextRank).toBeNull()
  })

  it('lists the closest visible locked achievements', () => {
    const progress = evaluateAchievements({ knives: knives(41), now: NOW })
    const next = nextAchievements(progress).map((entry) => entry.id)
    // Fixture knives miss only the designer: 92% catalogue coverage.
    expect(next).toEqual(['perfectionist', 'half-hundred', 'source-hunter'])
    expect(next).not.toContain('the-answer')
  })
})

describe('achievement progress text', () => {
  it('formats counts, metres, kilograms and percentages, capped at the target', async () => {
    const { formatAchievementProgress, achievementPercent } =
      await import('@/lib/achievements/format')
    const entry = (id: string, current: number, target: number) => ({
      id,
      current,
      target,
      done: current >= target,
      available: true,
    })
    expect(formatAchievementProgress(entry('half-hundred', 37, 50))).toBe(
      '37 / 50',
    )
    expect(formatAchievementProgress(entry('metre-of-edge', 64, 100))).toBe(
      '0.6 / 1 m',
    )
    expect(formatAchievementProgress(entry('heavy-metal', 6400, 10_000))).toBe(
      '6.4 / 10 kg',
    )
    expect(formatAchievementProgress(entry('perfectionist', 92, 100))).toBe(
      '92% / 100%',
    )
    expect(formatAchievementProgress(entry('half-hundred', 80, 50))).toBe(
      '50 / 50',
    )
    expect(achievementPercent(entry('half-hundred', 80, 50))).toBe(100)
    expect(achievementPercent(entry('half-hundred', 25, 50))).toBe(50)
  })
})

import { describe, expect, it } from 'vitest'
import {
  classifyAttention,
  classifyAttentionRows,
  parseAttentionActionRequest,
  type AttentionInputRow,
  type AttentionSourceInput,
} from '@/lib/price-monitor/attention-filter'
import { attentionSummaryDue } from '@/lib/price-monitor/attention'

const NOW = Date.parse('2026-11-26T15:00:00.000Z')
const HOUR = 3_600_000

function problem(
  overrides: Partial<AttentionSourceInput> = {},
): AttentionSourceInput {
  return {
    status: 'failed',
    consecutiveFailures: 1,
    attentionSince: new Date(NOW - HOUR).toISOString(),
    snoozedUntil: null,
    priceMinor: null,
    currency: null,
    ...overrides,
  }
}

const none = { siblings: [], paid: null, now: NOW }

describe('classifyAttention', () => {
  it('ignores statuses that are not problems', () => {
    expect(classifyAttention(problem({ status: 'ok' }), none)).toBeNull()
    expect(
      classifyAttention(problem({ status: 'out_of_stock' }), none),
    ).toBeNull()
  })

  it('keeps a put-off problem out until Later runs out', () => {
    const until = new Date(NOW + HOUR).toISOString()
    expect(classifyAttention(problem({ snoozedUntil: until }), none)).toEqual({
      class: 'snoozed',
      until,
    })
    expect(
      classifyAttention(
        problem({
          snoozedUntil: new Date(NOW - HOUR).toISOString(),
          consecutiveFailures: 5,
        }),
        none,
      ),
    ).toEqual({ class: 'attention' })
  })

  it('treats a one-off failure as quiet (Vosteed Porcupine at Amazon)', () => {
    expect(classifyAttention(problem(), none)).toEqual({
      class: 'quiet',
      reason: 'new',
    })
    expect(
      classifyAttention(problem({ status: 'price_unavailable' }), none),
    ).toEqual({ class: 'quiet', reason: 'new' })
  })

  it('counts three failures in a row or a day of trouble', () => {
    expect(
      classifyAttention(problem({ consecutiveFailures: 3 }), none),
    ).toEqual({ class: 'attention' })
    expect(
      classifyAttention(
        problem({
          status: 'price_unavailable',
          consecutiveFailures: 0,
          attentionSince: new Date(NOW - 25 * HOUR).toISOString(),
        }),
        none,
      ),
    ).toEqual({ class: 'attention' })
    // SOG Instinct Mini: blocked nine times, its only store.
    expect(
      classifyAttention(
        problem({ status: 'blocked', consecutiveFailures: 9 }),
        none,
      ),
    ).toEqual({ class: 'attention' })
  })

  it('stays quiet when other stores read fine (Spyderco Military 2)', () => {
    expect(
      classifyAttention(
        problem({
          status: 'price_unavailable',
          attentionSince: new Date(NOW - 48 * HOUR).toISOString(),
        }),
        {
          ...none,
          siblings: [{ priceMinor: 22050, currency: 'USD', inStock: true }],
        },
      ),
    ).toEqual({ class: 'quiet', reason: 'other_stores' })
  })

  it('takes a doubted price another store or the regular price agrees with (Psyop, Vombat)', () => {
    const doubted = problem({
      status: 'needs_review',
      consecutiveFailures: 0,
      priceMinor: 16900,
      currency: 'USD',
    })
    expect(
      classifyAttention(doubted, {
        ...none,
        siblings: [{ priceMinor: 16900, currency: 'USD', inStock: true }],
      }),
    ).toEqual({ class: 'quiet', reason: 'price_agrees' })
    expect(
      classifyAttention(doubted, {
        ...none,
        paid: { minor: 16950, currency: 'USD' },
      }),
    ).toEqual({ class: 'quiet', reason: 'price_agrees' })
    // Another currency never agrees.
    expect(
      classifyAttention(doubted, {
        ...none,
        siblings: [{ priceMinor: 16900, currency: 'EUR', inStock: true }],
      }),
    ).toEqual({ class: 'attention' })
  })

  it('needs the user only when the doubted price is the best offer', () => {
    // Kizer Nice Guy: $59 at Blade HQ, $41.30 at Kizer.
    expect(
      classifyAttention(
        problem({
          status: 'needs_review',
          priceMinor: 5900,
          currency: 'USD',
        }),
        {
          ...none,
          siblings: [{ priceMinor: 4130, currency: 'USD', inStock: true }],
        },
      ),
    ).toEqual({ class: 'quiet', reason: 'other_stores' })
    // Bigger Digger: $89.95, the other USD store is out of stock.
    expect(
      classifyAttention(
        problem({
          status: 'needs_review',
          priceMinor: 8995,
          currency: 'USD',
        }),
        {
          ...none,
          siblings: [
            { priceMinor: 7990, currency: 'USD', inStock: false },
            { priceMinor: 7990, currency: 'EUR', inStock: true },
          ],
        },
      ),
    ).toEqual({ class: 'attention' })
  })
})

describe('classifyAttentionRows', () => {
  it('uses the knife’s other healthy stores as siblings', () => {
    const row = (
      id: number,
      knifeId: string,
      overrides: Partial<AttentionInputRow>,
    ): AttentionInputRow => ({
      ...problem(),
      id,
      knifeId,
      ...overrides,
    })
    const verdicts = classifyAttentionRows(
      [
        row(1, 'a', { status: 'blocked', consecutiveFailures: 4 }),
        row(2, 'a', { status: 'ok', priceMinor: 1000, currency: 'USD' }),
        row(3, 'b', { status: 'blocked', consecutiveFailures: 4 }),
      ],
      () => null,
      NOW,
    )
    expect(verdicts.get(1)).toEqual({ class: 'quiet', reason: 'other_stores' })
    expect(verdicts.has(2)).toBe(false)
    expect(verdicts.get(3)).toEqual({ class: 'attention' })
  })
})

describe('attentionSummaryDue', () => {
  const at = (hour: number, day = 26) => new Date(2026, 10, day, hour).getTime()

  it('runs once per local day from 9:00', () => {
    expect(attentionSummaryDue(null, at(8))).toBe(false)
    expect(attentionSummaryDue(null, at(9))).toBe(true)
    expect(attentionSummaryDue(new Date(at(9)).toISOString(), at(18))).toBe(
      false,
    )
    expect(
      attentionSummaryDue(new Date(at(18, 25)).toISOString(), at(10)),
    ).toBe(true)
  })
})

describe('parseAttentionActionRequest', () => {
  it('validates the action, ids and Later days', () => {
    expect(
      parseAttentionActionRequest({
        action: 'snooze',
        sourceIds: [3, 3, 4],
        days: 7,
      }),
    ).toEqual({ action: 'snooze', sourceIds: [3, 4], days: 7 })
    expect(() =>
      parseAttentionActionRequest({ action: 'snooze', sourceIds: [1] }),
    ).toThrow('days must be 1 or 7.')
    expect(() =>
      parseAttentionActionRequest({ action: 'nuke', sourceIds: [1] }),
    ).toThrow('action must be one of')
    expect(() =>
      parseAttentionActionRequest({ action: 'pause', sourceIds: [] }),
    ).toThrow('sourceIds')
  })
})

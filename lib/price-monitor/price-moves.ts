/**
 * Which price changes count on Price Drops. A store's price can wobble by a
 * fraction of a percent (currency conversion) or bounce up and back within a
 * day; neither should read as a drop or a rise. Stored events, the chart and
 * notifications are unaffected: this only classifies them for display.
 *
 * The rules, for one source's price events inside the window (oldest first):
 * - A move counts once the price is at least `minPercent` away from the
 *   current level: the price at the start of the window, or the price after
 *   the last move that counted. Smaller moves add up, so a slow drift still
 *   counts once it passes the threshold.
 * - When a counted move brings the price back to (within half the threshold
 *   of) a level it had earlier in the window, the moves in between cancel out
 *   and the source is marked as fluctuating.
 */

/** Share of the threshold within which a price counts as "back" at a level. */
const RETURN_SHARE = 0.5

export type PriceMoveEvent = {
  id: number
  previousPriceMinor: number
  priceMinor: number
  currency: string | null
  occurredAt: string
}

export type PriceMoveClass = {
  /** Net result: a counted drop or rise that still stands, or no change. */
  result: 'drop' | 'increase' | 'same'
  /** Level before the counted change (drop/increase only). */
  previousPriceMinor: number | null
  deltaMinor: number | null
  deltaPct: number | null
  /** When the counted change happened (drop/increase only). */
  changedAt: string | null
  /**
   * For no change: how far the price sits from its reference level, in
   * percent, when it moved but stayed under the threshold.
   */
  driftPct: number | null
  /** The price went somewhere and came back to an earlier level. */
  fluctuating: boolean
  /** Events that moved the price by at least the threshold. */
  significantIds: number[]
}

const round2 = (value: number) => Math.round(value * 100) / 100

function pctChange(from: number, to: number) {
  return from > 0 ? ((to - from) / from) * 100 : to === from ? 0 : Infinity
}

/** Whether `price` is within `percent` of `level` (equal always is). */
function near(level: number, price: number, percent: number) {
  if (price === level) return true
  return Math.abs(pctChange(level, price)) < percent
}

type Level = { price: number; at: string | null }

/**
 * Classifies one source's price events in the window. `currentPriceMinor`
 * is the source's latest price; when it does not match the latest event
 * (another currency, no price), the result is no change.
 */
export function classifyPriceMoves(
  events: readonly PriceMoveEvent[],
  current: { priceMinor: number | null; currency: string | null },
  minPercent: number,
): PriceMoveClass {
  const threshold = Math.max(0, minPercent)
  const returnTolerance = threshold * RETURN_SHARE
  const none: PriceMoveClass = {
    result: 'same',
    previousPriceMinor: null,
    deltaMinor: null,
    deltaPct: null,
    changedAt: null,
    driftPct: null,
    fluctuating: false,
    significantIds: [],
  }
  if (!events.length) return none

  let levels: Level[] = []
  let currency: string | null = null
  let fluctuating = false
  const significantIds: number[] = []
  for (const event of events) {
    // A store that switched currency starts over from this event.
    if (!levels.length || event.currency !== currency) {
      levels = [{ price: event.previousPriceMinor, at: null }]
      currency = event.currency
      fluctuating = false
    }
    const price = event.priceMinor
    const top = levels[levels.length - 1]
    // Back at (about) an earlier level: the moves since then cancel out.
    let back = -1
    for (let index = levels.length - 2; index >= 0; index -= 1)
      if (near(levels[index].price, price, returnTolerance)) {
        back = index
        break
      }
    if (back >= 0) {
      levels = levels.slice(0, back + 1)
      fluctuating = true
      significantIds.push(event.id)
    } else if (!near(top.price, price, threshold)) {
      levels.push({ price, at: event.occurredAt })
      significantIds.push(event.id)
    }
  }

  const last = events[events.length - 1]
  if (
    current.priceMinor === null ||
    current.priceMinor !== last.priceMinor ||
    current.currency !== currency
  )
    return { ...none, significantIds }

  const price = current.priceMinor
  if (levels.length < 2) {
    const reference = levels[0].price
    const drift =
      price === reference ? null : round2(pctChange(reference, price))
    return {
      ...none,
      driftPct: drift !== null && Number.isFinite(drift) ? drift : null,
      fluctuating,
      significantIds,
    }
  }
  const previous = levels[levels.length - 2].price
  const deltaMinor = price - previous
  return {
    result: deltaMinor < 0 ? 'drop' : 'increase',
    previousPriceMinor: previous,
    deltaMinor,
    deltaPct: previous > 0 ? round2((deltaMinor / previous) * 100) : null,
    changedAt: levels[levels.length - 1].at,
    driftPct: null,
    fluctuating,
    significantIds,
  }
}

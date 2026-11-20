import type { Availability } from '@/lib/price-monitor/shared'

/** What one check observed, already validated and in minor units. */
export type Observation = {
  priceMinor: number | null
  currency: string | null
  availability: Availability
}

export type SnapshotState = Observation & { id: number }

export type PriceChange = {
  direction: 'drop' | 'increase'
  previousPriceMinor: number
  priceMinor: number
  currency: string
  deltaMinor: number
  /** Percent change, rounded to 2 decimals; negative for a drop. */
  deltaPct: number
  fromSnapshotId: number
}

export type StockChange = {
  kind: 'out_of_stock' | 'back_in_stock'
  previousAvailability: Availability
  availability: Availability
  fromSnapshotId: number
  /** The snapshot that first read the new status (the change happened there). */
  toSnapshotId: number
}

export type DetectResult = {
  /** touch: extend the latest snapshot; insert: start a new one. */
  action: 'touch' | 'insert'
  priceChange: PriceChange | null
  /** The price is in another currency than the last priced snapshot. */
  currencyChanged: boolean
}

const BUYABLE: ReadonlySet<Availability> = new Set([
  'in_stock',
  'limited',
  'preorder',
])

function sameState(a: Observation, b: Observation): boolean {
  return (
    a.priceMinor === b.priceMinor &&
    (a.currency ?? null) === (b.currency ?? null) &&
    a.availability === b.availability
  )
}

/**
 * Compares an observation with the source's latest snapshot (`latest`) and
 * its latest snapshot that had a price (`latestPriced`). Price changes use
 * `latestPriced`, so in stock 100 → sold out without price → in stock 80
 * still reports the drop. The first observation is a baseline: no events.
 */
export function detectChange(
  latest: SnapshotState | null,
  latestPriced: SnapshotState | null,
  next: Observation,
): DetectResult {
  if (!latest) {
    return {
      action: 'insert',
      priceChange: null,
      currencyChanged: false,
    }
  }
  if (sameState(latest, next)) {
    return {
      action: 'touch',
      priceChange: null,
      currencyChanged: false,
    }
  }

  let priceChange: PriceChange | null = null
  let currencyChanged = false
  if (
    next.priceMinor !== null &&
    latestPriced &&
    latestPriced.priceMinor !== null
  ) {
    if (next.currency !== latestPriced.currency) {
      currencyChanged = true
    } else if (next.priceMinor !== latestPriced.priceMinor) {
      const deltaMinor = next.priceMinor - latestPriced.priceMinor
      priceChange = {
        direction: deltaMinor < 0 ? 'drop' : 'increase',
        previousPriceMinor: latestPriced.priceMinor,
        priceMinor: next.priceMinor,
        currency: next.currency ?? '',
        deltaMinor,
        deltaPct:
          Math.round((deltaMinor / latestPriced.priceMinor) * 10_000) / 100,
        fromSnapshotId: latestPriced.id,
      }
    }
  }

  return { action: 'insert', priceChange, currencyChanged }
}

/** A trusted snapshot's stock status and how many readings it covers. */
export type StockSnapshot = {
  id: number
  availability: Availability
  observations: number
}

/** How many recent snapshots stock detection looks back over. */
export const STOCK_HISTORY_LIMIT = 50

/**
 * Stock changes need two readings in a row. A store page can show the wrong
 * stock for a while (an inventory sync, a cached edition), so one reading
 * alone never notifies: the change is reported when the next check agrees.
 * It is compared with the last status that two readings agreed on, so a
 * one-off flip and the flip back report nothing.
 *
 * `history` holds the source's trusted snapshots, newest first (up to
 * STOCK_HISTORY_LIMIT); `next` is the status this check observed.
 */
export function detectStockChange(
  history: readonly StockSnapshot[],
  next: Availability,
): StockChange | null {
  // Group snapshots into runs of the same status, newest first.
  // `id` is a run's newest snapshot, `firstId` its oldest.
  const runs: {
    availability: Availability
    observations: number
    id: number
    firstId: number
  }[] = []
  for (const snapshot of history) {
    const run = runs.at(-1)
    if (run && run.availability === snapshot.availability) {
      run.observations += snapshot.observations
      run.firstId = snapshot.id
    } else {
      runs.push({
        availability: snapshot.availability,
        observations: snapshot.observations,
        id: snapshot.id,
        firstId: snapshot.id,
      })
    }
  }

  // Only the reading that confirms the newest status reports: it must match
  // a status seen exactly once so far.
  const [current, ...older] = runs
  if (!current || current.availability !== next || current.observations !== 1)
    return null

  // The baseline is the newest earlier status two readings agreed on, or the
  // source's oldest status known here (first readings are a baseline).
  const baseline = older.find((run) => run.observations >= 2) ?? older.at(-1)
  if (!baseline) return null

  const previous = baseline.availability
  if (next === 'out_of_stock' && previous !== 'out_of_stock') {
    return {
      kind: 'out_of_stock',
      previousAvailability: previous,
      availability: next,
      fromSnapshotId: baseline.id,
      toSnapshotId: current.firstId,
    }
  }
  if (previous === 'out_of_stock' && BUYABLE.has(next)) {
    return {
      kind: 'back_in_stock',
      previousAvailability: previous,
      availability: next,
      fromSnapshotId: baseline.id,
      toSnapshotId: current.firstId,
    }
  }
  return null
}

export function medianPrice(values: readonly number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

/** Below 50 % or above 300 % of the recent median needs a second reading. */
export const PLAUSIBLE_RANGE = { min: 0.5, max: 3 } as const

/**
 * `history` holds the source's recent prices (same currency, newest first,
 * up to 5). With no history every price is plausible.
 */
export function isPlausiblePrice(
  priceMinor: number,
  history: readonly number[],
): boolean {
  const median = medianPrice(history)
  if (median === null || median <= 0) return true
  const ratio = priceMinor / median
  return ratio >= PLAUSIBLE_RANGE.min && ratio <= PLAUSIBLE_RANGE.max
}

/** Upper bound for any stored price, in major units. */
export const MAX_PRICE_MAJOR = 1_000_000

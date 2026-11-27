import type { MonitoredSource } from '@/lib/price-monitor/insights'

/**
 * Sections, search, sorting and grouping for the Price Drops table. Pure
 * functions, so the page stays a thin layer over them.
 */

export const SECTIONS = [
  'all',
  'drops',
  'increases',
  'oos',
  'attention',
  'recent',
] as const
export type Section = (typeof SECTIONS)[number]

export function parseSection(value: string | null | undefined): Section | null {
  // The old Below regular price tab is part of Drops now.
  if (value === 'below_paid') return 'drops'
  // The old Changed and Restocked tabs: their rows are in Down, Up, Out of
  // stock or All now.
  if (value === 'changes' || value === 'restocked') return 'all'
  return (SECTIONS as readonly string[]).includes(value ?? '')
    ? (value as Section)
    : null
}

export const SECTION_LABEL: Record<Section, string> = {
  all: 'All',
  drops: '↓ Down',
  increases: '↑ Up',
  oos: 'Out of stock',
  attention: 'Needs attention',
  recent: 'Recently checked',
}

/** In stock, read on its last check and cheaper than the regular price. */
export function isBelowPaid(source: MonitoredSource): boolean {
  return (
    source.priceMinor !== null &&
    source.paidMinor !== null &&
    source.priceMinor < source.paidMinor &&
    source.result !== 'out_of_stock' &&
    source.result !== 'attention' &&
    source.result !== 'pending'
  )
}

/** In stock, read on its last check and dearer than the regular price. */
export function isAbovePaid(source: MonitoredSource): boolean {
  return (
    source.priceMinor !== null &&
    source.paidMinor !== null &&
    source.priceMinor > source.paidMinor &&
    source.result !== 'out_of_stock' &&
    source.result !== 'attention' &&
    source.result !== 'pending'
  )
}

/**
 * A page in trouble that needs the user. Quiet problems (a first failure, a
 * doubted price another store agrees with, a broken store of a knife other
 * stores read) and ones put off with Later only get a grey mark.
 */
export function needsAttention(source: MonitoredSource): boolean {
  return (
    source.result === 'attention' &&
    (source.attention?.class ?? 'attention') === 'attention'
  )
}

/** A page in trouble the user put off with Later. */
export function isSnoozed(source: MonitoredSource): boolean {
  return source.result === 'attention' && source.attention?.class === 'snoozed'
}

/**
 * Knives no store sells now: every listing read so far shows out of stock.
 * Listings not read yet count neither way, like the Wishlist's stock pill.
 */
export function soldOutKnives(sources: MonitoredSource[]): Set<string> {
  const read = new Map<string, boolean>()
  for (const source of sources) {
    if (source.availability === null) continue
    const soldOut = source.availability === 'out_of_stock'
    read.set(source.knife.id, (read.get(source.knife.id) ?? true) && soldOut)
  }
  return new Set(
    [...read].filter(([, soldOut]) => soldOut).map(([knifeId]) => knifeId),
  )
}

/** How many knives the listings belong to: a tab counts knives, not links. */
export function knifeCount(sources: readonly MonitoredSource[]): number {
  return new Set(sources.map((source) => source.knife.id)).size
}

/** The supervisor's coverage bar in knives, counted like the tabs. */
export type KnifeCoverage = {
  monitored: number
  read: number
  soldOut: number
  attention: number
  neverChecked: number
  /** Knives with a link not checked for 1.5 × the check interval. */
  stale: number
}

/**
 * Each monitored knife once, in the first group it fits: never checked (no
 * link read yet), sold out (the Out of stock tab), needs attention (the
 * Needs attention tab), else read.
 */
export function knifeCoverage(
  sources: MonitoredSource[],
  now: number,
  intervalHours: number | null,
): KnifeCoverage {
  const byKnife = new Map<string, MonitoredSource[]>()
  for (const source of sources) {
    const list = byKnife.get(source.knife.id)
    if (list) list.push(source)
    else byKnife.set(source.knife.id, [source])
  }
  const soldOut = soldOutKnives(sources)
  const staleBefore =
    intervalHours === null ? null : now - intervalHours * 1.5 * 3_600_000
  const coverage: KnifeCoverage = {
    monitored: byKnife.size,
    read: 0,
    soldOut: 0,
    attention: 0,
    neverChecked: 0,
    stale: 0,
  }
  for (const [knifeId, list] of byKnife) {
    const checked = list.filter((source) => source.lastCheckedAt !== null)
    if (!checked.length) {
      coverage.neverChecked += 1
      continue
    }
    if (
      staleBefore !== null &&
      checked.some((source) => Date.parse(source.lastCheckedAt!) < staleBefore)
    )
      coverage.stale += 1
    if (soldOut.has(knifeId)) coverage.soldOut += 1
    else if (list.some(SECTION_FILTER.attention)) coverage.attention += 1
    else coverage.read += 1
  }
  return coverage
}

/**
 * Knives some store sells now at or below their regular price. Up leaves
 * them out: a store charging more does not matter while the knife can be
 * bought for its regular price elsewhere.
 */
export function atRegularKnives(sources: MonitoredSource[]): Set<string> {
  return new Set(
    sources
      .filter(
        (source) =>
          source.priceMinor !== null &&
          source.paidMinor !== null &&
          source.priceMinor <= source.paidMinor &&
          source.result !== 'out_of_stock' &&
          source.result !== 'attention' &&
          source.result !== 'pending',
      )
      .map((source) => source.knife.id),
  )
}

/**
 * Listing-level tabs. Out of stock and Up are about the knife, so their
 * listing rule is only a first pass: see `sectionRows`.
 */
export const SECTION_FILTER: Record<
  Exclude<Section, 'oos'>,
  (source: MonitoredSource) => boolean
> = {
  all: () => true,
  // What a buyer counts as a drop: a store cut its price, or the knife can
  // be bought below its regular price now, even at a store just added.
  drops: (source) => source.result === 'drop' || isBelowPaid(source),
  // The mirror of Down: a store raised its price, or sells above the
  // regular price now, even one just added or restocked. `sectionRows` then
  // drops knives another store sells at or below the regular price.
  increases: (source) => source.result === 'increase' || isAbovePaid(source),
  attention: (source) => needsAttention(source) || source.retireHint !== null,
  recent: (source) => Boolean(source.lastCheckedAt),
}

/**
 * Rows a tab shows. Out of stock lists every listing of a knife that no
 * store sells; Up skips knives some store sells at or below the regular
 * price. Both judge the knife on all of its stores (`all`), not only the
 * ones a search or store filter leaves in `rows`.
 */
export function sectionRows(
  section: Section,
  rows: MonitoredSource[],
  all: MonitoredSource[],
): MonitoredSource[] {
  if (section === 'oos') {
    const soldOut = soldOutKnives(all)
    return rows.filter((source) => soldOut.has(source.knife.id))
  }
  const listed = rows.filter(SECTION_FILTER[section])
  if (section !== 'increases') return listed
  const atRegular = atRegularKnives(all)
  return listed.filter((source) => !atRegular.has(source.knife.id))
}

export const EMPTY_TEXT: Record<Section, string> = {
  all: 'Nothing is monitored yet.',
  drops:
    'Nothing is cheaper than its regular price or dropped in the last 30 days.',
  increases:
    'Nothing is dearer than its regular price or went up in the last 30 days.',
  oos: 'Nothing is out of stock.',
  attention: 'Every store page was read on its last check.',
  recent: 'Nothing has been checked yet.',
}

const RESULT_ORDER: Record<MonitoredSource['result'], number> = {
  drop: 0,
  increase: 1,
  restocked: 2,
  out_of_stock: 3,
  attention: 4,
  pending: 5,
  same: 6,
}

/** Price against the regular price, in money and percent. */
export function vsPaid(
  source: Pick<MonitoredSource, 'priceMinor' | 'paidMinor'>,
): { deltaMinor: number; pct: number } | null {
  if (source.priceMinor === null || !source.paidMinor) return null
  const deltaMinor = source.priceMinor - source.paidMinor
  return { deltaMinor, pct: (deltaMinor / source.paidMinor) * 100 }
}

/**
 * Whether a row's price is one to compare with the regular price: not out
 * of stock and not a price a failed check kept. The row chart's chip and the
 * regular-price sort both use it, so they agree.
 */
export function hasBuyablePrice(
  source: Pick<MonitoredSource, 'priceMinor' | 'result'>,
): boolean {
  return (
    source.priceMinor !== null &&
    source.result !== 'out_of_stock' &&
    source.result !== 'attention'
  )
}

/** Case-insensitive match on brand, name, model/steel subtitle and store. */
export function matchesQuery(source: MonitoredSource, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const haystack = [
    source.knife.brand,
    source.knife.name,
    source.knife.subtitle ?? '',
    source.storeName,
  ]
    .join(' ')
    .toLowerCase()
  return words.every((word) => haystack.includes(word))
}

export type StoreOption = { laneKey: string; label: string; count: number }

/** Stores with their number of listings, most listings first. */
export function storeOptions(sources: MonitoredSource[]): StoreOption[] {
  const byLane = new Map<string, StoreOption>()
  for (const source of sources) {
    const option = byLane.get(source.laneKey) ?? {
      laneKey: source.laneKey,
      label: source.laneKey === 'amazon' ? 'Amazon' : source.storeName,
      count: 0,
    }
    option.count += 1
    byLane.set(source.laneKey, option)
  }
  return [...byLane.values()].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label),
  )
}

export const SORT_KEYS = ['price', 'change', 'paid', 'checked'] as const
export type SortKey = (typeof SORT_KEYS)[number]
export type Sort = { key: SortKey; dir: 'asc' | 'desc' } | null

/** The first direction a column sorts in when its header is pressed. */
export const FIRST_DIR: Record<SortKey, 'asc' | 'desc'> = {
  price: 'asc',
  change: 'asc',
  paid: 'asc',
  checked: 'desc',
}

/** Header press: first direction, then the other, then back to default. */
export function nextSort(current: Sort, key: SortKey): Sort {
  if (!current || current.key !== key) return { key, dir: FIRST_DIR[key] }
  if (current.dir === FIRST_DIR[key])
    return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
  return null
}

/** A row's 30-day trend in percent (-20 is 20% down), when known. */
export type TrendPct = (source: MonitoredSource) => number | null

function sortValue(
  source: MonitoredSource,
  key: SortKey,
  trendPct?: TrendPct,
): number | null {
  switch (key) {
    case 'price':
      return source.priceMinor
    case 'change':
      // The Trend column: the net move over the chart window, else the
      // latest change while trends are loading or missing.
      return trendPct?.(source) ?? source.deltaPct
    case 'paid':
      return hasBuyablePrice(source) ? (vsPaid(source)?.pct ?? null) : null
    case 'checked':
      return source.lastCheckedAt ? Date.parse(source.lastCheckedAt) : null
  }
}

const byName = (a: MonitoredSource, b: MonitoredSource) =>
  `${a.knife.brand} ${a.knife.name}`.localeCompare(
    `${b.knife.brand} ${b.knife.name}`,
  )

/**
 * How much cheaper a row is, in percent: against the regular price, or the
 * store's own cut when that is bigger.
 */
function savingPct(source: MonitoredSource): number {
  const regular = vsPaid(source)
  return Math.max(
    regular && regular.pct < 0 ? -regular.pct : 0,
    source.result === 'drop' && source.deltaPct !== null
      ? Math.abs(source.deltaPct)
      : 0,
  )
}

/**
 * Rows for a section: by result (drops first) unless a column is sorted;
 * Drops puts the biggest saving first. `trendPct` feeds the Trend sort.
 * Missing values always sort last. Recently checked keeps the newest 30.
 */
export function sortRows(
  section: Section,
  list: MonitoredSource[],
  sort: Sort,
  trendPct?: TrendPct,
): MonitoredSource[] {
  const sorted = [...list]
  if (sort) {
    const factor = sort.dir === 'asc' ? 1 : -1
    sorted.sort((a, b) => {
      const left = sortValue(a, sort.key, trendPct)
      const right = sortValue(b, sort.key, trendPct)
      if (left === null || right === null)
        return left === right ? byName(a, b) : left === null ? 1 : -1
      return (left - right) * factor || byName(a, b)
    })
  } else if (section === 'drops')
    sorted.sort(
      (a, b) =>
        savingPct(b) - savingPct(a) ||
        (b.changedAt ?? '').localeCompare(a.changedAt ?? '') ||
        byName(a, b),
    )
  else if (section === 'recent')
    sorted.sort((a, b) =>
      (b.lastCheckedAt ?? '').localeCompare(a.lastCheckedAt ?? ''),
    )
  else
    sorted.sort(
      (a, b) =>
        RESULT_ORDER[a.result] - RESULT_ORDER[b.result] ||
        (b.changedAt ?? '').localeCompare(a.changedAt ?? '') ||
        byName(a, b),
    )
  return section === 'recent' ? sorted.slice(0, 30) : sorted
}

export type KnifeGroup = {
  knifeId: string
  /** The row that stands for the knife: its best in-stock price. */
  lead: MonitoredSource
  sources: MonitoredSource[]
}

/** The cheapest in-stock listing, else the most notable result. */
function leadSource(sources: MonitoredSource[]): MonitoredSource {
  const priced = sources.filter(
    (source) =>
      source.priceMinor !== null &&
      source.result !== 'out_of_stock' &&
      source.result !== 'attention' &&
      source.result !== 'pending',
  )
  if (priced.length) {
    const currencies = new Map<string, number>()
    for (const source of priced)
      currencies.set(
        source.currency ?? '',
        (currencies.get(source.currency ?? '') ?? 0) + 1,
      )
    const currency = [...currencies].sort((a, b) => b[1] - a[1])[0][0]
    return priced
      .filter((source) => (source.currency ?? '') === currency)
      .reduce((best, source) =>
        source.priceMinor! < best.priceMinor! ? source : best,
      )
  }
  return [...sources].sort(
    (a, b) => RESULT_ORDER[a.result] - RESULT_ORDER[b.result],
  )[0]
}

/**
 * One group per knife, in the order its first row appears in `rows`, so
 * groups follow the current sort. A tab only picks which knives are listed:
 * each group holds all the knife's listings in `pool` (the search and store
 * filter), so the row leads with the knife's best in-stock price even when
 * only another store matched the tab (an Out of stock tab listing a knife
 * that one store sold out of). The tab's own rows come first.
 */
export function groupByKnife(
  rows: MonitoredSource[],
  pool: MonitoredSource[] = rows,
): KnifeGroup[] {
  const groups = new Map<string, MonitoredSource[]>()
  for (const source of rows) {
    const list = groups.get(source.knife.id) ?? []
    list.push(source)
    groups.set(source.knife.id, list)
  }
  for (const source of pool) {
    const list = groups.get(source.knife.id)
    if (list && !list.some((row) => row.sourceId === source.sourceId))
      list.push(source)
  }
  return [...groups].map(([knifeId, sources]) => ({
    knifeId,
    lead: leadSource(sources),
    sources,
  }))
}

import type { MonitoredSource } from '@/lib/price-monitor/insights'

/**
 * Sections, search, sorting and grouping for the Price Drops table. Pure
 * functions, so the page stays a thin layer over them.
 */

export const SECTIONS = [
  'all',
  'changes',
  'drops',
  'increases',
  'restocked',
  'oos',
  'attention',
  'recent',
] as const
export type Section = (typeof SECTIONS)[number]

export function parseSection(value: string | null | undefined): Section | null {
  // The old Below regular price tab is part of Drops now.
  if (value === 'below_paid') return 'drops'
  return (SECTIONS as readonly string[]).includes(value ?? '')
    ? (value as Section)
    : null
}

export const SECTION_LABEL: Record<Section, string> = {
  all: 'All',
  changes: 'Changes',
  drops: 'Drops',
  increases: 'Increases',
  restocked: 'Restocked',
  oos: 'Out of stock',
  attention: 'Needs attention',
  recent: 'Recently monitored',
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

export const SECTION_FILTER: Record<
  Section,
  (source: MonitoredSource) => boolean
> = {
  all: () => true,
  changes: (source) =>
    source.result === 'drop' ||
    source.result === 'increase' ||
    source.result === 'restocked' ||
    source.result === 'out_of_stock',
  // What a buyer counts as a drop: a store cut its price, or the knife can
  // be bought below its regular price now, even at a store just added.
  drops: (source) => source.result === 'drop' || isBelowPaid(source),
  increases: (source) => source.result === 'increase',
  restocked: (source) => source.result === 'restocked',
  oos: (source) => source.result === 'out_of_stock',
  attention: (source) =>
    source.result === 'attention' || source.retireHint !== null,
  recent: (source) => Boolean(source.lastCheckedAt),
}

export const EMPTY_TEXT: Record<Section, string> = {
  all: 'Nothing is monitored yet.',
  changes: 'No price or stock changes in the last 30 days.',
  drops:
    'Nothing is cheaper than its regular price or dropped in the last 30 days.',
  increases: 'No price increases in the last 30 days.',
  restocked: 'Nothing came back in stock in the last 7 days.',
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

function sortValue(source: MonitoredSource, key: SortKey): number | null {
  switch (key) {
    case 'price':
      return source.priceMinor
    case 'change':
      return source.deltaPct
    case 'paid':
      return vsPaid(source)?.pct ?? null
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
 * Drops puts the biggest saving first.
 * Missing values always sort last. Recently monitored keeps the newest 30.
 */
export function sortRows(
  section: Section,
  list: MonitoredSource[],
  sort: Sort,
): MonitoredSource[] {
  const sorted = [...list]
  if (sort) {
    const factor = sort.dir === 'asc' ? 1 : -1
    sorted.sort((a, b) => {
      const left = sortValue(a, sort.key)
      const right = sortValue(b, sort.key)
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
 * groups follow the current sort.
 */
export function groupByKnife(rows: MonitoredSource[]): KnifeGroup[] {
  const groups = new Map<string, MonitoredSource[]>()
  for (const source of rows) {
    const list = groups.get(source.knife.id) ?? []
    list.push(source)
    groups.set(source.knife.id, list)
  }
  return [...groups].map(([knifeId, sources]) => ({
    knifeId,
    lead: leadSource(sources),
    sources,
  }))
}

import { prioritizePinnedKnives, type Knife } from '@/lib/data'
import { matchesCollection } from '@/lib/smart-collections'
import type { CollectionDisplay } from '@/lib/settings-shared'

/**
 * Collection helpers shared by the Lumen-palette layouts (Atrium, Ledger and
 * Shelf). They read the same URL filters as the Modern collection, so links
 * such as `/collection?brand=…` or `?view=pinned` keep working in every style.
 */

export type LumenStatusFilter = 'owned' | 'sold'

/** URL keys the Lumen layouts write in addition to the shared filters. */
export const LUMEN_STATUS_PARAM = 'status'

export function filterLumenKnives(
  knives: Knife[],
  params: URLSearchParams,
): Knife[] {
  const filters = new URLSearchParams(params)
  const pinnedOnly = filters.get('view') === 'pinned'
  const status = filters.get(LUMEN_STATUS_PARAM)
  const query = filters.get('q') ?? ''
  filters.delete('q')
  filters.delete('view')
  filters.delete(LUMEN_STATUS_PARAM)
  filters.delete('smart')
  return knives.filter(
    (knife) =>
      matchesLumenSearch(knife, query) &&
      matchesCollection(knife, filters) &&
      (!pinnedOnly || knife.pinned) &&
      (status === 'sold'
        ? knife.sold
        : status === 'owned'
          ? !knife.sold
          : true),
  )
}

/**
 * Text search for the Lumen-based layouts. Every word must appear in the
 * knife's name, brand, model number, blade style, steel, lock or handle, so
 * "spyderco s30v" narrows to Spyderco knives in S30V.
 */
export function matchesLumenSearch(knife: Knife, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const text = [
    knife.name,
    knife.brand,
    knife.specs.modelNumber,
    knife.bladeStyle,
    knife.specs.bladeMaterial,
    knife.specs.lockingMechanism,
    knife.handleMaterial,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return words.every((word) => text.includes(word))
}

export function sortLumenKnives(
  knives: Knife[],
  sort: CollectionDisplay['sort'],
  pinnedFirst: boolean,
): Knife[] {
  const sorted = [...knives].sort((left, right) => {
    if (sort === 'model') return left.name.localeCompare(right.name)
    if (sort === 'brand')
      return (
        left.brand.localeCompare(right.brand) ||
        left.name.localeCompare(right.name)
      )
    return Date.parse(right.addedAt) - Date.parse(left.addedAt)
  })
  return prioritizePinnedKnives(sorted, pinnedFirst)
}

export type FacetCount = { value: string; count: number }

/** Distinct non-empty values with their counts, most common first. */
export function countFacet(
  knives: Knife[],
  getValue: (knife: Knife) => string | undefined,
): FacetCount[] {
  const counts = new Map<string, number>()
  for (const knife of knives) {
    const value = getValue(knife)?.trim()
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  '₽': 'RUB',
  '₴': 'UAH',
  '₹': 'INR',
}

export type ParsedPrice = { amount: number; currency: string }

/**
 * Reads an amount and currency from a free-text price such as "$189",
 * "189.95 USD" or "1.299,00 €". Returns null when no amount is present.
 * Prices without a currency mark are reported as `''` so they are never
 * added to amounts in a known currency.
 */
export function parsePrice(value: string | undefined): ParsedPrice | null {
  const text = value?.trim()
  if (!text) return null
  const number = text.match(/\d[\d\s.,']*/)
  if (!number) return null
  let digits = number[0].replace(/[\s']/g, '').replace(/[.,]$/, '')
  const lastComma = digits.lastIndexOf(',')
  const lastDot = digits.lastIndexOf('.')
  if (lastComma > lastDot) {
    // "1.299,00" or "189,95": the comma is the decimal mark when two digits
    // or fewer follow it; otherwise it separates thousands ("1,299").
    digits =
      digits.length - lastComma - 1 <= 2
        ? digits.replace(/\./g, '').replace(',', '.')
        : digits.replace(/,/g, '')
  } else {
    digits = digits.replace(/,/g, '')
    // "1.299" with three digits after a single dot is a thousands mark.
    if (/^\d{1,3}(\.\d{3})+$/.test(digits)) digits = digits.replace(/\./g, '')
  }
  const amount = Number(digits)
  if (!Number.isFinite(amount)) return null
  const code = text.match(/\b([A-Z]{3})\b/)?.[1]
  const symbol = Object.keys(CURRENCY_SYMBOLS).find((mark) =>
    text.includes(mark),
  )
  return {
    amount,
    currency: code ?? (symbol ? CURRENCY_SYMBOLS[symbol] : ''),
  }
}

export type CollectionValue = {
  total: number
  currency: string
  pricedCount: number
}

/**
 * Sums recorded prices in the most common currency. Knives priced in another
 * currency, or without one, are left out rather than mixed in.
 */
export function summarizeCollectionValue(
  knives: Knife[],
): CollectionValue | null {
  const byCurrency = new Map<string, { total: number; count: number }>()
  for (const knife of knives) {
    const price = parsePrice(knife.specs.price)
    if (!price || !price.currency) continue
    const entry = byCurrency.get(price.currency) ?? { total: 0, count: 0 }
    entry.total += price.amount
    entry.count += 1
    byCurrency.set(price.currency, entry)
  }
  const top = [...byCurrency].sort((a, b) => b[1].count - a[1].count)[0]
  return top
    ? { total: top[1].total, currency: top[0], pricedCount: top[1].count }
    : null
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount)
  } catch {
    return `${Math.round(amount).toLocaleString('en-US')} ${currency}`.trim()
  }
}

/** Knives added in the same calendar month as `now`. */
export function countAddedThisMonth(knives: Knife[], now = new Date()): number {
  return knives.filter((knife) => {
    const added = new Date(knife.addedAt)
    return (
      added.getFullYear() === now.getFullYear() &&
      added.getMonth() === now.getMonth()
    )
  }).length
}

/** Additions per calendar month, oldest first, ending with `now`'s month. */
export function countAddedByMonth(
  knives: Knife[],
  months: number,
  now = new Date(),
): { label: string; count: number }[] {
  return Array.from({ length: months }, (_, index) => {
    const date = new Date(
      now.getFullYear(),
      now.getMonth() - (months - 1 - index),
      1,
    )
    return {
      label: date.toLocaleDateString('en-US', { month: 'short' }),
      count: knives.filter((knife) => {
        const added = new Date(knife.addedAt)
        return (
          added.getFullYear() === date.getFullYear() &&
          added.getMonth() === date.getMonth()
        )
      }).length,
    }
  })
}

export function formatShortDate(value: string, withYear = false): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  })
}

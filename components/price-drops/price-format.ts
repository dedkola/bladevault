import { formatMoney } from '@/lib/price-monitor/money'
import type { ChangeEvent } from '@/lib/price-monitor/insights'
import type {
  Availability,
  PriceSourceStatus,
} from '@/lib/price-monitor/shared'

/** Money in minor units, or an em dash when unknown. */
export function money(minor: number | null, currency: string | null): string {
  if (minor === null || !currency) return '—'
  return formatMoney(minor, currency)
}

export function relativeTime(
  iso: string | null,
  now = Date.now(),
  style: 'long' | 'short' = 'long',
): string {
  if (!iso) return ''
  const seconds = Math.round((Date.parse(iso) - now) / 1000)
  const format = new Intl.RelativeTimeFormat(undefined, {
    numeric: 'auto',
    style,
  })
  const abs = Math.abs(seconds)
  if (abs < 60) return format.format(seconds, 'second')
  if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute')
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), 'hour')
  return format.format(Math.round(seconds / 86_400), 'day')
}

export function shortDateTime(
  iso: string,
  hourCycle: 'h12' | 'h23',
  now = Date.now(),
): string {
  const date = new Date(iso)
  const sameDay = new Date(now).toDateString() === date.toDateString()
  const time = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle,
  })
  if (sameDay) return `today ${time}`
  const yesterday = new Date(now - 86_400_000).toDateString()
  if (yesterday === date.toDateString()) return `yesterday ${time}`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function storeLabel(storeName: string): string {
  return storeName === 'amazon' ? 'Amazon' : storeName
}

export function deltaLabel(event: ChangeEvent): string {
  if (event.deltaMinor === null || event.deltaPct === null) return ''
  const arrow = event.deltaMinor < 0 ? '↓' : '↑'
  return `${arrow} ${money(Math.abs(event.deltaMinor), event.currency)} · ${Math.abs(
    event.deltaPct,
  ).toFixed(1)}%`
}

export const STATUS_LABEL: Record<PriceSourceStatus, string> = {
  pending: 'Not checked yet',
  checking: 'Checking',
  ok: 'Checked',
  price_unavailable: 'Price unavailable',
  out_of_stock: 'Out of stock',
  failed: 'Failed',
  blocked: 'Blocked',
  needs_review: 'AI doubts the price',
}

export type StatusTone = 'ok' | 'warn' | 'bad' | 'idle' | 'run'

export const STATUS_TONE: Record<PriceSourceStatus, StatusTone> = {
  pending: 'idle',
  checking: 'run',
  ok: 'ok',
  price_unavailable: 'warn',
  out_of_stock: 'warn',
  failed: 'bad',
  blocked: 'bad',
  needs_review: 'warn',
}

/** Availability worth a tag next to a price; in and out of stock have none. */
export const AVAILABILITY_LABEL: Partial<Record<Availability, string>> = {
  limited: 'Low stock',
  preorder: 'Preorder',
}

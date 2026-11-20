import { formatMoney } from '@/lib/price-monitor/money'
import type { ChangeEvent } from '@/lib/price-monitor/insights'
import type { PriceSourceStatus } from '@/lib/price-monitor/shared'

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

/**
 * A time in the app's 12/24-hour setting: "14:05" today, "Nov 18, 14:05"
 * on another day, with the year when it is not this year.
 */
export function clockTime(
  iso: string,
  hourCycle: 'h12' | 'h23',
  now = Date.now(),
): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return ''
  const time = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hourCycle,
  })
  const today = new Date(now)
  if (date.toDateString() === today.toDateString()) return time
  const day = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  })
  return `${day}, ${time}`
}

/** A whole hour (0–24) in the app's 12/24-hour setting: "08:00" or "8:00 AM". */
export function hourLabel(hour: number, hourCycle: 'h12' | 'h23'): string {
  return new Date(2000, 0, 1, hour % 24).toLocaleTimeString(undefined, {
    hour: hourCycle === 'h23' ? '2-digit' : 'numeric',
    minute: '2-digit',
    hourCycle,
  })
}

/** "26 min", "3 h", "2 d". */
export function durationLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`
}

/** A check this recently due is "due now" rather than overdue. */
const DUE_NOW_MS = 15 * 60_000

/** "next in 3 hours", "due now" or "overdue 9 h", never "next 9 hours ago". */
export function nextCheckLabel(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now
  if (ms > 0) return `next ${relativeTime(iso, now)}`
  if (-ms < DUE_NOW_MS) return 'due now'
  return `overdue ${durationLabel(-ms)}`
}

/**
 * A price change in percent, unsigned: one decimal below 10% so a 0.3% move
 * never reads as 0%, whole numbers above.
 */
export function percentLabel(pct: number): string {
  const abs = Math.abs(pct)
  if (abs > 0 && abs < 0.05) return '<0.1%'
  return `${abs < 9.95 ? abs.toFixed(1) : abs.toFixed(0)}%`
}

export function storeLabel(storeName: string): string {
  return storeName === 'amazon' ? 'Amazon' : storeName
}

export function deltaLabel(event: ChangeEvent): string {
  if (event.deltaMinor === null || event.deltaPct === null) return ''
  const arrow = event.deltaMinor < 0 ? '↓' : '↑'
  return `${arrow} ${money(Math.abs(event.deltaMinor), event.currency)} · ${percentLabel(
    event.deltaPct,
  )}`
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

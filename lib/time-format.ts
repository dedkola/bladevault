import type { TimeFormat } from '@/lib/settings-shared'

export function getHourCycle(timeFormat: TimeFormat): 'h12' | 'h23' {
  return timeFormat === '24h' ? 'h23' : 'h12'
}

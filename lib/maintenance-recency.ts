import type { Knife, KnifeActivityEvent } from '@/lib/data'

/** Calendar-day age keeps the buckets stable across daylight-saving changes. */
function calendarDay(date: Date) {
  return (
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000
  )
}

export function getMaintenanceRecency(
  knives: Pick<Knife, 'id'>[],
  activity: KnifeActivityEvent[],
  now: Date,
) {
  const latest = new Map<string, Date>()
  for (const event of activity) {
    if (event.type !== 'maintained') continue
    const date = new Date(event.occurredAt)
    if (!Number.isFinite(date.getTime()) || date > now) continue
    const previous = latest.get(event.knifeId)
    if (!previous || date > previous) latest.set(event.knifeId, date)
  }

  const groups = [
    { label: 'Within 30 days', knifeIds: [] as string[] },
    { label: '31–90 days', knifeIds: [] as string[] },
    { label: 'Over 90 days', knifeIds: [] as string[] },
    { label: 'No maintenance recorded', knifeIds: [] as string[] },
  ]
  for (const knife of knives) {
    const date = latest.get(knife.id)
    const age = date ? calendarDay(now) - calendarDay(date) : undefined
    const index = age === undefined ? 3 : age <= 30 ? 0 : age <= 90 ? 1 : 2
    groups[index].knifeIds.push(knife.id)
  }
  return groups.map((group) => ({
    ...group,
    count: group.knifeIds.length,
    percent: knives.length
      ? Math.round((group.knifeIds.length / knives.length) * 100)
      : 0,
  }))
}

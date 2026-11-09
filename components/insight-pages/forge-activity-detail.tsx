import Link from 'next/link'
import { useMemo } from 'react'
import { ImageIcon } from 'lucide-react'
import Image from '@/components/vault-image'
import { ForgeActivityMap } from '@/components/forge-activity-map'
import {
  InsightPanel,
  type InsightSelection,
} from '@/components/insight-pages/detail-primitives'
import type { ActivityDay, CollectionStats } from '@/lib/collection-stats'
import { getImageUrl, type Knife, type KnifeActivityEvent } from '@/lib/data'
import styles from './forge-activity-detail.module.css'

type Totals = { added: number; edited: number; maintained: number }

const KINDS = [
  { key: 'added', label: 'Added' },
  { key: 'edited', label: 'Edited' },
  { key: 'maintained', label: 'Maintained' },
] as const
const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
]
const number = new Intl.NumberFormat('en-US')

function emptyTotals(): Totals {
  return { added: 0, edited: 0, maintained: 0 }
}

function addDay(totals: Totals, day: ActivityDay) {
  totals.added += day.addedCount
  totals.edited += day.editedCount
  totals.maintained += day.maintainedCount
}

function sum(totals: Totals) {
  return totals.added + totals.edited + totals.maintained
}

/** Consecutive active days ending today, or yesterday if today is quiet. */
function currentStreak(days: ActivityDay[]) {
  let index = days.length - 1
  if (index >= 0 && days[index].count === 0) index -= 1
  let streak = 0
  while (index >= 0 && days[index].count > 0) {
    streak += 1
    index -= 1
  }
  return streak
}

function longestStreak(days: ActivityDay[]) {
  let best = 0
  let run = 0
  for (const day of days) {
    run = day.count > 0 ? run + 1 : 0
    best = Math.max(best, run)
  }
  return best
}

function Stack({ totals, max }: { totals: Totals; max: number }) {
  return (
    <>
      {KINDS.map(({ key }) =>
        totals[key] ? (
          <span
            key={key}
            data-kind={key}
            style={{ flexGrow: totals[key], flexBasis: 0 }}
          />
        ) : null,
      )}
      <span
        style={{ flexGrow: Math.max(0, max - sum(totals)), flexBasis: 0 }}
      />
    </>
  )
}

/**
 * Forge's activity detail page: the calendar map plus rhythm breakdowns by
 * month, weekday and hour, and the knives that see the most attention.
 */
export function ForgeActivityDetail({
  stats,
  events,
  knivesById,
  onSelect,
}: {
  stats: CollectionStats
  events?: KnifeActivityEvent[]
  knivesById: Map<string, Knife>
  onSelect: (selection: InsightSelection) => void
}) {
  const days = stats.activity

  const months = useMemo(() => {
    const list: {
      key: string
      date: Date
      totals: Totals
      knifeIds: Set<string>
    }[] = []
    for (const day of days) {
      const key = `${day.date.getFullYear()}-${day.date.getMonth()}`
      let month = list.at(-1)
      if (month?.key !== key) {
        month = {
          key,
          date: new Date(day.date.getFullYear(), day.date.getMonth(), 1),
          totals: emptyTotals(),
          knifeIds: new Set(),
        }
        list.push(month)
      }
      addDay(month.totals, day)
      day.knifeIds.forEach((id) => month.knifeIds.add(id))
    }
    return list
  }, [days])

  const weekdays = useMemo(() => {
    const list = WEEKDAYS.map((name) => ({
      name,
      totals: emptyTotals(),
      activeDays: 0,
      knifeIds: new Set<string>(),
    }))
    for (const day of days) {
      const entry = list[(day.date.getDay() + 6) % 7]
      addDay(entry.totals, day)
      if (day.count) entry.activeDays += 1
      day.knifeIds.forEach((id) => entry.knifeIds.add(id))
    }
    return list
  }, [days])

  // Hours come from recorded events inside the same 52-week window.
  const hours = useMemo(() => {
    const list = Array.from({ length: 24 }, () => 0)
    const start = days[0]?.date.getTime() ?? 0
    for (const event of events ?? []) {
      const time = new Date(event.occurredAt)
      if (Number.isNaN(time.getTime()) || time.getTime() < start) continue
      list[time.getHours()] += 1
    }
    return list
  }, [events, days])

  const topKnives = useMemo(() => {
    const counts = new Map<string, Totals>()
    for (const day of days) {
      for (const { key } of KINDS) {
        const ids =
          key === 'added'
            ? day.addedKnifeIds
            : key === 'edited'
              ? day.editedKnifeIds
              : day.maintainedKnifeIds
        for (const id of ids) {
          const entry = counts.get(id) ?? emptyTotals()
          entry[key] += 1
          counts.set(id, entry)
        }
      }
    }
    return [...counts.entries()]
      .map(([id, totals]) => ({ knife: knivesById.get(id), totals }))
      .filter((item): item is { knife: Knife; totals: Totals } =>
        Boolean(item.knife),
      )
      .sort((left, right) => sum(right.totals) - sum(left.totals))
      .slice(0, 8)
  }, [days, knivesById])

  const total = days.reduce((value, day) => value + day.count, 0)
  const activeDays = stats.activeDays
  const busiestMonth = months.reduce<(typeof months)[number] | undefined>(
    (peak, month) =>
      sum(month.totals) > (peak ? sum(peak.totals) : 0) ? month : peak,
    undefined,
  )
  const busiestWeekday = weekdays.reduce((peak, day) =>
    sum(day.totals) > sum(peak.totals) ? day : peak,
  )
  const monthMax = Math.max(1, ...months.map((month) => sum(month.totals)))
  const weekdayMax = Math.max(1, ...weekdays.map((day) => sum(day.totals)))
  const hourMax = Math.max(1, ...hours)
  const hourTotal = hours.reduce((value, count) => value + count, 0)
  const peakHour = hours.indexOf(Math.max(...hours))
  const weekendShare = total
    ? Math.round(
        ((sum(weekdays[5].totals) + sum(weekdays[6].totals)) / total) * 100,
      )
    : 0
  const formatHour = (hour: number) =>
    new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, {
      hour: 'numeric',
    })

  const facts = [
    { label: 'Total activity', value: number.format(total), note: 'events' },
    {
      label: 'Active days',
      value: activeDays,
      note: `of ${days.length} · ${Math.round((activeDays / Math.max(1, days.length)) * 100)}%`,
    },
    {
      label: 'Current streak',
      value: currentStreak(days),
      note: `longest ${longestStreak(days)} days`,
    },
    {
      label: 'Per active day',
      value: activeDays ? (total / activeDays).toFixed(1) : '0',
      note: 'events on average',
    },
    {
      label: 'Busiest month',
      value: busiestMonth
        ? busiestMonth.date.toLocaleDateString(undefined, { month: 'short' })
        : '—',
      note: busiestMonth
        ? `${number.format(sum(busiestMonth.totals))} events`
        : 'no activity',
    },
  ]

  return (
    <div className={styles.root}>
      <dl className={styles.facts}>
        {facts.map((fact) => (
          <div key={fact.label} className={styles.fact}>
            <dt>{fact.label}</dt>
            <dd>
              <strong>{fact.value}</strong>
              <span>{fact.note}</span>
            </dd>
          </div>
        ))}
      </dl>

      <InsightPanel
        title="Activity calendar"
        description="Pick a day or month to see what changed. Drag the strip under the calendars to move through the year."
      >
        <ForgeActivityMap stats={stats} knivesById={knivesById} />
      </InsightPanel>

      <div className={styles.row}>
        <InsightPanel
          title="Monthly rhythm"
          description="Additions, edits and maintenance per month. Select a month to list its knives."
          className={styles.wide}
        >
          <div className={styles.legend}>
            {KINDS.map(({ key, label }) => (
              <span key={key} data-kind={key}>
                <i />
                {label}
              </span>
            ))}
          </div>
          <div className={styles.columns}>
            {months.map((month) => {
              const label = month.date.toLocaleDateString(undefined, {
                month: 'long',
                year: 'numeric',
              })
              return (
                <button
                  key={month.key}
                  type="button"
                  className={styles.column}
                  disabled={!month.knifeIds.size}
                  aria-label={`${label}: ${month.totals.added} added, ${month.totals.edited} edited, ${month.totals.maintained} maintained`}
                  onClick={() =>
                    onSelect({
                      title: `${label} · activity`,
                      knifeIds: [...month.knifeIds],
                    })
                  }
                >
                  <strong>{sum(month.totals) || ''}</strong>
                  <span className={styles.columnStack}>
                    <Stack totals={month.totals} max={monthMax} />
                  </span>
                  <small>
                    {month.date.toLocaleDateString(undefined, {
                      month: 'short',
                    })}
                  </small>
                </button>
              )
            })}
          </div>
        </InsightPanel>

        <InsightPanel
          title="Weekday pattern"
          description={`${busiestWeekday.name}s are busiest · ${weekendShare}% happens on weekends.`}
          className={styles.narrow}
        >
          <div className={styles.rows}>
            {weekdays.map((day) => (
              <button
                key={day.name}
                type="button"
                className={styles.weekdayRow}
                disabled={!day.knifeIds.size}
                aria-label={`${day.name}: ${sum(day.totals)} events across ${day.activeDays} active days`}
                onClick={() =>
                  onSelect({
                    title: `${day.name}s · activity`,
                    knifeIds: [...day.knifeIds],
                  })
                }
              >
                <span className={styles.weekdayName}>
                  {day.name.slice(0, 3)}
                </span>
                <span className={styles.rowStack}>
                  <Stack totals={day.totals} max={weekdayMax} />
                </span>
                <strong>{sum(day.totals)}</strong>
              </button>
            ))}
          </div>
        </InsightPanel>
      </div>

      <div className={styles.row}>
        <InsightPanel
          title="Most active knives"
          description="Knives with the most active days: added, edited or maintained."
          className={styles.half}
        >
          {topKnives.length ? (
            <ol className={styles.knives}>
              {topKnives.map(({ knife, totals }, index) => (
                <li key={knife.id}>
                  <Link
                    href={`/collection/${encodeURIComponent(knife.id)}`}
                    className={styles.knife}
                  >
                    <span className={styles.rank}>
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className={styles.thumb}>
                      {knife.images[0] ? (
                        <Image
                          src={getImageUrl(knife.images[0])}
                          alt=""
                          fill
                          sizes="40px"
                          className="object-contain"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <ImageIcon size={14} aria-hidden="true" />
                      )}
                    </span>
                    <span className={styles.knifeText}>
                      <strong>{knife.name}</strong>
                      <span>{knife.brand || 'Maker not recorded'}</span>
                    </span>
                    <span className={styles.knifeKinds}>
                      {KINDS.map(({ key, label }) =>
                        totals[key] ? (
                          <span key={key} data-kind={key} title={label}>
                            <i />
                            {totals[key]}
                          </span>
                        ) : null,
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          ) : (
            <p className={styles.empty}>No activity in the last 52 weeks.</p>
          )}
        </InsightPanel>

        <InsightPanel
          title="Time of day"
          description={
            hourTotal
              ? `Most changes happen around ${formatHour(peakHour)}.`
              : 'Needs recorded activity history.'
          }
          className={styles.half}
        >
          {hourTotal ? (
            <div className={styles.hours}>
              <div className={styles.hourBars}>
                {hours.map((count, hour) => (
                  <span
                    key={hour}
                    title={`${formatHour(hour)}: ${count} events`}
                    data-peak={hour === peakHour || undefined}
                    style={{
                      height: count
                        ? `${Math.max(6, (count / hourMax) * 100)}%`
                        : 0,
                    }}
                  />
                ))}
              </div>
              <div className={styles.hourAxis} aria-hidden="true">
                {[0, 6, 12, 18].map((hour) => (
                  <span key={hour}>{formatHour(hour)}</span>
                ))}
              </div>
              <dl className={styles.dayParts}>
                {[
                  { label: 'Night', from: 0, to: 6 },
                  { label: 'Morning', from: 6, to: 12 },
                  { label: 'Afternoon', from: 12, to: 18 },
                  { label: 'Evening', from: 18, to: 24 },
                ].map((part) => {
                  const count = hours
                    .slice(part.from, part.to)
                    .reduce((value, item) => value + item, 0)
                  return (
                    <div key={part.label}>
                      <dt>{part.label}</dt>
                      <dd>{Math.round((count / hourTotal) * 100)}%</dd>
                    </div>
                  )
                })}
              </dl>
            </div>
          ) : (
            <p className={styles.empty}>
              Hours are read from recorded events, which are unavailable right
              now.
            </p>
          )}
        </InsightPanel>
      </div>
    </div>
  )
}

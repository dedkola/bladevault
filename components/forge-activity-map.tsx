'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronLeft, ChevronRight, ImageIcon } from 'lucide-react'
import Image from '@/components/vault-image'
import { formatActivityDayLabel } from '@/components/collection-insights'
import type { ActivityDay, CollectionStats } from '@/lib/collection-stats'
import { getImageUrl, type Knife } from '@/lib/data'
import styles from './forge-activity-map.module.css'

type ActivityKind = 'all' | 'added' | 'edited' | 'maintained'
type EventKind = Exclude<ActivityKind, 'all'>
type Selection = { mode: 'day' | 'month'; key: string }

const KINDS: { value: ActivityKind; label: string }[] = [
  { value: 'all', label: 'All activity' },
  { value: 'added', label: 'Added' },
  { value: 'edited', label: 'Edited' },
  { value: 'maintained', label: 'Maintained' },
]
const EVENT_KINDS: { value: EventKind; label: string }[] = [
  { value: 'added', label: 'Added' },
  { value: 'edited', label: 'Edited' },
  { value: 'maintained', label: 'Maintained' },
]
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
/** Narrowest a month calendar gets before fewer are shown side by side. */
const MONTH_WIDTH = 236
const PREVIEW_LIMIT = 8
const number = new Intl.NumberFormat('en-US')

function countFor(day: ActivityDay, kind: ActivityKind): number {
  if (kind === 'added') return day.addedCount
  if (kind === 'edited') return day.editedCount
  if (kind === 'maintained') return day.maintainedCount
  return day.count
}

function idsFor(day: ActivityDay, kind: EventKind): string[] {
  if (kind === 'added') return day.addedKnifeIds
  if (kind === 'edited') return day.editedKnifeIds
  return day.maintainedKnifeIds
}

function dateKeyOf(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function monthKeyOf(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}`
}

function longestStreak(days: ActivityDay[], kind: ActivityKind): number {
  let best = 0
  let current = 0
  for (const day of days) {
    current = countFor(day, kind) > 0 ? current + 1 : 0
    best = Math.max(best, current)
  }
  return best
}

function sumDays(days: ActivityDay[]): Record<EventKind, number> {
  return days.reduce(
    (sum, day) => ({
      added: sum.added + day.addedCount,
      edited: sum.edited + day.editedCount,
      maintained: sum.maintained + day.maintainedCount,
    }),
    { added: 0, edited: 0, maintained: 0 },
  )
}

function Thumb({ knife, size }: { knife: Knife; size: number }) {
  return (
    <span className={styles.thumb}>
      {knife.images[0] ? (
        <Image
          src={getImageUrl(knife.images[0])}
          alt=""
          fill
          sizes={`${size}px`}
          className="object-contain"
          referrerPolicy="no-referrer"
        />
      ) : (
        <ImageIcon size={12} aria-hidden="true" />
      )}
    </span>
  )
}

/**
 * The newer styles' take on the Classic activity heatmap: the totals double
 * as the filter, hovering a day shows its breakdown, and picking a day or a
 * month lists what changed underneath instead of opening a dialog.
 */
export function ForgeActivityMap({
  stats,
  knivesById,
}: {
  stats: CollectionStats
  knivesById: Map<string, Knife>
}) {
  const [kind, setKind] = useState<ActivityKind>('all')
  const [selection, setSelection] = useState<Selection>()
  const [hover, setHover] = useState<{ key: string; x: number; y: number }>()
  const [expanded, setExpanded] = useState<EventKind[]>([])
  const wrapRef = useRef<HTMLDivElement>(null)
  const cellsRef = useRef<HTMLDivElement>(null)
  // How many month calendars fit side by side, and the last one shown.
  const [perPage, setPerPage] = useState(3)
  const [pageEnd, setPageEnd] = useState<number>()
  // A day to focus once it has rendered (it may sit in a newly paged month).
  const focusKeyRef = useRef<string>(undefined)

  useEffect(() => {
    const key = focusKeyRef.current
    if (!key) return
    focusKeyRef.current = undefined
    cellsRef.current
      ?.querySelector<HTMLButtonElement>(`[data-key="${key}"]`)
      ?.focus()
  })

  useEffect(() => {
    const node = wrapRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width
      setPerPage(
        Math.max(1, Math.min(4, Math.floor((width + 28) / (MONTH_WIDTH + 28)))),
      )
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const days = stats.activity
  const indexByKey = useMemo(
    () => new Map(days.map((day, index) => [day.dateKey, index])),
    [days],
  )
  const weeks = useMemo(
    () =>
      Array.from({ length: 52 }, (_, index) =>
        days.slice(index * 7, index * 7 + 7),
      ),
    [days],
  )
  const monthInfo = useMemo(() => {
    const list: { key: string; year: number; month: number }[] = []
    for (const day of days) {
      const key = monthKeyOf(day.date)
      if (list.at(-1)?.key !== key) {
        list.push({
          key,
          year: day.date.getFullYear(),
          month: day.date.getMonth(),
        })
      }
    }
    return list
  }, [days])
  const months = monthInfo.map((item) => item.key)
  const lastPage = Math.max(0, months.length - 1)
  const visibleEnd = Math.min(
    lastPage,
    Math.max(Math.min(perPage, months.length) - 1, pageEnd ?? lastPage),
  )
  const visibleStart = Math.max(0, visibleEnd - perPage + 1)
  const visibleMonths = monthInfo.slice(visibleStart, visibleEnd + 1)
  const visibleKeys = new Set(visibleMonths.map((item) => item.key))

  const firstPage = Math.max(0, Math.min(perPage, months.length) - 1)
  /** Show the calendars ending at the given month index. */
  function pageTo(end: number) {
    setPageEnd(Math.min(lastPage, Math.max(firstPage, end)))
  }
  // Week index where each month's calendar starts, for the scrubber labels.
  const monthStarts = monthInfo.map((info) => {
    const index = days.findIndex((day) => monthKeyOf(day.date) === info.key)
    return { ...info, week: Math.floor(Math.max(0, index) / 7) }
  })
  const windowStart = monthStarts[visibleStart]?.week ?? 0
  const windowEnd = monthStarts[visibleEnd + 1]?.week ?? 52
  const scrubRef = useRef<HTMLDivElement>(null)
  const wheelRef = useRef(0)
  const swipeRef = useRef<number>(undefined)
  // Latest paging state for the native wheel listener below.
  const pagingRef = useRef({ visibleEnd, pageTo })
  useEffect(() => {
    pagingRef.current = { visibleEnd, pageTo }
  })

  /** Centre the calendars on the month under a point of the scrubber. */
  function scrubTo(clientX: number) {
    const box = scrubRef.current?.getBoundingClientRect()
    if (!box) return
    const week = Math.min(
      51,
      Math.max(0, Math.floor(((clientX - box.left) / box.width) * 52)),
    )
    const middle = weeks[week]?.[3] ?? weeks[week]?.[0]
    if (!middle) return
    const index = months.indexOf(monthKeyOf(middle.date))
    pageTo(index + Math.floor((perPage - 1) / 2))
  }

  // Sideways trackpad scrolling pages months. It needs a non-passive
  // listener so the browser's back-swipe gesture does not fire instead.
  useEffect(() => {
    const node = wrapRef.current
    if (!node) return
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return
      event.preventDefault()
      wheelRef.current += event.deltaX
      if (Math.abs(wheelRef.current) < 60) return
      const { visibleEnd: end, pageTo: go } = pagingRef.current
      go(end + Math.sign(wheelRef.current))
      wheelRef.current = 0
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [])

  /** Page the calendars so the given month is on screen. */
  function revealMonth(key: string) {
    const index = months.indexOf(key)
    if (index < 0) return
    if (index > visibleEnd) setPageEnd(index)
    else if (index < visibleStart) setPageEnd(index + perPage - 1)
  }

  const totals: Record<ActivityKind, number> = {
    all: days.reduce((sum, day) => sum + day.count, 0),
    added: stats.additionsInActivityRange,
    edited: stats.editsInActivityRange,
    maintained: stats.maintainedKnivesInActivityRange,
  }
  // Quartiles of the active days, so one bulk-edit day does not wash every
  // other day out to the palest shade.
  const thresholds = useMemo(() => {
    const counts = days
      .map((day) => countFor(day, kind))
      .filter((count) => count > 0)
      .sort((left, right) => left - right)
    if (!counts.length) return [0, 0, 0]
    return [0.25, 0.5, 0.75].map(
      (share) => counts[Math.floor(share * (counts.length - 1))],
    )
  }, [days, kind])
  const weekTotals = weeks.map((week) =>
    week.reduce((sum, day) => sum + countFor(day, kind), 0),
  )
  // Square root keeps one bulk week from flattening every other bar.
  const maxWeek = Math.sqrt(Math.max(1, ...weekTotals))
  const activeDays = days.filter((day) => countFor(day, kind) > 0).length
  const streak = longestStreak(days, kind)
  const busiest = days.reduce<ActivityDay | undefined>(
    (peak, day) =>
      countFor(day, kind) > (peak ? countFor(peak, kind) : 0) ? day : peak,
    undefined,
  )
  const latestActive = [...days]
    .reverse()
    .find((day) => countFor(day, kind) > 0)
  const todayKey = days.at(-1)?.dateKey

  const current: Selection | undefined =
    selection ??
    (latestActive ? { mode: 'day', key: latestActive.dateKey } : undefined)
  const selectedDays = !current
    ? []
    : current.mode === 'day'
      ? days.filter((day) => day.dateKey === current.key)
      : days.filter((day) => monthKeyOf(day.date) === current.key)
  // When the panel resizes and fewer months fit, keep the selection on screen.
  const [shownPerPage, setShownPerPage] = useState(perPage)
  if (shownPerPage !== perPage) {
    setShownPerPage(perPage)
    const selectedMonth =
      current?.mode === 'month'
        ? current.key
        : selectedDays[0] && monthKeyOf(selectedDays[0].date)
    if (selectedMonth) revealMonth(selectedMonth)
  }
  const selectedDayKey = current?.mode === 'day' ? current.key : undefined
  const rovingKey = selectedDayKey ?? latestActive?.dateKey ?? todayKey
  const selectedSums = sumDays(selectedDays)
  const visibleKinds = EVENT_KINDS.filter(
    (item) => kind === 'all' || kind === item.value,
  )
  const groups = visibleKinds
    .map((item) => {
      const ids = new Set(
        selectedDays.flatMap((day) => idsFor(day, item.value)),
      )
      return {
        ...item,
        knives: [...ids]
          .map((id) => knivesById.get(id))
          .filter((knife): knife is Knife => Boolean(knife)),
      }
    })
    .filter((group) => group.knives.length > 0)

  function selectDay(key: string, focus = false) {
    setSelection({ mode: 'day', key })
    setExpanded([])
    const day = days[indexByKey.get(key) ?? -1]
    if (day) revealMonth(monthKeyOf(day.date))
    if (focus) focusKeyRef.current = key
  }

  function selectMonth(key: string) {
    setSelection({ mode: 'month', key })
    setExpanded([])
    revealMonth(key)
  }

  function step(direction: -1 | 1) {
    if (!current) return
    if (current.mode === 'month') {
      const next = months[months.indexOf(current.key) + direction]
      if (next) selectMonth(next)
      return
    }
    let index = (indexByKey.get(current.key) ?? 0) + direction
    while (index >= 0 && index < days.length) {
      if (countFor(days[index], kind) > 0) {
        selectDay(days[index].dateKey)
        return
      }
      index += direction
    }
  }

  function showHover(target: EventTarget) {
    if (!(target instanceof HTMLElement)) return
    const key = target.dataset.key
    const wrap = wrapRef.current
    if (!key || !wrap) return
    const cell = target.getBoundingClientRect()
    const box = wrap.getBoundingClientRect()
    setHover({
      key,
      x: Math.min(
        Math.max(cell.left + cell.width / 2 - box.left, 120),
        box.width - 120,
      ),
      y: cell.top - box.top,
    })
  }

  function onCellsKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const key = (event.target as HTMLElement).dataset.key
    if (!key) return
    const offsets: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    }
    const offset = offsets[event.key]
    if (offset === undefined) return
    event.preventDefault()
    const next = days[(indexByKey.get(key) ?? 0) + offset]
    if (next) selectDay(next.dateKey, true)
  }

  const hoverIndex = hover ? indexByKey.get(hover.key) : undefined
  const hoverDay = hoverIndex === undefined ? undefined : days[hoverIndex]
  const hoverWeekIndex =
    hoverIndex === undefined ? undefined : Math.floor(hoverIndex / 7)
  const hoverWeekTotal =
    hoverWeekIndex === undefined ? 0 : weekTotals[hoverWeekIndex]
  const hoverMonthTotal = hoverDay
    ? days
        .filter(
          (day) =>
            monthKeyOf(day.date) === monthKeyOf(hoverDay.date) &&
            day.date <= hoverDay.date,
        )
        .reduce((sum, day) => sum + countFor(day, kind), 0)
    : 0
  const hoverKnives = hoverDay
    ? [...new Set(visibleKinds.flatMap((item) => idsFor(hoverDay, item.value)))]
        .map((id) => knivesById.get(id))
        .filter((knife): knife is Knife => Boolean(knife))
    : []

  const readoutTitle = !current
    ? ''
    : current.mode === 'day'
      ? selectedDays[0]?.date.toLocaleDateString(undefined, {
          weekday: 'long',
          month: 'short',
          day: 'numeric',
        })
      : selectedDays[0]?.date.toLocaleDateString(undefined, {
          month: 'long',
          year: 'numeric',
        })
  const currentIndex = current ? indexByKey.get(current.key) : undefined
  const canStepBack =
    current?.mode === 'month'
      ? months.indexOf(current.key) > 0
      : days.slice(0, currentIndex ?? 0).some((day) => countFor(day, kind) > 0)
  const canStepForward =
    current?.mode === 'month'
      ? months.indexOf(current.key) < months.length - 1
      : days
          .slice((currentIndex ?? days.length) + 1)
          .some((day) => countFor(day, kind) > 0)

  return (
    <div className={styles.root}>
      <div className={styles.kinds} role="group" aria-label="Activity type">
        {KINDS.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={kind === item.value}
            onClick={() => {
              setKind(item.value)
              setSelection(undefined)
              setExpanded([])
            }}
            className={styles.kind}
          >
            <span className={styles.kindLabel} data-kind={item.value}>
              <i />
              {item.label}
            </span>
            <strong className={styles.kindValue}>
              {number.format(totals[item.value])}
            </strong>
          </button>
        ))}
      </div>

      <div ref={wrapRef} className={styles.mapWrap}>
        <div className={styles.calendarNav}>
          <button
            type="button"
            onClick={() => pageTo(visibleEnd - 1)}
            disabled={visibleStart === 0}
            aria-label="Earlier months"
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => pageTo(visibleEnd + 1)}
            disabled={visibleEnd >= lastPage}
            aria-label="Later months"
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
        <div
          ref={cellsRef}
          className={styles.calendars}
          style={{ gridTemplateColumns: `repeat(${perPage}, minmax(0, 1fr))` }}
          role="group"
          aria-label="Activity by day. Arrow keys move between days."
          onKeyDown={onCellsKeyDown}
          onPointerOver={(event) => {
            // Touch taps select a day; the readout already shows it.
            if (event.pointerType === 'mouse') showHover(event.target)
          }}
          onPointerLeave={() => setHover(undefined)}
          onPointerDown={(event) => {
            if (event.pointerType === 'touch') swipeRef.current = event.clientX
          }}
          onPointerUp={(event) => {
            const start = swipeRef.current
            swipeRef.current = undefined
            if (start === undefined) return
            const distance = event.clientX - start
            // Swipe left for later months, right for earlier ones.
            if (Math.abs(distance) > 48)
              pageTo(visibleEnd - Math.sign(distance))
          }}
          onFocus={(event) => {
            if (event.target.matches(':focus-visible')) {
              showHover(event.target)
            }
          }}
          onBlur={() => setHover(undefined)}
        >
          {visibleMonths.map((info) => {
            const first = new Date(info.year, info.month, 1)
            const length = new Date(info.year, info.month + 1, 0).getDate()
            const lead = (first.getDay() + 6) % 7
            const monthSelected =
              current?.mode === 'month' && current.key === info.key
            return (
              <div
                key={info.key}
                className={styles.calendar}
                data-dim={
                  (current?.mode === 'month' && !monthSelected) || undefined
                }
              >
                <button
                  type="button"
                  className={styles.monthTitle}
                  aria-pressed={monthSelected}
                  aria-label={`Show ${first.toLocaleDateString(undefined, {
                    month: 'long',
                    year: 'numeric',
                  })}`}
                  onClick={() => selectMonth(info.key)}
                >
                  {first.toLocaleDateString(undefined, {
                    month: 'long',
                    year: 'numeric',
                  })}
                </button>
                <div className={styles.dayGrid}>
                  {WEEKDAYS.map((label) => (
                    <span
                      key={label}
                      className={styles.weekday}
                      aria-hidden="true"
                    >
                      {label}
                    </span>
                  ))}
                  {Array.from({ length: lead }, (_, index) => (
                    <span key={`lead-${index}`} aria-hidden="true" />
                  ))}
                  {Array.from({ length }, (_, index) => {
                    const date = new Date(info.year, info.month, index + 1)
                    const day = days[indexByKey.get(dateKeyOf(date)) ?? -1]
                    if (!day) {
                      return (
                        <span
                          key={index}
                          className={styles.day}
                          data-outside
                          aria-hidden="true"
                        >
                          {index + 1}
                        </span>
                      )
                    }
                    const count = countFor(day, kind)
                    const level =
                      count === 0
                        ? 0
                        : 1 + thresholds.filter((limit) => count > limit).length
                    const label = formatActivityDayLabel(
                      day.date,
                      kind === 'all' || kind === 'added' ? day.addedCount : 0,
                      kind === 'all' || kind === 'edited' ? day.editedCount : 0,
                      kind === 'all' || kind === 'maintained'
                        ? day.maintainedCount
                        : 0,
                    )
                    return (
                      <button
                        key={day.dateKey}
                        type="button"
                        data-key={day.dateKey}
                        aria-label={label}
                        aria-pressed={selectedDayKey === day.dateKey}
                        tabIndex={day.dateKey === rovingKey ? 0 : -1}
                        data-level={level}
                        data-today={day.dateKey === todayKey || undefined}
                        onClick={() => selectDay(day.dateKey)}
                        className={styles.day}
                      >
                        {index + 1}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
        <div
          ref={scrubRef}
          className={styles.scrubber}
          role="slider"
          tabIndex={0}
          aria-label="Months shown. Drag or use arrow keys to move through the year."
          aria-valuemin={firstPage}
          aria-valuemax={lastPage}
          aria-valuenow={visibleEnd}
          aria-valuetext={visibleMonths
            .map((info) =>
              new Date(info.year, info.month, 1).toLocaleDateString(undefined, {
                month: 'long',
                year: 'numeric',
              }),
            )
            .join(' to ')}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            scrubTo(event.clientX)
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              scrubTo(event.clientX)
            }
          }}
          onKeyDown={(event) => {
            const moves: Record<string, number> = {
              ArrowLeft: visibleEnd - 1,
              ArrowRight: visibleEnd + 1,
              PageUp: visibleEnd - perPage,
              PageDown: visibleEnd + perPage,
              Home: firstPage,
              End: lastPage,
            }
            const next = moves[event.key]
            if (next === undefined) return
            event.preventDefault()
            pageTo(next)
          }}
        >
          <div className={styles.weekBars} aria-hidden="true">
            {weekTotals.map((total, index) => (
              <span
                key={index}
                data-active={hoverWeekIndex === index || undefined}
                data-visible={
                  weeks[index]?.some((day) =>
                    visibleKeys.has(monthKeyOf(day.date)),
                  ) || undefined
                }
                style={{
                  height: total
                    ? `${Math.max(10, (Math.sqrt(total) / maxWeek) * 100)}%`
                    : 0,
                }}
              />
            ))}
            <i
              className={styles.scrubWindow}
              style={{
                left: `${(windowStart / 52) * 100}%`,
                width: `${((windowEnd - windowStart) / 52) * 100}%`,
              }}
            />
          </div>
          <div className={styles.scrubMonths} aria-hidden="true">
            {monthStarts.map((info, index) => (
              <span
                key={info.key}
                // A partial leading month would collide with the next label.
                hidden={(monthStarts[index + 1]?.week ?? 99) - info.week < 2}
                data-visible={
                  (index >= visibleStart && index <= visibleEnd) || undefined
                }
                style={{ left: `${(info.week / 52) * 100}%` }}
              >
                <span className={styles.scrubShort}>
                  {new Date(info.year, info.month, 1).toLocaleDateString(
                    undefined,
                    { month: 'short' },
                  )}
                </span>
                <span className={styles.scrubNarrow}>
                  {new Date(info.year, info.month, 1).toLocaleDateString(
                    undefined,
                    { month: 'narrow' },
                  )}
                </span>
              </span>
            ))}
          </div>
        </div>

        {hoverDay && hover && (
          <div
            className={styles.hoverCard}
            style={{ left: hover.x, top: hover.y }}
            aria-hidden="true"
          >
            <strong className={styles.hoverDate}>
              {hoverDay.date.toLocaleDateString(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </strong>
            <ul className={styles.hoverRows}>
              {EVENT_KINDS.map((item) => {
                const value = countFor(hoverDay, item.value)
                return (
                  <li
                    key={item.value}
                    data-kind={item.value}
                    data-empty={value === 0 || undefined}
                  >
                    <i />
                    <span>{item.label}</span>
                    <strong>{value}</strong>
                  </li>
                )
              })}
            </ul>
            {hoverKnives.length > 0 && (
              <div className={styles.hoverThumbs}>
                {hoverKnives.slice(0, 5).map((knife) => (
                  <Thumb key={knife.id} knife={knife} size={30} />
                ))}
                {hoverKnives.length > 5 && (
                  <span className={styles.hoverMore}>
                    +{hoverKnives.length - 5}
                  </span>
                )}
              </div>
            )}
            <span className={styles.hoverFoot}>
              Week total {hoverWeekTotal} · Month so far {hoverMonthTotal}
            </span>
          </div>
        )}
      </div>

      <section className={styles.readout} aria-live="polite">
        <header className={styles.readoutHead}>
          <div className={styles.readoutTitle}>
            <span>
              {current?.mode === 'month' ? 'Selected month' : 'Selected day'}
            </span>
            <strong>{readoutTitle || 'No activity yet'}</strong>
          </div>
          <div className={styles.readoutSums}>
            {visibleKinds.map((item) => (
              <span
                key={item.value}
                data-kind={item.value}
                data-empty={selectedSums[item.value] === 0 || undefined}
              >
                <i />
                {selectedSums[item.value]} {item.label.toLowerCase()}
              </span>
            ))}
          </div>
          <div className={styles.stepper}>
            <button
              type="button"
              onClick={() => step(-1)}
              disabled={!canStepBack}
              aria-label={
                current?.mode === 'month'
                  ? 'Previous month'
                  : 'Previous active day'
              }
            >
              <ChevronLeft size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              disabled={!canStepForward}
              aria-label={
                current?.mode === 'month' ? 'Next month' : 'Next active day'
              }
            >
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </div>
        </header>

        {groups.length ? (
          <div className={styles.groups}>
            {groups.map((group) => {
              const open = expanded.includes(group.value)
              const shown = open
                ? group.knives
                : group.knives.slice(0, PREVIEW_LIMIT)
              return (
                <div key={group.value} className={styles.group}>
                  <div className={styles.groupHead} data-kind={group.value}>
                    <i />
                    <span>{group.label}</span>
                    <strong>
                      {group.knives.length}{' '}
                      {group.knives.length === 1 ? 'knife' : 'knives'}
                    </strong>
                    {group.knives.length > PREVIEW_LIMIT && (
                      <button
                        type="button"
                        onClick={() =>
                          setExpanded((list) =>
                            open
                              ? list.filter((value) => value !== group.value)
                              : [...list, group.value],
                          )
                        }
                      >
                        {open
                          ? 'Show fewer'
                          : `Show all ${group.knives.length}`}
                      </button>
                    )}
                  </div>
                  <div className={styles.knives}>
                    {shown.map((knife) => (
                      <Link
                        key={knife.id}
                        href={`/collection/${encodeURIComponent(knife.id)}`}
                        className={styles.knife}
                      >
                        <Thumb knife={knife} size={40} />
                        <span className={styles.knifeText}>
                          <strong>{knife.name}</strong>
                          <span>{knife.brand || 'Maker not recorded'}</span>
                        </span>
                      </Link>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <p className={styles.readoutEmpty}>
            {current
              ? 'Nothing recorded for this selection.'
              : 'No activity in the last 52 weeks.'}
          </p>
        )}
      </section>

      <div className={styles.foot}>
        <dl className={styles.facts}>
          <div>
            <dt>Active days</dt>
            <dd>{activeDays}</dd>
          </div>
          <div>
            <dt>Longest streak</dt>
            <dd>
              {streak} {streak === 1 ? 'day' : 'days'}
            </dd>
          </div>
          {busiest && (
            <div>
              <dt>Busiest day</dt>
              <dd>
                <button
                  type="button"
                  className={styles.factLink}
                  onClick={() => selectDay(busiest.dateKey, true)}
                >
                  {busiest.date.toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                  })}{' '}
                  · {countFor(busiest, kind)}
                </button>
              </dd>
            </div>
          )}
        </dl>
        <span className={styles.legend} aria-hidden="true">
          Less
          {[0, 1, 2, 3, 4].map((level) => (
            <i key={level} data-level={level} className={styles.swatch} />
          ))}
          More
        </span>
      </div>
    </div>
  )
}

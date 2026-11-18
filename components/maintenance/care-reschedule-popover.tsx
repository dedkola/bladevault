'use client'

import Link from 'next/link'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DayPicker, UI, type ClassNames } from 'react-day-picker'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { careToneDotClass } from '@/components/care-badge'
import { dayPickerClassNames } from '@/components/ui/date-input'
import { useCare } from '@/components/providers/care-provider'
import { formatCareDate, type CareJob } from '@/lib/care-insights'
import { localDateAfter } from '@/lib/care-notifications'
import { CARE_TRACK_NAMES } from '@/lib/settings-shared'

// The app's date-picker calendar, sized down to fit the card.
const calendarClassNames: Partial<ClassNames> = {
  ...dayPickerClassNames,
  [UI.Root]: 'relative text-foreground',
  [UI.Weekday]:
    'w-8 text-center text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground',
  [UI.Day]: 'size-8 p-0 text-center text-[12.5px]',
  [UI.DayButton]:
    'inline-flex size-8 items-center justify-center rounded-md text-[12.5px] text-foreground transition-colors hover:bg-[var(--bladevault-surface-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-35',
}

function parseDay(day: string) {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year, month - 1, date)
}

function toDay(date: Date) {
  return localDateAfter(date, 0)
}

const OPTIONS = [
  { label: 'Tomorrow', days: 1 },
  { label: 'Next week', days: 7 },
  { label: 'Next month', days: 30 },
] as const

function dueText(days: number) {
  if (days < 0) return `${-days} day${days === -1 ? '' : 's'} overdue`
  if (days === 0) return 'due today'
  return `due in ${days} day${days === 1 ? '' : 's'}`
}

/**
 * First day a reschedule can move the job to: the day after its normal
 * deadline (last logged care plus its interval), since a reschedule only
 * ever pushes a job later.
 */
function firstLaterDay(job: CareJob) {
  const last = new Date(job.lastAt)
  return localDateAfter(
    new Date(last.getFullYear(), last.getMonth(), last.getDate()),
    job.intervalDays + 1,
  )
}

function longDate(day: string) {
  return new Date(`${day}T00:00`).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/**
 * Small card next to a timeline pin: push the job to a later date without
 * logging care, or open the knife. A hover preview closes when the
 * pointer leaves; a pinned card (opened by a click or the keyboard) takes
 * focus and stays until Escape, a click outside or an action.
 */
export function CareReschedulePopover({
  job,
  anchor,
  pinned,
  knifeName,
  now,
  onClose,
  onHoverStart,
  onHoverEnd,
}: {
  job: CareJob | null
  anchor: HTMLElement | null
  pinned: boolean
  knifeName: string
  now: Date
  onClose: () => void
  /** Pointer entered or left the card, so a hover preview can stay open. */
  onHoverStart?: () => void
  onHoverEnd?: () => void
}) {
  const { deferCare } = useCare()
  const ref = useRef<HTMLDivElement>(null)
  const [pending, setPending] = useState(false)
  // Keyed by job, so another pin's card never shows this one's error.
  const [failure, setFailure] = useState<{
    key: string
    message: string
  } | null>(null)
  const jobKey = job ? `${job.knifeId}\u0000${job.track}` : ''
  const error = failure?.key === jobKey ? failure.message : null
  // The "Set to" calendar, open for this job only: the picked day and the
  // month on show.
  const [picker, setPicker] = useState<{
    key: string
    day: string | null
    month: Date
  } | null>(null)
  const picking = picker?.key === jobKey
  const open = job !== null && anchor !== null
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  // Show in the top layer under (or above) the pin and follow it while the
  // page scrolls or resizes.
  useLayoutEffect(() => {
    const popover = ref.current
    if (!popover || !open) return
    const place = () => {
      if (!anchor.isConnected) {
        onCloseRef.current()
        return
      }
      const rect = anchor.getBoundingClientRect()
      const width = popover.offsetWidth
      const height = popover.offsetHeight
      const left = Math.min(
        Math.max(8, rect.left + rect.width / 2 - width / 2),
        window.innerWidth - width - 8,
      )
      const below = rect.bottom + 6
      const top =
        below + height > window.innerHeight - 8
          ? Math.max(8, rect.top - height - 6)
          : below
      popover.style.left = `${left}px`
      popover.style.top = `${top}px`
      popover.setAttribute('data-placed', '')
    }
    if (!popover.matches(':popover-open')) popover.showPopover()
    place()
    // The card grows when its calendar opens; keep it on screen.
    const resizes = new ResizeObserver(place)
    resizes.observe(popover)
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      resizes.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      popover.removeAttribute('data-placed')
      if (popover.matches(':popover-open')) popover.hidePopover()
      // Reopening the card starts from the quick options again.
      setPicker(null)
    }
  }, [open, anchor, job?.knifeId, job?.track])

  // A pinned card closes on Escape or a press outside it and its pin.
  useEffect(() => {
    const popover = ref.current
    if (!popover || !open || !pinned) return
    popover.focus({ preventScroll: true })
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (popover.contains(target) || anchor.contains(target)) return
      onCloseRef.current()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      // The calendar handles its own Escape (closing just the calendar).
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      onCloseRef.current()
      anchor.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, pinned, anchor])

  async function apply(until: string) {
    if (!job) return
    setPending(true)
    setFailure(null)
    try {
      await deferCare(job.knifeId, job.track, until)
      onClose()
      anchor?.focus({ preventScroll: true })
    } catch (err) {
      setFailure({
        key: jobKey,
        message: err instanceof Error ? err.message : 'Could not reschedule',
      })
    } finally {
      setPending(false)
    }
  }

  const options = job
    ? [...OPTIONS, { label: 'Skip this time', days: job.intervalDays }]
    : []
  // A planned date can't be in the past or before the normal deadline.
  const today = localDateAfter(now, 0)
  const pushFrom = job ? firstLaterDay(job) : today
  const earliest = pushFrom > today ? pushFrom : today
  const chosen = picking ? picker.day : null
  const canSet =
    job !== null &&
    !pending &&
    chosen !== null &&
    chosen >= earliest &&
    chosen !== job.dueOn

  function openPicker() {
    if (!job) return
    const day = job.dueOn < earliest ? null : job.dueOn
    setPicker({ key: jobKey, day, month: parseDay(day ?? earliest) })
    // Let the keyboard carry on into the calendar.
    requestAnimationFrame(() => {
      ref.current
        ?.querySelector<HTMLButtonElement>(
          '.id-care-reschedule-calendar button[aria-selected="true"], .id-care-reschedule-calendar td:not([data-disabled]) button',
        )
        ?.focus()
    })
  }

  function closePicker() {
    setPicker(null)
    ref.current?.focus({ preventScroll: true })
  }

  return (
    <div
      ref={ref}
      popover="manual"
      role="dialog"
      tabIndex={-1}
      aria-label={
        job ? `${CARE_TRACK_NAMES[job.track]}: ${knifeName}` : undefined
      }
      className="id-care-pin-list id-care-reschedule"
      onMouseEnter={onHoverStart}
      // Keep a hover preview open while its calendar is in use.
      onMouseLeave={picking ? undefined : onHoverEnd}
    >
      {job && (
        <>
          <strong className="id-care-reschedule-date">
            {longDate(job.dueOn)}
          </strong>
          <ul className="id-care-reschedule-rows">
            <li>
              <i className="id-care-swatch" data-kind={job.track} />
              <span>{CARE_TRACK_NAMES[job.track]}</span>
              <strong>{knifeName}</strong>
            </li>
            <li>
              <i className={careToneDotClass(job.level)} />
              <span>
                {job.deferredUntil
                  ? 'Rescheduled'
                  : job.dueInDays < 0
                    ? 'Overdue'
                    : 'Due'}
              </span>
              <strong>{dueText(job.dueInDays)}</strong>
            </li>
          </ul>
          <div className="id-care-reschedule-options">
            {options.map((option) => {
              const until = localDateAfter(now, option.days)
              return (
                <button
                  key={option.label}
                  type="button"
                  // Only dates later than the current deadline help.
                  disabled={pending || until <= job.dueOn}
                  title={`Move to ${formatCareDate(until, now)}`}
                  onClick={() => void apply(until)}
                >
                  {option.label}
                </button>
              )
            })}
            {!picking && (
              <button
                type="button"
                className="id-care-reschedule-set-toggle"
                disabled={pending}
                onClick={openPicker}
              >
                Set to…
              </button>
            )}
          </div>
          {picking && (
            <div
              className="id-care-reschedule-calendar"
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return
                // Close just the calendar, not the whole card; the card's
                // own Escape handler skips handled events.
                event.preventDefault()
                closePicker()
              }}
            >
              <DayPicker
                mode="single"
                month={picker.month}
                onMonthChange={(month) => setPicker({ ...picker, month })}
                startMonth={parseDay(earliest)}
                selected={chosen ? parseDay(chosen) : undefined}
                onSelect={(date) =>
                  setPicker({ ...picker, day: date ? toDay(date) : null })
                }
                disabled={{ before: parseDay(earliest) }}
                showOutsideDays
                fixedWeeks
                classNames={calendarClassNames}
                components={{
                  Chevron: ({ orientation, className }) =>
                    orientation === 'left' ? (
                      <ChevronLeft className={className} size={14} />
                    ) : (
                      <ChevronRight className={className} size={14} />
                    ),
                }}
              />
              <div className="id-care-reschedule-calendar-actions">
                <button type="button" onClick={closePicker}>
                  Cancel
                </button>
                <button
                  type="button"
                  data-primary
                  disabled={!canSet}
                  onClick={() => chosen && void apply(chosen)}
                >
                  {chosen
                    ? `Set to ${formatCareDate(chosen, now)}`
                    : 'Pick a day'}
                </button>
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="id-care-reschedule-error">
              {error}
            </p>
          )}
          <Link
            className="id-care-reschedule-open"
            href={`/collection/${encodeURIComponent(job.knifeId)}`}
          >
            Go to knife page
          </Link>
        </>
      )}
    </div>
  )
}

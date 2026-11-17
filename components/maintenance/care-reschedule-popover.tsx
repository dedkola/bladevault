'use client'

import Link from 'next/link'
import { useLayoutEffect, useRef, useState } from 'react'
import { careToneDotClass } from '@/components/care-badge'
import { useCare } from '@/components/providers/care-provider'
import type { CareJob } from '@/lib/care-insights'
import { localDateAfter } from '@/lib/care-notifications'
import { CARE_TRACK_NAMES } from '@/lib/settings-shared'

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
 * Small card next to a timeline pin: push the job to a later date without
 * logging care, or open the knife. Light-dismisses like any popover.
 */
export function CareReschedulePopover({
  job,
  anchor,
  knifeName,
  now,
  onClose,
  onHoverStart,
  onHoverEnd,
}: {
  job: CareJob | null
  anchor: HTMLElement | null
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
  const [error, setError] = useState<string | null>(null)
  const open = job !== null && anchor !== null

  // Show in the top layer, then place it under (or above) the pin.
  useLayoutEffect(() => {
    const popover = ref.current
    if (!popover || !open) return
    if (!popover.matches(':popover-open')) popover.showPopover()
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
    return () => {
      popover.removeAttribute('data-placed')
      if (popover.matches(':popover-open')) popover.hidePopover()
    }
  }, [open, anchor, job?.knifeId, job?.track])

  async function apply(until: string) {
    if (!job) return
    setPending(true)
    setError(null)
    try {
      await deferCare(job.knifeId, job.track, until)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reschedule')
    } finally {
      setPending(false)
    }
  }

  const options = job
    ? [...OPTIONS, { label: 'Skip this time', days: job.intervalDays }]
    : []

  return (
    <div
      ref={ref}
      popover="auto"
      className="id-care-pin-list id-care-reschedule"
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
      onToggle={(event) => {
        if (event.newState === 'closed') {
          setError(null)
          onClose()
        }
      }}
    >
      {job && (
        <>
          <strong className="id-care-reschedule-date">
            {new Date(`${job.dueOn}T00:00`).toLocaleDateString(undefined, {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </strong>
          <ul className="id-care-reschedule-rows">
            <li>
              <i className="id-care-swatch" data-kind={job.track} />
              <span>{CARE_TRACK_NAMES[job.track]}</span>
              <strong>{knifeName}</strong>
            </li>
            <li>
              <i className={careToneDotClass(job.level)} />
              <span>{job.dueInDays < 0 ? 'Overdue' : 'Due'}</span>
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
                  title={
                    option.label === 'Skip this time'
                      ? `A full ${job.intervalDays}-day interval from today`
                      : undefined
                  }
                  onClick={() => void apply(until)}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
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

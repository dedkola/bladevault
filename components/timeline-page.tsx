'use client'

import Link from 'next/link'
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import {
  Flag,
  ImageIcon,
  NotebookPen,
  PackagePlus,
  Plus,
  Wrench,
} from 'lucide-react'
import Image from '@/components/vault-image'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { buttonVariants } from '@/components/ui/button'
import { useKnives } from '@/components/providers/knives-provider'
import { readJsonResponse } from '@/lib/api-response'
import {
  getImageUrl,
  maintenanceTypeName,
  type KnifeNote,
  type MaintenanceEvent,
} from '@/lib/data'
import { formatKnifeCount } from '@/lib/knife-count'
import {
  brandKey,
  buildTimelineEntries,
  filterTimelineByYear,
  formatKnifeName,
  groupTimelineByMonth,
  listTimelineYears,
  type TimelineEntry,
  type TimelineEntryType,
  type TimelineGroup,
  type TimelineKnifeRef,
} from '@/lib/timeline'
import { buildYearRecap, type YearRecap } from '@/lib/timeline-stats'
import styles from './timeline-page.module.css'

/** Months rendered at first, and added by each "Show earlier" press. */
const MONTH_PAGE = 12
/** Brand names listed in the recap before the rest collapse into a count. */
const NEW_BRANDS_SHOWN = 5
const number = new Intl.NumberFormat('en-US')

const KIND: Record<TimelineEntryType, { label: string; icon: typeof Flag }> = {
  added: { label: 'Added', icon: PackagePlus },
  maintenance: { label: 'Maintenance', icon: Wrench },
  note: { label: 'Note', icon: NotebookPen },
  milestone: { label: 'Milestone', icon: Flag },
}

type TimelinePayload = {
  maintenanceEvents?: MaintenanceEvent[]
  notes?: KnifeNote[]
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${number.format(count)} ${count === 1 ? one : many}`
}

function formatBrandList(brands: string[]) {
  if (brands.length <= NEW_BRANDS_SHOWN) return brands.join(', ')
  const rest = brands.length - NEW_BRANDS_SHOWN
  return `${brands.slice(0, NEW_BRANDS_SHOWN).join(', ')} and ${number.format(rest)} more`
}

function formatEntryDate(entry: TimelineEntry) {
  return new Date(entry.time).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

function monthName(month: number) {
  return new Date(2000, month, 1).toLocaleDateString('en-US', {
    month: 'long',
  })
}

function knifeHref(knife: TimelineKnifeRef) {
  return `/collection/${encodeURIComponent(knife.id)}`
}

function Thumb({ knife }: { knife: TimelineKnifeRef }) {
  return (
    <span className={styles.thumb} aria-hidden="true">
      {knife.image ? (
        <Image
          src={getImageUrl(knife.image)}
          alt=""
          fill
          sizes="48px"
          className="object-contain"
          referrerPolicy="no-referrer"
        />
      ) : (
        <ImageIcon size={14} />
      )}
    </span>
  )
}

function KnifeLink({ knife }: { knife: TimelineKnifeRef }) {
  return (
    <Link href={knifeHref(knife)} className={styles.knifeLink}>
      {formatKnifeName(knife)}
    </Link>
  )
}

function Entry({ entry }: { entry: TimelineEntry }) {
  const { label, icon: Icon } = KIND[entry.type]
  const knife = entry.knife
  const kindLabel =
    entry.type === 'maintenance' && entry.maintenanceType
      ? maintenanceTypeName(entry.maintenanceType)
      : label

  return (
    <li className={styles.entry} data-kind={entry.type}>
      <span className={styles.marker} aria-hidden="true">
        <Icon size={13} strokeWidth={2.2} />
      </span>
      <div className={styles.card}>
        <div className={styles.meta}>
          <time dateTime={entry.occurredAt}>{formatEntryDate(entry)}</time>
          <span>{kindLabel}</span>
        </div>
        {entry.type === 'milestone' ? (
          <>
            <p className={styles.milestoneTitle}>{entry.title}</p>
            {entry.detail && <p className={styles.detail}>{entry.detail}</p>}
            {knife && (
              <Link href={knifeHref(knife)} className={styles.subtleLink}>
                View knife
              </Link>
            )}
          </>
        ) : (
          knife && (
            <div className={styles.knifeRow}>
              {entry.type === 'added' && <Thumb knife={knife} />}
              <div className={styles.knifeText}>
                <p className={styles.knifeLine}>
                  <KnifeLink knife={knife} />
                  {entry.firstOfBrand && (
                    <span className={styles.badge}>New brand</span>
                  )}
                  {entry.type === 'added' && knife.sold && (
                    <span className={styles.badge} data-tone="muted">
                      Sold
                    </span>
                  )}
                </p>
                {entry.detail && (
                  <p className={styles.detail}>{entry.detail}</p>
                )}
              </div>
            </div>
          )
        )}
      </div>
    </li>
  )
}

function MonthSection({ group }: { group: TimelineGroup }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className={styles.month}>
      <h2 id={id} className={styles.monthLabel}>
        {group.label}
        <span>{plural(group.entries.length, 'moment')}</span>
      </h2>
      <ol className={styles.entries}>
        {group.entries.map((entry) => (
          <Entry key={entry.id} entry={entry} />
        ))}
      </ol>
    </section>
  )
}

function RecapStat({ value, label }: { value: number; label: string }) {
  return (
    <div className={styles.recapStat}>
      <dt>{label}</dt>
      <dd>{number.format(value)}</dd>
    </div>
  )
}

function Highlight({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <li>
      <span>{label}</span>
      <p>{children}</p>
    </li>
  )
}

function YearRecapCard({
  recap,
  inProgress,
}: {
  recap: YearRecap
  inProgress: boolean
}) {
  const id = useId()
  const [topCare] = recap.maintenanceByType
  return (
    <section aria-labelledby={id} className={styles.recap}>
      <div className={styles.recapHead}>
        <span className={styles.eyebrow}>Year in review</span>
        <h2 id={id}>
          Your {recap.year}
          {inProgress ? ' so far' : ''}
        </h2>
        <p>
          {recap.knivesAdded > 0
            ? `The collection grew to ${formatKnifeCount(recap.collectionSize, number.format(recap.collectionSize))}.`
            : `No new knives — ${plural(recap.collectionSize, 'knife', 'knives')} looked after instead.`}
        </p>
      </div>
      <dl className={styles.recapStats}>
        <RecapStat
          value={recap.knivesAdded}
          label={recap.knivesAdded === 1 ? 'knife added' : 'knives added'}
        />
        <RecapStat
          value={recap.brandCount}
          label={recap.brandCount === 1 ? 'brand' : 'brands'}
        />
        <RecapStat
          value={recap.totalMaintenance}
          label={
            recap.totalMaintenance === 1 ? 'care session' : 'care sessions'
          }
        />
        <RecapStat
          value={recap.notesWritten}
          label={recap.notesWritten === 1 ? 'note' : 'notes'}
        />
      </dl>
      <ul className={styles.highlights}>
        {recap.mostMaintained && (
          <Highlight label="Most-maintained blade">
            <KnifeLink knife={recap.mostMaintained.knife} /> ·{' '}
            {plural(recap.mostMaintained.count, 'session')}
          </Highlight>
        )}
        {recap.topBrand && recap.knivesAdded > 1 && (
          <Highlight label="Top brand">
            {recap.topBrand.name} · {formatKnifeCount(recap.topBrand.count)}
          </Highlight>
        )}
        {recap.newBrands.length > 0 && (
          <Highlight
            label={recap.newBrands.length === 1 ? 'New brand' : 'New brands'}
          >
            {formatBrandList(recap.newBrands)}
          </Highlight>
        )}
        {recap.firstAddition && (
          <Highlight label="First knife of the year">
            <KnifeLink knife={recap.firstAddition} />
          </Highlight>
        )}
        {topCare && (
          <Highlight label="Most common care">
            {maintenanceTypeName(topCare.type)} ·{' '}
            {plural(topCare.count, 'time')}
          </Highlight>
        )}
        {recap.busiestMonth && (
          <Highlight label="Busiest month">
            {monthName(recap.busiestMonth.month)} ·{' '}
            {plural(recap.busiestMonth.count, 'moment')}
          </Highlight>
        )}
      </ul>
    </section>
  )
}

export function TimelinePage() {
  const { knives, isLoading } = useKnives()
  const [payload, setPayload] = useState<TimelinePayload>()
  const [loadFailed, setLoadFailed] = useState(false)
  const [selectedYear, setSelectedYear] = useState<number | 'all'>('all')
  const [visibleMonths, setVisibleMonths] = useState(MONTH_PAGE)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const response = await fetch('/api/timeline', { cache: 'no-store' })
        const data = await readJsonResponse<TimelinePayload>(response)
        if (cancelled) return
        if (response.ok) setPayload(data)
        else setLoadFailed(true)
      } catch {
        if (!cancelled) setLoadFailed(true)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const maintenanceEvents = useMemo(
    () =>
      Array.isArray(payload?.maintenanceEvents)
        ? payload.maintenanceEvents
        : [],
    [payload],
  )
  const notes = useMemo(
    () => (Array.isArray(payload?.notes) ? payload.notes : []),
    [payload],
  )
  const entries = useMemo(
    () => buildTimelineEntries(knives, maintenanceEvents, notes),
    [knives, maintenanceEvents, notes],
  )
  const years = useMemo(() => listTimelineYears(entries), [entries])
  const year =
    selectedYear !== 'all' && years.includes(selectedYear)
      ? selectedYear
      : 'all'
  const groups = useMemo(
    () => groupTimelineByMonth(filterTimelineByYear(entries, year), 'newest'),
    [entries, year],
  )
  const recap = useMemo(
    () =>
      year === 'all'
        ? undefined
        : buildYearRecap(knives, maintenanceEvents, notes, year),
    [knives, maintenanceEvents, notes, year],
  )
  const firstEntry = entries[0]
  const brandCount = useMemo(
    () =>
      new Set(knives.map((knife) => brandKey(knife.brand)).filter(Boolean))
        .size,
    [knives],
  )
  const shownGroups = groups.slice(0, visibleMonths)
  const hiddenMonths = groups.length - shownGroups.length

  function chooseYear(next: number | 'all') {
    setSelectedYear(next)
    setVisibleMonths(MONTH_PAGE)
  }

  return (
    <div className={styles.root} data-timeline>
      <PageHeader
        title="Timeline"
        description="The story of your collection: every knife added, every sharpening, every note."
      />
      {isLoading || (!payload && !loadFailed) ? (
        <div
          className={styles.loading}
          role="status"
          aria-label="Loading timeline"
        >
          <div />
          <div />
          <div />
          <span className="sr-only">Loading timeline</span>
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          title="Your story starts with the first knife"
          description="Add a knife and its maintenance and notes will build a timeline here."
          action={
            <Link href="/add" className={buttonVariants({ size: 'sm' })}>
              <Plus size={15} /> Add a knife
            </Link>
          }
        />
      ) : (
        <>
          <div className={styles.toolbar}>
            <div className={styles.years} role="group" aria-label="Show a year">
              {(['all', ...years] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={year === option}
                  onClick={() => chooseYear(option)}
                >
                  {option === 'all' ? 'All time' : option}
                </button>
              ))}
            </div>
            {year === 'all' && firstEntry && (
              <p className={styles.summary}>
                Since{' '}
                {new Date(firstEntry.time).toLocaleDateString('en-US', {
                  month: 'long',
                  year: 'numeric',
                })}{' '}
                ·{' '}
                {formatKnifeCount(knives.length, number.format(knives.length))}{' '}
                · {plural(brandCount, 'brand')} ·{' '}
                {plural(maintenanceEvents.length, 'care session')}
              </p>
            )}
          </div>
          {loadFailed && (
            <p className={styles.notice} role="status">
              Maintenance and notes could not be loaded, so only additions are
              shown.
            </p>
          )}
          {recap && (
            <YearRecapCard
              recap={recap}
              inProgress={recap.year === new Date().getFullYear()}
            />
          )}
          <div className={styles.rail}>
            {shownGroups.map((group) => (
              <MonthSection key={group.key} group={group} />
            ))}
          </div>
          {hiddenMonths > 0 && (
            <button
              type="button"
              className={styles.more}
              onClick={() => setVisibleMonths((count) => count + MONTH_PAGE)}
            >
              Show earlier months ({number.format(hiddenMonths)} more)
            </button>
          )}
        </>
      )}
    </div>
  )
}

'use client'

import Image from '@/components/vault-image'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { ImageIcon } from 'lucide-react'
import { useCare } from '@/components/providers/care-provider'
import { useKnives } from '@/components/providers/knives-provider'
import {
  InsightMetrics,
  InsightPanel,
} from '@/components/insight-pages/detail-primitives'
import { careToneDotClass, careToneTextClass } from '@/components/care-badge'
import {
  CareStatusBar,
  CareStatusLegend,
  careFilterHref,
  useCareSummary,
} from '@/components/care-status-summary'
import { getImageUrl, type Knife } from '@/lib/data'
import {
  CARE_FILTER_VALUES,
  CARE_STATUS_LABELS,
  careDueSummary,
  formatTrackDueLine,
  type CareStatusLevel,
  type KnifeCareStatus,
} from '@/lib/maintenance-due'
import { CARE_TRACK_NAMES } from '@/lib/settings-shared'
import { cn } from '@/lib/utils'

const LEVEL_ORDER: Record<CareStatusLevel, number> = {
  overdue: 0,
  'due-soon': 1,
  never: 2,
  ok: 3,
}

function CareKnifeRow({
  knife,
  status,
}: {
  knife: Knife
  status: KnifeCareStatus
}) {
  const tracks = status.tracks
    .map(
      (track) =>
        `${CARE_TRACK_NAMES[track.track]}: ${formatTrackDueLine(track).toLowerCase()}`,
    )
    .join(' · ')
  return (
    <Link
      className="id-knife-row"
      href={`/collection/${encodeURIComponent(knife.id)}`}
      data-care-row={status.level ?? undefined}
    >
      <span className="id-knife-thumb" data-photo-stage>
        {knife.images[0] ? (
          <Image
            src={getImageUrl(knife.images[0])}
            alt=""
            fill
            sizes="64px"
            className="object-contain"
            referrerPolicy="no-referrer"
          />
        ) : (
          <ImageIcon className="size-5 text-muted-foreground" />
        )}
      </span>
      <span className="id-knife-meta">
        <strong>
          {knife.brand ? `${knife.brand} · ` : ''}
          {knife.name}
        </strong>
        <small>{tracks || 'No reminders for this knife'}</small>
      </span>
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 text-right text-[11px] font-medium',
          careToneTextClass(status.level),
        )}
      >
        <span
          aria-hidden="true"
          className={cn('size-2 rounded-full', careToneDotClass(status.level))}
        />
        {careDueSummary(status) ??
          (status.level ? CARE_STATUS_LABELS[status.level] : '—')}
      </span>
    </Link>
  )
}

export function CareDetail() {
  const { knives } = useKnives()
  const { reminders, statusById } = useCare()
  const summary = useCareSummary()
  const [levels, setLevels] = useState<CareStatusLevel[]>([])
  const [query, setQuery] = useState('')

  const rows = useMemo(() => {
    const knivesById = new Map(knives.map((knife) => [knife.id, knife]))
    return [...statusById.values()]
      .flatMap((status) => {
        const knife = knivesById.get(status.knifeId)
        return knife && status.level ? [{ knife, status }] : []
      })
      .sort(
        (left, right) =>
          LEVEL_ORDER[left.status.level!] - LEVEL_ORDER[right.status.level!] ||
          (left.status.worst?.dueInDays ?? Infinity) -
            (right.status.worst?.dueInDays ?? Infinity) ||
          left.knife.name.localeCompare(right.knife.name),
      )
  }, [knives, statusById])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return rows.filter(
      ({ knife, status }) =>
        (levels.length === 0 || levels.includes(status.level!)) &&
        (!needle ||
          `${knife.brand} ${knife.name}`.toLowerCase().includes(needle)),
    )
  }, [rows, levels, query])

  if (!reminders.enabled || !summary) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        Care reminders are off. Turn them on in{' '}
        <Link href="/settings" className="underline underline-offset-2">
          Settings → Maintenance
        </Link>
        .
      </p>
    )
  }

  const { counts, tracked, attention } = summary
  const toggleLevel = (level: CareStatusLevel) =>
    setLevels((current) =>
      current.includes(level)
        ? current.filter((item) => item !== level)
        : [...current, level],
    )

  return (
    <div className="id-care">
      <InsightMetrics
        items={[
          {
            value: counts.overdue,
            label: 'Overdue',
            helper: 'Past their care interval',
          },
          {
            value: counts['due-soon'],
            label: 'Due soon',
            helper: `Within ${reminders.dueSoonDays} days of the deadline`,
          },
          reminders.neverLogged === 'off'
            ? {
                value: counts.ok,
                label: 'Up to date',
                helper: 'Inside every interval',
              }
            : {
                value: counts.never,
                label: 'Missing care',
                helper: 'A kind of care with no entry yet',
              },
        ]}
      />
      <div className="id-grid id-recent-grid">
        <InsightPanel
          title="Needs attention"
          description={
            attention.length
              ? `${attention.length} ${attention.length === 1 ? 'knife' : 'knives'} overdue or due soon`
              : 'Nothing is due right now'
          }
          footer={
            <>
              <span>{tracked} tracked knives</span>
              <Link
                href={careFilterHref('overdue')}
                className="underline-offset-2 hover:underline"
              >
                Open overdue in collection
              </Link>
            </>
          }
        >
          <CareStatusBar counts={counts} tracked={tracked} className="mb-3" />
          <CareStatusLegend counts={counts} />
          <div className="id-scroll mt-3">
            {attention.length ? (
              attention.map(({ knife, status }) => (
                <CareKnifeRow key={knife.id} knife={knife} status={status} />
              ))
            ) : (
              <p className="py-5 text-sm text-muted-foreground">
                Every tracked knife is inside its care interval.
              </p>
            )}
          </div>
        </InsightPanel>
        <InsightPanel
          title="All tracked knives"
          description="Most urgent first · select a knife to log care"
          footer={
            <span aria-live="polite">
              {filtered.length} of {rows.length} knives
            </span>
          }
        >
          <div
            role="group"
            aria-label="Filter by care status"
            className="mb-2 flex flex-wrap gap-1.5"
          >
            {CARE_FILTER_VALUES.map((level) => (
              <button
                key={level}
                type="button"
                aria-pressed={levels.includes(level)}
                onClick={() => toggleLevel(level)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  levels.includes(level) &&
                    'border-foreground/40 bg-muted text-foreground',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn('size-2 rounded-full', careToneDotClass(level))}
                />
                {CARE_STATUS_LABELS[level]}
                <span className="tabular-nums">{counts[level]}</span>
              </button>
            ))}
          </div>
          <input
            className="id-search"
            type="search"
            aria-label="Search tracked knives"
            placeholder="Search maker or model…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="id-scroll">
            {filtered.length ? (
              filtered.map(({ knife, status }) => (
                <CareKnifeRow key={knife.id} knife={knife} status={status} />
              ))
            ) : (
              <p className="py-5 text-sm text-muted-foreground">
                No matching knives.
              </p>
            )}
          </div>
        </InsightPanel>
      </div>
    </div>
  )
}

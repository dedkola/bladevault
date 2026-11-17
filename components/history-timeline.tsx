import Link from 'next/link'
import { useId, type ReactNode } from 'react'
import {
  ChevronRight,
  Flag,
  ImageIcon,
  ImageOff,
  NotebookPen,
  PackagePlus,
  Pencil,
  ShieldCheck,
  Trash2,
  Wrench,
} from 'lucide-react'
import Image from '@/components/vault-image'
import { LogEventDetails } from '@/components/log-event-details'
import {
  getImageUrl,
  maintenanceTypeName,
  type AuditLogEvent,
  type AuditLogEventChange,
  type Knife,
} from '@/lib/data'
import { formatKnifeCount } from '@/lib/knife-count'
import { formatKnifeName, type TimelineEntry } from '@/lib/timeline'
import type { YearRecap } from '@/lib/timeline-stats'
import styles from './history-timeline.module.css'

export type ViewEvent = AuditLogEvent & {
  title: string
  shortDate: string
  time: string
  rowTime: string
  dateKey: string
  dateLabel: string
}

type ItemDate = {
  time: number
  dateKey: string
  dateLabel: string
  shortDate: string
  rowTime: string
}

export type HistoryItem =
  | (ItemDate & { kind: 'event'; key: string; event: ViewEvent })
  | (ItemDate & { kind: 'story'; key: string; entry: TimelineEntry })

export type HistoryDay = {
  dateKey: string
  dateLabel: string
  items: HistoryItem[]
}

type EntryKind =
  | 'created'
  | 'updated'
  | 'maintenance'
  | 'note'
  | 'deleted'
  | 'system'
  | 'added'
  | 'milestone'

const KIND_ICON: Record<EntryKind, typeof Flag> = {
  created: PackagePlus,
  updated: Pencil,
  maintenance: Wrench,
  note: NotebookPen,
  deleted: Trash2,
  system: ShieldCheck,
  added: PackagePlus,
  milestone: Flag,
}

/** Changes shown on the card before "Show details" lists the rest. */
const CHANGE_PREVIEW = 3
const VALUE_PREVIEW = 70
const NEW_BRANDS_SHOWN = 5
const number = new Intl.NumberFormat('en-US')

export function isMaintenanceEvent(event: AuditLogEvent): boolean {
  return (
    event.source === 'Maintenance' ||
    event.source === 'MCP / add_maintenance_event'
  )
}

export function isNoteEvent(event: AuditLogEvent): boolean {
  return event.source === 'Notes'
}

export function eventKind(event: AuditLogEvent): EntryKind {
  if (isNoteEvent(event)) return 'note'
  if (isMaintenanceEvent(event)) return 'maintenance'
  return event.type
}

const KIND_LABEL: Record<EntryKind, string> = {
  created: 'Created',
  updated: 'Updated',
  maintenance: 'Maintenance',
  note: 'Note',
  deleted: 'Deleted',
  system: 'System',
  added: 'Added',
  milestone: 'Milestone',
}

export function eventTitle(event: AuditLogEvent): string {
  if (isNoteEvent(event)) {
    if (event.type === 'deleted') return 'Note deleted'
    if (event.summary === 'A note was updated.') return 'Note updated'
    return 'Note added'
  }
  if (isMaintenanceEvent(event)) {
    if (event.type === 'deleted') return 'Maintenance deleted'
    if (event.summary.endsWith('entry was updated.')) {
      return 'Maintenance updated'
    }
    return 'Maintenance logged'
  }

  switch (event.type) {
    case 'created':
      return 'Knife added'
    case 'updated':
      return 'Metadata updated'
    case 'deleted':
      return 'Knife deleted'
    case 'system':
      return 'System event'
  }
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${number.format(count)} ${count === 1 ? one : many}`
}

function clip(value: string) {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > VALUE_PREVIEW
    ? `${flat.slice(0, VALUE_PREVIEW - 1).trimEnd()}…`
    : flat
}

function isUnset(value: string) {
  return !value.trim() || value === 'Not logged'
}

function ChangePreview({ change }: { change: AuditLogEventChange }) {
  return (
    <li>
      <span className={styles.changeField}>{change.field}</span>
      {isUnset(change.before) ? (
        <span>{isUnset(change.after) ? '—' : clip(change.after)}</span>
      ) : isUnset(change.after) ? (
        <span>
          <s>{clip(change.before)}</s> removed
        </span>
      ) : (
        <span>
          <s>{clip(change.before)}</s>
          <span aria-hidden="true"> → </span>
          <span className="sr-only"> changed to </span>
          {clip(change.after)}
        </span>
      )}
    </li>
  )
}

function Thumb({ knife, gone }: { knife?: Knife; gone?: boolean }) {
  const image = knife?.images[0]
  return (
    <span className={styles.thumb} aria-hidden="true">
      {image ? (
        <Image
          src={getImageUrl(image)}
          alt=""
          fill
          sizes="56px"
          className="object-contain"
          referrerPolicy="no-referrer"
        />
      ) : gone ? (
        <ImageOff size={15} />
      ) : (
        <ImageIcon size={15} />
      )}
    </span>
  )
}

function Marker({ kind }: { kind: EntryKind }) {
  const Icon = KIND_ICON[kind]
  return (
    <span className={styles.marker} aria-hidden="true">
      <Icon size={13} strokeWidth={2.2} />
    </span>
  )
}

function ItemTime({ item }: { item: HistoryItem }) {
  const occurredAt =
    item.kind === 'event' ? item.event.occurredAt : item.entry.occurredAt
  return (
    <time
      dateTime={occurredAt}
      title={`${item.shortDate} · ${item.rowTime}`}
      className={styles.time}
    >
      <span className="sr-only">{item.shortDate} · </span>
      {item.rowTime}
    </time>
  )
}

function EventCard({
  item,
  knife,
  firstOfBrand,
  selected,
  knivesLoading,
  registerButton,
  onToggle,
  onClose,
}: {
  item: Extract<HistoryItem, { kind: 'event' }>
  knife?: Knife
  firstOfBrand: boolean
  selected: boolean
  knivesLoading: boolean
  registerButton: (id: number, node: HTMLButtonElement | null) => void
  onToggle: (id: number) => void
  onClose: () => void
}) {
  const { event } = item
  const kind = eventKind(event)
  const knifeHref = knife ? `/collection/${encodeURIComponent(knife.id)}` : null
  const gone = !knivesLoading && Boolean(event.knifeId) && !knife
  const detailId = `log-detail-${event.id}`
  const previews = event.changes.slice(0, CHANGE_PREVIEW)
  const moreChanges = event.changes.length - previews.length

  return (
    <li className={styles.item} data-kind={kind}>
      <Marker kind={kind} />
      <div className={styles.stack}>
        <article
          data-log-entry
          data-event-type={event.type}
          data-event-title={event.title}
          data-maintenance={isMaintenanceEvent(event) || undefined}
          data-state={selected ? 'selected' : undefined}
          className={styles.card}
          onClick={(click) => {
            if ((click.target as HTMLElement).closest('a, button')) return
            onToggle(event.id)
          }}
        >
          <div className={styles.cardBody}>
            <div className={styles.meta}>
              <ItemTime item={item} />
              <span className={styles.kindLabel} data-log-kind-label>
                {KIND_LABEL[kind]}
              </span>
              {event.source.toLowerCase() !==
                KIND_LABEL[kind].toLowerCase() && <span>{event.source}</span>}
            </div>
            <div className={styles.knifeRow}>
              {event.knifeId && <Thumb knife={knife} gone={gone} />}
              <div className={styles.knifeText}>
                <p className={styles.knifeLine}>
                  {knifeHref ? (
                    <Link href={knifeHref} className={styles.knifeLink}>
                      {event.subject}
                    </Link>
                  ) : (
                    <span className={styles.subject}>{event.subject}</span>
                  )}
                  {event.type === 'created' && firstOfBrand && (
                    <span className={styles.badge}>New brand</span>
                  )}
                  {knife?.sold && (
                    <span className={styles.badge} data-tone="muted">
                      Sold
                    </span>
                  )}
                  {gone && (
                    <span className={styles.badge} data-tone="muted">
                      No longer in the collection
                    </span>
                  )}
                </p>
                <p className={styles.summary}>
                  <b>{event.title}</b>
                  <span aria-hidden="true"> · </span>
                  <span data-log-summary>{event.summary}</span>
                </p>
              </div>
            </div>
            {previews.length > 0 && (
              <ul className={styles.changes} aria-label="Changes">
                {previews.map((change, index) => (
                  <ChangePreview
                    key={`${change.field}-${index}`}
                    change={change}
                  />
                ))}
                {moreChanges > 0 && (
                  <li className={styles.moreChanges}>
                    +{plural(moreChanges, 'more change')}
                  </li>
                )}
              </ul>
            )}
          </div>
          <button
            type="button"
            ref={(node) => registerButton(event.id, node)}
            onClick={() => onToggle(event.id)}
            aria-expanded={selected}
            aria-controls={selected ? detailId : undefined}
            aria-label={`${selected ? 'Collapse' : 'Expand'} ${event.title} details for ${event.subject}`}
            className={styles.expand}
          >
            <ChevronRight size={15} />
          </button>
        </article>
        {selected && (
          <section
            id={detailId}
            data-log-detail-row
            className={styles.details}
            aria-label={`Event details for ${event.subject}`}
          >
            <LogEventDetails
              compact
              event={event}
              title={event.title}
              time={event.time}
              knifeHref={knifeHref}
              knifeUnavailable={gone}
              onClose={onClose}
            />
          </section>
        )}
      </div>
    </li>
  )
}

function StoryCard({
  item,
  knife,
}: {
  item: Extract<HistoryItem, { kind: 'story' }>
  knife?: Knife
}) {
  const { entry } = item
  const kind: EntryKind = entry.type === 'milestone' ? 'milestone' : 'added'
  const ref = entry.knife
  const href = ref ? `/collection/${encodeURIComponent(ref.id)}` : null

  return (
    <li className={styles.item} data-kind={kind} data-story-entry={kind}>
      <Marker kind={kind} />
      <div className={styles.stack}>
        <article className={styles.card}>
          <div className={styles.cardBody}>
            <div className={styles.meta}>
              <ItemTime item={item} />
              <span className={styles.kindLabel}>{KIND_LABEL[kind]}</span>
              {kind === 'added' && <span>Collection record</span>}
            </div>
            {kind === 'milestone' ? (
              <div className={styles.knifeRow}>
                {ref && <Thumb knife={knife} />}
                <div className={styles.knifeText}>
                  <p className={styles.milestoneTitle}>{entry.title}</p>
                  {entry.detail && (
                    <p className={styles.summary}>{entry.detail}</p>
                  )}
                  {href && (
                    <Link href={href} className={styles.subtleLink}>
                      View knife
                    </Link>
                  )}
                </div>
              </div>
            ) : (
              ref && (
                <div className={styles.knifeRow}>
                  <Thumb knife={knife} />
                  <div className={styles.knifeText}>
                    <p className={styles.knifeLine}>
                      {href && (
                        <Link href={href} className={styles.knifeLink}>
                          {formatKnifeName(ref)}
                        </Link>
                      )}
                      {entry.firstOfBrand && (
                        <span className={styles.badge}>New brand</span>
                      )}
                      {ref.sold && (
                        <span className={styles.badge} data-tone="muted">
                          Sold
                        </span>
                      )}
                    </p>
                    <p className={styles.summary}>
                      <b>Added to the collection</b>
                      <span aria-hidden="true"> · </span>
                      Dated from the knife record; History started recording
                      later, so there are no change details.
                    </p>
                  </div>
                </div>
              )
            )}
          </div>
        </article>
      </div>
    </li>
  )
}

export function HistoryRail({
  days,
  knivesById,
  firstOfBrand,
  selectedId,
  knivesLoading,
  registerButton,
  onToggle,
  onClose,
}: {
  days: HistoryDay[]
  knivesById: Map<string, Knife>
  firstOfBrand: Set<string>
  selectedId: number | null
  knivesLoading: boolean
  registerButton: (id: number, node: HTMLButtonElement | null) => void
  onToggle: (id: number) => void
  onClose: () => void
}) {
  return (
    <div className={styles.rail} data-history-rail>
      {days.map((day) => (
        <DaySection key={day.dateKey} day={day}>
          {day.items.map((item) =>
            item.kind === 'event' ? (
              <EventCard
                key={item.key}
                item={item}
                knife={
                  item.event.knifeId
                    ? knivesById.get(item.event.knifeId)
                    : undefined
                }
                firstOfBrand={
                  !!item.event.knifeId && firstOfBrand.has(item.event.knifeId)
                }
                selected={selectedId === item.event.id}
                knivesLoading={knivesLoading}
                registerButton={registerButton}
                onToggle={onToggle}
                onClose={onClose}
              />
            ) : (
              <StoryCard
                key={item.key}
                item={item}
                knife={
                  item.entry.knife
                    ? knivesById.get(item.entry.knife.id)
                    : undefined
                }
              />
            ),
          )}
        </DaySection>
      ))}
    </div>
  )
}

function DaySection({
  day,
  children,
}: {
  day: HistoryDay
  children: ReactNode
}) {
  const id = useId()
  return (
    <section aria-labelledby={id} className={styles.day}>
      <h2 id={id} className={styles.dayLabel} data-history-day>
        {day.dateLabel}
        <span>{plural(day.items.length, 'entry', 'entries')}</span>
      </h2>
      <ol className={styles.entries}>{children}</ol>
    </section>
  )
}

export function HistoryYears({
  years,
  activeYear,
  showingAll,
  disabled,
  onChoose,
}: {
  years: number[]
  activeYear: number | null
  showingAll: boolean
  disabled: boolean
  onChoose: (year: number | 'all') => void
}) {
  if (years.length === 0) return null
  return (
    <div className={styles.years} role="group" aria-label="Show a year">
      <button
        type="button"
        aria-pressed={showingAll}
        disabled={disabled}
        onClick={() => onChoose('all')}
      >
        All time
      </button>
      {years.map((year) => (
        <button
          key={year}
          type="button"
          aria-pressed={activeYear === year}
          disabled={disabled}
          onClick={() => onChoose(year)}
        >
          {year}
        </button>
      ))}
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

function RecapKnife({ id, name }: { id: string; name: string }) {
  return (
    <Link
      href={`/collection/${encodeURIComponent(id)}`}
      className={styles.knifeLink}
    >
      {name}
    </Link>
  )
}

function monthName(month: number) {
  return new Date(2000, month, 1).toLocaleDateString('en-US', {
    month: 'long',
  })
}

export function YearRecapCard({ recap }: { recap: YearRecap }) {
  const id = useId()
  const inProgress = recap.year === new Date().getFullYear()
  const [topCare] = recap.maintenanceByType
  const brands =
    recap.newBrands.length <= NEW_BRANDS_SHOWN
      ? recap.newBrands.join(', ')
      : `${recap.newBrands.slice(0, NEW_BRANDS_SHOWN).join(', ')} and ${number.format(recap.newBrands.length - NEW_BRANDS_SHOWN)} more`
  const stats = [
    [recap.knivesAdded, 'knife added', 'knives added'],
    [recap.brandCount, 'brand', 'brands'],
    [recap.totalMaintenance, 'care session', 'care sessions'],
    [recap.notesWritten, 'note', 'notes'],
  ] as const

  return (
    <section aria-labelledby={id} className={styles.recap} data-history-recap>
      <span className={styles.eyebrow}>Year in review</span>
      <h2 id={id}>
        Your {recap.year}
        {inProgress ? ' so far' : ''}
      </h2>
      <p className={styles.recapLead}>
        {recap.knivesAdded > 0
          ? `The collection grew to ${formatKnifeCount(recap.collectionSize, number.format(recap.collectionSize))}.`
          : `No new knives — ${plural(recap.collectionSize, 'knife', 'knives')} looked after instead.`}
      </p>
      <dl className={styles.recapStats}>
        {stats.map(([value, one, many]) => (
          <div key={many}>
            <dt>{value === 1 ? one : many}</dt>
            <dd>{number.format(value)}</dd>
          </div>
        ))}
      </dl>
      <ul className={styles.highlights}>
        {recap.mostMaintained && (
          <Highlight label="Most-maintained blade">
            <RecapKnife
              id={recap.mostMaintained.knife.id}
              name={formatKnifeName(recap.mostMaintained.knife)}
            />{' '}
            · {plural(recap.mostMaintained.count, 'session')}
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
            {brands}
          </Highlight>
        )}
        {recap.firstAddition && (
          <Highlight label="First knife of the year">
            <RecapKnife
              id={recap.firstAddition.id}
              name={formatKnifeName(recap.firstAddition)}
            />
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

export function HistoryShowMore({
  hiddenDays,
  onShowMore,
}: {
  hiddenDays: number
  onShowMore: () => void
}) {
  if (hiddenDays <= 0) return null
  return (
    <button type="button" className={styles.more} onClick={onShowMore}>
      Show earlier days ({number.format(hiddenDays)} more)
    </button>
  )
}

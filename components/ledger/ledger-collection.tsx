'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, ExternalLink, Star } from 'lucide-react'
import { useKnives } from '@/components/providers/knives-provider'
import { KnifePhoto } from '@/components/lumen/knife-photo'
import { OPEN_GLOBAL_SEARCH_EVENT } from '@/components/global-knife-search'
import { CollectionChipFilter } from '@/components/collection-chip-filter'
import { buildChipFilterFields } from '@/lib/chip-filter-fields'
import { isEditableTarget } from '@/components/ledger/ledger-shell'
import {
  useLumenCollection,
  useLumenKnifeActions,
} from '@/components/lumen/use-lumen-collection'
import { useKnifeDetail } from '@/components/lumen/use-knife-detail'
import { useLocalPreference } from '@/components/lumen/use-local-preference'
import type { AuditLogEvent, Knife } from '@/lib/data'
import {
  parseLengthToInches,
  parseWeightToOunces,
} from '@/lib/measurement-parser'
import { formatDimension, formatWeight } from '@/lib/measurements'
import type {
  CardField,
  CollectionDisplay,
  CustomField,
  DimensionUnit,
} from '@/lib/settings-shared'
import { getCardFieldDisplayValue, getCardFieldLabel } from '@/lib/card-fields'
import { useCare } from '@/components/providers/care-provider'
import { careToneTextClass } from '@/components/care-badge'
import {
  CARE_KIND_PARAM,
  careDueSummary,
  careKindChip,
} from '@/lib/maintenance-due'
import {
  countFacet,
  formatMoney,
  formatShortDate,
  parsePrice,
  summarizeCollectionValue,
} from '@/lib/lumen-collection'

const GROUPS = ['brand', 'style', 'lock'] as const
type GroupBy = (typeof GROUPS)[number]
const GROUP_LABELS: Record<GroupBy, string> = {
  brand: 'Brand',
  style: 'Blade style',
  lock: 'Lock',
}
const GROUP_VALUE: Record<GroupBy, (knife: Knife) => string> = {
  brand: (knife) => knife.brand,
  style: (knife) => knife.bladeStyle,
  lock: (knife) => knife.specs.lockingMechanism ?? '',
}
const SORT_LABELS: Record<CollectionDisplay['sort'], string> = {
  newest: 'Sorted by newest',
  model: 'Sorted by name',
  brand: 'Sorted by brand',
}
const NEXT_SORT: Record<CollectionDisplay['sort'], CollectionDisplay['sort']> =
  { newest: 'model', model: 'brand', brand: 'newest' }

/** Shorter column heads for the card fields, so they fit narrow columns. */
const SHORT_LABELS: Partial<Record<CardField, string>> = {
  care: 'Care',
  'specs.modelNumber': 'Model',
  'specs.bladeMaterial': 'Steel',
  'specs.bladeCoating': 'Finish',
  bladeStyle: 'Style',
  handleMaterial: 'Handle',
  'specs.lockingMechanism': 'Lock',
  'specs.overallLength': 'Overall',
  'specs.bladeLength': 'Blade',
  'specs.bladeThickness': 'Thick.',
  'specs.handleLength': 'Handle len.',
}
/** Figures: right-aligned mono columns. */
const NUMERIC_FIELDS = new Set<CardField>([
  'specs.price',
  'specs.hardness',
  'specs.overallLength',
  'specs.bladeLength',
  'specs.bladeThickness',
  'specs.handleLength',
  'specs.weight',
])
const COLUMN_WIDTH = { numeric: 84, text: 112 }
/** Width a column needs to stay readable, including its 14px gap. */
const COLUMN_FIT = { numeric: 86, text: 106 }
/** Row padding, border, thumbnail and gap, plus the narrowest name column. */
const ROW_CHROME = 83 + 110

type LedgerColumn = { key: CardField; label: string; numeric: boolean }

/**
 * The card fields chosen in Settings, as list columns. The list pane asks for
 * room for all of them; as many as fit its measured width are shown, in the
 * order chosen, so the name column never collapses.
 */
function useLedgerColumns(
  cardFields: CardField[],
  customFields: CustomField[],
  paneWidth: number | null,
) {
  return useMemo(() => {
    const columns: LedgerColumn[] = cardFields.map((key) => ({
      key,
      label: SHORT_LABELS[key] ?? getCardFieldLabel(key, customFields),
      numeric: NUMERIC_FIELDS.has(key),
    }))
    const visible: LedgerColumn[] = []
    let room = paneWidth === null ? Infinity : paneWidth - ROW_CHROME
    for (const column of columns) {
      room -= column.numeric ? COLUMN_FIT.numeric : COLUMN_FIT.text
      if (room < 0) break
      visible.push(column)
    }
    const fieldsWidth = columns.reduce(
      (sum, column) =>
        sum + 14 + (column.numeric ? COLUMN_WIDTH.numeric : COLUMN_WIDTH.text),
      0,
    )
    const style = {
      '--ledger-field-cols': visible
        .map((column) =>
          column.numeric
            ? `minmax(52px, ${COLUMN_WIDTH.numeric}px)`
            : `minmax(64px, ${COLUMN_WIDTH.text}px)`,
        )
        .join(' '),
      // Thumbnail, a name column of about 190px, padding and the fields.
      '--ledger-list-width': `${283 + fieldsWidth}px`,
    } as React.CSSProperties
    return { columns: visible, style }
  }, [cardFields, customFields, paneWidth])
}

/** A field value that fits its column, with the full text for a tooltip. */
function formatCell(
  knife: Knife,
  field: CardField,
  customFields: CustomField[],
  dimensionUnit: DimensionUnit,
) {
  const full = getCardFieldDisplayValue(
    knife,
    field,
    customFields,
    dimensionUnit,
  ).trim()
  if (!full) return { text: '—', title: undefined }
  if (field === 'specs.price') {
    const text = formatPrice(full)
    return { text, title: text === full ? undefined : full }
  }
  // "76 mm / 3 in" doesn't fit a column, so show millimetres there.
  if (dimensionUnit === 'both' && NUMERIC_FIELDS.has(field)) {
    const text = getCardFieldDisplayValue(knife, field, customFields, 'mm')
    return { text, title: full }
  }
  return { text: full, title: full }
}

/** A price that fits a narrow column: "$69.99" for "69.99 USD". */
function formatPrice(text: string) {
  const price = parsePrice(text)
  if (!price?.currency) return text
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: price.currency,
      maximumFractionDigits: Number.isInteger(price.amount) ? 0 : 2,
    }).format(price.amount)
  } catch {
    return text
  }
}

/**
 * The vault's audit log, loaded once and again only when a knife changes,
 * so stepping through the list doesn't refetch it for every entry.
 */
function useAuditLog(version: string) {
  const [events, setEvents] = useState<AuditLogEvent[] | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/logs', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('History unavailable')
        const data = (await response.json()) as { events?: AuditLogEvent[] }
        setEvents(data.events ?? [])
      })
      .catch(() => {
        if (!controller.signal.aborted) setEvents([])
      })
    return () => controller.abort()
  }, [version])
  return events
}

export function LedgerCollection() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { dimensionUnit, cardFields, customFieldDefinitions } = useKnives()
  const { reminders, statusById: careStatusById } = useCare()
  const [paneWidth, setPaneWidth] = useState<number | null>(null)
  const columnFields = useMemo(
    () =>
      reminders.enabled
        ? cardFields
        : cardFields.filter((field) => field !== 'care'),
    [cardFields, reminders.enabled],
  )
  const ledgerColumns = useLedgerColumns(
    columnFields,
    customFieldDefinitions,
    paneWidth,
  )
  const collection = useLumenCollection()
  const actions = useLumenKnifeActions()
  const { knives, filtered, isLoading, getValues, toggleSingle } = collection
  const [groupBy, setGroupBy] = useLocalPreference(
    'bladevault-ledger-group',
    GROUPS,
    'brand',
  )
  const [chosenId, setChosenId] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLElement>(null)

  // Fit the field columns to the list pane's width.
  useEffect(() => {
    const pane = paneRef.current
    if (!pane) return
    const observer = new ResizeObserver(([entry]) =>
      setPaneWidth(Math.round(entry.contentRect.width)),
    )
    observer.observe(pane)
    return () => observer.disconnect()
  }, [])
  // The newest change anywhere in the vault; the log reloads when it moves.
  const logVersion = useMemo(
    () =>
      knives.reduce(
        (latest, knife) =>
          knife.updatedAt > latest ? knife.updatedAt : latest,
        String(knives.length),
      ),
    [knives],
  )
  const auditLog = useAuditLog(logVersion)

  const groups = useMemo(() => {
    const map = new Map<string, Knife[]>()
    for (const knife of filtered) {
      const key = GROUP_VALUE[groupBy](knife).trim() || 'Not set'
      map.set(key, [...(map.get(key) ?? []), knife])
    }
    return [...map].sort(([a], [b]) =>
      a === 'Not set' ? 1 : b === 'Not set' ? -1 : a.localeCompare(b),
    )
  }, [filtered, groupBy])
  // Keyboard order follows the grouped list, not the sort order.
  const ordered = useMemo(() => groups.flatMap(([, items]) => items), [groups])
  // The detail pane falls back to the first knife, but the list marks a row
  // only once the user picks it, so a fresh page shows no selected entry.
  const current =
    ordered.find((knife) => knife.id === chosenId) ?? ordered[0] ?? null

  const handles = useMemo(
    () => countFacet(knives, (knife) => knife.handleMaterial).slice(0, 2),
    [knives],
  )
  const status = getValues('status')[0] ?? null
  const handle = getValues('handleMaterial')[0] ?? null
  const tokens = [
    {
      label: 'Pinned',
      on: getValues('view')[0] === 'pinned',
      toggle: () => toggleSingle('view', 'pinned'),
    },
    {
      label: 'Owned',
      on: status === 'owned',
      toggle: () => toggleSingle('status', 'owned'),
    },
    {
      label: 'Sold',
      on: status === 'sold',
      toggle: () => toggleSingle('status', 'sold'),
    },
    ...handles.map((item) => ({
      label: item.value,
      on: handle === item.value,
      toggle: () => toggleSingle('handleMaterial', item.value),
    })),
  ]
  if (handle && !handles.some((item) => item.value === handle)) {
    tokens.push({
      label: handle,
      on: true,
      toggle: () => toggleSingle('handleMaterial', handle),
    })
  }
  // The chip bar searches text and picks field values, as on Lumen. Pinned,
  // owned, sold and handle stay on the quick-filter tokens below it.
  const chipFields = useMemo(
    () =>
      buildChipFilterFields(
        knives,
        customFieldDefinitions,
        reminders.enabled ? careStatusById : undefined,
      ),
    [knives, customFieldDefinitions, reminders.enabled, careStatusById],
  )
  const knifeType = getValues('knifeType')[0]
  const careKind = reminders.enabled
    ? careKindChip(getValues(CARE_KIND_PARAM)[0])
    : null
  const extraChips = [
    ...(knifeType === 'fixed' || knifeType === 'folding'
      ? [
          {
            key: 'knifeType',
            label: knifeType === 'fixed' ? 'Fixed blades' : 'Folding knives',
          },
        ]
      : []),
    ...(getValues('missingSpecs')[0] === '1'
      ? [{ key: 'missingSpecs', label: 'Missing specifications' }]
      : []),
    ...(careKind ? [careKind] : []),
  ]
  // Start from the live URL so quick picks and typed text never overwrite
  // each other, and skip a router round trip per keystroke.
  const applyChipFilter = (update: (params: URLSearchParams) => void) => {
    const next = new URLSearchParams(window.location.search)
    update(next)
    next.delete('smart')
    const query = next.toString()
    window.history.replaceState(
      null,
      '',
      query ? `${pathname}?${query}` : pathname,
    )
  }
  const filteredValue = summarizeCollectionValue(
    filtered.filter((knife) => !knife.sold),
  )

  const focusRow = (id: string, focus: boolean) =>
    requestAnimationFrame(() => {
      const row = listRef.current?.querySelector<HTMLElement>(
        `[data-ledger-row="${CSS.escape(id)}"]`,
      )
      row?.scrollIntoView({ block: 'nearest' })
      if (focus) row?.focus()
    })

  const select = (id: string, focus = false) => {
    setChosenId(id)
    setDetailOpen(true)
    focusRow(id, focus)
  }

  const focusFilter = () => {
    searchRef.current?.focus()
    searchRef.current?.select()
  }

  // The footer's Search button and ⌘K filter the list on this page.
  useEffect(() => {
    const focus = () => {
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    window.addEventListener(OPEN_GLOBAL_SEARCH_EVENT, focus)
    return () => window.removeEventListener(OPEN_GLOBAL_SEARCH_EVENT, focus)
  }, [])

  // Keep the keyboard handler current without re-binding on every render.
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {})
  useEffect(() => {
    keyHandler.current = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        focusFilter()
        return
      }
      if (event.metaKey || event.ctrlKey) return
      if (event.key === '/' && !isEditableTarget(event.target)) {
        event.preventDefault()
        focusFilter()
        return
      }
      if (isEditableTarget(event.target) || !current) return
      const index = ordered.indexOf(current)
      const key = event.key.toLowerCase()
      // Arrow keys step through the list only from the list itself, so they
      // still scroll the document pane when it has focus.
      const inDetail =
        event.target instanceof Element &&
        Boolean(event.target.closest('[data-ledger-detail]'))
      const arrow = event.key === 'ArrowDown' || event.key === 'ArrowUp'
      if (arrow && inDetail) return
      if (key === 'j' || event.key === 'ArrowDown') {
        // Nothing marked yet: the first step lands on the first entry.
        const next = chosenId === current.id ? ordered[index + 1] : current
        if (next) {
          event.preventDefault()
          select(next.id, true)
        }
      } else if (key === 'k' || event.key === 'ArrowUp') {
        const previous = ordered[index - 1]
        if (previous) {
          event.preventDefault()
          select(previous.id, true)
        }
      } else if (key === 'e') {
        event.preventDefault()
        router.push(`/collection/${encodeURIComponent(current.id)}?edit=1`)
      } else if (key === 'p') {
        event.preventDefault()
        void actions.togglePin(current)
      } else if (key === 'c') {
        event.preventDefault()
        if (!actions.compareUnavailable) void actions.compare([current.id])
      }
    }
  })
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandler.current(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  return (
    <div
      data-ledger-split
      data-detail-open={detailOpen || undefined}
      style={ledgerColumns.style}
    >
      <h1 className="sr-only">Collection</h1>
      <section data-ledger-listpane aria-label="Knives" ref={paneRef}>
        <div data-ledger-toolbar>
          <CollectionChipFilter
            fields={chipFields}
            params={new URLSearchParams(searchParams.toString())}
            apply={applyChipFilter}
            extraChips={extraChips}
            lengthUnit={dimensionUnit}
            onClearAll={collection.clearFilters}
            summary={
              filtered.length !== knives.length
                ? `${filtered.length} of ${knives.length}`
                : undefined
            }
            inputRef={searchRef}
          />
          <button
            type="button"
            data-ledger-button
            onClick={() =>
              setGroupBy(GROUPS[(GROUPS.indexOf(groupBy) + 1) % GROUPS.length])
            }
            title="Change grouping"
          >
            Group: {GROUP_LABELS[groupBy]}
          </button>
        </div>
        <div data-ledger-tokens role="group" aria-label="Quick filters">
          {tokens.map((token) => (
            <button
              key={token.label}
              type="button"
              aria-pressed={token.on}
              onClick={token.toggle}
            >
              {token.on ? '✓ ' : '+ '}
              {token.label}
            </button>
          ))}
          {collection.hasFilters && (
            <button
              type="button"
              data-ledger-token-clear
              onClick={collection.clearFilters}
            >
              Clear
            </button>
          )}
        </div>
        {/* Columns follow Settings > Card fields. */}
        <div data-ledger-colhead aria-hidden="true">
          <span>Name</span>
          {ledgerColumns.columns.map((column) => (
            <span
              key={column.key}
              title={column.label}
              data-numeric={column.numeric || undefined}
            >
              {column.label}
            </span>
          ))}
        </div>
        <div data-ledger-rows ref={listRef}>
          {isLoading ? (
            <p data-ledger-empty>Loading collection…</p>
          ) : knives.length === 0 ? (
            <div data-ledger-empty>
              <p>Your vault is empty.</p>
              <Link href="/add" data-ledger-button="primary">
                Add your first knife
              </Link>
            </div>
          ) : ordered.length === 0 ? (
            <div data-ledger-empty>
              <p>No knives match.</p>
              <button
                type="button"
                data-ledger-button
                onClick={collection.clearFilters}
              >
                Clear filters
              </button>
            </div>
          ) : (
            groups.map(([group, items]) => (
              <section key={group} aria-label={group}>
                <h2 data-ledger-group>
                  <span>{group}</span>
                  <span>{items.length}</span>
                </h2>
                <ul>
                  {items.map((knife) => (
                    <li key={knife.id}>
                      <LedgerRow
                        knife={knife}
                        groupBy={groupBy}
                        columns={ledgerColumns.columns}
                        customFields={customFieldDefinitions}
                        selected={knife.id === chosenId}
                        dimensionUnit={dimensionUnit}
                        onSelect={() => select(knife.id)}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
        <footer data-ledger-listfoot>
          <span>
            {ordered.length} of {knives.length} knives
            {filteredValue && (
              <>
                {' · '}
                <b>
                  {formatMoney(filteredValue.total, filteredValue.currency)}
                </b>
              </>
            )}
          </span>
          <button
            type="button"
            onClick={() => collection.setSort(NEXT_SORT[collection.sort])}
            title="Change sort order"
          >
            {SORT_LABELS[collection.sort]}
          </button>
        </footer>
      </section>
      <section data-ledger-detail aria-label="Knife details">
        {current ? (
          <LedgerDocument
            summary={current}
            knives={knives}
            auditLog={auditLog}
            actions={actions}
            onBack={() => {
              setDetailOpen(false)
              focusRow(current.id, true)
            }}
          />
        ) : (
          !isLoading && (
            <p data-ledger-empty>Select a knife to see its details.</p>
          )
        )}
        <footer data-ledger-hints aria-hidden="true">
          <span>
            <kbd>J</kbd> <kbd>K</kbd> move
          </span>
          <span>
            <kbd>/</kbd> filter
          </span>
          <span>
            <kbd>E</kbd> edit
          </span>
          <span>
            <kbd>P</kbd> pin
          </span>
          <span>
            <kbd>C</kbd> compare
          </span>
          <span>
            <kbd>N</kbd> new
          </span>
        </footer>
      </section>
    </div>
  )
}

function LedgerRow({
  knife,
  groupBy,
  columns,
  customFields,
  selected,
  dimensionUnit,
  onSelect,
}: {
  knife: Knife
  groupBy: GroupBy
  columns: LedgerColumn[]
  customFields: CustomField[]
  selected: boolean
  dimensionUnit: DimensionUnit
  onSelect: () => void
}) {
  const { statusById: careStatusById } = useCare()
  // The line under the name skips what the group or a column already shows.
  const shown = new Set<CardField>(columns.map((column) => column.key))
  if (groupBy === 'style') shown.add('bladeStyle')
  if (groupBy === 'lock') shown.add('specs.lockingMechanism')
  const detail = [
    groupBy !== 'brand' && knife.brand,
    !shown.has('bladeStyle') && knife.bladeStyle,
    !shown.has('specs.bladeLength') &&
      knife.specs.bladeLength &&
      formatDimension(knife.specs.bladeLength, dimensionUnit),
    !shown.has('specs.lockingMechanism') && knife.specs.lockingMechanism,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <button
      type="button"
      data-ledger-row={knife.id}
      data-sold={knife.sold || undefined}
      aria-current={selected || undefined}
      onClick={onSelect}
    >
      <span data-ledger-thumb>
        <KnifePhoto knife={knife} sizes="48px" />
      </span>
      <span data-ledger-row-text>
        <b>
          {knife.name}
          {knife.pinned && <i data-ledger-pin title="Pinned" />}
          {knife.sold && <span className="sr-only"> (sold)</span>}
        </b>
        {detail && <small>{detail}</small>}
      </span>
      {columns.map((column) => {
        if (column.key === 'care') {
          const status = careStatusById.get(knife.id)
          const text = (status && careDueSummary(status)) || '—'
          return (
            <span
              key={column.key}
              data-ledger-cell
              data-empty={text === '—' || undefined}
              title={text === '—' ? undefined : text}
              className={status ? careToneTextClass(status.level) : undefined}
            >
              {text}
            </span>
          )
        }
        const cell = formatCell(knife, column.key, customFields, dimensionUnit)
        return (
          <span
            key={column.key}
            data-ledger-cell
            data-numeric={column.numeric || undefined}
            data-empty={cell.text === '—' || undefined}
            title={cell.title}
          >
            {cell.text}
          </span>
        )
      })}
    </button>
  )
}

/** The six most recent audit-log entries for one knife. */
function knifeHistory(events: AuditLogEvent[] | null, knifeId: string) {
  return {
    loading: events === null,
    events: (events ?? [])
      .filter((event) => event.knifeId === knifeId)
      .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
      .slice(0, 6),
  }
}

function fieldLabel(field: string) {
  const name = field.replace(/^(specs|customFields)\./, '')
  const spaced = name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function LedgerDocument({
  summary,
  knives,
  auditLog,
  actions,
  onBack,
}: {
  summary: Knife
  knives: Knife[]
  auditLog: AuditLogEvent[] | null
  actions: ReturnType<typeof useLumenKnifeActions>
  onBack: () => void
}) {
  const { dimensionUnit } = useKnives()
  const knife = useKnifeDetail(summary) ?? summary
  const [photo, setPhoto] = useState<{ id: string; index: number } | null>(null)
  const photoIndex = photo?.id === knife.id ? photo.index : 0
  const history = knifeHistory(auditLog, knife.id)
  const sideImages = knife.images
    .map((path, index) => ({ path, index }))
    .filter(({ index }) => index !== photoIndex)
  const extraCount = Math.max(0, sideImages.length - 3)

  const bars = useMemo(() => {
    const measure = (value: (item: Knife) => number | undefined) => {
      const values = knives
        .map(value)
        .filter((item): item is number => item !== undefined && item > 0)
      return { max: Math.max(0, ...values), values }
    }
    const weight = measure((item) =>
      item.specs.weight ? parseWeightToOunces(item.specs.weight) : undefined,
    )
    const blade = measure((item) =>
      item.specs.bladeLength
        ? parseLengthToInches(item.specs.bladeLength)
        : undefined,
    )
    const price = parsePrice(knife.specs.price)
    const prices = measure((item) => {
      const parsed = parsePrice(item.specs.price)
      return parsed && price && parsed.currency === price.currency
        ? parsed.amount
        : undefined
    })
    const average = prices.values.length
      ? prices.values.reduce((sum, value) => sum + value, 0) /
        prices.values.length
      : null
    return {
      weight: {
        max: weight.max,
        value: knife.specs.weight
          ? parseWeightToOunces(knife.specs.weight)
          : undefined,
      },
      blade: {
        max: blade.max,
        value: knife.specs.bladeLength
          ? parseLengthToInches(knife.specs.bladeLength)
          : undefined,
      },
      price: { max: prices.max, value: price?.amount },
      average:
        average !== null && price?.currency
          ? formatMoney(average, price.currency)
          : null,
    }
  }, [knives, knife.specs])

  const specs: [string, string | undefined][] = [
    ['Blade steel', knife.specs.bladeMaterial],
    ['Blade length', formatDimension(knife.specs.bladeLength, dimensionUnit)],
    [
      'Overall length',
      formatDimension(knife.specs.overallLength, dimensionUnit),
    ],
    ['Weight', formatWeight(knife.specs.weight, dimensionUnit)],
    ['Handle', knife.handleMaterial],
    ['Lock', knife.specs.lockingMechanism],
    ['Price', knife.specs.price],
    ['Country', knife.specs.country],
    ['Model number', knife.specs.modelNumber],
    ['Designer', knife.specs.designer],
    ['Hardness', knife.specs.hardness],
    ['Coating', knife.specs.bladeCoating],
  ]
  const shownSpecs = specs.filter(
    ([, value], index) => index < 8 || value?.trim(),
  )
  const pinBusy = actions.busy === `pin:${knife.id}`
  // Entries are numbered in the order they were added, like a ledger book.
  const entryNumber = useMemo(() => {
    const order = [...knives].sort((a, b) =>
      a.addedAt === b.addedAt
        ? a.id.localeCompare(b.id)
        : a.addedAt.localeCompare(b.addedAt),
    )
    const index = order.findIndex((item) => item.id === knife.id)
    return index < 0 ? null : String(index + 1).padStart(3, '0')
  }, [knives, knife.id])

  return (
    <>
      <div data-ledger-dhead>
        <button
          type="button"
          data-ledger-button
          data-ledger-back
          onClick={onBack}
        >
          <ArrowLeft aria-hidden="true" /> List
        </button>
        <span data-ledger-crumb>
          {knife.brand && <>{knife.brand} / </>}
          <b>{knife.name}</b>
        </span>
        <div data-ledger-dhead-actions>
          <button
            type="button"
            data-ledger-button
            aria-pressed={knife.pinned}
            disabled={pinBusy}
            onClick={() => void actions.togglePin(knife)}
          >
            <Star aria-hidden="true" data-filled={knife.pinned || undefined} />
            {knife.pinned ? 'Pinned' : 'Pin'}
          </button>
          <button
            type="button"
            data-ledger-button
            aria-pressed={actions.isInCompare(knife.id)}
            disabled={actions.compareUnavailable}
            onClick={() => void actions.compare([knife.id])}
          >
            {actions.isInCompare(knife.id) ? 'In comparison' : 'Compare'}
          </button>
          {knife.sourceUrl && (
            <a
              href={knife.sourceUrl}
              target="_blank"
              rel="noreferrer"
              data-ledger-button
            >
              Source <ExternalLink aria-hidden="true" />
            </a>
          )}
          <Link
            href={`/collection/${encodeURIComponent(knife.id)}?edit=1`}
            data-ledger-button="primary"
          >
            Edit
          </Link>
        </div>
      </div>
      <article data-ledger-doc>
        {entryNumber && (
          <p data-ledger-folio>
            <span>Entry № {entryNumber}</span>
            {knife.specs.modelNumber && (
              <span>Model {knife.specs.modelNumber}</span>
            )}
          </p>
        )}
        <h2 data-ledger-title>{knife.name}</h2>
        <div data-ledger-sub>
          {knife.brand && <span>{knife.brand}</span>}
          {knife.bladeStyle && <span data-pill>{knife.bladeStyle}</span>}
          {knife.specs.lockingMechanism && (
            <span data-pill>{knife.specs.lockingMechanism}</span>
          )}
          {knife.pinned && <span data-pill="accent">Pinned</span>}
          {knife.sold && <span data-pill="sold">Sold</span>}
          <span>· added {formatShortDate(knife.addedAt)}</span>
          <Link
            href={`/collection/${encodeURIComponent(knife.id)}`}
            data-ledger-open-page
          >
            Open full page
          </Link>
        </div>
        <div
          data-ledger-media
          data-single={knife.images.length < 2 || undefined}
        >
          <div data-ledger-media-main>
            <KnifePhoto
              knife={knife}
              src={knife.images[photoIndex]}
              sizes="(max-width: 820px) 100vw, 720px"
              priority
            />
          </div>
          {knife.images.length > 1 && (
            <div data-ledger-media-side>
              {sideImages.slice(0, 3).map(({ path, index }, position) => (
                <button
                  key={`${path}-${index}`}
                  type="button"
                  aria-label={`Show photo ${index + 1}`}
                  onClick={() => setPhoto({ id: knife.id, index })}
                >
                  <KnifePhoto knife={knife} src={path} sizes="120px" />
                  {position === 2 && extraCount > 0 && (
                    <span data-ledger-media-more>+{extraCount}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        <div data-ledger-cols>
          <div data-ledger-sect>
            <h3>Specifications</h3>
            <table data-ledger-kv>
              <tbody>
                {shownSpecs.map(([label, value]) => (
                  <tr key={label}>
                    <th scope="row">{label}</th>
                    <td>{value?.trim() || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {knife.description.trim() && (
              <p data-ledger-note>{knife.description}</p>
            )}
          </div>
          <div>
            <div data-ledger-sect>
              <h3>Within your vault</h3>
              <LedgerBar
                label="Weight"
                value={bars.weight.value}
                max={bars.weight.max}
                text={formatWeight(knife.specs.weight, dimensionUnit)}
              />
              <LedgerBar
                label="Blade"
                value={bars.blade.value}
                max={bars.blade.max}
                text={formatDimension(knife.specs.bladeLength, dimensionUnit)}
              />
              <LedgerBar
                label="Price"
                value={bars.price.value}
                max={bars.price.max}
                text={knife.specs.price ?? ''}
              />
              {bars.average && (
                <p data-ledger-caption>Vault average price {bars.average}</p>
              )}
            </div>
            <div data-ledger-sect>
              <h3>History</h3>
              {history.loading ? (
                <p data-ledger-caption>Loading history…</p>
              ) : history.events.length === 0 ? (
                <p data-ledger-caption>No recorded changes yet.</p>
              ) : (
                <ul data-ledger-log>
                  {history.events.map((event) => {
                    const change = event.changes[0]
                    return (
                      <li key={event.id}>
                        <time dateTime={event.occurredAt}>
                          {formatShortDate(event.occurredAt)}
                        </time>
                        {change && event.type === 'updated' ? (
                          <span>
                            {fieldLabel(change.field)}{' '}
                            {change.before && <del>{change.before}</del>}
                            {change.before && ' → '}
                            <ins>{change.after || 'cleared'}</ins>
                            {event.changes.length > 1 &&
                              ` +${event.changes.length - 1} more`}
                          </span>
                        ) : (
                          <span>{event.summary}</span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
              <Link href="/logs" data-ledger-more-link>
                All history →
              </Link>
            </div>
          </div>
        </div>
      </article>
    </>
  )
}

function LedgerBar({
  label,
  value,
  max,
  text,
}: {
  label: string
  value: number | undefined
  max: number
  text: string
}) {
  const width = value !== undefined && max > 0 ? (value / max) * 100 : 0
  return (
    <div data-ledger-bar>
      <span>{label}</span>
      <span data-ledger-track aria-hidden="true">
        <span style={{ width: `${width}%` }} />
      </span>
      <b>{text || '—'}</b>
    </div>
  )
}

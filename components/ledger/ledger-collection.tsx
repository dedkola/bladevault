'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, ExternalLink, Star } from 'lucide-react'
import { useKnives } from '@/components/providers/knives-provider'
import { KnifePhoto } from '@/components/lumen/knife-photo'
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
import type { CollectionDisplay } from '@/lib/settings-shared'
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

export function LedgerCollection() {
  const router = useRouter()
  const { dimensionUnit } = useKnives()
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
  const filteredValue = summarizeCollectionValue(
    filtered.filter((knife) => !knife.sold),
  )

  const select = (id: string, focus = false) => {
    setChosenId(id)
    setDetailOpen(true)
    requestAnimationFrame(() => {
      const row = listRef.current?.querySelector<HTMLElement>(
        `[data-ledger-row="${CSS.escape(id)}"]`,
      )
      row?.scrollIntoView({ block: 'nearest' })
      if (focus) row?.focus()
    })
  }

  // Keep the keyboard handler current without re-binding on every render.
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {})
  useEffect(() => {
    keyHandler.current = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === '/' && !isEditableTarget(event.target)) {
        event.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (isEditableTarget(event.target) || !current) return
      const index = ordered.indexOf(current)
      const key = event.key.toLowerCase()
      if (key === 'j' || event.key === 'ArrowDown') {
        const next = ordered[index + 1]
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
    <div data-ledger-split data-detail-open={detailOpen || undefined}>
      <h1 className="sr-only">Collection</h1>
      <section data-ledger-listpane aria-label="Knives">
        <div data-ledger-toolbar>
          <input
            ref={searchRef}
            type="search"
            value={collection.query}
            onChange={(event) => collection.setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') event.currentTarget.blur()
            }}
            placeholder="Filter…  steel:magnacut  lock:axis"
            aria-label="Filter knives. Use steel:, lock:, brand:, style: or handle: to search one field."
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
        <div data-ledger-colhead aria-hidden="true">
          <span>Name</span>
          <span>Steel</span>
          <span>Price</span>
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
                        selected={knife.id === current?.id}
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
      <section data-ledger-detail aria-label="Knife details" aria-live="polite">
        {current ? (
          <LedgerDocument
            summary={current}
            knives={knives}
            actions={actions}
            onBack={() => setDetailOpen(false)}
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
  selected,
  dimensionUnit,
  onSelect,
}: {
  knife: Knife
  groupBy: GroupBy
  selected: boolean
  dimensionUnit: ReturnType<typeof useKnives>['dimensionUnit']
  onSelect: () => void
}) {
  const detail = [
    groupBy === 'brand' ? knife.bladeStyle : knife.brand,
    knife.specs.bladeLength &&
      formatDimension(knife.specs.bladeLength, dimensionUnit),
    groupBy === 'lock' ? knife.bladeStyle : knife.specs.lockingMechanism,
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
      <span data-ledger-mono>{knife.specs.bladeMaterial || '—'}</span>
      <span data-ledger-num>{knife.specs.price || '—'}</span>
    </button>
  )
}

/** Recent audit-log entries for one knife; the log is loaded once. */
function useKnifeHistory(knifeId: string, version: string) {
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
    // Reload when the selected knife changes on the server.
  }, [version])
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
  actions,
  onBack,
}: {
  summary: Knife
  knives: Knife[]
  actions: ReturnType<typeof useLumenKnifeActions>
  onBack: () => void
}) {
  const { dimensionUnit } = useKnives()
  const knife = useKnifeDetail(summary) ?? summary
  const [photo, setPhoto] = useState<{ id: string; index: number } | null>(null)
  const photoIndex = photo?.id === knife.id ? photo.index : 0
  const history = useKnifeHistory(knife.id, knife.updatedAt)
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

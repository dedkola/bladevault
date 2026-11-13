'use client'

import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Dialog } from '@base-ui/react/dialog'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  X,
} from 'lucide-react'
import { useKnives } from '@/components/providers/knives-provider'
import { KnifePhoto } from '@/components/lumen/knife-photo'
import { LumenSelectMenu } from '@/components/lumen/lumen-select-menu'
import {
  useLumenCollection,
  useLumenKnifeActions,
} from '@/components/lumen/use-lumen-collection'
import { useKnifeDetail } from '@/components/lumen/use-knife-detail'
import { useLocalPreference } from '@/components/lumen/use-local-preference'
import { InspectorTabs } from '@/components/inspector-tabs'
import type { Knife } from '@/lib/data'
import { formatDimension, formatWeight } from '@/lib/measurements'
import type { CollectionDisplay } from '@/lib/settings-shared'
import {
  countAddedThisMonth,
  countFacet,
  formatShortDate,
} from '@/lib/lumen-collection'

const PAGE_SIZE = 60
const MAX_STYLE_CHIPS = 6
const SORT_OPTIONS: { value: CollectionDisplay['sort']; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'model', label: 'Name' },
  { value: 'brand', label: 'Brand' },
]
const TILE_SIZES = ['grid', 'large'] as const

export function AtriumCollection() {
  const { dimensionUnit } = useKnives()
  const collection = useLumenCollection()
  const actions = useLumenKnifeActions()
  const { knives, filtered, isLoading, getValues, toggleSingle } = collection
  const [tileSize, setTileSize] = useLocalPreference(
    'bladevault-atrium-tiles',
    TILE_SIZES,
    'grid',
  )
  const [visible, setVisible] = useState(PAGE_SIZE)
  const [selected, setSelected] = useState<string[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)

  const brandCount = useMemo(
    () => countFacet(knives, (knife) => knife.brand).length,
    [knives],
  )
  const addedThisMonth = useMemo(() => countAddedThisMonth(knives), [knives])
  const styles = useMemo(
    () => countFacet(knives, (knife) => knife.bladeStyle),
    [knives],
  )
  const steels = useMemo(
    () => countFacet(knives, (knife) => knife.specs.bladeMaterial),
    [knives],
  )
  const locks = useMemo(
    () => countFacet(knives, (knife) => knife.specs.lockingMechanism),
    [knives],
  )
  const activeStyle = getValues('bladeStyle')[0] ?? null
  const activeSteel = getValues('bladeMaterial')[0] ?? null
  const activeLock = getValues('lockingMechanism')[0] ?? null
  const pinnedOnly = getValues('view')[0] === 'pinned'
  // Keep a chosen style visible even when it is not among the most common.
  const styleChips = styles.slice(0, MAX_STYLE_CHIPS)
  if (activeStyle && !styleChips.some((chip) => chip.value === activeStyle)) {
    const match = styles.find((chip) => chip.value === activeStyle)
    styleChips.push(match ?? { value: activeStyle, count: 0 })
  }
  const moreStyles = styles.slice(MAX_STYLE_CHIPS)

  const openIndex = filtered.findIndex((knife) => knife.id === openId)
  const openKnife = openIndex >= 0 ? filtered[openIndex] : null
  const selectedKnives = selected
    .map((id) => knives.find((knife) => knife.id === id))
    .filter((knife): knife is Knife => Boolean(knife))

  const toggleSelected = (id: string) =>
    setSelected((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    )

  const step = (delta: number) => {
    const next = filtered[openIndex + delta]
    if (next) setOpenId(next.id)
  }

  return (
    <div data-atrium-collection>
      <h1 className="sr-only">Collection</h1>
      <section data-atrium-hero>
        <p data-atrium-title aria-hidden="true">
          Collection
          <small>{isLoading ? '' : filtered.length}</small>
        </p>
        <dl data-atrium-stats>
          <div>
            <dt>Brands</dt>
            <dd>{brandCount}</dd>
          </div>
          <div>
            <dt>Added this month</dt>
            <dd>{addedThisMonth}</dd>
          </div>
        </dl>
      </section>

      <div data-atrium-filters role="toolbar" aria-label="Collection filters">
        <button
          type="button"
          data-atrium-chip
          aria-pressed={!activeStyle}
          onClick={() => toggleSingle('bladeStyle', null)}
        >
          All<span>{knives.length}</span>
        </button>
        {styleChips.map((chip) => (
          <button
            key={chip.value}
            type="button"
            data-atrium-chip
            aria-pressed={activeStyle === chip.value}
            onClick={() => toggleSingle('bladeStyle', chip.value)}
          >
            {chip.value}
            <span>{chip.count}</span>
          </button>
        ))}
        {moreStyles.length > 0 && (
          <LumenSelectMenu
            label="More styles"
            options={moreStyles.map((item) => ({
              value: item.value,
              label: item.value,
              count: item.count,
            }))}
            value={activeStyle}
            clearable
            onSelect={(next) => toggleSingle('bladeStyle', next)}
            triggerProps={{ 'data-atrium-chip': true }}
          />
        )}
        <span data-atrium-filter-divider aria-hidden="true" />
        <LumenSelectMenu
          label={activeSteel ?? 'Steel'}
          options={steels.map((item) => ({
            value: item.value,
            label: item.value,
            count: item.count,
          }))}
          value={activeSteel}
          clearable
          emptyText="No blade steels recorded yet."
          onSelect={(next) => toggleSingle('bladeMaterial', next)}
          triggerProps={{ 'data-atrium-chip': true }}
        />
        <LumenSelectMenu
          label={activeLock ?? 'Lock'}
          options={locks.map((item) => ({
            value: item.value,
            label: item.value,
            count: item.count,
          }))}
          value={activeLock}
          clearable
          emptyText="No locks recorded yet."
          onSelect={(next) => toggleSingle('lockingMechanism', next)}
          triggerProps={{ 'data-atrium-chip': true }}
        />
        <button
          type="button"
          data-atrium-chip
          aria-pressed={pinnedOnly}
          onClick={() => toggleSingle('view', 'pinned')}
        >
          Pinned
        </button>
        {collection.hasFilters && (
          <button
            type="button"
            data-atrium-clear
            onClick={collection.clearFilters}
          >
            Clear filters
          </button>
        )}
        <span data-atrium-filter-spacer />
        <LumenSelectMenu
          label={
            SORT_OPTIONS.find((option) => option.value === collection.sort)
              ?.label ?? 'Newest'
          }
          options={SORT_OPTIONS}
          value={collection.sort}
          align="end"
          onSelect={(next) =>
            next && collection.setSort(next as CollectionDisplay['sort'])
          }
          triggerProps={{
            'data-atrium-chip': true,
            'data-atrium-sort': true,
            'aria-label': 'Sort order',
          }}
        />
        <span data-atrium-size-toggle role="group" aria-label="Tile size">
          <button
            type="button"
            aria-pressed={tileSize === 'grid'}
            onClick={() => setTileSize('grid')}
          >
            Grid
          </button>
          <button
            type="button"
            aria-pressed={tileSize === 'large'}
            onClick={() => setTileSize('large')}
          >
            Large
          </button>
        </span>
      </div>

      {isLoading ? (
        <div data-atrium-grid aria-busy="true">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} data-atrium-tile-skeleton />
          ))}
        </div>
      ) : knives.length === 0 ? (
        <div data-atrium-empty>
          <p>Your vault is empty.</p>
          <Link href="/add" data-atrium-button="primary">
            Add your first knife
          </Link>
        </div>
      ) : filtered.length === 0 ? (
        <div data-atrium-empty>
          <p>No knives match these filters.</p>
          <button
            type="button"
            data-atrium-button
            onClick={collection.clearFilters}
          >
            Clear filters
          </button>
        </div>
      ) : (
        <>
          <ul data-atrium-grid data-size={tileSize}>
            {filtered.slice(0, visible).map((knife, index) => (
              <AtriumTile
                key={knife.id}
                knife={knife}
                eager={index < 4}
                selected={selected.includes(knife.id)}
                dimensionUnit={dimensionUnit}
                onOpen={(trigger) => {
                  returnFocus.current = trigger
                  setOpenId(knife.id)
                }}
                onToggleSelected={() => toggleSelected(knife.id)}
              />
            ))}
          </ul>
          {visible < filtered.length && (
            <div data-atrium-more>
              <button
                type="button"
                data-atrium-button
                onClick={() => setVisible((count) => count + PAGE_SIZE)}
              >
                Show more ({filtered.length - visible} left)
              </button>
            </div>
          )}
        </>
      )}

      <div
        data-atrium-tray
        data-open={selectedKnives.length > 0 || undefined}
        aria-hidden={selectedKnives.length === 0}
        inert={selectedKnives.length === 0}
      >
        <span role="status">{selectedKnives.length} selected</span>
        <span data-atrium-tray-thumbs aria-hidden="true">
          {selectedKnives.slice(0, 4).map((knife) => (
            <span key={knife.id}>
              <KnifePhoto knife={knife} sizes="32px" />
            </span>
          ))}
        </span>
        <button
          type="button"
          data-atrium-tray-clear
          onClick={() => setSelected([])}
        >
          Clear
        </button>
        <button
          type="button"
          data-atrium-tray-go
          disabled={actions.compareUnavailable}
          onClick={() =>
            void actions
              .compare(
                selectedKnives.map((knife) => knife.id),
                true,
              )
              .then(() => setSelected([]))
          }
        >
          Compare →
        </button>
      </div>

      <AtriumSheet
        knife={openKnife}
        position={openIndex}
        total={filtered.length}
        onStep={step}
        onClose={() => setOpenId(null)}
        returnFocus={returnFocus}
        actions={actions}
      />
    </div>
  )
}

function AtriumTile({
  knife,
  eager,
  selected,
  dimensionUnit,
  onOpen,
  onToggleSelected,
}: {
  knife: Knife
  eager: boolean
  selected: boolean
  dimensionUnit: ReturnType<typeof useKnives>['dimensionUnit']
  onOpen: (trigger: HTMLElement) => void
  onToggleSelected: () => void
}) {
  const facts = [
    knife.specs.bladeMaterial,
    knife.specs.bladeLength &&
      `${formatDimension(knife.specs.bladeLength, dimensionUnit)} blade`,
    knife.specs.lockingMechanism,
  ].filter(Boolean)
  const subtitle = [knife.brand, knife.bladeStyle].filter(Boolean).join(' · ')
  return (
    <li data-atrium-tile data-selected={selected || undefined}>
      <button
        type="button"
        data-atrium-tile-open
        data-knife-card={knife.id}
        aria-label={`Open ${knife.brand} ${knife.name}`.trim()}
        onClick={(event) => onOpen(event.currentTarget)}
      >
        <span data-atrium-tile-art>
          <KnifePhoto
            knife={knife}
            priority={eager}
            sizes="(max-width: 760px) 50vw, (max-width: 1400px) 33vw, 25vw"
          />
        </span>
        {facts.length > 0 && (
          <span data-atrium-tile-facts aria-hidden="true">
            {facts.map((fact) => (
              <span key={fact}>{fact}</span>
            ))}
          </span>
        )}
        <span data-atrium-tile-meta>
          <span>
            <b>{knife.name}</b>
            {subtitle && <small>{subtitle}</small>}
          </span>
          {knife.specs.price && <em>{knife.specs.price}</em>}
        </span>
      </button>
      {(knife.pinned || knife.sold) && (
        <span data-atrium-tile-flags>
          {knife.pinned && <span data-flag="pin">Pinned</span>}
          {knife.sold && <span data-flag="sold">Sold</span>}
        </span>
      )}
      <button
        type="button"
        data-atrium-tile-check
        aria-pressed={selected}
        aria-label={`${selected ? 'Deselect' : 'Select'} ${knife.name} to compare`}
        title="Select to compare"
        onClick={onToggleSelected}
      >
        {selected && <Check aria-hidden="true" />}
      </button>
    </li>
  )
}

function AtriumSheet({
  knife: summary,
  position,
  total,
  onStep,
  onClose,
  returnFocus,
  actions,
}: {
  knife: Knife | null
  position: number
  total: number
  onStep: (delta: number) => void
  onClose: () => void
  returnFocus: React.RefObject<HTMLElement | null>
  actions: ReturnType<typeof useLumenKnifeActions>
}) {
  const { dimensionUnit } = useKnives()
  const knife = useKnifeDetail(summary)
  const [photo, setPhoto] = useState<{ id: string; index: number } | null>(null)
  const photoIndex = photo && photo.id === knife?.id ? photo.index : 0
  const images = knife?.images ?? []
  const image = images[photoIndex] ?? images[0]

  return (
    <Dialog.Root
      open={Boolean(summary)}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop data-atrium-scrim />
        <Dialog.Popup
          data-atrium-sheet
          finalFocus={returnFocus}
          onKeyDown={(event) => {
            if (event.target instanceof HTMLInputElement) return
            if (event.key === 'j' || event.key === 'ArrowDown') {
              event.preventDefault()
              onStep(1)
            }
            if (event.key === 'k' || event.key === 'ArrowUp') {
              event.preventDefault()
              onStep(-1)
            }
          }}
        >
          {knife && (
            <>
              <header data-atrium-sheet-head>
                <div>
                  <button
                    type="button"
                    data-atrium-icon-button
                    aria-label="Previous knife"
                    disabled={position <= 0}
                    onClick={() => onStep(-1)}
                  >
                    <ArrowUp />
                  </button>
                  <button
                    type="button"
                    data-atrium-icon-button
                    aria-label="Next knife"
                    disabled={position >= total - 1}
                    onClick={() => onStep(1)}
                  >
                    <ArrowDown />
                  </button>
                  <span data-atrium-sheet-position>
                    {position + 1} / {total}
                  </span>
                </div>
                <div>
                  <Link
                    href={`/collection/${encodeURIComponent(knife.id)}`}
                    data-atrium-button
                  >
                    Open page
                  </Link>
                  <Dialog.Close data-atrium-icon-button aria-label="Close">
                    <X />
                  </Dialog.Close>
                </div>
              </header>
              <div data-atrium-sheet-body>
                <div data-atrium-sheet-stage>
                  <KnifePhoto
                    knife={knife}
                    src={image}
                    sizes="(max-width: 760px) 100vw, 560px"
                    priority
                  />
                  {images.length > 1 && (
                    <>
                      <button
                        type="button"
                        data-atrium-stage-nav="prev"
                        aria-label="Previous photo"
                        onClick={() =>
                          setPhoto({
                            id: knife.id,
                            index:
                              (photoIndex - 1 + images.length) % images.length,
                          })
                        }
                      >
                        <ChevronLeft />
                      </button>
                      <button
                        type="button"
                        data-atrium-stage-nav="next"
                        aria-label="Next photo"
                        onClick={() =>
                          setPhoto({
                            id: knife.id,
                            index: (photoIndex + 1) % images.length,
                          })
                        }
                      >
                        <ChevronRight />
                      </button>
                    </>
                  )}
                </div>
                {images.length > 1 && (
                  <div data-atrium-thumbs role="group" aria-label="Photos">
                    {images.slice(0, 8).map((path, index) => (
                      <button
                        key={`${path}-${index}`}
                        type="button"
                        aria-label={`Photo ${index + 1}`}
                        aria-pressed={index === photoIndex}
                        onClick={() => setPhoto({ id: knife.id, index })}
                      >
                        <KnifePhoto knife={knife} src={path} sizes="64px" />
                      </button>
                    ))}
                  </div>
                )}
                <Dialog.Title data-atrium-sheet-title>
                  {knife.name}
                </Dialog.Title>
                <p data-atrium-sheet-sub>
                  {[knife.brand, knife.bladeStyle, knife.handleMaterial]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                <div data-atrium-sheet-actions>
                  <Link
                    href={`/collection/${encodeURIComponent(knife.id)}?edit=1`}
                    data-atrium-button="primary"
                  >
                    Edit
                  </Link>
                  <button
                    type="button"
                    data-atrium-button
                    aria-pressed={knife.pinned}
                    disabled={actions.busy === `pin:${knife.id}`}
                    onClick={() => void actions.togglePin(knife)}
                  >
                    {knife.pinned ? 'Unpin' : 'Pin'}
                  </button>
                  <button
                    type="button"
                    data-atrium-button
                    aria-pressed={actions.isInCompare(knife.id)}
                    disabled={actions.compareUnavailable}
                    onClick={() => void actions.compare([knife.id])}
                  >
                    {actions.isInCompare(knife.id)
                      ? 'In comparison'
                      : 'Add to compare'}
                  </button>
                  {knife.sourceUrl && (
                    <a
                      href={knife.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      data-atrium-button
                    >
                      Source <ExternalLink aria-hidden="true" />
                    </a>
                  )}
                </div>
                <dl data-atrium-specs>
                  <Spec label="Blade steel" value={knife.specs.bladeMaterial} />
                  <Spec label="Lock" value={knife.specs.lockingMechanism} />
                  <Spec
                    label="Blade length"
                    value={formatDimension(
                      knife.specs.bladeLength,
                      dimensionUnit,
                    )}
                  />
                  <Spec
                    label="Overall"
                    value={formatDimension(
                      knife.specs.overallLength,
                      dimensionUnit,
                    )}
                  />
                  <Spec
                    label="Weight"
                    value={formatWeight(knife.specs.weight, dimensionUnit)}
                  />
                  <Spec label="Price" value={knife.specs.price} />
                  <Spec label="Handle" value={knife.handleMaterial} />
                  <Spec
                    label="Added"
                    value={formatShortDate(knife.addedAt, true)}
                  />
                </dl>
                <div data-atrium-sheet-tabs>
                  <InspectorTabs knife={knife} dimensionUnit={dimensionUnit} />
                </div>
              </div>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Spec({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value?.trim() || '—'}</dd>
    </div>
  )
}

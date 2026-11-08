'use client'

import { memo, useCallback, useMemo, useState } from 'react'
import { ImageIcon, Pin, Scale } from 'lucide-react'
import Image from '@/components/vault-image'
import { SoldBadge } from '@/components/sold-badge'
import { useKnives } from '@/components/providers/knives-provider'
import { useComparisons } from '@/components/providers/comparisons-provider'
import { useCollectionItemNavigation } from '@/hooks/use-collection-item-navigation'
import { getImageUrl, getKnifeImageCount, type Knife } from '@/lib/data'
import { formatDimension, formatDimensionNumber } from '@/lib/measurements'
import {
  parseLengthToInches,
  parseLengthToMillimeters,
} from '@/lib/measurement-parser'
import type { DimensionUnit } from '@/lib/settings-shared'

function formatAddedDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  }).format(date)
}

function mostCommon(values: Array<string | undefined>): string {
  const counts = new Map<string, { label: string; count: number }>()
  for (const value of values) {
    const label = value?.trim()
    if (!label) continue
    const key = label.toLowerCase()
    const entry = counts.get(key)
    if (entry) entry.count += 1
    else counts.set(key, { label, count: 1 })
  }
  let best: { label: string; count: number } | undefined
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry
  }
  return best?.label ?? '—'
}

function medianBladeLength(knives: Knife[], unit: DimensionUnit) {
  const useMm = unit === 'mm'
  const values = knives
    .map((knife) =>
      useMm
        ? parseLengthToMillimeters(knife.specs.bladeLength)
        : parseLengthToInches(knife.specs.bladeLength),
    )
    .filter((value): value is number => value !== undefined && value > 0)
    .sort((a, b) => a - b)
  if (!values.length) return { value: '—', unit: '' }
  const middle = Math.floor(values.length / 2)
  const median =
    values.length % 2
      ? values[middle]
      : (values[middle - 1] + values[middle]) / 2
  return useMm
    ? { value: formatDimensionNumber(Math.round(median), 'mm'), unit: 'mm' }
    : { value: median.toFixed(2), unit: 'in' }
}

/** Title and stat strip shown above the Forge collection toolbar. */
export function ForgeCollectionSummary({
  knives,
  visibleKnives,
}: {
  knives: Knife[]
  visibleKnives: Knife[]
}) {
  const { dimensionUnit = 'in' } = useKnives()
  const stats = useMemo(() => {
    const now = new Date()
    const addedThisMonth = knives.filter((knife) => {
      const added = new Date(knife.addedAt)
      return (
        added.getFullYear() === now.getFullYear() &&
        added.getMonth() === now.getMonth()
      )
    }).length
    return {
      addedThisMonth,
      makers: new Set(
        visibleKnives
          .map((knife) => knife.brand.trim().toLowerCase())
          .filter(Boolean),
      ).size,
      topSteel: mostCommon(
        visibleKnives.map((knife) => knife.specs.bladeMaterial),
      ),
      blade: medianBladeLength(visibleKnives, dimensionUnit),
    }
  }, [knives, visibleKnives, dimensionUnit])
  const filtered = visibleKnives.length !== knives.length

  return (
    <section data-forge-summary aria-label="Collection summary">
      <h1 className="sr-only">Collection</h1>
      <dl data-forge-stats>
        <div>
          <dt>{filtered ? 'Showing' : 'Knives'}</dt>
          <dd>
            {visibleKnives.length}
            {filtered ? (
              <span>of {knives.length}</span>
            ) : stats.addedThisMonth > 0 ? (
              <span>+{stats.addedThisMonth} this month</span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Makers</dt>
          <dd>{stats.makers}</dd>
        </div>
        <div>
          <dt>Top steel</dt>
          <dd title={stats.topSteel}>{stats.topSteel}</dd>
        </div>
        <div>
          <dt>Median blade</dt>
          <dd>
            {stats.blade.value}
            {stats.blade.unit && <span>{stats.blade.unit}</span>}
          </dd>
        </div>
      </dl>
    </section>
  )
}

const ForgeCollectionCard = memo(function ForgeCollectionCard({
  knife,
  eager,
  active,
  dimensionUnit,
  onOpen,
  onOpenDetail,
}: {
  knife: Knife
  eager: boolean
  active: boolean
  dimensionUnit: DimensionUnit
  onOpen: (knife: Knife) => void
  onOpenDetail: (knife: Knife) => void
}) {
  const navigation = useCollectionItemNavigation(onOpen, onOpenDetail)
  const { updateKnife, pinnedItemsFirst, showFeedback } = useKnives()
  const {
    choose,
    membershipCount,
    lists: comparisonLists,
    loading: comparisonsLoading,
    error: comparisonsError,
  } = useComparisons()
  const [isTogglingPin, setIsTogglingPin] = useState(false)
  const [isTogglingCompare, setIsTogglingCompare] = useState(false)
  const comparisonCount = membershipCount(knife.id)
  const inCompare = comparisonCount > 0
  const modelNumber = knife.specs.modelNumber?.trim()
  const imageCount = getKnifeImageCount(knife)
  const label = `${knife.brand} ${knife.name}`
  const specs = [
    { label: 'Steel', value: knife.specs.bladeMaterial?.trim() },
    {
      label: 'Blade',
      // Inch marks keep the value short enough for the narrow spec cell.
      value: formatDimension(knife.specs.bladeLength, dimensionUnit).replace(
        /^([\d.]+) in$/,
        '$1″',
      ),
    },
    { label: 'Lock', value: knife.specs.lockingMechanism?.trim() },
  ]
  const added = formatAddedDate(knife.addedAt)

  const handlePin = useCallback(
    async (event: React.MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      try {
        setIsTogglingPin(true)
        await updateKnife(knife.id, { pinned: !knife.pinned })
        showFeedback(
          knife.pinned
            ? 'Unpinned'
            : pinnedItemsFirst
              ? 'Pinned — moved to top'
              : 'Pinned',
        )
      } catch (error) {
        showFeedback(
          error instanceof Error ? error.message : 'Could not update pin.',
          'error',
        )
      } finally {
        setIsTogglingPin(false)
      }
    },
    [updateKnife, knife.id, knife.pinned, pinnedItemsFirst, showFeedback],
  )

  const handleCompare = useCallback(
    async (event: React.MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      try {
        setIsTogglingCompare(true)
        await choose([knife.id])
      } catch (error) {
        showFeedback(
          error instanceof Error
            ? error.message
            : 'Could not update comparison.',
          'error',
        )
      } finally {
        setIsTogglingCompare(false)
      }
    },
    [choose, knife.id, showFeedback],
  )

  return (
    <article
      data-forge-card
      data-active={active || undefined}
      data-sold={knife.sold || undefined}
    >
      <div data-forge-well>
        {knife.images[0] ? (
          <Image
            src={getImageUrl(knife.images[0])}
            alt={label}
            fill
            loading={eager ? 'eager' : 'lazy'}
            priority={eager}
            sizes="(max-width: 560px) 100vw, (max-width: 1100px) 50vw, 340px"
            className="object-contain"
            referrerPolicy="no-referrer"
            decoding="async"
          />
        ) : (
          <ImageIcon aria-hidden="true" data-forge-well-empty />
        )}
        <span data-forge-badges>
          {imageCount > 0 && (
            <span
              data-forge-badge
              aria-label={`${imageCount} image${imageCount === 1 ? '' : 's'}`}
            >
              <ImageIcon aria-hidden="true" />
              {imageCount}
            </span>
          )}
          {knife.sold && <SoldBadge />}
        </span>
      </div>

      <div data-forge-card-body>
        <p data-forge-maker>
          <span>{knife.brand || 'Unknown maker'}</span>
          {modelNumber && <span title={modelNumber}>{modelNumber}</span>}
        </p>
        <h2 title={knife.name}>{knife.name}</h2>
        <dl data-forge-specs>
          {specs.map((spec) => (
            <div key={spec.label}>
              <dt>{spec.label}</dt>
              <dd title={spec.value || undefined}>{spec.value || '—'}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div data-forge-card-foot>
        <span>{added ? `Added ${added}` : ''}</span>
      </div>

      <button
        type="button"
        data-forge-card-open
        aria-pressed={active}
        aria-label={`Preview ${label}${modelNumber ? ` ${modelNumber}` : ''}`}
        onClick={(event) => navigation.onClick(event, knife)}
        onDoubleClick={() => navigation.onDoubleClick(knife)}
      />

      <button
        type="button"
        data-forge-pin
        data-on={knife.pinned || undefined}
        onClick={handlePin}
        disabled={isTogglingPin}
        aria-pressed={knife.pinned}
        aria-label={`${knife.pinned ? 'Unpin' : 'Pin'} ${label}`}
        title={knife.pinned ? 'Unpin' : 'Pin'}
      >
        <Pin aria-hidden="true" />
      </button>

      <button
        type="button"
        data-forge-compare
        data-on={inCompare || undefined}
        onClick={handleCompare}
        disabled={
          isTogglingCompare || comparisonsLoading || Boolean(comparisonsError)
        }
        aria-label={
          comparisonLists.length > 1
            ? `Choose comparisons for ${label}`
            : `${inCompare ? 'Remove' : 'Add'} ${label} ${inCompare ? 'from' : 'to'} compare`
        }
      >
        <Scale aria-hidden="true" />
        {inCompare
          ? `In ${comparisonCount} ${comparisonCount === 1 ? 'list' : 'lists'}`
          : 'Compare'}
      </button>
    </article>
  )
})

/** Forge gallery: product-shot cards with maker, model and key specs. */
export function ForgeCollectionGrid({
  knives,
  dimensionUnit = 'in',
  activeKnifeId,
  onOpen,
  onOpenDetail,
}: {
  knives: Knife[]
  dimensionUnit?: DimensionUnit
  activeKnifeId?: string | null
  onOpen: (knife: Knife) => void
  onOpenDetail: (knife: Knife) => void
}) {
  return (
    <div data-collection-grid data-forge-grid>
      {knives.map((knife, index) => (
        <ForgeCollectionCard
          key={knife.id}
          knife={knife}
          eager={index < 4}
          active={knife.id === activeKnifeId}
          dimensionUnit={dimensionUnit}
          onOpen={onOpen}
          onOpenDetail={onOpenDetail}
        />
      ))}
    </div>
  )
}

'use client'

import { memo, useCallback, useState } from 'react'
import { ImageIcon, Pin, Scale } from 'lucide-react'
import Image from '@/components/vault-image'
import { SoldBadge } from '@/components/sold-badge'
import { useKnives } from '@/components/providers/knives-provider'
import { useComparisons } from '@/components/providers/comparisons-provider'
import { useCollectionItemNavigation } from '@/hooks/use-collection-item-navigation'
import { getImageUrl, getKnifeImageCount, type Knife } from '@/lib/data'
import { formatDimension } from '@/lib/measurements'
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
  density = 'gallery',
  dimensionUnit = 'in',
  activeKnifeId,
  onOpen,
  onOpenDetail,
}: {
  knives: Knife[]
  density?: 'gallery' | 'compact'
  dimensionUnit?: DimensionUnit
  activeKnifeId?: string | null
  onOpen: (knife: Knife) => void
  onOpenDetail: (knife: Knife) => void
}) {
  return (
    <div data-collection-grid data-forge-grid data-density={density}>
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

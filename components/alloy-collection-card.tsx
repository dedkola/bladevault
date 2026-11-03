'use client'

import { memo, useState } from 'react'
import { Check, ImageIcon, Pin, Scale } from 'lucide-react'
import Image from '@/components/vault-image'
import { Checkbox } from '@/components/ui/checkbox'
import { useComparisons } from '@/components/providers/comparisons-provider'
import { useKnives } from '@/components/providers/knives-provider'
import { compactMeasurement } from '@/lib/compact-measurement'
import { getImageUrl, type Knife } from '@/lib/data'
import { useCollectionItemNavigation } from '@/hooks/use-collection-item-navigation'
import './alloy-collection.css'

export const AlloyCollectionCard = memo(function AlloyCollectionCard({
  knife,
  active = false,
  eager = false,
  selectionMode = false,
  selected = false,
  onOpen,
  onOpenDetail,
  onSelect,
}: {
  knife: Knife
  active?: boolean
  eager?: boolean
  selectionMode?: boolean
  selected?: boolean
  onOpen: (knife: Knife) => void
  onOpenDetail?: (knife: Knife) => void
  onSelect: (id: string) => void
}) {
  const navigation = useCollectionItemNavigation(onOpen, onOpenDetail)
  const { updateKnife, showFeedback } = useKnives()
  const { choose, membershipCount, loading, busy, error } = useComparisons()
  const [pinBusy, setPinBusy] = useState(false)
  const [compareBusy, setCompareBusy] = useState(false)
  const inCompare = membershipCount(knife.id) > 0
  const metadata = [
    knife.specs.bladeMaterial,
    compactMeasurement(knife.specs.bladeLength, ''),
    compactMeasurement(knife.specs.weight, ''),
  ].filter(Boolean)

  async function togglePin() {
    setPinBusy(true)
    try {
      await updateKnife(knife.id, { pinned: !knife.pinned })
      showFeedback(knife.pinned ? 'Unpinned' : 'Pinned')
    } catch (error) {
      showFeedback(
        error instanceof Error ? error.message : 'Could not update pin.',
        'error',
      )
    } finally {
      setPinBusy(false)
    }
  }

  async function toggleCompare() {
    setCompareBusy(true)
    try {
      await choose([knife.id])
    } catch (error) {
      showFeedback(
        error instanceof Error ? error.message : 'Could not update comparison.',
        'error',
      )
    } finally {
      setCompareBusy(false)
    }
  }

  return (
    <article
      data-alloy-card
      data-knife-card={knife.id}
      data-active={active || undefined}
      data-selection-mode={selectionMode || undefined}
      data-selected={selected || undefined}
    >
      <div data-alloy-card-stage>
        {knife.specs.modelNumber && (
          <span data-alloy-card-model>{knife.specs.modelNumber}</span>
        )}
        <button
          type="button"
          data-alloy-card-open
          aria-label={`${selectionMode ? 'Select' : 'Inspect'} ${knife.brand} ${knife.name}`}
          aria-pressed={selectionMode ? selected : active}
          onClick={(event) =>
            selectionMode
              ? onSelect(knife.id)
              : navigation.onClick(event, knife)
          }
          onDoubleClick={
            selectionMode ? undefined : () => navigation.onDoubleClick(knife)
          }
        >
          {knife.images[0] ? (
            <Image
              src={getImageUrl(knife.images[0])}
              alt={`${knife.brand} ${knife.name}`}
              fill
              sizes="(max-width: 640px) 50vw, (max-width: 1200px) 33vw, 28vw"
              className="object-contain"
              priority={eager}
            />
          ) : (
            <ImageIcon aria-hidden="true" />
          )}
        </button>
        {selectionMode ? (
          <div data-alloy-card-selection>
            <Checkbox
              checked={selected}
              onCheckedChange={() => onSelect(knife.id)}
              aria-label={`Select ${knife.name}`}
            />
          </div>
        ) : (
          <button
            type="button"
            data-alloy-card-pin
            aria-label={`${knife.pinned ? 'Unpin' : 'Pin'} ${knife.name}`}
            aria-pressed={knife.pinned}
            disabled={pinBusy}
            onClick={() => void togglePin()}
          >
            <Pin aria-hidden="true" />
          </button>
        )}
        {active && !selectionMode && (
          <span data-alloy-card-focus>
            <Check aria-hidden="true" /> In focus
          </span>
        )}
        {knife.sold && <span data-alloy-card-sold>Sold</span>}
      </div>
      <div data-alloy-card-caption>
        <div>
          <p data-alloy-card-brand>{knife.brand}</p>
          <h2>{knife.name}</h2>
          <p data-alloy-card-meta>
            {metadata.length
              ? metadata.join(' · ')
              : 'Specifications not recorded'}
          </p>
        </div>
        {!selectionMode && (
          <button
            type="button"
            data-alloy-card-compare
            aria-label={`${inCompare ? 'Manage comparison for' : 'Compare'} ${knife.name}`}
            aria-pressed={inCompare}
            disabled={loading || busy || compareBusy || Boolean(error)}
            onClick={() => void toggleCompare()}
          >
            {inCompare ? (
              <Check aria-hidden="true" />
            ) : (
              <Scale aria-hidden="true" />
            )}
          </button>
        )}
      </div>
    </article>
  )
})

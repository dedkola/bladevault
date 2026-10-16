import { useComparisons } from '@/components/providers/comparisons-provider'
import Image from '@/components/vault-image'
import { memo, useCallback, useState } from 'react'
import { Check, ImageIcon, Pin, Scale, Tag } from 'lucide-react'
import { getImageUrl, getKnifeImageCount, Knife } from '@/lib/data'
import { cn } from '@/lib/utils'
import { ImageCountBadge } from '@/components/image-count-badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { KnifeCardDetails } from '@/components/knife-card-details'
import { useKnives } from '@/components/providers/knives-provider'
import {
  activeKnifeActionStyle,
  activeKnifeFloatingClassName,
} from '@/lib/knife-action-styles'
import { getVisibleCardFields } from '@/lib/card-fields'

export type CollectionCardDensity = 'gallery' | 'compact'

function preferredMetric(value?: string): string {
  if (!value) return ''
  return value.split('|').at(-1)?.trim() ?? value
}

export const KnifeCard = memo(function KnifeCard({
  knife,
  eager = false,
  selectionMode = false,
  selected = false,
  active = false,
  density = 'gallery',
  onSelect,
  onOpen,
  variantLabel,
  imageSizes = '(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw',
}: {
  knife: Knife
  eager?: boolean
  selectionMode?: boolean
  selected?: boolean
  active?: boolean
  density?: CollectionCardDensity
  onSelect?: (id: string) => void
  onOpen?: (knife: Knife) => void
  variantLabel?: string
  imageSizes?: string
}) {
  const {
    updateKnife,
    pinnedItemsFirst,
    cardFields,
    customFieldDefinitions,
    showFeedback,
  } = useKnives()
  const pinned = knife.pinned
  const {
    choose,
    membershipCount,
    lists: comparisonLists,
    loading: comparisonsLoading,
    error: comparisonsError,
  } = useComparisons()
  const comparisonCount = membershipCount(knife.id)
  const inCompare = comparisonCount > 0
  const [isTogglingPin, setIsTogglingPin] = useState(false)
  const [isTogglingCompare, setIsTogglingCompare] = useState(false)
  const visibleCardFields = getVisibleCardFields(
    knife,
    cardFields,
    customFieldDefinitions,
  )
  const bladeLength = preferredMetric(knife.specs.bladeLength)
  const modelNumber = knife.specs.modelNumber?.trim()
  const imageCount = getKnifeImageCount(knife)
  const isCompact = density === 'compact'

  const handlePinClick = useCallback(
    async (event: React.MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      try {
        setIsTogglingPin(true)
        await updateKnife(knife.id, { pinned: !pinned })
        showFeedback(
          pinned
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
    [updateKnife, knife.id, pinned, pinnedItemsFirst, showFeedback],
  )

  const handleCompareClick = useCallback(
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
      className="group/card relative h-full min-w-0"
      data-knife-card={knife.id}
      data-active={active || undefined}
    >
      <Card
        className={cn(
          '@container/knife-card h-full gap-0 overflow-hidden p-0 transition-[box-shadow,transform] hover:shadow-sm',
          (active || selected) &&
            'ring-2 ring-[var(--bladevault-gold)] shadow-sm',
        )}
      >
        <div
          className={cn(
            'relative w-full bg-white',
            isCompact ? 'aspect-[1.7]' : 'aspect-video',
          )}
        >
          {knife.images.length > 0 ? (
            <Image
              src={getImageUrl(knife.images[0])}
              alt={`${knife.brand} ${knife.name}`}
              fill
              loading={eager ? 'eager' : 'lazy'}
              priority={eager}
              fetchPriority={eager ? 'high' : undefined}
              sizes={imageSizes}
              className={cn(
                'object-contain p-2 transition-transform duration-500 group-hover/card:scale-[1.03]',
                knife.sold && 'opacity-55 grayscale-[0.55]',
              )}
              referrerPolicy="no-referrer"
              decoding="async"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-muted/50">
              <ImageIcon className="size-8 text-muted-foreground/50" />
            </div>
          )}
          {knife.sold && (
            <span
              className={cn(
                'pointer-events-none absolute top-2 z-20 inline-flex items-center gap-1 rounded-md border border-border bg-background/95 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground',
                selectionMode ? 'left-10' : 'left-2',
              )}
            >
              <Tag aria-hidden="true" className="size-3" />
              Sold
            </span>
          )}
          {selectionMode && (
            <span
              className={cn(
                'absolute left-2 top-2 z-20 flex size-6 items-center justify-center rounded-full border bg-white/95 text-transparent shadow-sm transition-colors dark:bg-input/95',
                selected &&
                  'border-[var(--bladevault-olive)] bg-[var(--bladevault-olive)] text-[var(--bladevault-gold)] dark:bg-[var(--bladevault-olive)]',
              )}
              aria-hidden="true"
            >
              <Check className="size-3.5" strokeWidth={3} />
            </span>
          )}
          {knife.images.length > 0 && (
            <ImageCountBadge
              count={imageCount}
              size="sm"
              className="absolute bottom-2 right-2 z-20"
            />
          )}
        </div>

        <KnifeCardDetails
          brand={knife.brand}
          name={knife.name}
          modelNumber={modelNumber}
          fields={visibleCardFields}
          bladeLength={bladeLength}
          compact={isCompact}
          variantLabel={variantLabel}
          sold={knife.sold}
        />
      </Card>

      <button
        type="button"
        onClick={() => (selectionMode ? onSelect?.(knife.id) : onOpen?.(knife))}
        aria-pressed={selectionMode ? selected : active}
        aria-label={
          selectionMode
            ? `${selected ? 'Deselect' : 'Select'} ${knife.brand} ${knife.name}`
            : `Preview ${knife.brand} ${knife.name}${modelNumber ? ` ${modelNumber}` : ''}`
        }
        className="absolute inset-0 z-10 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bladevault-gold)] focus-visible:ring-offset-2"
      />

      {!selectionMode && (
        <>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handlePinClick}
            disabled={isTogglingPin}
            className={cn(
              "absolute right-2 top-2 z-20 rounded-md border bg-white/90 text-[var(--bladevault-olive)] shadow-sm transition-colors after:absolute after:-inset-2 after:content-[''] hover:bg-white hover:text-[var(--bladevault-olive)] dark:border-input dark:bg-[var(--bladevault-olive)] dark:text-[var(--bladevault-gold)] dark:hover:bg-[var(--bladevault-olive)] sm:after:inset-0",
              pinned && activeKnifeFloatingClassName,
            )}
            style={pinned ? activeKnifeActionStyle : undefined}
            aria-label={`${pinned ? 'Unpin' : 'Pin'} ${knife.brand} ${knife.name}`}
            title={pinned ? 'Unpin' : 'Pin'}
          >
            <Pin />
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={handleCompareClick}
            disabled={
              isTogglingCompare ||
              comparisonsLoading ||
              Boolean(comparisonsError)
            }
            className={cn(
              'absolute bottom-1.5 right-2 z-20 gap-1 px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground',
              inCompare && activeKnifeFloatingClassName,
            )}
            style={inCompare ? activeKnifeActionStyle : undefined}
            aria-label={
              comparisonLists.length > 1
                ? `Choose comparisons for ${knife.brand} ${knife.name}`
                : `${inCompare ? 'Remove' : 'Add'} ${knife.brand} ${knife.name} ${inCompare ? 'from' : 'to'} compare`
            }
          >
            <Scale className="size-3" />
            {inCompare
              ? `In ${comparisonCount} ${comparisonCount === 1 ? 'list' : 'lists'}`
              : 'Compare'}
          </Button>
        </>
      )}
    </article>
  )
})

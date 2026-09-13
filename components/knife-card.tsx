import Image from 'next/image'
import { memo, useCallback, useState } from 'react'
import { Check, ImageIcon, Pin, Scale } from 'lucide-react'
import { getImageUrl, Knife } from '@/lib/data'
import { cn } from '@/lib/utils'
import { ImageCountBadge } from '@/components/image-count-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useKnives } from '@/components/providers/knives-provider'
import {
  activeKnifeActionStyle,
  activeKnifeFloatingClassName,
} from '@/lib/knife-action-styles'
import { getCardFieldDisplayValue, getCardFieldLabel } from '@/lib/card-fields'

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
}) {
  const {
    updateKnife,
    compareIds,
    addToCompare,
    removeFromCompare,
    pinnedItemsFirst,
    cardFields,
    customFieldDefinitions,
    showFeedback,
  } = useKnives()
  const pinned = knife.pinned
  const inCompare = compareIds.includes(knife.id)
  const [isTogglingPin, setIsTogglingPin] = useState(false)
  const [isTogglingCompare, setIsTogglingCompare] = useState(false)
  const visibleCardFields = cardFields
    .filter((field) => field !== 'specs.modelNumber')
    .map((field) => ({
      label: getCardFieldLabel(field, customFieldDefinitions),
      value: getCardFieldDisplayValue(knife, field, customFieldDefinitions),
    }))
    .filter((field) => field.value)
  const bladeLength = preferredMetric(knife.specs.bladeLength)
  const modelNumber = knife.specs.modelNumber?.trim()
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
        if (inCompare) {
          await removeFromCompare(knife.id)
          showFeedback('Removed from compare')
        } else {
          await addToCompare(knife.id)
          showFeedback('Added to compare')
        }
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
    [addToCompare, removeFromCompare, knife.id, inCompare, showFeedback],
  )

  return (
    <article
      className="group/card relative min-w-0"
      data-knife-card={knife.id}
      data-active={active || undefined}
    >
      <Card
        className={cn(
          'gap-0 overflow-hidden p-0 transition-[box-shadow,transform] hover:shadow-sm',
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
              sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
              className="object-contain p-2 transition-transform duration-500 group-hover/card:scale-[1.03]"
              referrerPolicy="no-referrer"
              decoding="async"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-muted/50">
              <ImageIcon className="size-8 text-muted-foreground/50" />
            </div>
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
              count={knife.images.length}
              size="sm"
              className="absolute bottom-2 right-2 z-20"
            />
          )}
        </div>

        <CardContent
          className={cn(
            'min-w-0 border-t border-border/60',
            isCompact ? 'px-3 pb-3 pt-2.5' : 'px-3 pb-4 pt-3 sm:px-4',
          )}
        >
          <div className="flex min-w-0 items-baseline justify-between gap-2">
            <span className="truncate text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {knife.brand}
            </span>
            <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
              {modelNumber || '—'}
            </span>
          </div>
          <h2
            className={cn(
              'mt-1 line-clamp-2 font-medium leading-tight tracking-tight text-foreground',
              isCompact ? 'min-h-10 text-base' : 'min-h-10 text-lg sm:text-xl',
            )}
            title={`${knife.brand} ${knife.name}`}
          >
            {knife.name}
          </h2>
          {variantLabel ? (
            <p className="mt-2 line-clamp-2 min-h-8 text-[11px] leading-4 text-muted-foreground [overflow-wrap:anywhere]">
              {variantLabel}
            </p>
          ) : visibleCardFields.length > 0 ? (
            <dl
              className={cn(
                'mt-3 grid grid-cols-2 gap-x-3 gap-y-2',
                isCompact && '[&>div:nth-child(n+3)]:hidden max-sm:hidden',
              )}
            >
              {visibleCardFields.map((field) => (
                <div key={`${field.label}-${field.value}`} className="min-w-0">
                  <dt className="truncate text-[9px] text-muted-foreground">
                    {field.label}
                  </dt>
                  <dd
                    className="truncate text-[11px] font-medium text-foreground"
                    title={field.value}
                  >
                    {field.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </CardContent>

        <div className="flex min-h-9 items-center border-t border-border px-3 pr-24 text-[10px] text-muted-foreground">
          <span className="truncate">
            {bladeLength ? `${bladeLength} blade` : 'Blade length not recorded'}
          </span>
        </div>
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
            disabled={isTogglingCompare}
            className={cn(
              'absolute bottom-1.5 right-2 z-20 gap-1 px-1.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground',
              inCompare && activeKnifeFloatingClassName,
            )}
            style={inCompare ? activeKnifeActionStyle : undefined}
            aria-label={`${inCompare ? 'Remove' : 'Add'} ${knife.brand} ${knife.name} ${inCompare ? 'from' : 'to'} compare`}
          >
            <Scale className="size-3" />
            {inCompare ? 'Added' : 'Compare'}
          </Button>
        </>
      )}
    </article>
  )
})

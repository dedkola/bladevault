'use client'

import Image from 'next/image'
import { useState } from 'react'
import { ChevronRight, ImageIcon, Layers } from 'lucide-react'
import { KnifeCard, type CollectionCardDensity } from '@/components/knife-card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { getImageUrl } from '@/lib/data'
import { getKnifeVariantLabel, type KnifeFamily } from '@/lib/knife-families'
import { cn } from '@/lib/utils'

export function KnifeFamilyCard({
  family,
  allVariants,
  eager,
  activeKnifeId,
  density,
  onOpen,
}: {
  family: KnifeFamily
  allVariants: KnifeFamily['knives']
  eager: boolean
  activeKnifeId?: string
  density: CollectionCardDensity
  onOpen: (knife: KnifeFamily['knives'][number]) => void
}) {
  const [open, setOpen] = useState(false)
  const cover = family.knives[0]
  const countLabel =
    allVariants.length === 1
      ? '1 knife'
      : family.knives.length === allVariants.length
        ? `${allVariants.length} variants`
        : `${family.knives.length} of ${allVariants.length} variants match`
  const isCompact = density === 'compact'
  const hasVariants = allVariants.length > 1
  const containsActiveKnife = family.knives.some(
    (knife) => knife.id === activeKnifeId,
  )
  const summaryContent = (
    <>
      <span
        className={cn(
          'relative block w-full shrink-0 bg-white',
          isCompact ? 'aspect-[1.7]' : 'aspect-video',
        )}
      >
        {cover.images[0] ? (
          <Image
            src={getImageUrl(cover.images[0])}
            alt=""
            fill
            sizes="(max-width: 640px) 50vw, 33vw"
            priority={eager}
            className="object-contain p-2 transition-transform duration-500 group-hover:scale-[1.03]"
          />
        ) : (
          <span className="flex h-full items-center justify-center text-muted-foreground">
            <ImageIcon className="size-8" aria-hidden="true" />
          </span>
        )}
      </span>
      <span className={cn('block min-w-0 flex-1 p-3', !isCompact && 'sm:p-4')}>
        <span className="block truncate text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {family.brand}
        </span>
        <span
          className={cn(
            'mt-1 block h-10 line-clamp-2 font-medium leading-tight tracking-tight [overflow-wrap:anywhere]',
            isCompact ? 'text-base' : 'text-lg sm:text-xl',
          )}
        >
          {family.name}
        </span>
        <span className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <Layers className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate" title={countLabel}>
            {countLabel}
          </span>
          <ChevronRight
            className="ml-auto size-4 shrink-0 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none"
            aria-hidden="true"
          />
        </span>
      </span>
    </>
  )
  const summaryClassName = cn(
    'group flex w-full min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-[var(--bladevault-line)] hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:translate-y-0 motion-reduce:transform-none motion-reduce:transition-none',
    containsActiveKnife && 'ring-2 ring-[var(--bladevault-gold)]',
  )

  return (
    <article
      className="min-w-0 self-start"
      data-family-entry
      data-family-size={allVariants.length}
      data-knife-family={hasVariants ? '' : undefined}
    >
      {hasVariants ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger
            className={summaryClassName}
            aria-label={`${family.brand} ${family.name} · ${countLabel}`}
          >
            {summaryContent}
          </DialogTrigger>
          <DialogContent
            className="flex max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-6xl flex-col gap-0 overflow-hidden p-0 sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100%-2rem)]"
            data-family-variants-dialog
          >
            <DialogHeader className="shrink-0 border-b border-border px-4 py-4 pr-14 sm:px-5 sm:py-5 sm:pr-14">
              <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {family.brand}
              </span>
              <DialogTitle className="text-xl tracking-tight sm:text-2xl">
                {family.name}
              </DialogTitle>
              <DialogDescription>
                {family.knives.length === allVariants.length
                  ? `${allVariants.length} variants in your collection.`
                  : `Showing ${family.knives.length} of ${allVariants.length} variants matching the current filters.`}{' '}
                Choose one to preview.
              </DialogDescription>
            </DialogHeader>
            <div
              className={cn(
                'grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto overscroll-contain p-3 sm:grid-cols-2 sm:p-4 lg:grid-cols-3',
                isCompact && 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4',
              )}
              data-family-variant-grid
            >
              {family.knives.map((knife) => (
                <KnifeCard
                  key={knife.id}
                  knife={knife}
                  active={knife.id === activeKnifeId}
                  density={density}
                  imageSizes={
                    isCompact
                      ? '(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw'
                      : '(max-width: 640px) calc(100vw - 2rem), (max-width: 1024px) 50vw, 33vw'
                  }
                  onOpen={(selectedKnife) => {
                    setOpen(false)
                    onOpen(selectedKnife)
                  }}
                  variantLabel={getKnifeVariantLabel(knife, allVariants)}
                />
              ))}
            </div>
          </DialogContent>
        </Dialog>
      ) : (
        <button
          type="button"
          className={summaryClassName}
          onClick={() => onOpen(cover)}
          aria-pressed={containsActiveKnife}
          aria-label={`Preview ${cover.brand} ${cover.name}${cover.specs.modelNumber ? ` ${cover.specs.modelNumber}` : ''}`}
        >
          {summaryContent}
        </button>
      )}
    </article>
  )
}

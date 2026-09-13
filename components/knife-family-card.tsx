'use client'

import Image from 'next/image'
import { useState } from 'react'
import { ChevronDown, ImageIcon, Layers } from 'lucide-react'
import { KnifeCard, type CollectionCardDensity } from '@/components/knife-card'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
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
    family.knives.length === allVariants.length
      ? `${allVariants.length} variants`
      : `${family.knives.length} of ${allVariants.length} variants match`
  const isCompact = density === 'compact'
  const containsActiveKnife = family.knives.some(
    (knife) => knife.id === activeKnifeId,
  )

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        'min-w-0 self-start overflow-hidden rounded-xl border border-border bg-card',
        open && 'col-span-full',
        containsActiveKnife && 'ring-2 ring-[var(--bladevault-gold)]',
      )}
      data-knife-family
    >
      <CollapsibleTrigger
        className={cn(
          'group flex w-full min-w-0 flex-col text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          open && 'flex-row items-center',
        )}
        aria-label={`${family.brand} ${family.name} · ${countLabel}`}
      >
        <span
          className={cn(
            'relative block w-full shrink-0 bg-white',
            isCompact ? 'aspect-[1.7]' : 'aspect-video',
            open && 'm-3 aspect-square size-16 rounded-md',
          )}
        >
          {cover.images[0] ? (
            <Image
              src={getImageUrl(cover.images[0])}
              alt=""
              fill
              sizes={open ? '64px' : '(max-width: 640px) 50vw, 33vw'}
              priority={eager}
              className="object-contain p-2 transition-transform duration-500 group-hover:scale-[1.03]"
            />
          ) : (
            <span className="flex h-full items-center justify-center text-muted-foreground">
              <ImageIcon className="size-8" aria-hidden="true" />
            </span>
          )}
        </span>
        <span className={cn('block min-w-0 flex-1 p-3', !open && 'sm:p-4')}>
          <span className="block truncate text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {family.brand}
          </span>
          <span
            className={cn(
              'mt-1 block font-medium leading-tight tracking-tight [overflow-wrap:anywhere]',
              open || isCompact ? 'text-base' : 'text-lg sm:text-xl',
            )}
          >
            {family.name}
          </span>
          <span className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Layers className="size-3.5 shrink-0" aria-hidden="true" />
            {countLabel}
            <ChevronDown
              className={cn('ml-auto size-4 shrink-0', open && 'rotate-180')}
              aria-hidden="true"
            />
          </span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          className={cn(
            'grid grid-cols-2 gap-3 border-t border-border p-3 sm:grid-cols-2',
            isCompact && 'lg:grid-cols-3',
          )}
        >
          {family.knives.map((knife) => (
            <KnifeCard
              key={knife.id}
              knife={knife}
              active={knife.id === activeKnifeId}
              density={density}
              onOpen={onOpen}
              variantLabel={getKnifeVariantLabel(knife, allVariants)}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

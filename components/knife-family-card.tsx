'use client'

import Image from 'next/image'
import { useState } from 'react'
import { ChevronDown, ImageIcon, Layers } from 'lucide-react'
import { KnifeCard } from '@/components/knife-card'
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
}: {
  family: KnifeFamily
  allVariants: KnifeFamily['knives']
  eager: boolean
}) {
  const [open, setOpen] = useState(false)
  const cover = family.knives[0]
  const countLabel =
    family.knives.length === allVariants.length
      ? `${allVariants.length} variants`
      : `${family.knives.length} of ${allVariants.length} variants match`

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        'min-w-0 self-start overflow-hidden rounded-xl border border-border bg-card',
        open && 'col-span-full',
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
            'relative block aspect-[4/3] w-full shrink-0 bg-white',
            open && 'm-3 aspect-square size-16 rounded-md',
          )}
        >
          {cover.images[0] ? (
            <Image
              src={getImageUrl(cover.images[0])}
              alt=""
              fill
              sizes={open ? '64px' : '(max-width: 640px) 100vw, 33vw'}
              priority={eager}
              className="object-contain"
            />
          ) : (
            <span className="flex h-full items-center justify-center text-muted-foreground">
              <ImageIcon className="size-8" aria-hidden="true" />
            </span>
          )}
        </span>
        <span className="block min-w-0 flex-1 p-3">
          <span className="block truncate text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {family.brand}
          </span>
          <span className="block text-sm font-medium [overflow-wrap:anywhere]">
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
        <div className="grid grid-cols-1 gap-4 border-t border-border p-3 sm:grid-cols-2 lg:grid-cols-3">
          {family.knives.map((knife) => (
            <KnifeCard
              key={knife.id}
              knife={knife}
              variantLabel={getKnifeVariantLabel(knife, allVariants)}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

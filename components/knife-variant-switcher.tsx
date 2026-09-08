'use client'

import Link from 'next/link'
import Image from 'next/image'
import { ChevronDown, Check, ImageIcon, Layers } from 'lucide-react'
import { useKnives } from '@/components/providers/knives-provider'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { getImageUrl, type Knife } from '@/lib/data'
import { getKnifeFamilyKey, getKnifeVariantLabel } from '@/lib/knife-families'
import { cn } from '@/lib/utils'

export function KnifeVariantSwitcher({ knife }: { knife: Knife }) {
  const { knives } = useKnives()
  const familyKey = getKnifeFamilyKey(knife)
  const siblings = knives.filter(
    (item) => getKnifeFamilyKey(item) === familyKey,
  )
  if (siblings.length < 2) return null

  return (
    <Collapsible className="mb-6 min-w-0 rounded-xl border border-border bg-card">
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-3 rounded-xl p-3 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Layers
          className="size-4 shrink-0 text-[var(--bladevault-title)]"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium">
            {knife.name} · {siblings.length} variants
          </span>
          <span className="mt-1 block text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {getKnifeVariantLabel(knife, siblings)}
          </span>
        </span>
        <ChevronDown
          className="size-4 shrink-0 group-data-[panel-open]:rotate-180"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <nav
          aria-label="Model variants"
          className="grid gap-2 border-t border-border p-3 sm:grid-cols-2 xl:grid-cols-3"
        >
          {siblings.map((sibling) => {
            const active = sibling.id === knife.id
            const label = getKnifeVariantLabel(sibling, siblings)
            return (
              <Link
                key={sibling.id}
                href={`/collection/${sibling.id}`}
                aria-current={active ? 'page' : undefined}
                aria-label={`${sibling.brand} ${sibling.name} · ${label}`}
                className={cn(
                  'flex min-w-0 items-center gap-3 rounded-lg border p-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'border-[var(--bladevault-gold)] bg-accent'
                    : 'border-border hover:bg-accent/50',
                )}
              >
                <span
                  className="relative h-12 w-20 shrink-0 overflow-hidden rounded-md border border-border/60 bg-white"
                  data-variant-preview
                >
                  {sibling.images[0] ? (
                    <Image
                      src={getImageUrl(sibling.images[0])}
                      alt=""
                      fill
                      sizes="80px"
                      className="object-contain p-1"
                    />
                  ) : (
                    <span className="flex h-full items-center justify-center bg-muted/30 text-muted-foreground/50">
                      <ImageIcon className="size-4" aria-hidden="true" />
                    </span>
                  )}
                </span>
                <span className="min-w-0 flex-1 leading-5 [overflow-wrap:anywhere]">
                  {label}
                </span>
                {active && (
                  <Check className="size-4 shrink-0" aria-hidden="true" />
                )}
              </Link>
            )
          })}
        </nav>
      </CollapsibleContent>
    </Collapsible>
  )
}

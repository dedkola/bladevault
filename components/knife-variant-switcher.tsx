'use client'

import Link from 'next/link'
import Image from 'next/image'
import { ChevronDown, Check, ImageIcon, Layers } from 'lucide-react'
import { useKnives } from '@/components/providers/knives-provider'
import { useKnifeFamilyPanel } from '@/components/providers/knife-family-panel-provider'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { getImageUrl, type Knife } from '@/lib/data'
import { getKnifeFamilyKey, getKnifeVariantLabel } from '@/lib/knife-families'
import { cn } from '@/lib/utils'

function getVariantFields(knife: Knife, label: string) {
  const fields = [
    { label: 'Model', value: knife.specs.modelNumber },
    { label: 'Blade steel', value: knife.specs.bladeMaterial },
    { label: 'Handle', value: knife.handleMaterial },
    { label: 'Finish', value: knife.specs.bladeCoating },
  ]
    .map((field) => ({ ...field, value: field.value?.trim() }))
    .filter((field): field is { label: string; value: string } =>
      Boolean(field.value),
    )

  if (label === knife.id || label.endsWith(` · ${knife.id}`)) {
    fields.push({ label: 'Record', value: knife.id })
  }

  return fields
}

export function KnifeVariantSwitcher({ knife }: { knife: Knife }) {
  const { knives } = useKnives()
  const { openFamilyKey, setOpenFamilyKey } = useKnifeFamilyPanel()
  const familyKey = getKnifeFamilyKey(knife)
  const siblings = knives.filter(
    (item) => getKnifeFamilyKey(item) === familyKey,
  )
  if (siblings.length < 2) return null

  return (
    <Collapsible
      open={openFamilyKey === familyKey}
      onOpenChange={(open) => setOpenFamilyKey(open ? familyKey : null)}
      className="mb-6 min-w-0 rounded-xl border border-border bg-card"
    >
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
            const fields = getVariantFields(sibling, label)
            return (
              <Link
                key={sibling.id}
                href={`/collection/${sibling.id}`}
                aria-current={active ? 'page' : undefined}
                aria-label={`${sibling.brand} ${sibling.name} · ${label}`}
                className={cn(
                  'relative grid min-w-0 grid-cols-[7rem_minmax(0,1fr)] items-stretch gap-3 rounded-lg border p-2 pr-8 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4 sm:p-3 sm:pr-10',
                  active
                    ? 'border-[var(--bladevault-gold)] bg-accent'
                    : 'border-border hover:bg-accent/50',
                )}
              >
                <span
                  className="relative min-h-28 w-full overflow-hidden rounded-md border border-border/60 bg-white sm:min-h-32"
                  data-variant-preview
                >
                  {sibling.images[0] ? (
                    <Image
                      src={getImageUrl(sibling.images[0])}
                      alt=""
                      fill
                      sizes="(min-width: 640px) 144px, 112px"
                      className="object-contain p-2"
                    />
                  ) : (
                    <span className="flex h-full items-center justify-center bg-muted/30 text-muted-foreground/50">
                      <ImageIcon className="size-4" aria-hidden="true" />
                    </span>
                  )}
                </span>
                <dl className="min-w-0 self-center [overflow-wrap:anywhere]">
                  {fields.map((field) => (
                    <div
                      key={field.label}
                      className="grid min-w-0 grid-cols-1 gap-2 border-b border-border/60 py-1.5 first:pt-0 last:border-b-0 last:pb-0 sm:grid-cols-[4rem_minmax(0,1fr)]"
                    >
                      <dt className="sr-only text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground sm:not-sr-only">
                        {field.label}
                      </dt>
                      <dd className="min-w-0 font-medium leading-4">
                        {field.value}
                      </dd>
                    </div>
                  ))}
                </dl>
                {active && (
                  <Check
                    className="absolute right-3 top-3 size-4"
                    aria-hidden="true"
                  />
                )}
              </Link>
            )
          })}
        </nav>
      </CollapsibleContent>
    </Collapsible>
  )
}

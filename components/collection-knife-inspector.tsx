'use client'

import Image from 'next/image'
import Link from 'next/link'
import { ChevronDown, ImageIcon, Scale } from 'lucide-react'
import { useState } from 'react'
import { Button, buttonVariants } from '@/components/ui/button'
import { useKnives } from '@/components/providers/knives-provider'
import { getImageUrl, type Knife } from '@/lib/data'
import { getKnifeVariantLabel } from '@/lib/knife-families'
import { cn } from '@/lib/utils'

function preferredMetric(value?: string): string {
  if (!value) return 'Not recorded'
  return value.split('|').at(-1)?.trim() ?? value
}

export function CollectionKnifeInspector({
  knife,
  siblings,
  onSelect,
}: {
  knife: Knife
  siblings: Knife[]
  onSelect: (knife: Knife) => void
}) {
  const { compareIds, addToCompare, removeFromCompare, showFeedback } =
    useKnives()
  const [imageIndex, setImageIndex] = useState(0)
  const [isUpdatingCompare, setIsUpdatingCompare] = useState(false)
  const [isMobileExpanded, setIsMobileExpanded] = useState(true)
  const inCompare = compareIds.includes(knife.id)
  const image = knife.images[imageIndex]

  const toggleCompare = async () => {
    setIsUpdatingCompare(true)
    try {
      if (inCompare) {
        await removeFromCompare(knife.id)
        showFeedback('Removed from compare')
      } else {
        await addToCompare(knife.id)
        showFeedback('Added to compare')
      }
    } catch (error) {
      showFeedback(
        error instanceof Error ? error.message : 'Could not update comparison.',
        'error',
      )
    } finally {
      setIsUpdatingCompare(false)
    }
  }

  return (
    <aside
      aria-label={`Selected knife: ${knife.brand} ${knife.name}`}
      className={cn(
        'fixed inset-x-2 bottom-2 z-30 overflow-y-auto overscroll-contain rounded-xl border border-[var(--bladevault-line)] bg-background shadow-2xl xl:inset-y-4 xl:left-auto xl:right-4 xl:max-h-none xl:w-[26rem]',
        isMobileExpanded ? 'max-h-[min(78dvh,44rem)]' : 'max-h-16',
      )}
      data-collection-inspector
    >
      <div className="sticky top-0 z-10 flex min-h-16 items-center justify-between gap-3 border-b border-border bg-background/95 px-5 py-3 text-xs text-muted-foreground backdrop-blur-sm">
        <span className="min-w-0 truncate">
          <span className="hidden xl:inline">Collection / Selected knife</span>
          <span className="xl:hidden">
            Selected / {knife.brand} {knife.name}
          </span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => setIsMobileExpanded((current) => !current)}
          aria-expanded={isMobileExpanded}
          aria-label={
            isMobileExpanded
              ? 'Minimize selected knife'
              : 'Expand selected knife'
          }
          className="shrink-0 xl:hidden"
        >
          <ChevronDown
            className={cn(
              'size-4 transition-transform',
              !isMobileExpanded && 'rotate-180',
            )}
          />
        </Button>
      </div>

      <div className={cn(!isMobileExpanded && 'hidden xl:block')}>
        <div className="relative aspect-video bg-white">
          {image ? (
            <Image
              src={getImageUrl(image)}
              alt={`${knife.brand} ${knife.name}`}
              fill
              sizes="(max-width: 640px) calc(100vw - 1rem), 26rem"
              className="object-contain p-5"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <ImageIcon className="size-10" aria-hidden="true" />
            </div>
          )}
          {knife.images.length > 1 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setImageIndex((current) => (current + 1) % knife.images.length)
              }
              className="absolute bottom-3 right-3 bg-background/95"
            >
              Photo {imageIndex + 1} / {knife.images.length} →
            </Button>
          )}
        </div>

        <div className="border-t border-border px-5 py-6">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {knife.brand}
          </p>
          <h2
            id="collection-inspector-title"
            className="mt-1 text-3xl font-medium tracking-tight text-foreground"
          >
            {knife.name}
          </h2>
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            {knife.specs.modelNumber || 'Model number not recorded'}
          </p>

          {siblings.length > 1 && (
            <section
              className="mt-6"
              aria-labelledby="inspector-variants-title"
            >
              <h3
                id="inspector-variants-title"
                className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
              >
                {siblings.length} variants in your collection
              </h3>
              <div className="mt-3 flex flex-wrap gap-2">
                {siblings.map((sibling) => (
                  <Button
                    key={sibling.id}
                    type="button"
                    variant={sibling.id === knife.id ? 'secondary' : 'outline'}
                    size="xs"
                    onClick={() => onSelect(sibling)}
                    aria-pressed={sibling.id === knife.id}
                    title={getKnifeVariantLabel(sibling, siblings)}
                    className="font-mono"
                  >
                    {sibling.specs.modelNumber || sibling.name}
                  </Button>
                ))}
              </div>
            </section>
          )}

          <dl className="mt-7 grid grid-cols-2 gap-x-6 gap-y-5">
            {[
              ['Blade material', knife.specs.bladeMaterial],
              ['Handle', knife.handleMaterial],
              ['Blade length', preferredMetric(knife.specs.bladeLength)],
              ['Weight', preferredMetric(knife.specs.weight)],
              ['Lock', knife.specs.lockingMechanism],
              ['Designer', knife.specs.designer],
            ].map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-[10px] text-muted-foreground">{label}</dt>
                <dd className="mt-1 text-xs font-medium text-foreground [overflow-wrap:anywhere]">
                  {value || 'Not recorded'}
                </dd>
              </div>
            ))}
          </dl>

          <div className="mt-7 flex flex-wrap gap-2 border-b border-border pb-5">
            <Link
              href={`/collection/${knife.id}`}
              className={cn(buttonVariants({ size: 'sm' }))}
            >
              Open full page →
            </Link>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={toggleCompare}
              disabled={isUpdatingCompare}
            >
              <Scale className="size-3.5" />
              {inCompare ? 'Remove from compare' : 'Add to compare'}
            </Button>
          </div>

          <p className="mt-4 text-xs leading-5 text-muted-foreground">
            This selection stays open while you search, filter, scroll, or
            change views. Choose another knife to replace it.
          </p>
        </div>
      </div>
    </aside>
  )
}

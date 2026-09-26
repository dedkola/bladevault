'use client'

import { useComparisons } from '@/components/providers/comparisons-provider'

import Image from 'next/image'
import Link from 'next/link'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ImageIcon,
  Scale,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, buttonVariants } from '@/components/ui/button'
import { useKnives } from '@/components/providers/knives-provider'
import { getImageUrl, getKnifeImageCount, type Knife } from '@/lib/data'
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
  const { showFeedback } = useKnives()
  const [imageIndex, setImageIndex] = useState(0)
  const [fullImages, setFullImages] = useState<string[] | null>(null)
  const [isUpdatingCompare, setIsUpdatingCompare] = useState(false)
  const [isMobileExpanded, setIsMobileExpanded] = useState(true)
  const {
    choose,
    membershipCount,
    lists: comparisonLists,
    loading: comparisonsLoading,
    error: comparisonsError,
  } = useComparisons()
  const comparisonCount = membershipCount(knife.id)
  const inCompare = comparisonCount > 0
  const imageCount = getKnifeImageCount(knife)
  const images = fullImages ?? knife.images
  const image = images[imageIndex]
  const nextImage = () =>
    setImageIndex((current) => (current + 1) % images.length)
  const prevImage = () =>
    setImageIndex((current) => (current - 1 + images.length) % images.length)

  useEffect(() => {
    if (imageCount <= knife.images.length) return

    const controller = new AbortController()
    void fetch(`/api/knives/${encodeURIComponent(knife.id)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return
        const data = (await response.json()) as { knife?: Knife }
        if (Array.isArray(data.knife?.images)) {
          setFullImages(data.knife.images)
        }
      })
      .catch(() => {
        // Keep the list thumbnail available if detail loading fails.
      })

    return () => controller.abort()
  }, [imageCount, knife.id, knife.images.length])

  const toggleCompare = async () => {
    setIsUpdatingCompare(true)
    try {
      await choose([knife.id])
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
          {images.length > 1 && (
            <>
              <button
                type="button"
                onClick={prevImage}
                className="absolute left-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center text-[var(--bladevault-gold)] transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bladevault-gold)]"
                aria-label="Previous image"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={nextImage}
                className="absolute right-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center text-[var(--bladevault-gold)] transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bladevault-gold)]"
                aria-label="Next image"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </>
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
              disabled={
                isUpdatingCompare ||
                comparisonsLoading ||
                Boolean(comparisonsError)
              }
            >
              <Scale className="size-3.5" />
              {comparisonLists.length > 1
                ? inCompare
                  ? `In ${comparisonCount} ${comparisonCount === 1 ? 'list' : 'lists'}`
                  : 'Add to compare'
                : inCompare
                  ? 'Remove from compare'
                  : 'Add to compare'}
            </Button>
          </div>
        </div>
      </div>
    </aside>
  )
}

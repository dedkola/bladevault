'use client'

import { useRef, useSyncExternalStore, type RefObject } from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import Link from 'next/link'
import { SoldBadge } from '@/components/sold-badge'
import { ChevronLeft, ChevronRight, ImageIcon, Pencil, X } from 'lucide-react'
import Image from '@/components/vault-image'
import { Button, buttonVariants } from '@/components/ui/button'
import { formatDimension } from '@/lib/measurements'
import { InspectorTabs } from '@/components/inspector-tabs'
import type { DimensionUnit } from '@/lib/settings-shared'
import { getImageUrl, type Knife } from '@/lib/data'

const phoneInspectorQuery = '(max-width: 950px)'
const phoneInspectorSnapshot = () =>
  window.matchMedia(phoneInspectorQuery).matches
const desktopInspectorSnapshot = () => false
function subscribePhoneInspector(onChange: () => void) {
  const media = window.matchMedia(phoneInspectorQuery)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

export function ModernCollectionInspector({
  knife,
  variant = 'modern',
  dimensionUnit = 'in',
  siblings,
  image,
  hasMoreImages,
  onPreviousImage,
  onNextImage,
  onSelect,
  onClose,
  onPin,
  onCompare,
  pinBusy,
  compareBusy,
  inCompare,
  autoSelected,
  returnFocusRef,
}: {
  knife: Knife
  variant?: 'modern' | 'alloy'
  dimensionUnit?: DimensionUnit
  siblings: Knife[]
  image?: string
  hasMoreImages: boolean
  onPreviousImage: () => void
  onNextImage: () => void
  onSelect: (knife: Knife) => void
  onClose: () => void
  onPin: () => void
  onCompare: () => void
  pinBusy: boolean
  compareBusy: boolean
  inCompare: boolean
  autoSelected: boolean
  returnFocusRef?: RefObject<HTMLElement | null>
}) {
  const isPhone = useSyncExternalStore(
    subscribePhoneInspector,
    phoneInspectorSnapshot,
    desktopInspectorSnapshot,
  )
  const isPhoneDialog = variant === 'alloy' && isPhone && !autoSelected
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const contents = (
    <>
      <div data-inspector-header>
        <span>{variant === 'alloy' ? 'In focus' : 'Knife inspector'}</span>
        <div className="flex items-center gap-1">
          <Link
            href={`/collection/${knife.id}?edit=1`}
            className={buttonVariants({ variant: 'ghost', size: 'icon-xs' })}
            aria-label="Edit selected knife"
          >
            <Pencil className="size-3" />
          </Link>
          {isPhoneDialog ? (
            <DialogPrimitive.Close
              ref={closeButtonRef}
              render={<Button variant="ghost" size="icon-xs" />}
              aria-label="Close selected knife"
            >
              <X className="size-3.5" />
            </DialogPrimitive.Close>
          ) : (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onClose}
              aria-label="Close selected knife"
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
      <div data-inspector-image className="relative">
        {image ? (
          <Image
            src={getImageUrl(image)}
            alt={`${knife.brand} ${knife.name}`}
            fill
            sizes="(max-width: 820px) 300px, 322px"
            className="object-contain"
          />
        ) : (
          <ImageIcon className="size-8 text-muted-foreground" />
        )}
        {hasMoreImages && (
          <>
            <button
              onClick={onPreviousImage}
              aria-label="Previous image"
              className="absolute left-1 top-1/2 -translate-y-1/2 rounded-full p-1 text-primary focus-visible:outline-2"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              onClick={onNextImage}
              aria-label="Next image"
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full p-1 text-primary focus-visible:outline-2"
            >
              <ChevronRight className="size-4" />
            </button>
          </>
        )}
      </div>
      {variant === 'alloy' && knife.specs.bladeLength && (
        <div data-alloy-measure>
          <span>
            {formatDimension(knife.specs.bladeLength, dimensionUnit) ||
              'Not recorded'}{' '}
            blade
          </span>
        </div>
      )}
      <div data-inspector-body>
        <div data-inspector-identity>
          {variant === 'alloy' && (
            <p data-alloy-inspector-brand>{knife.brand}</p>
          )}
          <h2 id="collection-inspector-title">{knife.name}</h2>
          {knife.sold && <SoldBadge className="mt-2" />}
          <p>
            {knife.brand} · {knife.specs.modelNumber || 'Model not recorded'} ·{' '}
            {new Date(knife.addedAt).getFullYear()}
          </p>
        </div>
        <div data-inspector-actions>
          <Link
            href={`/collection/${knife.id}`}
            className={buttonVariants({ size: 'sm' })}
          >
            Open knife
          </Link>
          <Button
            variant="outline"
            size="sm"
            onClick={onPin}
            aria-pressed={knife.pinned}
            disabled={pinBusy}
          >
            {knife.pinned ? 'Pinned' : 'Pin'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onCompare}
            aria-pressed={inCompare}
            disabled={compareBusy}
          >
            {inCompare ? 'In list' : 'Compare'}
          </Button>
        </div>
        <InspectorTabs
          knife={knife}
          variant={variant}
          dimensionUnit={dimensionUnit}
        />
        <div data-inspector-family>
          <span>In the family</span>
          {siblings.length > 1 ? (
            <div>
              {siblings
                .filter((sibling) => sibling.id !== knife.id)
                .map((sibling) => (
                  <button key={sibling.id} onClick={() => onSelect(sibling)}>
                    {sibling.specs.modelNumber || sibling.name}
                  </button>
                ))}
            </div>
          ) : (
            <p>No other variants.</p>
          )}
        </div>
      </div>
    </>
  )
  const inspectorProps = {
    'data-collection-inspector': true,
    'data-modern-inspector': true,
    'data-alloy-inspector': variant === 'alloy' || undefined,
    'data-auto-selected': autoSelected || undefined,
    'aria-label': `Selected knife: ${knife.brand} ${knife.name}`,
  }
  if (isPhoneDialog) {
    return (
      <DialogPrimitive.Root
        open
        disablePointerDismissal
        onOpenChange={(open) => {
          if (!open) onClose()
        }}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Popup
            {...inspectorProps}
            render={<aside />}
            aria-labelledby="collection-inspector-title"
            initialFocus={closeButtonRef}
            finalFocus={() =>
              returnFocusRef?.current?.isConnected
                ? returnFocusRef.current
                : document.querySelector<HTMLElement>(
                    '[data-alloy-collection-search] input',
                  )
            }
          >
            {contents}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    )
  }
  return <aside {...inspectorProps}>{contents}</aside>
}

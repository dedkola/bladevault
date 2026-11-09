'use client'

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import Link from 'next/link'
import { SoldBadge } from '@/components/sold-badge'
import {
  ChevronLeft,
  ChevronRight,
  ImageIcon,
  Pencil,
  Pin,
  X,
} from 'lucide-react'
import { CompareIcon } from '@/components/icons/compare-icon'
import Image from '@/components/vault-image'
import { Button, buttonVariants } from '@/components/ui/button'
import { formatDimension, formatWeight } from '@/lib/measurements'
import type { DimensionUnit } from '@/lib/settings-shared'
import {
  getImageUrl,
  maintenanceTypeName,
  type Knife,
  type MaintenanceEvent,
} from '@/lib/data'

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
  const [tab, setTab] = useState<'overview' | 'specifications' | 'history'>(
    'overview',
  )
  const [history, setHistory] = useState<MaintenanceEvent[]>([])
  const [historyStatus, setHistoryStatus] = useState<
    'loading' | 'ready' | 'error'
  >('loading')
  useEffect(() => {
    if (tab !== 'history') return
    const controller = new AbortController()
    fetch(`/api/knives/${encodeURIComponent(knife.id)}/maintenance`, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('History unavailable')
        const data = (await response.json()) as { events?: MaintenanceEvent[] }
        setHistory(data.events ?? [])
        setHistoryStatus('ready')
      })
      .catch(() => {
        if (!controller.signal.aborted) setHistoryStatus('error')
      })
    return () => controller.abort()
  }, [knife.id, tab])
  const specs =
    tab === 'overview'
      ? variant === 'alloy'
        ? [
            [
              'Blade length',
              formatDimension(knife.specs.bladeLength, dimensionUnit) ||
                'Not recorded',
            ],
            [
              'Weight',
              formatWeight(knife.specs.weight, dimensionUnit) || 'Not recorded',
            ],
            ['Blade steel', knife.specs.bladeMaterial],
            ['Handle', knife.handleMaterial],
          ]
        : [
            ['Maker', knife.brand],
            ['Designer', knife.specs.designer],
            ['Lock', knife.specs.lockingMechanism],
            [
              'Weight',
              formatWeight(knife.specs.weight, dimensionUnit) || 'Not recorded',
            ],
            ['Handle', knife.handleMaterial],
            ['Family', knife.name],
          ]
      : [
          ['Blade material', knife.specs.bladeMaterial],
          ['Hardness', knife.specs.hardness],
          [
            'Blade length',
            formatDimension(knife.specs.bladeLength, dimensionUnit) ||
              'Not recorded',
          ],
          [
            'Overall length',
            formatDimension(knife.specs.overallLength, dimensionUnit) ||
              'Not recorded',
          ],
          [
            'Thickness',
            formatDimension(knife.specs.bladeThickness, dimensionUnit) ||
              'Not recorded',
          ],
          ['Finish', knife.specs.bladeCoating],
          ['Lock', knife.specs.lockingMechanism],
          ['Model', knife.specs.modelNumber],
          [
            'Handle length',
            formatDimension(knife.specs.handleLength, dimensionUnit) ||
              'Not recorded',
          ],
          ['Country', knife.specs.country],
          ['Price', knife.specs.price],
        ]
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
            <Pin data-inspector-action-icon aria-hidden="true" />
            {knife.pinned ? 'Pinned' : 'Pin'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onCompare}
            aria-pressed={inCompare}
            disabled={compareBusy}
          >
            <CompareIcon data-inspector-action-icon aria-hidden="true" />
            {inCompare ? 'In list' : 'Compare'}
          </Button>
        </div>
        <div data-inspector-tabs role="tablist" aria-label="Knife information">
          {(['overview', 'specifications', 'history'] as const).map((value) => (
            <button
              key={value}
              id={`inspector-tab-${value}`}
              role="tab"
              aria-selected={tab === value}
              aria-controls={`inspector-panel-${value}`}
              tabIndex={tab === value ? 0 : -1}
              onClick={() => setTab(value)}
              onKeyDown={(event) => {
                const tabs = ['overview', 'specifications', 'history'] as const
                const index = tabs.indexOf(value)
                const next =
                  event.key === 'ArrowRight'
                    ? tabs[(index + 1) % 3]
                    : event.key === 'ArrowLeft'
                      ? tabs[(index + 2) % 3]
                      : event.key === 'Home'
                        ? tabs[0]
                        : event.key === 'End'
                          ? tabs[2]
                          : null
                if (next) {
                  event.preventDefault()
                  setTab(next)
                  document.getElementById(`inspector-tab-${next}`)?.focus()
                }
              }}
            >
              {value.charAt(0).toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
        <div
          data-inspector-panel
          id={`inspector-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`inspector-tab-${tab}`}
        >
          {tab === 'overview' && (
            <>
              <p data-inspector-note>
                {variant === 'alloy' && (
                  <span data-alloy-note-label>Collector’s note</span>
                )}
                {knife.description || 'No notes recorded.'}
              </p>
              <div data-inspector-chips>
                {[
                  knife.specs.bladeMaterial,
                  knife.specs.bladeLength
                    ? formatDimension(knife.specs.bladeLength, dimensionUnit) ||
                      'Not recorded'
                    : '',
                  knife.bladeStyle,
                ]
                  .filter(Boolean)
                  .map((value, index) => (
                    <span key={`${value}-${index}`}>{value}</span>
                  ))}
              </div>
            </>
          )}
          {tab === 'history' ? (
            <ul data-inspector-history>
              <li>
                <b>Catalogued</b>
                <span>{new Date(knife.addedAt).toLocaleDateString()}</span>
              </li>
              {knife.updatedAt !== knife.addedAt && (
                <li>
                  <b>Record updated</b>
                  <span>{new Date(knife.updatedAt).toLocaleDateString()}</span>
                </li>
              )}
              {historyStatus === 'loading' ? (
                <li role="status">Loading maintenance history…</li>
              ) : historyStatus === 'error' ? (
                <li role="status">
                  Maintenance history is unavailable. Open the knife to retry.
                </li>
              ) : (
                history.map((event) => (
                  <li key={event.id}>
                    <b>{maintenanceTypeName(event.type)}</b>
                    <span>
                      {new Date(event.occurredAt).toLocaleDateString()}
                      {event.notes ? ` · ${event.notes}` : ''}
                    </span>
                  </li>
                ))
              )}
            </ul>
          ) : (
            <dl data-inspector-specs>
              {specs.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value || 'Not recorded'}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
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

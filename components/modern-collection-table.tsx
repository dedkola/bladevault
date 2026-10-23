'use client'

import Image from '@/components/vault-image'
import { ChevronRight, ImageIcon } from 'lucide-react'
import { getImageUrl, type Knife } from '@/lib/data'
import { cn } from '@/lib/utils'
import { compactMeasurement as preferredMetric } from '@/lib/compact-measurement'

function statusForKnife(knife: Knife) {
  if (knife.pinned) return { label: 'Pinned', tone: 'pinned' as const }
  if (
    !knife.specs.designer ||
    !knife.specs.bladeLength ||
    !knife.handleMaterial ||
    !knife.bladeStyle ||
    !knife.specs.lockingMechanism
  ) {
    return { label: 'Needs detail', tone: 'missing' as const }
  }
  return { label: 'Complete', tone: 'complete' as const }
}

export function ModernCollectionTable({
  knives,
  activeKnifeId,
  onOpen,
  onOpenDetail,
}: {
  knives: Knife[]
  activeKnifeId?: string | null
  onOpen: (knife: Knife) => void
  onOpenDetail: (knife: Knife) => void
}) {
  return (
    <div data-modern-collection-table>
      <div className="mb-2 flex items-center justify-between gap-3 text-[10.5px] text-muted-foreground">
        <span>
          <b className="font-medium text-foreground">{knives.length}</b> objects
        </span>
        <span className="hidden sm:inline">
          Select a row to inspect · double-click to open
        </span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-[0_1px_2px_rgb(0_0_0/4%)]">
        <table className="w-full table-fixed border-collapse text-left">
          <thead>
            <tr className="border-b border-border bg-[var(--bladevault-surface-soft)] text-[9.5px] text-muted-foreground">
              <th scope="col" className="w-[38%] px-3 py-2 font-medium">
                Object
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Maker
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Steel
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Blade
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Weight
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Status
              </th>
              <th scope="col" className="w-6 px-2 py-2" aria-label="Open" />
            </tr>
          </thead>
          <tbody>
            {knives.map((knife) => {
              const active = knife.id === activeKnifeId
              const status = statusForKnife(knife)
              const modelNumber = knife.specs.modelNumber?.trim()
              const designer = knife.specs.designer?.trim()

              return (
                <tr
                  key={knife.id}
                  tabIndex={0}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => onOpen(knife)}
                  onDoubleClick={() => onOpenDetail(knife)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onOpen(knife)
                    if (event.key === ' ') {
                      event.preventDefault()
                      onOpen(knife)
                    }
                  }}
                  className={cn(
                    'group cursor-pointer border-b border-border/70 text-[10.5px] text-muted-foreground transition-colors last:border-b-0 hover:bg-[var(--bladevault-surface-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    active &&
                      'bg-[var(--bladevault-nav-active-bg)] shadow-[inset_2px_0_0_var(--bladevault-nav-active-fg)]',
                  )}
                >
                  <td className="px-3 py-[7px]">
                    <div className="flex min-w-0 items-center gap-[9px]">
                      <div className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-[7px] bg-[#f5f5f7]">
                        {knife.images[0] ? (
                          <Image
                            src={getImageUrl(knife.images[0])}
                            alt=""
                            width={40}
                            height={40}
                            className="size-9 object-contain p-0.5 mix-blend-multiply"
                            sizes="36px"
                          />
                        ) : (
                          <ImageIcon
                            className="size-4 text-[#86868b]"
                            aria-hidden="true"
                          />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-[11.5px] font-[550] tracking-[-0.01em] text-foreground">
                          {knife.name}
                        </div>
                        <div className="truncate mt-px text-[9.5px] text-muted-foreground">
                          {modelNumber || '—'}
                          <span className="px-1 opacity-40">·</span>
                          {designer || 'Designer missing'}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="truncate px-2 py-[7px]" title={knife.brand}>
                    {knife.brand || '—'}
                  </td>
                  <td
                    className="truncate px-2 py-[7px] font-medium text-foreground"
                    title={knife.specs.bladeMaterial}
                  >
                    {knife.specs.bladeMaterial || '—'}
                  </td>
                  <td className="truncate px-2 py-[7px] tabular-nums">
                    {preferredMetric(knife.specs.bladeLength)}
                  </td>
                  <td className="truncate px-2 py-[7px] tabular-nums">
                    {preferredMetric(knife.specs.weight)}
                  </td>
                  <td className="px-2 py-[7px]">
                    <span
                      className={cn(
                        'inline-flex whitespace-nowrap rounded-full px-1.5 py-1 text-[9px] font-medium leading-none',
                        status.tone === 'complete' &&
                          'bg-[#2f9e6d]/10 text-[#2f9e6d]',
                        status.tone === 'pinned' &&
                          'bg-[var(--bladevault-nav-active-bg)] text-[var(--bladevault-nav-active-fg)]',
                        status.tone === 'missing' &&
                          'bg-[#f6821f]/10 text-[#c66a15]',
                      )}
                    >
                      {status.label}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">
                    <ChevronRight
                      className={cn(
                        'size-3 opacity-30 transition-opacity group-hover:opacity-100',
                        active &&
                          'text-[var(--bladevault-nav-active-fg)] opacity-100',
                      )}
                      strokeWidth={1.7}
                      aria-hidden="true"
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function ModernCollectionGallery({
  knives,
  activeKnifeId,
  onOpen,
}: {
  knives: Knife[]
  activeKnifeId?: string | null
  onOpen: (knife: Knife) => void
}) {
  return (
    <div data-collection-grid data-modern-collection-gallery>
      {knives.map((knife, index) => (
        <button
          key={knife.id}
          type="button"
          data-modern-object-card
          aria-label={`Preview ${knife.brand} ${knife.name}`}
          aria-pressed={knife.id === activeKnifeId}
          onClick={() => onOpen(knife)}
        >
          <span data-modern-object-stage>
            {knife.images[0] ? (
              <Image
                src={getImageUrl(knife.images[0])}
                alt={`${knife.brand} ${knife.name}`}
                fill
                sizes="(max-width: 560px) 100vw, (max-width: 820px) 50vw, 350px"
                priority={index === 0}
                className="object-contain"
              />
            ) : (
              <ImageIcon className="size-6 text-muted-foreground" />
            )}
          </span>
          <span data-modern-object-caption>
            <span>
              <b>{knife.name}</b>
              <span>
                {knife.brand} · {knife.specs.bladeMaterial || '—'}
              </span>
            </span>
            <span>{preferredMetric(knife.specs.bladeLength)}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

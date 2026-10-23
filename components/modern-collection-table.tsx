'use client'

import Image from '@/components/vault-image'
import { ChevronRight } from 'lucide-react'
import { getImageUrl, type Knife } from '@/lib/data'
import { cn } from '@/lib/utils'

function preferredMetric(value?: string): string {
  if (!value) return '—'
  return value.split('|')[0]?.trim() ?? value
}

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
    <div
      data-modern-collection-table
      className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border bg-[var(--bladevault-surface-soft)] px-3 py-1.5 text-[9px] text-muted-foreground">
        <span>
          <b className="font-medium text-foreground">{knives.length}</b> objects
        </span>
        <span className="hidden sm:inline">
          Select a row to inspect · double-click to open
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-left">
          <thead>
            <tr className="border-b border-border bg-card text-[9px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              <th className="w-[38%] px-3 py-1.5">Object</th>
              <th className="px-3 py-1.5">Maker</th>
              <th className="px-3 py-1.5">Steel</th>
              <th className="px-3 py-1.5">Blade</th>
              <th className="px-3 py-1.5">Weight</th>
              <th className="px-3 py-1.5">Status</th>
              <th className="w-6 px-2 py-1.5" aria-label="Open" />
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
                    'group cursor-pointer border-b border-border/70 text-[10.5px] text-muted-foreground transition-colors last:border-b-0 hover:bg-[var(--bladevault-surface-hover)]/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    active &&
                      'bg-[var(--bladevault-nav-active-bg)] shadow-[inset_2px_0_0_var(--bladevault-nav-active-fg)]',
                  )}
                >
                  <td className="px-3 py-1">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg bg-[var(--bladevault-surface-soft)]">
                        {knife.images[0] ? (
                          <Image
                            src={getImageUrl(knife.images[0])}
                            alt=""
                            width={40}
                            height={40}
                            className="h-8 w-8 object-contain"
                            sizes="40px"
                          />
                        ) : null}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-[11px] font-medium text-foreground">
                          {knife.name}
                        </div>
                        <div className="truncate text-[9px] text-muted-foreground">
                          {modelNumber || '—'}
                          <span className="px-1 opacity-40">·</span>
                          {designer || 'Designer missing'}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="max-w-[130px] truncate px-3 py-1">
                    {knife.brand || '—'}
                  </td>
                  <td className="px-3 py-1 font-medium text-foreground">
                    {knife.specs.bladeMaterial || '—'}
                  </td>
                  <td className="px-3 py-1 tabular-nums">
                    {preferredMetric(knife.specs.bladeLength)}
                  </td>
                  <td className="px-3 py-1 tabular-nums">
                    {preferredMetric(knife.specs.weight)}
                  </td>
                  <td className="px-3 py-1">
                    <span
                      className={cn(
                        'inline-flex whitespace-nowrap rounded-full px-2 py-1 text-[9px] font-medium leading-none',
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
                        'size-3.5 opacity-30 transition-opacity group-hover:opacity-100',
                        active &&
                          'text-[var(--bladevault-nav-active-fg)] opacity-100',
                      )}
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

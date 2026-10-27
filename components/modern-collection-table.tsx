'use client'

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import Image from '@/components/vault-image'
import { ImageIcon } from 'lucide-react'
import { getImageUrl, type Knife } from '@/lib/data'
import { Checkbox } from '@/components/ui/checkbox'
import type { CollectionColumnDefinition } from '@/lib/collection-columns'
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
    return { label: 'Incomplete', tone: 'missing' as const }
  }
  return { label: 'Complete', tone: 'complete' as const }
}

// Collection summaries omit descriptions; load them only when this column is visible.
function KnifeDescription({ knife }: { knife: Knife }) {
  const [result, setResult] = useState<{ value?: string; error?: string }>({})
  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch(
          `/api/knives/${encodeURIComponent(knife.id)}`,
          { signal: controller.signal, cache: 'no-store' },
        )
        const data = await response.json()
        if (!response.ok)
          throw new Error(data.error || 'Could not load description')
        if (!controller.signal.aborted)
          setResult({ value: data.knife.description || '—' })
      } catch (error) {
        if (!controller.signal.aborted)
          setResult({
            error:
              error instanceof Error
                ? error.message
                : 'Could not load description',
          })
      }
    })()
    return () => controller.abort()
  }, [knife.id])
  return (
    <span title={result.error ?? result.value}>
      {result.error ?? result.value ?? 'Loading…'}
    </span>
  )
}

function ColumnResizeGrip({
  label,
  minWidth,
  width,
  onPreview,
  onCommit,
  onCancel,
}: {
  label: string
  minWidth: number
  width?: number
  onPreview: (width: number) => void
  onCommit: (width: number | undefined) => void
  onCancel: () => void
}) {
  const drag = useRef<{
    startX: number
    startWidth: number
    width: number
  } | null>(null)
  const clamp = (value: number) =>
    Math.round(Math.min(800, Math.max(minWidth, value)))
  return (
    <span
      role="separator"
      aria-label={`Resize ${label} column`}
      aria-orientation="vertical"
      aria-valuemin={minWidth}
      aria-valuemax={800}
      aria-valuenow={width}
      tabIndex={0}
      data-column-resize-grip
      title="Drag to resize · arrow keys adjust width · double-click to reset"
      onDragStart={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        const startWidth =
          event.currentTarget.parentElement!.getBoundingClientRect().width
        drag.current = { startX: event.clientX, startWidth, width: startWidth }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (!drag.current) return
        const next = clamp(
          drag.current.startWidth + event.clientX - drag.current.startX,
        )
        drag.current.width = next
        onPreview(next)
      }}
      onPointerUp={(event) => {
        if (!drag.current) return
        const next = clamp(drag.current.width)
        drag.current = null
        onCommit(next)
        event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={() => {
        drag.current = null
        onCancel()
      }}
      onLostPointerCapture={() => {
        if (drag.current) {
          drag.current = null
          onCancel()
        }
      }}
      onDoubleClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onCommit(undefined)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        event.stopPropagation()
        const current =
          event.currentTarget.parentElement!.getBoundingClientRect().width
        onCommit(clamp(current + (event.key === 'ArrowRight' ? 10 : -10)))
      }}
    />
  )
}

export function ModernCollectionTable({
  knives,
  activeKnifeId,
  onOpen,
  onOpenDetail,
  columns,
  selectedIds,
  onSelect,
  onSelectAll,
  allSelected,
  someSelected,
  selectionDisabled,
  onReorderColumn,
  columnWidths,
  onResizeColumn,
}: {
  columnWidths: Record<string, number>
  onResizeColumn: (key: string, width: number | undefined) => void
  onReorderColumn: (sourceId: string, targetId: string) => void
  columns: CollectionColumnDefinition[]
  selectedIds: Set<string>
  onSelect: (id: string) => void
  onSelectAll: () => void
  allSelected: boolean
  someSelected: boolean
  selectionDisabled?: boolean
  knives: Knife[]
  activeKnifeId?: string | null
  onOpen: (knife: Knife) => void
  onOpenDetail: (knife: Knife) => void
}) {
  const [previewWidths, setPreviewWidths] = useState<Record<string, number>>({})
  const widths = { ...columnWidths, ...previewWidths }
  const resizeGrip = (key: string, label: string) => {
    const clearPreview = () =>
      setPreviewWidths((current) => {
        const next = { ...current }
        delete next[key]
        return next
      })
    return (
      <ColumnResizeGrip
        label={label}
        minWidth={key === 'knife' ? 140 : 48}
        width={widths[key]}
        onPreview={(width) =>
          setPreviewWidths((current) => ({ ...current, [key]: width }))
        }
        onCommit={(width) => {
          onResizeColumn(key, width)
          clearPreview()
        }}
        onCancel={clearPreview}
      />
    )
  }
  const draggedId = useRef<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const moveColumn = (sourceId: string, targetId: string) => {
    onReorderColumn(sourceId, targetId)
    const column = columns.find((item) => item.key === sourceId)
    setAnnouncement(
      `${column?.label ?? 'Column'} moved to position ${columns.findIndex((item) => item.key === targetId) + 1}.`,
    )
  }
  return (
    <div
      data-modern-collection-table
      style={
        {
          '--collection-columns': [
            '28px',
            widths.knife ? `${widths.knife}px` : 'minmax(140px, 1.5fr)',
            ...columns.map((column) =>
              widths[column.key] ? `${widths[column.key]}px` : column.width,
            ),
          ].join(' '),
        } as CSSProperties
      }
    >
      <span className="sr-only" role="status">
        {announcement}
      </span>
      <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-[0_1px_2px_rgb(0_0_0/4%)]">
        <table className="w-full table-fixed border-collapse text-left">
          <thead>
            <tr className="border-b border-border bg-[var(--bladevault-surface-soft)] text-[length:var(--modern-font-secondary)] text-muted-foreground">
              <th scope="col" className="w-10 px-3 py-2">
                <Checkbox
                  aria-label="Select all matching knives"
                  checked={allSelected}
                  indeterminate={someSelected && !allSelected}
                  disabled={selectionDisabled}
                  onCheckedChange={onSelectAll}
                />
              </th>
              <th
                scope="col"
                data-column-heading
                aria-label="Knife"
                className="w-[38%] px-3 py-2 font-medium"
              >
                Knife
                {resizeGrip('knife', 'Knife')}
              </th>
              {columns.map((column, index) => (
                <th
                  key={column.key}
                  aria-label={column.label}
                  data-column-heading
                  scope="col"
                  className={cn(
                    'px-2 py-2 font-medium truncate',
                    dropTarget === column.key && 'ring-2 ring-inset ring-ring',
                  )}
                  onDragOver={(event) => {
                    if (!draggedId.current) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    setDropTarget(column.key)
                  }}
                  onDragLeave={(event) => {
                    if (
                      !event.currentTarget.contains(
                        event.relatedTarget as Node | null,
                      )
                    )
                      setDropTarget(null)
                  }}
                  onDrop={(event) => {
                    if (!draggedId.current) return
                    event.preventDefault()
                    const source = draggedId.current
                    draggedId.current = null
                    setDropTarget(null)
                    if (source !== column.key) moveColumn(source, column.key)
                  }}
                >
                  <button
                    type="button"
                    draggable
                    aria-label={`Reorder ${column.label} column`}
                    title="Drag to reorder columns · use Arrow Left or Arrow Right to move"
                    className="block w-full cursor-grab truncate rounded text-left focus-visible:outline-2 focus-visible:outline-ring active:cursor-grabbing"
                    onDragStart={(event) => {
                      draggedId.current = column.key
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('text/plain', column.key)
                    }}
                    onDragEnd={() => {
                      draggedId.current = null
                      setDropTarget(null)
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.key !== 'ArrowLeft' &&
                        event.key !== 'ArrowRight'
                      )
                        return
                      event.preventDefault()
                      const target =
                        columns[index + (event.key === 'ArrowLeft' ? -1 : 1)]
                      if (target) moveColumn(column.key, target.key)
                    }}
                  >
                    {column.label}
                  </button>
                  {resizeGrip(column.key, column.label)}
                </th>
              ))}
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
                    if (event.target !== event.currentTarget) return
                    if (event.key === 'Enter') onOpen(knife)
                    if (event.key === ' ') {
                      event.preventDefault()
                      onOpen(knife)
                    }
                  }}
                  className={cn(
                    'group cursor-pointer border-b border-border/70 text-[length:var(--modern-font-body)] text-muted-foreground transition-colors last:border-b-0 hover:bg-[var(--bladevault-surface-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    active &&
                      'bg-[var(--bladevault-nav-active-bg)] shadow-[inset_2px_0_0_var(--bladevault-nav-active-fg)]',
                  )}
                >
                  <td
                    className="px-3 py-1"
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <Checkbox
                      aria-label={`Select ${knife.name}`}
                      checked={selectedIds.has(knife.id)}
                      disabled={selectionDisabled}
                      onCheckedChange={() => onSelect(knife.id)}
                    />
                  </td>
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
                        <div className="truncate text-[length:var(--modern-font-body)] font-[550] tracking-[-0.01em] text-foreground">
                          {knife.name}
                        </div>
                        {(modelNumber || designer) && (
                          <div className="truncate mt-px text-[length:var(--modern-font-secondary)] text-muted-foreground">
                            {modelNumber}
                            {modelNumber && designer && (
                              <span className="px-1 opacity-40">·</span>
                            )}
                            {designer}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  {columns.map((column) => {
                    const value = column.getValue(knife)
                    return (
                      <td
                        key={column.key}
                        data-collection-status={
                          column.key === 'status' ? '' : undefined
                        }
                        className="truncate px-2 py-[7px]"
                        title={value || undefined}
                      >
                        {column.key === 'status' ? (
                          <span
                            className={cn(
                              'inline-flex whitespace-nowrap rounded-full px-1.5 py-1 text-[length:var(--modern-font-caption)] font-medium leading-none',
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
                        ) : column.key === 'description' ? (
                          <KnifeDescription
                            key={`${knife.id}:${knife.updatedAt}`}
                            knife={knife}
                          />
                        ) : (
                          value || '—'
                        )}
                      </td>
                    )
                  })}
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

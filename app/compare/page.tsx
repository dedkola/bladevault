'use client'

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import Image from 'next/image'
import Link from 'next/link'
import {
  ArchiveX,
  FileDown,
  ImageIcon,
  Lightbulb,
  ListPlus,
  Plus,
  Printer,
  Shuffle,
  X,
} from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import {
  getImageUrl,
  Knife,
  matchesKnifeSearch,
  prioritizePinnedKnives,
} from '@/lib/data'
import { useKnives } from '@/components/providers/knives-provider'
import { SearchField } from '@/components/search-field'
import { useDebouncedValue } from '@/lib/use-debounced-value'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Card, CardContent } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

function HorizontalScrollArea({
  children,
  label,
  className,
  viewportClassName,
}: {
  children: ReactNode
  label: string
  className?: string
  viewportClassName?: string
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [hasRightOverflow, setHasRightOverflow] = useState(false)

  const updateOverflow = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const nextHasRightOverflow =
      viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 1

    setHasRightOverflow((current) =>
      current === nextHasRightOverflow ? current : nextHasRightOverflow,
    )
  }, [])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const frame = window.requestAnimationFrame(updateOverflow)
    const resizeObserver = new ResizeObserver(updateOverflow)
    const mutationObserver = new MutationObserver(updateOverflow)

    resizeObserver.observe(viewport)
    if (viewport.firstElementChild instanceof HTMLElement) {
      resizeObserver.observe(viewport.firstElementChild)
    }
    mutationObserver.observe(viewport, { childList: true, subtree: true })
    viewport.addEventListener('scroll', updateOverflow, { passive: true })

    return () => {
      window.cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      viewport.removeEventListener('scroll', updateOverflow)
    }
  }, [updateOverflow])

  return (
    <div className={cn('relative min-w-0', className)}>
      <div
        ref={viewportRef}
        className={cn(
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          viewportClassName,
        )}
        role="region"
        aria-label={label}
        tabIndex={0}
      >
        {children}
      </div>
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-y-0 right-0 z-40 w-8 bg-gradient-to-l from-background to-transparent opacity-0 transition-opacity',
          hasRightOverflow && 'opacity-100',
        )}
      />
    </div>
  )
}

const builtInCompareRows = [
  { label: 'Overall Length', key: 'specs.overallLength' },
  { label: 'Blade Length', key: 'specs.bladeLength' },
  { label: 'Blade Thickness', key: 'specs.bladeThickness' },
  { label: 'Handle Length', key: 'specs.handleLength' },
  { label: 'Weight', key: 'specs.weight' },
  { label: 'Blade Material', key: 'specs.bladeMaterial' },
  { label: 'Blade Style', key: 'bladeStyle' },
  { label: 'Blade Coating / Finish', key: 'specs.bladeCoating' },
  { label: 'Hardness', key: 'specs.hardness' },
  { label: 'Locking Mechanism', key: 'specs.lockingMechanism' },
  { label: 'Handle Material', key: 'handleMaterial' },
  { label: 'Model Number', key: 'specs.modelNumber' },
  { label: 'Price', key: 'specs.price' },
  { label: 'Country', key: 'specs.country' },
] as const

type BuiltInCompareRowKey = (typeof builtInCompareRows)[number]['key']
type CompareRowKey = BuiltInCompareRowKey | `custom:${string}`

function getRowValue(knife: Knife, rowKey: CompareRowKey): string {
  if (rowKey.startsWith('custom:')) {
    const fieldId = rowKey.slice('custom:'.length)
    return knife.customFields[fieldId] ?? '-'
  }

  if (rowKey.includes('.')) {
    const specKey = rowKey.split('.')[1] as keyof Knife['specs']
    return knife.specs[specKey] ?? '-'
  }

  const knifeKey = rowKey as 'bladeStyle' | 'handleMaterial'
  return knife[knifeKey] ?? '-'
}

function getSearchResultSummary(knife: Knife): string {
  return [
    knife.specs.modelNumber ? `Model ${knife.specs.modelNumber}` : '',
    knife.specs.bladeMaterial,
    knife.bladeStyle,
    knife.handleMaterial,
    knife.specs.country,
  ]
    .filter(Boolean)
    .join(' · ')
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function buildPrintableHtml(
  comparedKnives: Knife[],
  generatedAt: string,
  compareRows: { label: string; key: CompareRowKey }[],
) {
  const headerCells = comparedKnives
    .map((knife) => `<th>${escapeHtml(`${knife.brand} ${knife.name}`)}</th>`)
    .join('')

  const bodyRows = compareRows
    .map((row) => {
      const cells = comparedKnives
        .map((knife) => `<td>${escapeHtml(getRowValue(knife, row.key))}</td>`)
        .join('')
      return `<tr><th>${escapeHtml(row.label)}</th>${cells}</tr>`
    })
    .join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>BladeVault Comparison</title>
  <style>
    body {
      margin: 24px;
      color: #111827;
      font-family: "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
      print-color-adjust: exact;
      -webkit-print-color-adjust: exact;
    }
    h1 {
      margin: 0 0 6px;
      font-size: 24px;
    }
    p {
      margin: 0 0 18px;
      color: #4b5563;
      font-size: 12px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      font-size: 12px;
    }
    thead th {
      background: #111827;
      color: #ffffff;
      text-align: left;
      border: 1px solid #d1d5db;
      padding: 8px;
      word-wrap: break-word;
    }
    tbody th {
      background: #f3f4f6;
      text-align: left;
      font-weight: 600;
    }
    td, tbody th {
      border: 1px solid #d1d5db;
      padding: 7px 8px;
      word-wrap: break-word;
      vertical-align: top;
    }
    tbody tr:nth-child(even) td {
      background: #f9fafb;
    }
    @media print {
      body {
        margin: 12mm;
      }
    }
  </style>
</head>
<body>
  <h1>BladeVault Comparison</h1>
  <p>Generated ${escapeHtml(generatedAt)}</p>
  <table>
    <thead>
      <tr>
        <th>Feature</th>
        ${headerCells}
      </tr>
    </thead>
    <tbody>
      ${bodyRows}
    </tbody>
  </table>
</body>
</html>`
}

export default function ComparePage() {
  const {
    knives,
    compareIds,
    addToCompare,
    addManyToCompare,
    removeFromCompare,
    clearCompare,
    pinnedItemsFirst,
    customFieldDefinitions,
    showFeedback,
  } = useKnives()
  const [hoveredCell, setHoveredCell] = useState<{
    knifeId: string
    rowKey: CompareRowKey
  } | null>(null)
  const [showDifferencesOnly, setShowDifferencesOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [isBulkAdding, setIsBulkAdding] = useState(false)
  const printFrameRef = useRef<HTMLIFrameElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const debouncedQuery = useDebouncedValue(query, 200)

  const compareRows: { label: string; key: CompareRowKey }[] = useMemo(
    () => [
      ...builtInCompareRows,
      ...customFieldDefinitions.map((field) => ({
        label: field.name,
        key: `custom:${field.id}` as `custom:${string}`,
      })),
    ],
    [customFieldDefinitions],
  )

  useEffect(() => {
    return () => {
      printFrameRef.current?.remove()
      printFrameRef.current = null
    }
  }, [])

  useEffect(() => {
    const handleSearchShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isTyping =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable

      if (event.key === '/' && !isTyping) {
        event.preventDefault()
        searchInputRef.current?.focus()
        return
      }

      if (
        event.key === 'Escape' &&
        document.activeElement === searchInputRef.current &&
        query
      ) {
        event.preventDefault()
        setQuery('')
      }
    }

    window.addEventListener('keydown', handleSearchShortcut)
    return () => window.removeEventListener('keydown', handleSearchShortcut)
  }, [query])

  const comparedKnives = prioritizePinnedKnives(
    compareIds
      .map((id) => knives.find((k) => k.id === id))
      .filter((k): k is Knife => Boolean(k)),
    pinnedItemsFirst,
  )
  const availableKnives = useMemo(
    () =>
      knives
        .filter((knife) => !compareIds.includes(knife.id))
        .sort((left, right) => {
          if (pinnedItemsFirst && left.pinned !== right.pinned) {
            return left.pinned ? -1 : 1
          }

          return (
            left.brand.localeCompare(right.brand) ||
            left.name.localeCompare(right.name)
          )
        }),
    [compareIds, knives, pinnedItemsFirst],
  )
  const filteredAvailableKnives = useMemo(() => {
    if (!debouncedQuery.trim()) return []

    return availableKnives.filter((knife) =>
      matchesKnifeSearch(knife, debouncedQuery),
    )
  }, [availableKnives, debouncedQuery])
  const suggestedKnives = useMemo(
    () =>
      [...availableKnives]
        .sort((left, right) => {
          if (pinnedItemsFirst && left.pinned !== right.pinned) {
            return left.pinned ? -1 : 1
          }
          return (
            new Date(right.addedAt).getTime() -
              new Date(left.addedAt).getTime() ||
            left.brand.localeCompare(right.brand) ||
            left.name.localeCompare(right.name)
          )
        })
        .slice(0, 4),
    [availableKnives, pinnedItemsFirst],
  )
  const hasSearchQuery = query.trim().length > 0
  const isSearchPending = query.trim() !== debouncedQuery.trim()

  const handleSelect = async (id: string) => {
    if (!id) return
    if (compareIds.includes(id)) return
    try {
      await addToCompare(id)
      showFeedback('Added to compare')
    } catch (error) {
      showFeedback(
        error instanceof Error ? error.message : 'Could not add to compare.',
        'error',
      )
    }
  }

  const handleBulkAdd = async () => {
    const ids = filteredAvailableKnives.map((knife) => knife.id)
    if (ids.length === 0) return

    try {
      setIsBulkAdding(true)
      await addManyToCompare(ids)
      showFeedback(
        `Added ${ids.length} ${ids.length === 1 ? 'knife' : 'knives'} to compare`,
      )
    } catch (error) {
      showFeedback(
        error instanceof Error
          ? error.message
          : 'Could not add matching knives to compare.',
        'error',
      )
    } finally {
      setIsBulkAdding(false)
    }
  }

  const handleRemove = (id: string) => {
    removeFromCompare(id)
  }

  const handleClearCompare = () => {
    void clearCompare()
  }

  const handleCompareRandomPair = async () => {
    const shuffled = [...knives].sort(() => Math.random() - 0.5)
    const pair = shuffled.slice(0, 2).map((knife) => knife.id)
    if (pair.length < 2) {
      showFeedback('Add at least two knives to compare.', 'error')
      return
    }
    try {
      await addManyToCompare(pair)
      showFeedback('Random pair added to compare')
    } catch (error) {
      showFeedback(
        error instanceof Error ? error.message : 'Could not add pair.',
        'error',
      )
    }
  }

  const hasComparedKnives = comparedKnives.length > 0
  const visibleCompareRows = useMemo(() => {
    if (!showDifferencesOnly) return compareRows

    return compareRows.filter((row) => {
      const values = new Set(
        comparedKnives.map((knife) => getRowValue(knife, row.key)),
      )
      return values.size > 1
    })
  }, [compareRows, comparedKnives, showDifferencesOnly])

  const handleExportPdf = async () => {
    if (!hasComparedKnives) return

    const [{ jsPDF }, { default: autoTable }] = await Promise.all([
      import('jspdf'),
      import('jspdf-autotable'),
    ])

    const doc = new jsPDF({
      orientation: 'landscape',
      unit: 'mm',
      format: 'a4',
    })

    const title = 'BladeVault Comparison Table'
    const head = [
      [
        'Feature',
        ...comparedKnives.map((knife) => `${knife.brand} ${knife.name}`),
      ],
    ]
    const body = visibleCompareRows.map((row) => [
      row.label,
      ...comparedKnives.map((knife) => getRowValue(knife, row.key)),
    ])

    autoTable(doc, {
      startY: 18,
      head,
      body,
      theme: 'grid',
      styles: {
        fontSize: 8,
        cellPadding: 2,
      },
      headStyles: {
        fillColor: [17, 24, 39],
        textColor: [255, 255, 255],
      },
      alternateRowStyles: {
        fillColor: [249, 250, 251],
      },
      columnStyles: {
        0: {
          fontStyle: 'bold',
          cellWidth: 46,
        },
      },
      didDrawPage: () => {
        doc.setFontSize(12)
        doc.text(title, 14, 12)
      },
    })

    doc.save(
      `bladevault-comparison-${new Date().toISOString().slice(0, 10)}.pdf`,
    )
  }

  const handlePrint = () => {
    if (!hasComparedKnives) return

    const generatedAt = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date())
    const printableHtml = buildPrintableHtml(
      comparedKnives,
      generatedAt,
      visibleCompareRows,
    )

    printFrameRef.current?.remove()

    const iframe = document.createElement('iframe')
    printFrameRef.current = iframe
    iframe.setAttribute('aria-hidden', 'true')
    iframe.title = 'BladeVault Print Frame'
    iframe.style.position = 'fixed'
    iframe.style.right = '0'
    iframe.style.bottom = '0'
    iframe.style.width = '0'
    iframe.style.height = '0'
    iframe.style.border = '0'
    iframe.style.opacity = '0'
    iframe.style.pointerEvents = 'none'

    iframe.addEventListener(
      'load',
      () => {
        const frameWindow = iframe.contentWindow
        if (!frameWindow) {
          iframe.remove()
          if (printFrameRef.current === iframe) {
            printFrameRef.current = null
          }
          return
        }

        let fallbackTimer = 0
        const cleanup = () => {
          frameWindow.removeEventListener('afterprint', cleanup)
          window.clearTimeout(fallbackTimer)
          iframe.remove()
          if (printFrameRef.current === iframe) {
            printFrameRef.current = null
          }
        }

        frameWindow.addEventListener('afterprint', cleanup, { once: true })
        fallbackTimer = window.setTimeout(cleanup, 10_000)

        frameWindow.focus()
        window.setTimeout(() => {
          try {
            frameWindow.print()
          } catch {
            cleanup()
          }
        }, 50)
      },
      { once: true },
    )

    document.body.appendChild(iframe)
    iframe.srcdoc = printableHtml
  }

  return (
    <div className="flex-1 p-6 lg:p-8 w-full max-w-7xl mx-auto">
      <PageHeader
        title="Compare"
        actions={
          knives.length > 0 ? (
            <div className="flex w-full flex-wrap justify-end gap-2 sm:w-auto">
              <Button
                variant="outline"
                size="sm"
                onClick={handleClearCompare}
                disabled={!hasComparedKnives}
              >
                <ArchiveX className="mr-2 h-4 w-4" />
                Clear
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void handleExportPdf()
                }}
                disabled={!hasComparedKnives}
              >
                <FileDown className="mr-2 h-4 w-4" />
                Export PDF
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handlePrint}
                disabled={!hasComparedKnives}
              >
                <Printer className="mr-2 h-4 w-4" />
                Print
              </Button>
            </div>
          ) : undefined
        }
      />

      {knives.length === 0 ? (
        <EmptyState
          title="Nothing to compare"
          description="Add at least one knife to use the comparison tool."
          icon={<ArchiveX className="h-8 w-8" />}
          action={
            <Button
              size="sm"
              render={<Link href="/add">Add your first knife</Link>}
              nativeButton={false}
            />
          }
        />
      ) : (
        <>
          <Card className="mb-6 border-[var(--bladevault-line)]/80 bg-background shadow-none">
            <CardContent className="space-y-3 p-4">
              <div>
                <div className="text-sm font-medium text-foreground">
                  Compare Lineup
                </div>
              </div>

              {availableKnives.length > 0 && (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <SearchField
                    value={query}
                    onChange={setQuery}
                    placeholder="Search model name…"
                    className="mx-0 max-w-none sm:max-w-sm sm:flex-1"
                    inputRef={searchInputRef}
                    shortcutHint="/"
                  />
                  {hasSearchQuery && (
                    <div
                      className="flex items-center gap-2 sm:ml-auto"
                      aria-live="polite"
                    >
                      {isSearchPending ? (
                        <span className="text-xs text-muted-foreground">
                          Searching…
                        </span>
                      ) : (
                        <>
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {filteredAvailableKnives.length}{' '}
                            {filteredAvailableKnives.length === 1
                              ? 'match'
                              : 'matches'}
                          </span>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              void handleBulkAdd()
                            }}
                            disabled={
                              filteredAvailableKnives.length === 0 ||
                              isBulkAdding
                            }
                          >
                            <ListPlus className="mr-1.5 h-4 w-4" />
                            {isBulkAdding
                              ? 'Adding…'
                              : `Add all ${filteredAvailableKnives.length}`}
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {availableKnives.length > 0 && hasSearchQuery && (
                <div
                  className="overflow-hidden rounded-lg border border-[var(--bladevault-line)]/70 bg-[color:var(--bladevault-surface-soft)]/30"
                  role="region"
                  aria-label="Available knife search results"
                >
                  <div className="border-b border-[var(--bladevault-line)]/60 px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-[var(--bladevault-title)]">
                    Search results
                  </div>
                  {isSearchPending ? (
                    <div className="px-3 py-5 text-center text-sm text-muted-foreground">
                      Searching…
                    </div>
                  ) : filteredAvailableKnives.length > 0 ? (
                    <ul className="max-h-56 divide-y divide-[var(--bladevault-line)]/50 overflow-y-auto">
                      {filteredAvailableKnives.map((knife) => {
                        const summary = getSearchResultSummary(knife)

                        return (
                          <li
                            key={knife.id}
                            className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-[color:var(--bladevault-surface-hover)]/45"
                          >
                            <div className="relative h-12 w-16 shrink-0 overflow-hidden rounded-md border border-[var(--bladevault-line)]/60 bg-white">
                              {knife.images.length > 0 ? (
                                <Image
                                  src={getImageUrl(knife.images[0])}
                                  alt=""
                                  fill
                                  sizes="64px"
                                  className="object-contain"
                                  referrerPolicy="no-referrer"
                                />
                              ) : (
                                <div className="flex h-full w-full items-center justify-center bg-muted/30">
                                  <ImageIcon className="h-5 w-5 text-muted-foreground/50" />
                                </div>
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium text-foreground">
                                {knife.brand} {knife.name}
                              </div>
                              {summary && (
                                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                                  {summary}
                                </div>
                              )}
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              onClick={() => {
                                void handleSelect(knife.id)
                              }}
                              disabled={isBulkAdding}
                              aria-label={`Add ${knife.brand} ${knife.name} to compare`}
                            >
                              Add
                            </Button>
                          </li>
                        )
                      })}
                    </ul>
                  ) : (
                    <div className="px-3 py-5 text-center text-sm text-muted-foreground">
                      No available knives match “{query.trim()}”.
                    </div>
                  )}
                </div>
              )}

              {comparedKnives.length > 0 && (
                <HorizontalScrollArea
                  label="Compare lineup"
                  viewportClassName="overflow-x-auto rounded-lg"
                >
                  <div className="flex min-w-max items-center rounded-lg border border-[var(--bladevault-line)]/70 bg-[color:var(--bladevault-surface-soft)]/45 px-3 py-2">
                    {comparedKnives.map((knife, index) => (
                      <div key={knife.id} className="flex items-center">
                        {index > 0 && (
                          <div className="mx-3 h-4 w-px bg-border" />
                        )}
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleRemove(knife.id)}
                            className="rounded-sm text-[var(--bladevault-local)] transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                            aria-label={`Remove ${knife.brand} ${knife.name} from compare`}
                            title="Remove"
                          >
                            <X className="h-4 w-4" />
                          </button>
                          <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--bladevault-title)]">
                            {knife.brand} {knife.name}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </HorizontalScrollArea>
              )}
            </CardContent>
          </Card>

          {comparedKnives.length === 0 ? (
            <div className="space-y-6">
              <EmptyState
                title="Select knives to compare"
                description="Search above to find knives or add them from your collection."
                icon={<ArchiveX className="h-8 w-8" />}
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    render={<Link href="/collection">Browse collection</Link>}
                    nativeButton={false}
                  />
                }
              />
              {suggestedKnives.length > 0 && (
                <Card className="border-[var(--bladevault-line)]/80 bg-background shadow-none">
                  <CardContent className="space-y-3 p-4">
                    <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <Lightbulb className="h-4 w-4 text-[var(--bladevault-gold)]" />
                      Suggested knives
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {suggestedKnives.map((knife) => (
                        <Button
                          key={knife.id}
                          variant="outline"
                          size="sm"
                          onClick={() => handleSelect(knife.id)}
                        >
                          <Plus className="mr-1.5 h-3.5 w-3.5" />
                          {knife.brand} {knife.name}
                        </Button>
                      ))}
                    </div>
                    {knives.length >= 2 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleCompareRandomPair}
                      >
                        <Shuffle className="mr-1.5 h-3.5 w-3.5" />
                        Compare a random pair
                      </Button>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>
          ) : (
            <Card className="border-[var(--bladevault-line)]/80 bg-background shadow-none">
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-foreground">
                      Comparison Matrix
                    </div>
                  </div>
                  <label
                    htmlFor="differences-only"
                    className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground"
                  >
                    <Checkbox
                      id="differences-only"
                      checked={showDifferencesOnly}
                      onCheckedChange={(checked) =>
                        setShowDifferencesOnly(checked === true)
                      }
                    />
                    Differences only
                  </label>
                </div>

                <HorizontalScrollArea
                  label="Comparison matrix"
                  className="rounded-xl"
                  viewportClassName="max-h-[72vh] overflow-auto rounded-xl border border-[var(--bladevault-line)]/80 bg-[color:var(--bladevault-surface-soft)]/30"
                >
                  <Table className="min-w-full" containerClassName="contents">
                    <TableHeader>
                      <TableRow className="bg-[color:var(--bladevault-surface-soft)]/70 hover:bg-[color:var(--bladevault-surface-soft)]/70">
                        <TableHead className="sticky left-0 top-0 z-30 w-44 border-r border-[var(--bladevault-line)] bg-[var(--bladevault-surface-soft)] text-[10px] uppercase tracking-wider text-[var(--bladevault-title)] shadow-[1px_0_0_0_var(--bladevault-line)]">
                          Feature
                        </TableHead>
                        {comparedKnives.map((knife) => (
                          <TableHead
                            key={knife.id}
                            className={cn(
                              'sticky top-0 z-20 min-w-[200px] border-r border-[var(--bladevault-line)]/70 bg-background align-top transition-colors last:border-r-0',
                              hoveredCell?.knifeId === knife.id &&
                                'bg-[color:var(--bladevault-surface-hover)]/55',
                            )}
                          >
                            <div className="space-y-2 rounded-lg bg-background/80 p-2">
                              <div className="group/image relative aspect-video w-full cursor-pointer overflow-hidden rounded-md border border-[var(--bladevault-line)]/50 bg-[color:var(--bladevault-surface-soft)]/40">
                                {knife.images.length > 0 ? (
                                  <Image
                                    src={getImageUrl(knife.images[0])}
                                    alt={knife.name}
                                    fill
                                    sizes="(max-width: 640px) 100vw, 200px"
                                    className="object-contain"
                                    referrerPolicy="no-referrer"
                                  />
                                ) : (
                                  <div className="flex h-full w-full items-center justify-center bg-muted/30">
                                    <ImageIcon className="h-8 w-8 text-muted-foreground/50" />
                                  </div>
                                )}
                                <button
                                  type="button"
                                  onClick={() => handleRemove(knife.id)}
                                  className="absolute right-1.5 top-1.5 z-10 rounded-full bg-background/90 p-0.5 text-red-500 opacity-0 transition-opacity group-hover/image:opacity-100 hover:text-red-600 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                                  aria-label={`Remove ${knife.brand} ${knife.name} from compare`}
                                  title="Remove"
                                >
                                  <X className="h-4 w-4" />
                                </button>
                              </div>
                              <Link
                                href={`/collection/${knife.id}`}
                                className="block space-y-0.5 hover:underline"
                              >
                                <div className="text-sm font-medium leading-tight whitespace-normal">
                                  {knife.name}
                                </div>
                                <div className="text-[10px] uppercase tracking-wider text-[var(--bladevault-title)] whitespace-normal">
                                  {knife.brand}
                                </div>
                              </Link>
                            </div>
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleCompareRows.map((row, idx) => (
                        <TableRow
                          key={row.key}
                          className={cn(
                            idx % 2 === 0
                              ? 'bg-background'
                              : 'bg-[color:var(--bladevault-surface-soft)]/35',
                            hoveredCell?.rowKey === row.key &&
                              'bg-[color:var(--bladevault-surface-hover)]/35',
                          )}
                        >
                          <TableCell
                            className={cn(
                              'sticky left-0 z-10 border-r border-[var(--bladevault-line)] text-[11px] font-medium uppercase tracking-wider text-[var(--bladevault-title)] shadow-[1px_0_0_0_var(--bladevault-line)] transition-colors',
                              idx % 2 === 0
                                ? 'bg-background'
                                : 'bg-[var(--bladevault-surface-soft)]',
                              hoveredCell?.rowKey === row.key &&
                                'bg-[var(--bladevault-surface-hover)]',
                            )}
                          >
                            {row.label}
                          </TableCell>
                          {comparedKnives.map((knife) => {
                            const value = getRowValue(knife, row.key)
                            return (
                              <TableCell
                                key={knife.id}
                                className={cn(
                                  'align-top border-r border-[var(--bladevault-line)]/45 py-2.5 text-sm leading-snug whitespace-normal wrap-break-word text-foreground transition-colors last:border-r-0',
                                  hoveredCell?.knifeId === knife.id &&
                                    'bg-[color:var(--bladevault-surface-hover)]/35',
                                  hoveredCell?.knifeId === knife.id &&
                                    hoveredCell?.rowKey === row.key &&
                                    'bg-[color:var(--bladevault-surface-hover)]/60',
                                )}
                                onMouseEnter={() =>
                                  setHoveredCell({
                                    knifeId: knife.id,
                                    rowKey: row.key,
                                  })
                                }
                                onMouseLeave={() => setHoveredCell(null)}
                              >
                                {value ?? '-'}
                              </TableCell>
                            )
                          })}
                        </TableRow>
                      ))}
                      {visibleCompareRows.length === 0 && (
                        <TableRow>
                          <TableCell
                            colSpan={comparedKnives.length + 1}
                            className="py-8 text-center text-sm text-muted-foreground"
                          >
                            All selected knives have matching values.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </HorizontalScrollArea>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  )
}

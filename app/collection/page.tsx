'use client'

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import {
  CheckSquare2,
  ChevronDown,
  Grid3X3,
  LayoutGrid,
  PencilLine,
  Pin,
  PinOff,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import {
  CollectionRanges,
  SmartCollectionControls,
} from '@/components/smart-collection-controls'
import { matchesCollection, rangeDefinitions } from '@/lib/smart-collections'
import { PageHeader } from '@/components/page-header'
import { BulkEditDialog } from '@/components/bulk-edit-dialog'
import { KnifeCard, type CollectionCardDensity } from '@/components/knife-card'
import { KnifeFamilyCard } from '@/components/knife-family-card'
import { CollectionKnifeInspector } from '@/components/collection-knife-inspector'
import { EmptyState } from '@/components/empty-state'
import { FilterMultiSelect } from '@/components/filter-multi-select'
import { SearchField } from '@/components/search-field'
import { useKnives } from '@/components/providers/knives-provider'
import { Knife, prioritizePinnedKnives } from '@/lib/data'
import { getKnifeFamilyKey, groupKnifeFamilies } from '@/lib/knife-families'
import { CustomFieldType } from '@/lib/settings-shared'
import { useDebouncedValue } from '@/lib/use-debounced-value'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  type BulkEditFieldDefinition,
  type BulkEditFieldKey,
  builtInBulkEditFields,
} from '@/lib/bulk-edit'
import {
  builtInFilterDefinitions,
  type BuiltInFilterKey,
  getFilterOptionLabel,
  NOT_SET_FILTER_VALUE,
} from '@/lib/collection-filters'

const PAGE_SIZE = 24
type CollectionView = 'knives' | 'families' | 'pinned'
type CollectionSort = 'newest' | 'model' | 'brand'
type CustomFilterKey = `custom:${string}`
type FilterKey = BuiltInFilterKey | CustomFilterKey

function isCustomFilterKey(key: string): key is CustomFilterKey {
  return key.startsWith('custom:')
}

function customFilterKeyToFieldId(key: string): string {
  return key.slice('custom:'.length)
}

function formatCustomFilterValue(value: string, type: CustomFieldType): string {
  if (type !== 'date' || !value) return value
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
    }).format(new Date(value))
  } catch {
    return value
  }
}

function sortFilterOptions(options: string[], type: CustomFieldType): string[] {
  if (type === 'number') {
    return [...options].sort((left, right) => {
      const leftNumber = Number.parseFloat(left)
      const rightNumber = Number.parseFloat(right)
      if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) {
        return leftNumber - rightNumber
      }
      return left.localeCompare(right)
    })
  }
  return [...options].sort((left, right) => left.localeCompare(right))
}

function CollectionContent() {
  const {
    knives,
    pinnedItemsFirst,
    bulkUpdateKnives,
    bulkPinKnives,
    showFeedback,
    customFieldDefinitions,
  } = useKnives()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const searchInputRef = useRef<HTMLInputElement>(null)
  const loadMoreRef = useRef<HTMLDivElement>(null)
  const query = searchParams.get('q') ?? ''
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [isFiltersOpen, setIsFiltersOpen] = useState(false)
  const [isSelectionMode, setIsSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [isBulkEditOpen, setIsBulkEditOpen] = useState(false)
  const [isBulkPinning, setIsBulkPinning] = useState(false)
  const [density, setDensity] = useState<CollectionCardDensity>('gallery')
  const [sortOrder, setSortOrder] = useState<CollectionSort>('newest')
  const [activeKnifeId, setActiveKnifeId] = useState<string | null>(null)
  const debouncedQuery = useDebouncedValue(query, 200)
  const requestedView = searchParams.get('view')
  const collectionView: CollectionView = isSelectionMode
    ? 'knives'
    : requestedView === 'families' || requestedView === 'pinned'
      ? requestedView
      : 'knives'
  const isFamilyView = collectionView === 'families'
  const isPinnedView = collectionView === 'pinned'

  const replaceParams = useCallback(
    (
      update: (params: URLSearchParams) => void,
      mode: 'router' | 'history' = 'router',
    ) => {
      const params = new URLSearchParams(searchParams.toString())
      params.delete('sort')
      update(params)
      const nextQuery = params.toString()
      const nextUrl = nextQuery ? `${pathname}?${nextQuery}` : pathname

      if (mode === 'history') {
        window.history.replaceState(null, '', nextUrl)
        return
      }

      router.replace(nextUrl, { scroll: false })
    },
    [pathname, router, searchParams],
  )

  const setQuery = useCallback(
    (value: string) => {
      replaceParams((params) => {
        if (value) {
          params.set('q', value)
        } else {
          params.delete('q')
        }
      })
      setVisibleCount(PAGE_SIZE)
    },
    [replaceParams],
  )

  const setCollectionView = (view: CollectionView) => {
    replaceParams((params) => {
      if (view === 'knives') params.delete('view')
      else params.set('view', view)
    })
    setVisibleCount(PAGE_SIZE)
  }

  const filterDefinitions = useMemo(
    () => [
      ...builtInFilterDefinitions,
      ...customFieldDefinitions.map((field) => ({
        key: `custom:${field.id}` as CustomFilterKey,
        label: field.name,
        type: field.type,
        getValue: (knife: Knife) => knife.customFields[field.id],
      })),
    ],
    [customFieldDefinitions],
  )

  const bulkEditFields = useMemo<BulkEditFieldDefinition[]>(
    () => [
      ...builtInBulkEditFields.map((field) => ({ ...field })),
      ...customFieldDefinitions.map((field) => ({
        key: `customFields.${field.id}` as BulkEditFieldKey,
        label: field.name,
        type: field.type,
      })),
    ],
    [customFieldDefinitions],
  )

  // `useSearchParams` returns a new object reference every render, so we use
  // the query string as a stable key to avoid recomputing filters on every
  // render when the URL has not actually changed.
  const searchParamsKey = searchParams.toString()

  const selectedFilters = useMemo(
    () =>
      Object.fromEntries(
        filterDefinitions.map((definition) => [
          definition.key,
          searchParams.getAll(definition.key).filter(Boolean),
        ]),
      ) as Record<FilterKey, string[]>,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchParamsKey, filterDefinitions],
  )

  const optionsByFilter = useMemo(() => {
    const populatedByKey = new Map<FilterKey, Set<string>>()
    const hasMissingByKey = new Map<FilterKey, boolean>()

    for (const definition of filterDefinitions) {
      populatedByKey.set(definition.key, new Set())
      hasMissingByKey.set(definition.key, false)
    }

    for (const knife of knives) {
      for (const definition of filterDefinitions) {
        const value = definition.getValue(knife)
        if (!value || value.trim().length === 0) {
          hasMissingByKey.set(definition.key, true)
          continue
        }
        populatedByKey.get(definition.key)?.add(value)
      }
    }

    const result = {} as Record<FilterKey, string[]>
    for (const definition of filterDefinitions) {
      const field = isCustomFilterKey(definition.key)
        ? customFieldDefinitions.find(
            (item) => item.id === customFilterKeyToFieldId(definition.key),
          )
        : undefined
      const type = field?.type ?? 'text'
      const populated = sortFilterOptions(
        Array.from(populatedByKey.get(definition.key) ?? []),
        type,
      )

      result[definition.key] = hasMissingByKey.get(definition.key)
        ? [NOT_SET_FILTER_VALUE, ...populated]
        : populated
    }

    return result
  }, [knives, filterDefinitions, customFieldDefinitions])

  const filteredKnives = useMemo(() => {
    const params = new URLSearchParams(searchParamsKey)
    params.delete('view')
    params.set('q', debouncedQuery)
    const matches = knives.filter(
      (knife) =>
        matchesCollection(knife, params) && (!isPinnedView || knife.pinned),
    )
    const sorted = [...matches].sort((left, right) => {
      if (sortOrder === 'model') return left.name.localeCompare(right.name)
      if (sortOrder === 'brand') {
        return (
          left.brand.localeCompare(right.brand) ||
          left.name.localeCompare(right.name)
        )
      }
      return Date.parse(right.addedAt) - Date.parse(left.addedAt)
    })

    return prioritizePinnedKnives(sorted, pinnedItemsFirst && !isPinnedView)
  }, [
    knives,
    debouncedQuery,
    searchParamsKey,
    pinnedItemsFirst,
    isPinnedView,
    sortOrder,
  ])

  const setFilterValues = (key: FilterKey, values: string[]) => {
    replaceParams((params) => {
      params.delete(key)
      values.forEach((value) => {
        params.append(key, value)
      })
    })
    setVisibleCount(PAGE_SIZE)
  }

  const familiesByKey = useMemo(
    () =>
      new Map(
        groupKnifeFamilies(knives).map((family) => [family.key, family.knives]),
      ),
    [knives],
  )
  const filteredFamilies = useMemo(
    () => groupKnifeFamilies(filteredKnives),
    [filteredKnives],
  )
  const activeKnife = useMemo(
    () => knives.find((knife) => knife.id === activeKnifeId) ?? null,
    [activeKnifeId, knives],
  )
  const activeKnifeSiblings = activeKnife
    ? (familiesByKey.get(getKnifeFamilyKey(activeKnife)) ?? [activeKnife])
    : []
  const resultCount = isFamilyView
    ? filteredFamilies.length
    : filteredKnives.length

  const toggleFilterValue = (key: FilterKey, value: string) => {
    const currentValues = selectedFilters[key]
    const nextValues = currentValues.includes(value)
      ? currentValues.filter((currentValue) => currentValue !== value)
      : [...currentValues, value]

    setFilterValues(key, nextValues)
  }

  const clearAllFilters = useCallback(() => {
    replaceParams((params) => {
      params.delete('q')
      params.delete('smart')
      params.delete('missingSpecs')
      rangeDefinitions.forEach((field) => {
        params.delete(`${field.key}Min`)
        params.delete(`${field.key}Max`)
      })
      filterDefinitions.forEach((definition) => params.delete(definition.key))
    })
    setVisibleCount(PAGE_SIZE)
  }, [replaceParams, filterDefinitions])

  const activeFilters = filterDefinitions.flatMap((definition) =>
    selectedFilters[definition.key].map((value) => ({
      key: definition.key,
      label: definition.label,
      value:
        value === NOT_SET_FILTER_VALUE
          ? getFilterOptionLabel(value)
          : isCustomFilterKey(definition.key)
            ? formatCustomFilterValue(
                value,
                customFieldDefinitions.find(
                  (item) =>
                    item.id === customFilterKeyToFieldId(definition.key),
                )?.type ?? 'text',
              )
            : value,
      rawValue: value,
    })),
  )

  const extraFilters = [
    ...rangeDefinitions.flatMap((field) =>
      (['Min', 'Max'] as const).flatMap((bound) => {
        const key = `${field.key}${bound}`
        const value = searchParams.get(key)
        return value === null
          ? []
          : [
              {
                key,
                label: `${field.label} ${bound === 'Min' ? '≥' : '<'} ${value} ${field.unit}`,
              },
            ]
      }),
    ),
    ...(searchParams.get('missingSpecs') === '1'
      ? [{ key: 'missingSpecs', label: 'Missing specifications' }]
      : []),
  ]
  const updateExtraFilter = (key: string, value: string) => {
    replaceParams((params) => {
      if (value) params.set(key, value)
      else params.delete(key)
    }, 'history')
    setVisibleCount(PAGE_SIZE)
  }
  const hasActiveFilters =
    activeFilters.length > 0 ||
    extraFilters.length > 0 ||
    query.trim().length > 0

  useEffect(() => {
    const loadMoreElement = loadMoreRef.current
    if (!loadMoreElement || visibleCount >= resultCount) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return

        setVisibleCount((count) => Math.min(count + PAGE_SIZE, resultCount))
      },
      { rootMargin: '400px 0px' },
    )

    observer.observe(loadMoreElement)
    return () => observer.disconnect()
  }, [resultCount, visibleCount, isFamilyView])

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
        return
      }

      if (event.key === 'Escape' && !isTyping && hasActiveFilters) {
        if (
          target?.closest('[role="dialog"], [role="menu"], [role="listbox"]')
        ) {
          return
        }
        event.preventDefault()
        clearAllFilters()
      }
    }

    window.addEventListener('keydown', handleSearchShortcut)
    return () => window.removeEventListener('keydown', handleSearchShortcut)
  }, [query, setQuery, hasActiveFilters, clearAllFilters])

  const selectedKnives = useMemo(
    () => knives.filter((knife) => selectedIds.has(knife.id)),
    [knives, selectedIds],
  )
  const allFilteredSelected =
    filteredKnives.length > 0 &&
    filteredKnives.every((knife) => selectedIds.has(knife.id))

  const toggleKnifeSelection = useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const toggleAllFiltered = () => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (allFilteredSelected) {
        filteredKnives.forEach((knife) => next.delete(knife.id))
      } else {
        filteredKnives.forEach((knife) => next.add(knife.id))
      }
      return next
    })
  }

  const exitSelectionMode = () => {
    setIsBulkEditOpen(false)
    setIsSelectionMode(false)
    setSelectedIds(new Set())
  }

  const handleBulkEdit = async (field: BulkEditFieldKey, value: string) => {
    const fieldLabel = bulkEditFields.find((item) => item.key === field)?.label
    const selectedCount = selectedIds.size
    await bulkUpdateKnives(Array.from(selectedIds), field, value)
    showFeedback(
      `${fieldLabel ?? 'Field'} updated for ${selectedCount} ${selectedCount === 1 ? 'knife' : 'knives'}`,
    )
    exitSelectionMode()
  }

  const selectedKnivesPinned = useMemo(
    () =>
      selectedKnives.length > 0 &&
      selectedKnives.every((knife) => knife.pinned),
    [selectedKnives],
  )

  const handleBulkPin = async () => {
    if (selectedIds.size === 0) return
    const selectedCount = selectedIds.size
    const pinned = !selectedKnivesPinned
    setIsBulkPinning(true)
    try {
      await bulkPinKnives(Array.from(selectedIds), pinned)
      showFeedback(
        `${pinned ? 'Pinned' : 'Unpinned'} ${selectedCount} ${selectedCount === 1 ? 'knife' : 'knives'}`,
      )
    } catch (error) {
      showFeedback(
        error instanceof Error ? error.message : 'Could not update pins.',
        'error',
      )
    } finally {
      setIsBulkPinning(false)
    }
  }

  return (
    <div
      className={cn(
        'mx-auto w-full flex-1 p-4 sm:p-6 lg:p-8',
        activeKnife ? 'max-w-[100rem] xl:pr-[28rem]' : 'max-w-7xl',
        isSelectionMode && 'pb-28 lg:pb-28',
      )}
    >
      <PageHeader
        title={
          <span className="text-3xl font-semibold tracking-[-0.045em] sm:text-4xl">
            Your collection.
          </span>
        }
        description={`${knives.length} ${knives.length === 1 ? 'knife' : 'knives'}, each with a story. All in one place.`}
        actions={
          <SmartCollectionControls
            params={new URLSearchParams(searchParamsKey)}
            navigate={(query) => {
              router.replace(query ? `${pathname}?${query}` : pathname, {
                scroll: false,
              })
              setVisibleCount(PAGE_SIZE)
            }}
          />
        }
      />

      {knives.length > 0 && (
        <nav
          aria-label="Collection grouping"
          className="mb-5 flex gap-6 border-b border-border"
        >
          {(
            [
              ['knives', 'All knives', knives.length],
              ['families', 'Model families', familiesByKey.size],
              [
                'pinned',
                'Pinned',
                knives.filter((knife) => knife.pinned).length,
              ],
            ] as const
          ).map(([view, label, count]) => (
            <button
              key={view}
              type="button"
              onClick={() => setCollectionView(view)}
              disabled={isSelectionMode}
              aria-current={collectionView === view ? 'page' : undefined}
              className={cn(
                'relative flex items-center gap-2 pb-3 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                collectionView === view &&
                  'font-semibold text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-[var(--bladevault-gold)]',
              )}
            >
              {label}
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-foreground">
                {count}
              </span>
            </button>
          ))}
        </nav>
      )}

      {knives.length > 0 && (
        <div
          data-collection-filter-panel
          className="mb-5 rounded-xl border border-[var(--bladevault-line)]/80 bg-[color:var(--bladevault-surface-soft)]/25 p-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder="Search model name…"
              className="mx-0 max-w-lg basis-full sm:basis-80 lg:basis-96"
              inputRef={searchInputRef}
              shortcutHint="/"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsFiltersOpen((current) => !current)}
              aria-expanded={isFiltersOpen}
              aria-controls="collection-filters"
            >
              <SlidersHorizontal className="size-3.5" aria-hidden="true" />
              Filters
              {activeFilters.length + extraFilters.length > 0 && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
                  {activeFilters.length + extraFilters.length}
                </span>
              )}
              <ChevronDown
                className={cn(
                  'size-3 transition-transform',
                  isFiltersOpen && 'rotate-180',
                )}
                aria-hidden="true"
              />
            </Button>
            <span className="text-xs tabular-nums text-muted-foreground sm:ml-auto">
              {isSelectionMode
                ? `${selectedIds.size} selected · ${filteredKnives.length} matches`
                : `${filteredKnives.length} ${filteredKnives.length === 1 ? 'knife' : 'knives'}`}
            </span>
            <label className="sr-only" htmlFor="collection-sort">
              Sort collection
            </label>
            <select
              id="collection-sort"
              value={sortOrder}
              onChange={(event) => {
                setSortOrder(event.target.value as CollectionSort)
                setVisibleCount(PAGE_SIZE)
              }}
              className="h-7 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="newest">Newest added</option>
              <option value="model">Model A–Z</option>
              <option value="brand">Brand A–Z</option>
            </select>
            <div
              className="flex rounded-lg border border-border bg-background p-0.5"
              role="group"
              aria-label="Card density"
            >
              <Button
                type="button"
                variant={density === 'gallery' ? 'secondary' : 'ghost'}
                size="icon-sm"
                onClick={() => setDensity('gallery')}
                aria-pressed={density === 'gallery'}
                aria-label="Gallery view"
              >
                <LayoutGrid className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant={density === 'compact' ? 'secondary' : 'ghost'}
                size="icon-sm"
                onClick={() => setDensity('compact')}
                aria-pressed={density === 'compact'}
                aria-label="Compact view"
              >
                <Grid3X3 className="size-3.5" />
              </Button>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (isSelectionMode) {
                  exitSelectionMode()
                } else {
                  setActiveKnifeId(null)
                  setIsSelectionMode(true)
                }
              }}
            >
              {isSelectionMode ? (
                <X className="size-3.5" />
              ) : (
                <CheckSquare2 className="size-3.5" />
              )}
              {isSelectionMode ? 'Cancel selection' : 'Select'}
            </Button>
          </div>

          <div
            id="collection-filters"
            className={cn(
              'mt-3 gap-2 sm:grid-cols-2 lg:gap-2.5 xl:grid-cols-4',
              isFiltersOpen ? 'grid' : 'hidden',
            )}
          >
            {filterDefinitions.map((definition) => (
              <FilterMultiSelect
                key={definition.key}
                label={definition.label}
                options={optionsByFilter[definition.key]}
                selectedValues={selectedFilters[definition.key]}
                onToggleValue={(value) =>
                  toggleFilterValue(definition.key, value)
                }
                onSelectAll={() =>
                  setFilterValues(
                    definition.key,
                    optionsByFilter[definition.key],
                  )
                }
                onClear={() => setFilterValues(definition.key, [])}
                getOptionLabel={getFilterOptionLabel}
              />
            ))}
            <CollectionRanges
              params={new URLSearchParams(searchParamsKey)}
              update={updateExtraFilter}
            />
          </div>
        </div>
      )}

      <div className="mb-6 flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          {activeFilters.map((filter) => (
            <Badge
              key={`${filter.key}-${filter.rawValue}`}
              variant="secondary"
              className="gap-1 pr-1 text-xs"
            >
              <span className="text-muted-foreground">{filter.label}:</span>
              {filter.value}
              <button
                onClick={() =>
                  setFilterValues(
                    filter.key,
                    selectedFilters[filter.key].filter(
                      (value) => value !== filter.rawValue,
                    ),
                  )
                }
                className="ml-1 rounded-sm p-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                aria-label={`Clear ${filter.label} filter value ${filter.value}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
          {extraFilters.map((filter) => (
            <Badge
              key={filter.key}
              variant="secondary"
              className="gap-1 pr-1 text-xs"
            >
              {filter.label}
              <button
                aria-label={`Clear ${filter.label}`}
                onClick={() => updateExtraFilter(filter.key, '')}
                className="ml-1 rounded-sm p-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </Badge>
          ))}
          {query.trim() && (
            <Badge variant="secondary" className="gap-1 pr-1 text-xs">
              <span className="text-muted-foreground">search:</span>
              {query.trim()}
              <button
                onClick={() => setQuery('')}
                className="ml-1 rounded-sm p-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                aria-label="Clear search"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
          {hasActiveFilters && (
            <Button variant="ghost" size="xs" onClick={clearAllFilters}>
              Clear all
            </Button>
          )}
          {hasActiveFilters && (
            <span className="ml-auto text-xs text-muted-foreground hidden sm:inline">
              Press{' '}
              <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">
                Esc
              </kbd>{' '}
              to clear
            </span>
          )}
        </div>
      </div>

      {filteredKnives.length === 0 ? (
        <EmptyState
          title={
            hasActiveFilters ? 'No matches found' : 'Your library is empty'
          }
          description={
            hasActiveFilters
              ? 'Try clearing the search or filters to see more results.'
              : 'Add a knife to start building your collection.'
          }
          action={
            hasActiveFilters ? (
              <Button variant="outline" size="sm" onClick={clearAllFilters}>
                Clear all
              </Button>
            ) : (
              <Button
                size="sm"
                render={<Link href="/add">Add your first knife</Link>}
                nativeButton={false}
              />
            )
          }
        />
      ) : (
        <div className="space-y-6">
          <div
            className={cn(
              'grid [overflow-anchor:none]',
              density === 'gallery'
                ? 'grid-cols-2 gap-3 sm:gap-4'
                : 'grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5',
              density === 'gallery' &&
                (activeKnife
                  ? 'xl:grid-cols-2'
                  : 'sm:grid-cols-2 lg:grid-cols-3'),
              density === 'compact' && activeKnife && 'xl:grid-cols-3',
            )}
            data-collection-grid
            data-density={density}
          >
            {isFamilyView
              ? filteredFamilies.slice(0, visibleCount).map((family, index) => {
                  const allVariants =
                    familiesByKey.get(family.key) ?? family.knives
                  return allVariants.length > 1 ? (
                    <KnifeFamilyCard
                      key={family.key}
                      family={family}
                      allVariants={allVariants}
                      eager={index === 0}
                      activeKnifeId={activeKnifeId ?? undefined}
                      density={density}
                      onOpen={(knife) => setActiveKnifeId(knife.id)}
                    />
                  ) : (
                    <KnifeCard
                      key={family.key}
                      knife={family.knives[0]}
                      eager={index === 0}
                      active={family.knives[0].id === activeKnifeId}
                      density={density}
                      onOpen={(knife) => setActiveKnifeId(knife.id)}
                    />
                  )
                })
              : filteredKnives
                  .slice(0, visibleCount)
                  .map((knife, index) => (
                    <KnifeCard
                      key={knife.id}
                      knife={knife}
                      eager={index === 0}
                      selectionMode={isSelectionMode}
                      selected={selectedIds.has(knife.id)}
                      active={knife.id === activeKnifeId}
                      density={density}
                      onSelect={toggleKnifeSelection}
                      onOpen={(knife) => setActiveKnifeId(knife.id)}
                    />
                  ))}
          </div>
          {visibleCount < resultCount && (
            <div
              ref={loadMoreRef}
              className="h-px"
              data-infinite-scroll-sentinel
              aria-hidden="true"
            />
          )}
        </div>
      )}

      {activeKnife && !isSelectionMode && (
        <CollectionKnifeInspector
          key={activeKnife.id}
          knife={activeKnife}
          siblings={activeKnifeSiblings}
          onSelect={(knife) => setActiveKnifeId(knife.id)}
        />
      )}

      {isSelectionMode && (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
          <div className="pointer-events-auto flex w-full max-w-2xl flex-col gap-3 rounded-xl border border-[var(--bladevault-line)] bg-background/95 p-3 shadow-xl backdrop-blur sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1" aria-live="polite">
              <div className="text-sm font-medium text-foreground">
                {selectedIds.size === 0
                  ? 'Select knives to edit'
                  : `${selectedIds.size} ${selectedIds.size === 1 ? 'knife' : 'knives'} selected`}
              </div>
              <div className="text-xs text-muted-foreground">
                One field will be replaced for every selected knife.
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={toggleAllFiltered}
                disabled={filteredKnives.length === 0}
              >
                {allFilteredSelected
                  ? 'Deselect matches'
                  : `Select all ${filteredKnives.length}`}
              </Button>
              {selectedIds.size > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedIds(new Set())}
                >
                  Clear
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                onClick={() => setIsBulkEditOpen(true)}
                disabled={selectedIds.size === 0}
              >
                <PencilLine className="mr-1.5 size-3.5" />
                Bulk edit
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleBulkPin}
                disabled={selectedIds.size === 0 || isBulkPinning}
              >
                {selectedKnivesPinned ? (
                  <PinOff className="mr-1.5 size-3.5" />
                ) : (
                  <Pin className="mr-1.5 size-3.5" />
                )}
                {selectedKnivesPinned ? 'Unpin' : 'Pin'}
              </Button>
            </div>
          </div>
        </div>
      )}

      <BulkEditDialog
        open={isBulkEditOpen}
        selectedKnives={selectedKnives}
        allKnives={knives}
        fields={bulkEditFields}
        onOpenChange={setIsBulkEditOpen}
        onApply={handleBulkEdit}
      />
    </div>
  )
}

export default function CollectionPage() {
  return (
    <Suspense
      fallback={
        <div className="flex-1 p-6 lg:p-8 w-full max-w-7xl mx-auto">
          <PageHeader
            title="Your collection."
            description="Browse and manage every knife in your collection."
          />
          <div className="h-96 rounded-xl border border-dashed bg-muted/50" />
        </div>
      }
    >
      <CollectionContent />
    </Suspense>
  )
}

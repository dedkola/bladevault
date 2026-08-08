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
  PencilLine,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { BulkEditDialog } from '@/components/bulk-edit-dialog'
import { KnifeCard } from '@/components/knife-card'
import { EmptyState } from '@/components/empty-state'
import { FilterMultiSelect } from '@/components/filter-multi-select'
import { SearchField } from '@/components/search-field'
import { useKnives } from '@/components/providers/knives-provider'
import { Knife, matchesKnifeSearch, prioritizePinnedKnives } from '@/lib/data'
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

const PAGE_SIZE = 24
const NOT_SET_FILTER_VALUE = '__not_set__'

function getFilterOptionLabel(value: string): string {
  return value === NOT_SET_FILTER_VALUE ? 'Not set' : value
}

const builtInFilterDefinitions = [
  { key: 'brand', label: 'Brand', getValue: (knife: Knife) => knife.brand },
  {
    key: 'modelNumber',
    label: 'Model Number',
    getValue: (knife: Knife) => knife.specs.modelNumber,
  },
  {
    key: 'bladeMaterial',
    label: 'Blade Material',
    getValue: (knife: Knife) => knife.specs.bladeMaterial,
  },
  {
    key: 'bladeStyle',
    label: 'Blade Style',
    getValue: (knife: Knife) => knife.bladeStyle,
  },
  {
    key: 'bladeCoating',
    label: 'Blade Coating / Finish',
    getValue: (knife: Knife) => knife.specs.bladeCoating,
  },
  {
    key: 'hardness',
    label: 'Hardness',
    getValue: (knife: Knife) => knife.specs.hardness,
  },
  {
    key: 'lockingMechanism',
    label: 'Locking Mechanism',
    getValue: (knife: Knife) => knife.specs.lockingMechanism,
  },
  {
    key: 'handleMaterial',
    label: 'Handle Material',
    getValue: (knife: Knife) => knife.handleMaterial,
  },
  {
    key: 'handleLength',
    label: 'Handle Length',
    getValue: (knife: Knife) => knife.specs.handleLength,
  },
  {
    key: 'bladeLength',
    label: 'Blade Length',
    getValue: (knife: Knife) => knife.specs.bladeLength,
  },
  {
    key: 'overallLength',
    label: 'Overall Length',
    getValue: (knife: Knife) => knife.specs.overallLength,
  },
  {
    key: 'bladeThickness',
    label: 'Blade Thickness',
    getValue: (knife: Knife) => knife.specs.bladeThickness,
  },
  {
    key: 'weight',
    label: 'Weight',
    getValue: (knife: Knife) => knife.specs.weight,
  },
  {
    key: 'price',
    label: 'Price',
    getValue: (knife: Knife) => knife.specs.price,
  },
  {
    key: 'country',
    label: 'Country',
    getValue: (knife: Knife) => knife.specs.country,
  },
] as const

type BuiltInFilterKey = (typeof builtInFilterDefinitions)[number]['key']
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
    showFeedback,
    customFieldDefinitions,
  } = useKnives()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const searchInputRef = useRef<HTMLInputElement>(null)
  const query = searchParams.get('q') ?? ''
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [isFiltersOpen, setIsFiltersOpen] = useState(false)
  const [isSelectionMode, setIsSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [isBulkEditOpen, setIsBulkEditOpen] = useState(false)
  const debouncedQuery = useDebouncedValue(query, 200)

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
  }, [query, setQuery])

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

  const selectedFilters = useMemo(
    () =>
      Object.fromEntries(
        filterDefinitions.map((definition) => [
          definition.key,
          searchParams.getAll(definition.key).filter(Boolean),
        ]),
      ) as Record<FilterKey, string[]>,
    [searchParams, filterDefinitions],
  )

  const optionsByFilter = useMemo(
    () =>
      Object.fromEntries(
        filterDefinitions.map((definition) => {
          const field = isCustomFilterKey(definition.key)
            ? customFieldDefinitions.find(
                (item) => item.id === customFilterKeyToFieldId(definition.key),
              )
            : undefined
          const type = field?.type ?? 'text'
          const rawValues = knives.map((knife) => definition.getValue(knife))
          const hasMissingValue = rawValues.some(
            (value) => !value || value.trim().length === 0,
          )
          const populatedValues = sortFilterOptions(
            Array.from(
              new Set(
                rawValues.filter((value): value is string =>
                  Boolean(value && value.trim().length > 0),
                ),
              ),
            ),
            type,
          )

          return [
            definition.key,
            hasMissingValue
              ? [NOT_SET_FILTER_VALUE, ...populatedValues]
              : populatedValues,
          ]
        }),
      ) as Record<FilterKey, string[]>,
    [knives, filterDefinitions, customFieldDefinitions],
  )

  const filteredKnives = useMemo(() => {
    const matches = knives.filter((knife) => {
      if (!matchesKnifeSearch(knife, debouncedQuery)) return false

      return filterDefinitions.every((definition) => {
        const selectedValues = selectedFilters[definition.key]

        if (selectedValues.length === 0) {
          return true
        }

        const value = definition.getValue(knife)
        return selectedValues.some((selectedValue) =>
          selectedValue === NOT_SET_FILTER_VALUE
            ? !value || value.trim().length === 0
            : value === selectedValue,
        )
      })
    })

    return prioritizePinnedKnives(matches, pinnedItemsFirst)
  }, [
    knives,
    debouncedQuery,
    selectedFilters,
    filterDefinitions,
    pinnedItemsFirst,
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

  const toggleFilterValue = (key: FilterKey, value: string) => {
    const currentValues = selectedFilters[key]
    const nextValues = currentValues.includes(value)
      ? currentValues.filter((currentValue) => currentValue !== value)
      : [...currentValues, value]

    setFilterValues(key, nextValues)
  }

  const clearAllFilters = () => {
    replaceParams((params) => {
      params.delete('q')
      filterDefinitions.forEach((definition) => params.delete(definition.key))
    })
    setVisibleCount(PAGE_SIZE)
  }

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

  const hasActiveFilters = activeFilters.length > 0 || query.trim().length > 0

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

  return (
    <div
      className={`flex-1 p-6 lg:p-8 w-full max-w-7xl mx-auto ${isSelectionMode ? 'pb-28 lg:pb-28' : ''}`}
    >
      <PageHeader title="Collection" />

      {knives.length > 0 && (
        <div className="mb-4 flex flex-col gap-3 border border-[var(--bladevault-line)]/80 bg-[color:var(--bladevault-surface-soft)]/35 p-3 sm:flex-row sm:items-center">
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder="Search model name…"
            className="mx-0 max-w-none sm:max-w-sm sm:flex-1"
            inputRef={searchInputRef}
            shortcutHint="/"
          />
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto sm:justify-end">
            <span className="mr-1 text-xs tabular-nums text-muted-foreground">
              {isSelectionMode
                ? `${selectedIds.size} selected · ${filteredKnives.length} ${filteredKnives.length === 1 ? 'match' : 'matches'}`
                : filteredKnives.length === knives.length
                  ? `${knives.length} ${knives.length === 1 ? 'knife' : 'knives'}`
                  : `${filteredKnives.length} of ${knives.length} knives`}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (isSelectionMode) {
                  exitSelectionMode()
                } else {
                  setIsSelectionMode(true)
                }
              }}
            >
              {isSelectionMode ? (
                <X className="mr-1.5 size-3.5" />
              ) : (
                <CheckSquare2 className="mr-1.5 size-3.5" />
              )}
              {isSelectionMode ? 'Cancel selection' : 'Select'}
            </Button>
          </div>
        </div>
      )}

      {knives.length > 0 && (
        <div className="mb-6 border border-border/80 bg-muted/20 p-3 sm:p-4">
          <button
            type="button"
            onClick={() => setIsFiltersOpen((current) => !current)}
            aria-expanded={isFiltersOpen}
            aria-controls="collection-filters"
            className="flex min-h-8 w-full items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:hidden"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            Filters
            {activeFilters.length > 0 ? (
              <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold leading-none text-foreground tabular-nums">
                {activeFilters.length}
              </span>
            ) : null}
            <ChevronDown
              className={cn(
                'ml-auto h-3.5 w-3.5 transition-transform',
                isFiltersOpen && 'rotate-180',
              )}
              aria-hidden="true"
            />
          </button>
          <div className="mb-3 hidden items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:flex">
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            Filters
          </div>
          <div
            id="collection-filters"
            className={cn(
              'mt-3 gap-2 sm:mt-0 sm:grid sm:grid-cols-2 lg:gap-2.5 xl:grid-cols-4',
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
          <div className="grid grid-cols-1 gap-6 [overflow-anchor:none] sm:grid-cols-2 lg:grid-cols-3">
            {filteredKnives.slice(0, visibleCount).map((knife, index) => (
              <KnifeCard
                key={knife.id}
                knife={knife}
                eager={index === 0}
                selectionMode={isSelectionMode}
                selected={selectedIds.has(knife.id)}
                onSelect={toggleKnifeSelection}
              />
            ))}
          </div>
          {visibleCount < filteredKnives.length && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setVisibleCount((count) =>
                    Math.min(count + PAGE_SIZE, filteredKnives.length),
                  )
                }
              >
                Load more ({filteredKnives.length - visibleCount} remaining)
              </Button>
            </div>
          )}
        </div>
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
            title="My Library"
            description="Manage and browse your complete knife inventory."
          />
          <div className="h-96 rounded-xl border border-dashed bg-muted/50" />
        </div>
      }
    >
      <CollectionContent />
    </Suspense>
  )
}

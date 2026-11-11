'use client'

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { Check, Search, X } from 'lucide-react'
import { NOT_SET_FILTER_VALUE } from '@/lib/collection-filters'
import { cn } from '@/lib/utils'

export type ChipFilterField = {
  key: string
  label: string
  options: { value: string; label: string; count: number }[]
  /** Unit the numeric `Min`/`Max` limits are stored in, when supported. */
  rangeUnit?: 'mm' | 'g'
  /** User-created field; listed in its own group. */
  custom?: boolean
}

type CollectionChipFilterProps = {
  fields: ChipFilterField[]
  params: URLSearchParams
  /** Applies one atomic change to the collection query string. */
  apply: (update: (params: URLSearchParams) => void) => void
  /** Active filters that are not field values (type, ranges, missing specs). */
  extraChips: { key: string; label: string }[]
  /** Unit a bare length is typed and shown in. */
  lengthUnit: 'in' | 'mm' | 'both'
  onClearAll: () => void
  summary?: string
  inputRef: RefObject<HTMLInputElement | null>
}

type MenuItem = {
  id: string
  section: string
  label: ReactNode
  hint?: string | number
  checked?: boolean
  run: () => void
}

const MAX_VALUE_MATCHES = 8

type RangeUnit = 'mm' | 'in' | 'g' | 'oz'
const UNIT_FACTORS: Record<RangeUnit, number> = {
  mm: 1,
  in: 25.4,
  g: 1,
  oz: 28.349523125,
}
const NUMBER = String.raw`(\d+(?:[.,]\d+)?)`
const LIMIT_PATTERN = new RegExp(
  String.raw`^([<>]=?)?\s*${NUMBER}(?:\s*(?:-|–|to)\s*${NUMBER})?\s*(mm|in|inch|inches|"|g|grams?|oz)?$`,
  'i',
)
const trimNumber = (value: number, digits: number) =>
  Number(value.toFixed(digits))

function parseRangeUnit(raw: string | undefined): RangeUnit | null {
  const unit = raw?.toLowerCase()
  if (!unit) return null
  if (unit === 'mm' || unit === 'oz') return unit
  return unit.startsWith('g') ? 'g' : 'in'
}

/**
 * One-row search and filter bar: suggests fields, then that field's values,
 * then fields again. Picked filters stay in the bar as chips.
 */
export function CollectionChipFilter({
  fields,
  params,
  apply,
  extraChips,
  lengthUnit,
  onClearAll,
  summary,
  inputRef,
}: CollectionChipFilterProps) {
  const listId = useId()
  const barRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [text, setText] = useState('')
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  // Search text saved while the typed text previews as a live search.
  const [savedQuery, setSavedQuery] = useState<string | null>(null)

  const query = params.get('q') ?? ''
  const pending = fields.find((field) => field.key === pendingKey) ?? null
  const needle = text.trim().toLowerCase()

  const restoreQuery = (next: URLSearchParams) => {
    if (savedQuery === null) return
    if (savedQuery) next.set('q', savedQuery)
    else next.delete('q')
  }
  const reset = () => {
    setText('')
    setPendingKey(null)
    setSavedQuery(null)
    setActiveIndex(0)
  }
  const pickField = (key: string) => {
    if (savedQuery !== null) apply(restoreQuery)
    setSavedQuery(null)
    setPendingKey(key)
    setText('')
    setActiveIndex(0)
    setIsOpen(true)
  }
  const toggleValue = (key: string, value: string) => {
    apply((next) => {
      restoreQuery(next)
      const values = next.getAll(key)
      next.delete(key)
      const updated = values.includes(value)
        ? values.filter((current) => current !== value)
        : [...values, value]
      updated.forEach((current) => next.append(key, current))
    })
    reset()
  }
  const setLimits = (key: string, limits: { Min?: number; Max?: number }) => {
    apply((next) => {
      for (const bound of ['Min', 'Max'] as const) {
        const value = limits[bound]
        if (value !== undefined)
          next.set(`${key}${bound}`, String(trimNumber(value, 3)))
      }
      // A lower limit at or above the upper one would match nothing.
      const min = next.get(`${key}Min`)
      const max = next.get(`${key}Max`)
      if (min !== null && max !== null && Number(min) >= Number(max))
        next.delete(`${key}${limits.Min === undefined ? 'Min' : 'Max'}`)
    })
    reset()
  }
  // Units a typed number can mean: the typed one, else the Settings unit.
  const unitsFor = (field: ChipFilterField, typed: RangeUnit | null) => {
    const allowed: RangeUnit[] =
      field.rangeUnit === 'g' ? ['g', 'oz'] : ['in', 'mm']
    if (typed) return allowed.includes(typed) ? [typed] : []
    if (field.rangeUnit === 'g') return ['g' as const]
    return lengthUnit === 'both' ? allowed : [lengthUnit]
  }
  // Stored limits are in mm or g; show lengths in the display unit.
  const describeRange = (field: ChipFilterField) => {
    const stored = (['Min', 'Max'] as const).map((bound) => {
      const value = params.get(`${field.key}${bound}`)
      return value === null || !Number.isFinite(Number(value))
        ? null
        : Number(value)
    })
    if (stored.every((value) => value === null)) return null
    const inches = stored.map((value) =>
      value === null ? null : trimNumber(value / 25.4, 2),
    )
    // Limits typed in inches convert back cleanly; show those as inches.
    const cleanInches = stored.every(
      (value, index) =>
        value === null || Math.abs((inches[index] ?? 0) * 25.4 - value) < 0.01,
    )
    const useInches =
      field.rangeUnit === 'mm' &&
      (lengthUnit === 'in' ||
        (cleanInches &&
          (lengthUnit === 'both' ||
            stored.some((value) => value !== null && value % 1 !== 0))))
    const [min, max] = useInches ? inches : stored
    const unit = useInches ? 'in' : field.rangeUnit
    return min !== null && max !== null
      ? `${min}–${max} ${unit}`
      : min !== null
        ? `≥ ${min} ${unit}`
        : `< ${max} ${unit}`
  }
  const unitHint = (field: ChipFilterField) =>
    field.rangeUnit === 'mm'
      ? lengthUnit === 'both'
        ? 'in / mm'
        : lengthUnit
      : field.rangeUnit

  const items: MenuItem[] = []
  if (pending) {
    const limit = pending.rangeUnit ? text.trim().match(LIMIT_PATTERN) : null
    if (limit) {
      const first = Number(limit[2].replace(',', '.'))
      const second =
        limit[3] === undefined ? null : Number(limit[3].replace(',', '.'))
      for (const unit of unitsFor(pending, parseRangeUnit(limit[4]))) {
        const factor = UNIT_FACTORS[unit]
        if (second !== null) {
          if (first < second)
            items.push({
              id: `between:${unit}`,
              section: 'Range',
              label: `Between ${first} and ${second} ${unit}`,
              run: () =>
                setLimits(pending.key, {
                  Min: first * factor,
                  Max: second * factor,
                }),
            })
          continue
        }
        if (!limit[1]?.startsWith('<'))
          items.push({
            id: `min:${unit}`,
            section: 'Range',
            label: `At least ${first} ${unit}`,
            run: () => setLimits(pending.key, { Min: first * factor }),
          })
        if (!limit[1]?.startsWith('>') && first > 0)
          items.push({
            id: `max:${unit}`,
            section: 'Range',
            label: `Under ${first} ${unit}`,
            run: () => setLimits(pending.key, { Max: first * factor }),
          })
      }
    }
    const selected = params.getAll(pending.key)
    const visible = pending.options.filter(
      (option) => !needle || option.label.toLowerCase().includes(needle),
    )
    // "Select all" means every recorded value, so it leaves "Not set" out.
    const selectable = visible.filter(
      (option) => option.value !== NOT_SET_FILTER_VALUE,
    )
    if (
      selectable.length > 1 &&
      selectable.some((option) => !selected.includes(option.value))
    )
      items.push({
        id: 'select-all',
        section: pending.label,
        label: needle
          ? `Select all matching “${text.trim()}”`
          : `Select all ${pending.label.toLowerCase()} values`,
        hint: selectable.length,
        run: () => {
          apply((next) => {
            const current = next.getAll(pending.key)
            for (const option of selectable)
              if (!current.includes(option.value))
                next.append(pending.key, option.value)
          })
          reset()
        },
      })
    if (selected.length > 0 && !needle)
      items.push({
        id: 'clear-selection',
        section: pending.label,
        label: 'Clear selection',
        run: () => {
          apply((next) => next.delete(pending.key))
          reset()
        },
      })
    for (const option of visible) {
      items.push({
        id: `value:${option.value}`,
        section: pending.label,
        label: option.label,
        hint: option.count,
        checked: selected.includes(option.value),
        run: () => toggleValue(pending.key, option.value),
      })
    }
  } else {
    const fieldItems = (custom: boolean) =>
      fields
        .filter(
          (field) =>
            Boolean(field.custom) === custom &&
            (custom || field.options.length > 0 || field.rangeUnit) &&
            (!needle || field.label.toLowerCase().includes(needle)),
        )
        .map((field) => ({
          id: `field:${field.key}`,
          section: custom ? 'Custom fields' : 'Filter by',
          label: field.label,
          hint: unitHint(field),
          run: () => pickField(field.key),
        }))
    items.push(...fieldItems(false))
    if (
      params.get('missingSpecs') !== '1' &&
      'missing specifications'.includes(needle)
    )
      items.push({
        id: 'missingSpecs',
        section: 'Filter by',
        label: 'Missing specifications',
        run: () => {
          apply((next) => {
            restoreQuery(next)
            next.set('missingSpecs', '1')
          })
          reset()
        },
      })
    items.push(...fieldItems(true))
    if (needle.length >= 2) {
      let matches = 0
      for (const field of fields) {
        const selected = params.getAll(field.key)
        for (const option of field.options) {
          if (matches >= MAX_VALUE_MATCHES) break
          if (
            !option.label.toLowerCase().includes(needle) ||
            selected.includes(option.value)
          )
            continue
          matches += 1
          items.push({
            id: `match:${field.key}:${option.value}`,
            section: 'Matches',
            label: (
              <>
                <span className="text-muted-foreground">{field.label}:</span>{' '}
                {option.label}
              </>
            ),
            hint: option.count,
            run: () => toggleValue(field.key, option.value),
          })
        }
      }
    }
    if (needle)
      items.push({
        id: 'search',
        section: 'Search',
        label: `Search for “${text.trim()}”`,
        run: reset,
      })
  }
  const activeItem = items[Math.min(activeIndex, items.length - 1)]

  const chips = [
    ...(query.trim() && savedQuery === null
      ? [
          {
            id: 'q',
            label: 'Search',
            value: query.trim(),
            fieldKey: null as string | null,
            remove: (next: URLSearchParams) => next.delete('q'),
          },
        ]
      : []),
    ...fields.flatMap((field) => {
      const selected = params.getAll(field.key).filter(Boolean)
      return selected.length
        ? [
            {
              id: field.key,
              label: field.label,
              value:
                selected.length > 1 &&
                field.options.every(
                  (option) =>
                    option.value === NOT_SET_FILTER_VALUE ||
                    selected.includes(option.value),
                )
                  ? selected.includes(NOT_SET_FILTER_VALUE)
                    ? 'All'
                    : 'Any value'
                  : selected.length > 3
                    ? `${selected.length} selected`
                    : selected
                        .map(
                          (value) =>
                            field.options.find(
                              (option) => option.value === value,
                            )?.label ?? value,
                        )
                        .join(', '),
              fieldKey: field.key as string | null,
              remove: (next: URLSearchParams) => next.delete(field.key),
            },
          ]
        : []
    }),
    ...fields.flatMap((field) => {
      const range = field.rangeUnit ? describeRange(field) : null
      return range
        ? [
            {
              id: `range:${field.key}`,
              label: field.label,
              value: range,
              fieldKey: field.key as string | null,
              remove: (next: URLSearchParams) => {
                next.delete(`${field.key}Min`)
                next.delete(`${field.key}Max`)
              },
            },
          ]
        : []
    }),
    ...extraChips
      .filter(
        (chip) =>
          !fields.some(
            (field) =>
              field.rangeUnit &&
              (chip.key === `${field.key}Min` ||
                chip.key === `${field.key}Max`),
          ),
      )
      .map((chip) => ({
        id: `extra:${chip.key}`,
        label: '',
        value: chip.label,
        fieldKey: null as string | null,
        remove: (next: URLSearchParams) => next.delete(chip.key),
      })),
  ]
  const hasContent = chips.length > 0 || Boolean(text) || Boolean(pending)

  const changeText = (next: string) => {
    setText(next)
    setActiveIndex(0)
    setIsOpen(true)
    if (pending) return
    // Typed text searches live; the previous search returns if it is erased.
    // The saved search comes from the live URL, which can be ahead of `params`.
    const trimmed = next.trim()
    let base: string | null = savedQuery
    apply((nextParams) => {
      base ??= nextParams.get('q') ?? ''
      if (trimmed || base) nextParams.set('q', trimmed || base)
      else nextParams.delete('q')
    })
    setSavedQuery(trimmed ? base : null)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!isOpen) return setIsOpen(true)
      if (!items.length) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      const current = Math.min(activeIndex, items.length - 1)
      setActiveIndex((current + step + items.length) % items.length)
    } else if (event.key === 'Enter') {
      if (!isOpen || !activeItem) return
      event.preventDefault()
      activeItem.run()
    } else if (event.key === 'Backspace' && !text) {
      if (pending) {
        setPendingKey(null)
        setActiveIndex(0)
      } else {
        const last = chips[chips.length - 1]
        if (last) apply(last.remove)
      }
    } else if (event.key === 'Escape') {
      // Keep the page-level Escape handler from clearing every filter.
      event.stopPropagation()
      if (pending || text) {
        if (savedQuery !== null) apply(restoreQuery)
        reset()
      } else if (isOpen) setIsOpen(false)
      else inputRef.current?.blur()
    }
  }

  // Keep the menu under the caret without letting it leave the bar.
  useLayoutEffect(() => {
    const bar = barRef.current
    const menu = menuRef.current
    const input = inputRef.current
    if (!isOpen || !bar || !menu || !input) return
    const left = Math.min(
      input.offsetLeft - 8,
      bar.clientWidth - menu.offsetWidth,
    )
    menu.style.left = `${Math.max(0, left)}px`
    menu
      .querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  })

  let lastSection = ''

  return (
    <div
      ref={barRef}
      data-collection-chip-filter
      className="group relative mb-3.5 flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-input bg-background px-2.5 py-1 text-sm transition-[border-color,box-shadow] focus-within:border-primary focus-within:ring-[3px] focus-within:ring-primary/15"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault()
          inputRef.current?.focus()
        }
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return
        setIsOpen(false)
        // Typed text stays applied as the search; an unfinished field goes.
        reset()
      }}
    >
      <Search
        className="size-3.5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      {chips.map((chip) => (
        <span
          key={chip.id}
          className="inline-flex h-6 max-w-full items-center rounded-md border border-border bg-muted text-xs"
        >
          <button
            type="button"
            disabled={!chip.fieldKey}
            onClick={() => {
              if (!chip.fieldKey) return
              pickField(chip.fieldKey)
              inputRef.current?.focus()
            }}
            title={chip.fieldKey ? `Change ${chip.label}` : undefined}
            className="flex min-w-0 items-center gap-1 rounded-l-md py-0.5 pl-2 pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring enabled:cursor-pointer"
          >
            {chip.label && (
              <span className="shrink-0 text-muted-foreground">
                {chip.label}:
              </span>
            )}
            <span className="truncate font-medium text-[var(--bladevault-title)]">
              {chip.value}
            </span>
          </button>
          <button
            type="button"
            aria-label={`Remove ${chip.label ? `${chip.label}: ` : ''}${chip.value}`}
            onClick={() => {
              apply(chip.remove)
              inputRef.current?.focus()
            }}
            className="mr-0.5 rounded-sm p-0.5 text-muted-foreground hover:bg-border hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </span>
      ))}
      {pending && (
        <span className="inline-flex h-6 items-center rounded-md border border-dashed border-primary bg-primary/10 px-2 text-xs text-muted-foreground">
          {pending.label}:
        </span>
      )}
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label="Search and filter collection"
        aria-expanded={isOpen}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          isOpen && activeItem ? `${listId}-${activeItem.id}` : undefined
        }
        autoComplete="off"
        spellCheck={false}
        value={text}
        placeholder={
          pending
            ? pending.rangeUnit
              ? `Pick a value or type a range, e.g. 3-4 (${unitHint(pending)})…`
              : 'Pick or type a value…'
            : chips.length
              ? 'Add filter…'
              : 'Search or filter by brand, steel, lock…'
        }
        onChange={(event) => changeText(event.target.value)}
        onFocus={() => setIsOpen(true)}
        onClick={() => setIsOpen(true)}
        onKeyDown={handleKeyDown}
        className="h-7 min-w-32 flex-1 border-0 bg-transparent p-0 text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
      {summary && (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {summary}
        </span>
      )}
      {hasContent ? (
        <button
          type="button"
          aria-label="Clear search and filters"
          title="Clear all"
          onClick={() => {
            reset()
            onClearAll()
            inputRef.current?.focus()
          }}
          className="shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      ) : (
        <kbd className="pointer-events-none hidden shrink-0 rounded border border-border/80 bg-muted/60 px-1.5 py-0.5 font-mono text-[9px] leading-none text-muted-foreground group-focus-within:hidden sm:inline-flex">
          /
        </kbd>
      )}
      {isOpen && (
        <div
          ref={menuRef}
          id={listId}
          role="listbox"
          aria-label={pending ? pending.label : 'Filters'}
          onMouseDown={(event) => event.preventDefault()}
          className="absolute left-0 top-full z-30 mt-1.5 max-h-80 w-72 max-w-full overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {items.length === 0 && (
            <div className="px-2.5 py-2 text-xs text-muted-foreground">
              {pending?.rangeUnit
                ? `No matching values. Type a number or a range such as 3-4 (${unitHint(pending)}).`
                : 'No matches'}
            </div>
          )}
          {items.map((item) => {
            const heading = item.section !== lastSection ? item.section : null
            lastSection = item.section
            const isActive = item === activeItem
            return (
              <div key={item.id} role="presentation">
                {heading && (
                  <div className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                    {heading}
                  </div>
                )}
                <div
                  id={`${listId}-${item.id}`}
                  role="option"
                  aria-selected={isActive}
                  onClick={item.run}
                  onMouseMove={() => setActiveIndex(items.indexOf(item))}
                  className={cn(
                    'relative flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px]',
                    isActive &&
                      'bg-accent before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-primary',
                  )}
                >
                  {item.checked !== undefined && (
                    <Check
                      className={cn(
                        'size-3.5 shrink-0 text-primary',
                        !item.checked && 'invisible',
                      )}
                      aria-hidden="true"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint !== undefined && (
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {item.hint}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

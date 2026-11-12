'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useKnives } from '@/components/providers/knives-provider'
import { useComparisons } from '@/components/providers/comparisons-provider'
import type { Knife } from '@/lib/data'
import type { CollectionDisplay } from '@/lib/settings-shared'
import { filterLumenKnives, sortLumenKnives } from '@/lib/lumen-collection'
import { useDebouncedValue } from '@/lib/use-debounced-value'

/**
 * Shared state for the Lumen-palette collection layouts: URL-backed filters
 * (the same keys the Modern collection uses), the saved sort order, and the
 * pin, sold and compare actions with their feedback.
 */
export function useLumenCollection() {
  const {
    knives,
    isLoading,
    pinnedItemsFirst,
    collectionDisplay,
    updateCollectionDisplay,
    showFeedback,
  } = useKnives()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const paramsKey = searchParams.toString()
  const urlQuery = searchParams.get('q') ?? ''
  // Typing updates the field immediately; the URL follows after a pause.
  const [draft, setDraft] = useState<{ base: string; value: string } | null>(
    null,
  )
  const query = draft && draft.base === urlQuery ? draft.value : urlQuery
  const debouncedQuery = useDebouncedValue(query, 200)
  const queryTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(queryTimer.current), [])

  const replaceParams = useCallback(
    (update: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(paramsKey)
      update(params)
      params.delete('smart')
      const next = params.toString()
      router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false })
    },
    [paramsKey, pathname, router],
  )

  const setQuery = useCallback(
    (value: string) => {
      setDraft({ base: urlQuery, value })
      window.clearTimeout(queryTimer.current)
      queryTimer.current = window.setTimeout(() => {
        replaceParams((params) => {
          if (value.trim()) params.set('q', value)
          else params.delete('q')
        })
      }, 250)
    },
    [replaceParams, urlQuery],
  )

  const filtered = useMemo(() => {
    const params = new URLSearchParams(paramsKey)
    params.set('q', debouncedQuery)
    return sortLumenKnives(
      filterLumenKnives(knives, params),
      collectionDisplay.sort,
      pinnedItemsFirst && params.get('view') !== 'pinned',
    )
  }, [
    knives,
    paramsKey,
    debouncedQuery,
    collectionDisplay.sort,
    pinnedItemsFirst,
  ])

  const getValues = useCallback(
    (key: string) => new URLSearchParams(paramsKey).getAll(key),
    [paramsKey],
  )

  /** Makes `value` the only selection for `key`, or clears it when repeated. */
  const toggleSingle = useCallback(
    (key: string, value: string | null) =>
      replaceParams((params) => {
        const current = params.get(key)
        params.delete(key)
        if (value !== null && current !== value) params.set(key, value)
      }),
    [replaceParams],
  )

  const clearFilters = useCallback(() => {
    window.clearTimeout(queryTimer.current)
    setDraft(null)
    router.replace(pathname, { scroll: false })
  }, [pathname, router])

  const hasFilters = useMemo(() => {
    const params = new URLSearchParams(paramsKey)
    params.delete('smart')
    return params.toString() !== ''
  }, [paramsKey])

  const setSort = useCallback(
    (sort: CollectionDisplay['sort']) => {
      void updateCollectionDisplay({ sort }).catch((error) =>
        showFeedback(
          error instanceof Error
            ? error.message
            : 'Could not save display settings.',
          'error',
        ),
      )
    },
    [showFeedback, updateCollectionDisplay],
  )

  return {
    knives,
    isLoading,
    filtered,
    query,
    setQuery,
    getValues,
    toggleSingle,
    replaceParams,
    clearFilters,
    hasFilters,
    sort: collectionDisplay.sort,
    setSort,
  }
}

/** Pin, sold and compare actions with busy state and feedback. */
export function useLumenKnifeActions() {
  const { updateKnife, showFeedback, pinnedItemsFirst } = useKnives()
  const comparisons = useComparisons()
  const [busy, setBusy] = useState<string | null>(null)

  const run = useCallback(
    async (key: string, action: () => Promise<void>, fallback: string) => {
      setBusy(key)
      try {
        await action()
      } catch (error) {
        showFeedback(error instanceof Error ? error.message : fallback, 'error')
      } finally {
        setBusy(null)
      }
    },
    [showFeedback],
  )

  const togglePin = useCallback(
    (knife: Knife) =>
      run(
        `pin:${knife.id}`,
        async () => {
          await updateKnife(knife.id, { pinned: !knife.pinned })
          showFeedback(
            knife.pinned
              ? 'Unpinned'
              : pinnedItemsFirst
                ? 'Pinned — moved to top'
                : 'Pinned',
          )
        },
        'Could not update pin.',
      ),
    [pinnedItemsFirst, run, showFeedback, updateKnife],
  )

  const toggleSold = useCallback(
    (knife: Knife) =>
      run(
        `sold:${knife.id}`,
        async () => {
          await updateKnife(knife.id, { sold: !knife.sold })
          showFeedback(knife.sold ? 'Marked as owned' : 'Marked as sold')
        },
        'Could not update the knife.',
      ),
    [run, showFeedback, updateKnife],
  )

  /** Adds knives to a comparison; a single knife already in it is removed. */
  const compare = useCallback(
    (ids: string[], bulk = false) =>
      run(
        `compare:${ids.join(',')}`,
        () => comparisons.choose(ids, bulk),
        'Could not update comparison.',
      ),
    [comparisons, run],
  )

  return {
    togglePin,
    toggleSold,
    compare,
    busy,
    isInCompare: (id: string) => comparisons.membershipCount(id) > 0,
    compareUnavailable:
      comparisons.loading || comparisons.busy || Boolean(comparisons.error),
    activeComparison: comparisons.active,
  }
}

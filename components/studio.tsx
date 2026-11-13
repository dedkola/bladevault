'use client'

import { isModernThemeFamily } from '@/lib/settings-shared'
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { WorkspaceHeaderActionsContext } from '@/components/workspace-header-actions'
import Link from 'next/link'
import {
  ArrowRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Expand,
  Grid2X2,
  ImageIcon,
  LayoutDashboard,
  Pause,
  Pencil,
  Pin,
  Play,
  Plus,
  Search,
  X,
} from 'lucide-react'
import { CompareIcon } from '@/components/icons/compare-icon'
import Image from '@/components/vault-image'
import { useKnives } from '@/components/providers/knives-provider'
import { PageHeader } from '@/components/page-header'
import { useComparisons } from '@/components/providers/comparisons-provider'
import { useSmartCollections } from '@/components/providers/smart-collections-provider'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'
import { formatDimension, formatWeight } from '@/lib/measurements'
import { getImageUrl, type Knife } from '@/lib/data'
import { groupKnifeFamilies } from '@/lib/knife-families'
import { createStudioLayout } from '@/lib/studio'
import { matchesCollection } from '@/lib/smart-collections'
import { cn } from '@/lib/utils'
import styles from './studio.module.css'

// Smart Collections are selected as `smart:<id>`.
type StudioFilter = 'all' | 'folding' | 'fixed' | 'pinned' | `smart:${string}`

function StudioImage({
  knife,
  eager = false,
  imageIndex = 0,
}: {
  knife: Knife
  eager?: boolean
  imageIndex?: number
}) {
  const [failed, setFailed] = useState(false)
  return knife.images[imageIndex] && !failed ? (
    <Image
      src={getImageUrl(knife.images[imageIndex])}
      alt={`${knife.brand} ${knife.name}`.trim()}
      fill
      sizes="(max-width: 600px) 80vw, (max-width: 1100px) 50vw, 40vw"
      className={styles.image}
      fetchPriority={eager ? 'high' : undefined}
      loading={eager ? 'eager' : 'lazy'}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  ) : (
    <span className={styles.noImage}>
      <ImageIcon aria-hidden="true" />
      <span>No photo yet</span>
    </span>
  )
}

// Showcase mode: one visible tile flips to another knife on each beat.
const SHOWCASE_INTERVAL = 4000
// Matches the flap animation in studio.module.css (fall + land).
const FLIP_DURATION = 1000

type ShowcaseSwap = { slot: string; partner: string; knifeId: string }
type ShowcaseTile = {
  slot: string
  knife: string
  onScreen: boolean
  busy: boolean
}

function readShowcaseTiles(): ShowcaseTile[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-studio-gallery] [data-studio-slot]',
    ),
    (node) => {
      const rect = node.getBoundingClientRect()
      return {
        slot: node.dataset.studioSlot ?? '',
        knife: node.dataset.studioTile ?? '',
        onScreen:
          rect.height > 0 &&
          rect.top >= -rect.height / 3 &&
          rect.bottom <= window.innerHeight + rect.height / 3,
        // Never flip a tile under the pointer or holding keyboard focus.
        busy: node.matches(':hover') || node.contains(document.activeElement),
      }
    },
  )
}

function pickRandom<T>(items: T[]) {
  return items.length
    ? items[Math.floor(Math.random() * items.length)]
    : undefined
}

/** Choose a visible tile and the tile whose knife it will receive. */
function planShowcaseSwap(
  tiles: ShowcaseTile[],
  recent: string[],
): ShowcaseSwap | null {
  const target = pickRandom(
    tiles.filter(
      (tile) => tile.onScreen && !tile.busy && !recent.includes(tile.slot),
    ),
  )
  if (!target) return null
  // Prefer a knife from outside the viewport, so a new knife comes into view.
  const offScreen = tiles.filter((tile) => !tile.onScreen && !tile.busy)
  const partner = pickRandom(
    offScreen.length
      ? offScreen
      : tiles.filter((tile) => tile !== target && !tile.busy),
  )
  return partner
    ? { slot: target.slot, partner: partner.slot, knifeId: partner.knife }
    : null
}

function StudioTileFace({ knife, eager }: { knife: Knife; eager?: boolean }) {
  return (
    <>
      <div className={styles.stage}>
        <StudioImage
          key={knife.images[0] ?? knife.id}
          knife={knife}
          eager={eager}
        />
      </div>
      {knife.sold && <span className={styles.sold}>Sold</span>}
      <div className={styles.caption} aria-hidden="true">
        <div>
          <b>{knife.name}</b>
          <span>
            {[knife.brand, knife.specs.bladeMaterial]
              .filter(Boolean)
              .join(' · ') || 'Specifications not recorded'}
          </span>
        </div>
        <span className={styles.openArrow}>
          <ArrowUpRight />
        </span>
      </div>
    </>
  )
}

/** Tile content that turns over like a split-flap board when its knife changes. */
function StudioTileContent({
  knife,
  eager,
  incoming,
}: {
  knife: Knife
  eager?: boolean
  incoming?: Knife
}) {
  const [shown, setShown] = useState(knife)
  const [outgoing, setOutgoing] = useState<Knife | null>(null)
  if (shown !== knife) {
    if (shown.id !== knife.id) setOutgoing(shown)
    setShown(knife)
  }
  useEffect(() => {
    if (!outgoing) return
    const timer = window.setTimeout(() => setOutgoing(null), FLIP_DURATION)
    return () => window.clearTimeout(timer)
  }, [outgoing])

  return (
    <>
      <div className={cn(styles.face, outgoing && styles.faceIncoming)}>
        <StudioTileFace knife={knife} eager={eager || Boolean(outgoing)} />
      </div>
      {outgoing && (
        <div className={styles.flip} aria-hidden="true">
          <div className={cn(styles.flipHalf, styles.flipStatic)}>
            <div className={styles.flipFace}>
              <StudioTileFace knife={outgoing} eager />
            </div>
          </div>
          <div className={cn(styles.flipHalf, styles.flipTop)}>
            <div className={styles.flipFace}>
              <StudioTileFace knife={outgoing} eager />
            </div>
          </div>
          <div className={cn(styles.flipHalf, styles.flipBottom)}>
            <div className={styles.flipFace}>
              <StudioTileFace knife={knife} eager />
            </div>
          </div>
        </div>
      )}
      {/* Load the next knife's photo a beat early so the flip never shows a blank. */}
      {incoming && (
        <div className={styles.preload} aria-hidden="true">
          <StudioImage knife={incoming} eager />
        </div>
      )}
    </>
  )
}

export function StudioView() {
  const {
    knives,
    isLoading,
    updateKnife,
    showFeedback,
    themeStyle,
    dimensionUnit,
  } = useKnives()
  const {
    choose,
    membershipCount,
    loading: comparisonsLoading,
    busy: comparisonsBusy,
    error: comparisonsError,
  } = useComparisons()
  const { collections } = useSmartCollections()
  // The provider renders an empty loading state on the server. Randomness is
  // only visible after it loads, and lasts for this visit rather than each render.
  const [seed] = useState(() => Math.floor(Math.random() * 0x100000000))
  const [filter, setFilter] = useState<StudioFilter>('all')
  const [query, setQuery] = useState('')
  const [size, setSize] = useState<'regular' | 'large'>('regular')
  const [focus, setFocus] = useState(false)
  const [showcase, setShowcase] = useState(false)
  // Slot (layout knife id) -> displayed knife id. Swaps keep it a permutation.
  const [assignment, setAssignment] = useState<Record<string, string>>({})
  const [pendingSwap, setPendingSwap] = useState<ShowcaseSwap | null>(null)
  const pendingSwapRef = useRef<ShowcaseSwap | null>(null)
  const recentSlots = useRef<string[]>([])
  const headerTarget = useContext(WorkspaceHeaderActionsContext)
  const [quickLook, setQuickLook] = useState<{
    knifeId: string
    imageIndex: number
  } | null>(null)
  const [quickPhotos, setQuickPhotos] = useState<{
    knifeId: string
    images?: string[]
    error?: string
  } | null>(null)
  const [pinBusy, setPinBusy] = useState<string | null>(null)
  const [compareBusy, setCompareBusy] = useState<string | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const focusButton = useRef<HTMLButtonElement | null>(null)
  const layout = useMemo(() => createStudioLayout(knives, seed), [knives, seed])
  const smartCollection = filter.startsWith('smart:')
    ? collections.find((item) => `smart:${item.id}` === filter)
    : undefined
  // Fall back to All when the selected Smart Collection is deleted.
  const activeFilter: StudioFilter =
    filter.startsWith('smart:') && !smartCollection ? 'all' : filter
  const visible = useMemo(() => {
    const search = query.trim().toLocaleLowerCase()
    const typeFilter =
      activeFilter === 'fixed' || activeFilter === 'folding'
        ? new URLSearchParams({ knifeType: activeFilter })
        : smartCollection
          ? new URLSearchParams(smartCollection.query)
          : null
    const entries = layout.filter(({ knife }) => {
      if (typeFilter && !matchesCollection(knife, typeFilter)) return false
      if (activeFilter === 'pinned' && !knife.pinned) return false
      return (
        !search ||
        [
          knife.name,
          knife.brand,
          knife.bladeStyle,
          knife.handleMaterial,
          ...Object.values(knife.specs),
          ...Object.values(knife.customFields),
        ]
          .join(' ')
          .toLocaleLowerCase()
          .includes(search)
      )
    })
    return entries
  }, [layout, activeFilter, smartCollection, query])
  const displayed = useMemo(() => {
    const byId = new Map(visible.map(({ knife }) => [knife.id, knife]))
    const values = Object.values(assignment)
    // Ignore a stale arrangement (a knife left the filter or was deleted).
    const valid =
      new Set(values).size === values.length &&
      Object.entries(assignment).every(
        ([slot, id]) => byId.has(slot) && byId.has(id),
      )
    return visible.map((entry) => ({
      ...entry,
      slot: entry.knife.id,
      knife: (valid && byId.get(assignment[entry.knife.id])) || entry.knife,
    }))
  }, [visible, assignment])
  const incomingKnife = pendingSwap
    ? visible.find(({ knife }) => knife.id === pendingSwap.knifeId)?.knife
    : undefined
  const families = useMemo(
    () => groupKnifeFamilies(layout.map(({ knife }) => knife)),
    [layout],
  )
  const featuredFamilies = families
    .filter((family) => family.knives.some((knife) => knife.images.length))
    .slice(0, 3)
  const selectedSummary = quickLook
    ? knives.find((knife) => knife.id === quickLook.knifeId)
    : undefined
  const selectedPhotos =
    quickPhotos?.knifeId === quickLook?.knifeId ? quickPhotos : null
  const selectedKnife = selectedSummary
    ? {
        ...selectedSummary,
        images: selectedPhotos?.images ?? selectedSummary.images,
      }
    : undefined
  const photosLoading = Boolean(quickLook && !selectedPhotos)
  const quickLookCount = selectedPhotos?.images?.length ?? 0
  const quickLookId = quickLook?.knifeId
  const showcaseDisabled = isLoading || visible.length < 2

  useEffect(() => {
    // Quick Look pauses the showcase; it resumes when the dialog closes.
    if (!showcase || isLoading || quickLookId) return
    const tick = () => {
      if (document.hidden) return
      let tiles = readShowcaseTiles()
      const swap = pendingSwapRef.current
      const target = swap && tiles.find((tile) => tile.slot === swap.slot)
      const partner = swap && tiles.find((tile) => tile.slot === swap.partner)
      if (target && partner && !target.busy && partner.knife === swap.knifeId) {
        tiles = tiles.map((tile) => ({
          ...tile,
          knife:
            tile === target
              ? partner.knife
              : tile === partner
                ? target.knife
                : tile.knife,
        }))
        setAssignment(
          Object.fromEntries(tiles.map((tile) => [tile.slot, tile.knife])),
        )
        recentSlots.current = [target.slot, ...recentSlots.current].slice(0, 3)
      }
      const next = planShowcaseSwap(tiles, recentSlots.current)
      pendingSwapRef.current = next
      setPendingSwap(next)
    }
    const first = window.setTimeout(tick, 600)
    const timer = window.setInterval(tick, SHOWCASE_INTERVAL)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(timer)
    }
  }, [showcase, isLoading, quickLookId])

  function resetShowcase() {
    pendingSwapRef.current = null
    setPendingSwap(null)
    setAssignment({})
  }

  function toggleShowcase() {
    if (showcase) {
      pendingSwapRef.current = null
      setPendingSwap(null)
    }
    setShowcase(!showcase)
  }

  useEffect(() => {
    if (!quickLookId) return
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch(
          `/api/knives/${encodeURIComponent(quickLookId)}`,
          {
            signal: controller.signal,
            cache: 'no-store',
          },
        )
        const data = await readJsonResponse<{ knife?: Knife; error?: string }>(
          response,
        )
        if (!response.ok) {
          throw new Error(getApiErrorMessage(data, 'Could not load photos.'))
        }
        if (!Array.isArray(data.knife?.images)) {
          throw new Error('Could not load photos.')
        }
        if (!controller.signal.aborted) {
          setQuickPhotos({ knifeId: quickLookId, images: data.knife.images })
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setQuickPhotos({
            knifeId: quickLookId,
            error:
              error instanceof Error ? error.message : 'Could not load photos.',
          })
        }
      }
    })()
    return () => controller.abort()
  }, [quickLookId])

  async function togglePin(knife: Knife) {
    if (pinBusy) return
    setPinBusy(knife.id)
    try {
      await updateKnife(knife.id, { pinned: !knife.pinned })
      showFeedback(knife.pinned ? 'Unpinned' : 'Pinned')
    } catch (error) {
      showFeedback(
        error instanceof Error ? error.message : 'Could not update pin.',
        'error',
      )
    } finally {
      setPinBusy(null)
    }
  }

  async function compare(knife: Knife) {
    setCompareBusy(knife.id)
    try {
      await choose([knife.id])
    } catch (error) {
      showFeedback(
        error instanceof Error ? error.message : 'Could not update comparison.',
        'error',
      )
    } finally {
      setCompareBusy(null)
    }
  }

  function openQuickLook(id: string, trigger: HTMLElement) {
    returnFocus.current = trigger
    setQuickPhotos(null)
    setQuickLook({
      knifeId: id,
      imageIndex: 0,
    })
  }

  function moveQuickLook(delta: number) {
    if (quickLookCount < 2) return
    setQuickLook((current) =>
      current
        ? {
            ...current,
            imageIndex:
              (current.imageIndex + delta + quickLookCount) % quickLookCount,
          }
        : null,
    )
  }

  const compareDisabled =
    comparisonsLoading ||
    comparisonsBusy ||
    Boolean(comparisonsError) ||
    compareBusy !== null
  const gallery = (
    <div
      className={styles.gallery}
      data-studio-gallery
      data-size={size}
      aria-label="Collection showcase"
      aria-busy={isLoading}
    >
      {isLoading
        ? Array.from({ length: 8 }, (_, index) => (
            <div
              key={index}
              className={cn(styles.tile, styles.skeleton)}
              data-size={
                index === 0 ? 'tall' : index === 4 ? 'wide' : 'regular'
              }
            />
          ))
        : displayed.map(({ knife, slot, size: tileSize }, index) => (
            <article
              key={slot}
              className={styles.tile}
              data-studio-tile={knife.id}
              data-studio-slot={slot}
              data-size={tileSize}
            >
              <StudioTileContent
                knife={knife}
                eager={index < 4}
                incoming={
                  pendingSwap?.slot === slot ? incomingKnife : undefined
                }
              />
              <button
                type="button"
                className={styles.openTile}
                aria-label={`Quick look: ${knife.brand} ${knife.name}`}
                onClick={(event) =>
                  openQuickLook(knife.id, event.currentTarget)
                }
              />
              <div className={styles.tileActions}>
                <button
                  type="button"
                  aria-label={`${knife.pinned ? 'Unpin' : 'Pin'} ${knife.brand} ${knife.name}`}
                  aria-pressed={knife.pinned}
                  disabled={pinBusy !== null}
                  onClick={() => void togglePin(knife)}
                >
                  <Pin aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={`Compare ${knife.brand} ${knife.name}`}
                  aria-pressed={membershipCount(knife.id) > 0}
                  disabled={compareDisabled}
                  title={comparisonsError || 'Choose a comparison'}
                  onClick={() => void compare(knife)}
                >
                  <CompareIcon aria-hidden="true" />
                </button>
              </div>
            </article>
          ))}
      {!isLoading &&
        activeFilter === 'all' &&
        !query.trim() &&
        size === 'regular' &&
        featuredFamilies.length >= 2 && (
          <Link
            href="/collection?view=families"
            className={cn(styles.tile, styles.familyTile)}
          >
            <div className={styles.familyStack} aria-hidden="true">
              {featuredFamilies.map((family) => {
                const knife = family.knives.find((item) => item.images.length)!
                return (
                  <div key={family.key}>
                    <StudioImage knife={knife} />
                  </div>
                )
              })}
            </div>
            <div className={styles.familyCaption}>
              <div>
                <b>Browse by family</b>
                <span>
                  {featuredFamilies.map((family) => family.name).join(' · ')}
                </span>
              </div>
              <span>
                Explore <ArrowRight aria-hidden="true" />
              </span>
            </div>
          </Link>
        )}
    </div>
  )

  const showcaseLabel = showcase ? 'Pause showcase' : 'Play showcase'
  const showcaseIcon = showcase ? <Pause /> : <Play />
  const headerActions = (
    <>
      <Button
        variant="outline"
        size="icon"
        aria-label={showcaseLabel}
        title={showcaseLabel}
        onClick={toggleShowcase}
        disabled={showcaseDisabled}
      >
        {showcaseIcon}
      </Button>
      <Button
        ref={focusButton}
        variant="outline"
        size={
          isModernThemeFamily(themeStyle) || themeStyle === 'alloy'
            ? 'sm'
            : 'default'
        }
        onClick={() => setFocus(true)}
        disabled={isLoading || !visible.length}
      >
        <Expand />
        Focus mode
      </Button>
      <Link
        href="/add"
        className={buttonVariants({
          size:
            isModernThemeFamily(themeStyle) || themeStyle === 'alloy'
              ? 'sm'
              : 'default',
        })}
      >
        <Plus />
        Add knife
      </Link>
    </>
  )

  return (
    <>
      {isModernThemeFamily(themeStyle) &&
        headerTarget &&
        createPortal(
          <>
            <button
              type="button"
              aria-label={showcaseLabel}
              title={showcaseLabel}
              onClick={toggleShowcase}
              disabled={showcaseDisabled}
            >
              {showcase ? (
                <Pause aria-hidden="true" />
              ) : (
                <Play aria-hidden="true" />
              )}
            </button>
            <button
              ref={focusButton}
              type="button"
              aria-label="Focus mode"
              title="Focus mode"
              onClick={() => setFocus(true)}
              disabled={isLoading || !visible.length}
            >
              <Expand aria-hidden="true" />
            </button>
          </>,
          headerTarget,
        )}
      <div
        className={styles.root}
        data-studio
        data-alloy-studio={themeStyle === 'alloy' || undefined}
      >
        {themeStyle === 'alloy' ? (
          <h1 className="sr-only">Studio</h1>
        ) : !isModernThemeFamily(themeStyle) ? (
          <PageHeader
            title="Studio"
            description="Your collection, at a glance."
            breadcrumbs={[{ label: 'Studio' }]}
            actions={headerActions}
          />
        ) : null}
        <div className={styles.toolbar} aria-label="Studio controls">
          <div className={styles.toolbarLeft}>
            <div
              className={cn(styles.segmented, styles.filters)}
              role="group"
              aria-label="Filter collection"
            >
              {[
                ...(['all', 'folding', 'fixed', 'pinned'] as const).map(
                  (value) => ({
                    value: value as StudioFilter,
                    label: value[0].toUpperCase() + value.slice(1),
                  }),
                ),
                ...collections.map((collection) => ({
                  value: `smart:${collection.id}` as StudioFilter,
                  label: collection.name,
                })),
              ].map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={activeFilter === value}
                  onClick={() => {
                    if (value !== activeFilter) resetShowcase()
                    setFilter(value)
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className={styles.search}>
              <Search aria-hidden="true" />
              <span className="sr-only">Search knives</span>
              <input
                type="search"
                placeholder="Search knives"
                value={query}
                onChange={(event) => {
                  resetShowcase()
                  setQuery(event.target.value)
                }}
              />
            </label>
          </div>
          <div className={styles.toolbarRight}>
            <span className={styles.count} role="status">
              {isLoading
                ? 'Loading…'
                : `${visible.length} ${visible.length === 1 ? 'knife' : 'knives'}`}
            </span>
            {themeStyle === 'alloy' && (
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={showcaseLabel}
                title={showcaseLabel}
                onClick={toggleShowcase}
                disabled={showcaseDisabled}
              >
                {showcaseIcon}
              </Button>
            )}
            {themeStyle === 'alloy' && (
              <Button
                ref={focusButton}
                variant="outline"
                size="icon-sm"
                aria-label="Focus mode"
                title="Focus mode"
                onClick={() => setFocus(true)}
                disabled={isLoading || !visible.length}
              >
                <Expand />
              </Button>
            )}
            <div
              className={styles.segmented}
              role="group"
              aria-label="Tile size"
            >
              {/* One button cycles tile size: regular ↔ large. */}
              <button
                type="button"
                data-active
                aria-label={
                  size === 'regular'
                    ? 'Switch to large size'
                    : 'Switch to regular size'
                }
                title={
                  size === 'regular'
                    ? 'Switch to large size'
                    : 'Switch to regular size'
                }
                onClick={() =>
                  setSize(size === 'regular' ? 'large' : 'regular')
                }
              >
                {size === 'regular' ? <Grid2X2 /> : <LayoutDashboard />}
              </button>
            </div>
          </div>
        </div>
        {!focus && gallery}
        {!isLoading && !visible.length && (
          <div className={styles.empty}>
            <ImageIcon aria-hidden="true" />
            <h2>
              {knives.length ? 'No matching knives' : 'Your Studio starts here'}
            </h2>
            <p>
              {knives.length
                ? 'Try another search or show the whole collection.'
                : 'Add your first knife to bring your collection into view.'}
            </p>
            {knives.length ? (
              <Button
                variant="outline"
                onClick={() => {
                  resetShowcase()
                  setFilter('all')
                  setQuery('')
                }}
              >
                Show all knives
              </Button>
            ) : (
              <Link href="/add" className={buttonVariants()}>
                Add knife
              </Link>
            )}
          </div>
        )}
        <footer className={styles.footer}>
          <span>BladeVault Studio — a visual index of the vault.</span>
          <Link href="/collection">
            Open collection <ArrowRight aria-hidden="true" />
          </Link>
        </footer>
      </div>

      <Dialog open={focus} onOpenChange={setFocus}>
        <DialogContent
          data-studio-focus
          className={cn(styles.focus, 'translate-x-0 translate-y-0')}
          showCloseButton={false}
          finalFocus={focusButton}
        >
          <DialogTitle className="sr-only">Studio focus mode</DialogTitle>
          <DialogDescription className="sr-only">
            Browse your collection without distractions. Press Escape to exit.
          </DialogDescription>
          <div className={styles.focusActions}>
            <Button
              variant="outline"
              size="icon"
              aria-label={showcaseLabel}
              title={showcaseLabel}
              onClick={toggleShowcase}
              disabled={showcaseDisabled}
            >
              {showcaseIcon}
            </Button>
            <Button variant="outline" onClick={() => setFocus(false)}>
              <X />
              Exit focus
            </Button>
          </div>
          {gallery}
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(selectedKnife)}
        onOpenChange={(open) => {
          if (!open) setQuickLook(null)
        }}
      >
        <DialogContent
          data-studio-quick-look
          className={styles.quickLook}
          finalFocus={() =>
            returnFocus.current?.isConnected
              ? returnFocus.current
              : focusButton.current
          }
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault()
              moveQuickLook(event.key === 'ArrowLeft' ? -1 : 1)
            }
          }}
        >
          {selectedKnife && (
            <>
              <div className={styles.quickStage}>
                <StudioImage
                  key={`${selectedKnife.id}-${quickLook?.imageIndex}-${selectedKnife.images[quickLook?.imageIndex ?? 0]}`}
                  imageIndex={quickLook?.imageIndex ?? 0}
                  knife={selectedKnife}
                  eager
                />
                <div className={styles.quickNav}>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Previous image"
                    disabled={quickLookCount < 2}
                    onClick={() => moveQuickLook(-1)}
                  >
                    <ChevronLeft />
                  </Button>
                  <span
                    aria-live="polite"
                    aria-atomic="true"
                    role={selectedPhotos?.error ? 'alert' : undefined}
                  >
                    {photosLoading
                      ? 'Loading photos…'
                      : (selectedPhotos?.error ??
                        `${quickLookCount ? (quickLook?.imageIndex ?? 0) + 1 : 0} / ${quickLookCount}`)}
                  </span>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Next image"
                    disabled={quickLookCount < 2}
                    onClick={() => moveQuickLook(1)}
                  >
                    <ChevronRight />
                  </Button>
                </div>
              </div>
              <div className={styles.quickBody}>
                <div className={styles.quickIdentity}>
                  <DialogTitle className={styles.quickTitle}>
                    {selectedKnife.name}
                  </DialogTitle>
                  <DialogDescription className={styles.quickSubtitle}>
                    {[
                      selectedKnife.brand,
                      selectedKnife.specs.modelNumber,
                      selectedKnife.sold && 'Sold',
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'Model not recorded'}
                  </DialogDescription>
                </div>
                <dl className={styles.specs}>
                  {[
                    ['Steel', selectedKnife.specs.bladeMaterial],
                    [
                      'Blade',
                      formatDimension(
                        selectedKnife.specs.bladeLength,
                        dimensionUnit,
                      ),
                    ],
                    [
                      'Weight',
                      formatWeight(selectedKnife.specs.weight, dimensionUnit),
                    ],
                    ['Designer', selectedKnife.specs.designer],
                    ['Lock', selectedKnife.specs.lockingMechanism],
                    ['Handle', selectedKnife.handleMaterial],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value || 'Not recorded'}</dd>
                    </div>
                  ))}
                </dl>
                <div className={styles.quickActions}>
                  <Link
                    href={`/collection/${encodeURIComponent(selectedKnife.id)}`}
                    className={buttonVariants({ size: 'xs' })}
                  >
                    View knife <ArrowUpRight />
                  </Link>
                  <Link
                    href={`/collection/${encodeURIComponent(selectedKnife.id)}?edit=1`}
                    className={buttonVariants({
                      variant: 'outline',
                      size: 'xs',
                    })}
                  >
                    <Pencil />
                    Edit
                  </Link>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={pinBusy !== null}
                    aria-pressed={selectedKnife.pinned}
                    onClick={() => void togglePin(selectedKnife)}
                  >
                    <Pin />
                    {selectedKnife.pinned ? 'Pinned' : 'Pin'}
                  </Button>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={compareDisabled}
                    aria-pressed={membershipCount(selectedKnife.id) > 0}
                    title={comparisonsError || 'Update comparison membership'}
                    onClick={() => void compare(selectedKnife)}
                  >
                    <CompareIcon />
                    Compare
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

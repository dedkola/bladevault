'use client'

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
  Pencil,
  Pin,
  Plus,
  Scale,
  Search,
  X,
} from 'lucide-react'
import Image from '@/components/vault-image'
import { useKnives } from '@/components/providers/knives-provider'
import { PageHeader } from '@/components/page-header'
import { useComparisons } from '@/components/providers/comparisons-provider'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'
import { compactMeasurement } from '@/lib/compact-measurement'
import { getImageUrl, type Knife } from '@/lib/data'
import { groupKnifeFamilies } from '@/lib/knife-families'
import { createStudioLayout } from '@/lib/studio'
import { matchesCollection } from '@/lib/smart-collections'
import { cn } from '@/lib/utils'
import styles from './studio.module.css'

type StudioFilter = 'all' | 'folding' | 'fixed' | 'pinned'
type StudioSort = 'random' | 'name' | 'maker'

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

export function StudioView() {
  const { knives, isLoading, updateKnife, showFeedback, themeStyle } =
    useKnives()
  const {
    choose,
    membershipCount,
    loading: comparisonsLoading,
    busy: comparisonsBusy,
    error: comparisonsError,
  } = useComparisons()
  // The provider renders an empty loading state on the server. Randomness is
  // only visible after it loads, and lasts for this visit rather than each render.
  const [seed] = useState(() => Math.floor(Math.random() * 0x100000000))
  const [filter, setFilter] = useState<StudioFilter>('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<StudioSort>('random')
  const [size, setSize] = useState<'regular' | 'large'>('regular')
  const [focus, setFocus] = useState(false)
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
  const visible = useMemo(() => {
    const search = query.trim().toLocaleLowerCase()
    const typeFilter =
      filter === 'fixed' || filter === 'folding'
        ? new URLSearchParams({ knifeType: filter })
        : null
    const entries = layout.filter(({ knife }) => {
      if (typeFilter && !matchesCollection(knife, typeFilter)) return false
      if (filter === 'pinned' && !knife.pinned) return false
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
    if (sort === 'name')
      entries.sort((a, b) => a.knife.name.localeCompare(b.knife.name))
    if (sort === 'maker')
      entries.sort(
        (a, b) =>
          a.knife.brand.localeCompare(b.knife.brand) ||
          a.knife.name.localeCompare(b.knife.name),
      )
    return entries
  }, [layout, filter, query, sort])
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
        : visible.map(({ knife, size: tileSize }, index) => (
            <article
              key={knife.id}
              className={styles.tile}
              data-studio-tile={knife.id}
              data-size={tileSize}
            >
              <div className={styles.stage}>
                <StudioImage
                  key={knife.images[0] ?? knife.id}
                  knife={knife}
                  eager={index < 4}
                />
              </div>
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
                  <Scale aria-hidden="true" />
                </button>
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
            </article>
          ))}
      {!isLoading &&
        filter === 'all' &&
        !query.trim() &&
        sort === 'random' &&
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

  const headerActions = (
    <>
      <Button
        ref={focusButton}
        variant="outline"
        size={themeStyle === 'modern' ? 'sm' : 'default'}
        onClick={() => setFocus(true)}
        disabled={isLoading || !visible.length}
      >
        <Expand />
        Focus mode
      </Button>
      <Link
        href="/add"
        className={buttonVariants({
          size: themeStyle === 'modern' ? 'sm' : 'default',
        })}
      >
        <Plus />
        Add knife
      </Link>
    </>
  )

  return (
    <>
      {themeStyle === 'modern' &&
        headerTarget &&
        createPortal(
          <button
            ref={focusButton}
            type="button"
            aria-label="Focus mode"
            title="Focus mode"
            onClick={() => setFocus(true)}
            disabled={isLoading || !visible.length}
          >
            <Expand aria-hidden="true" />
          </button>,
          headerTarget,
        )}
      <div className={styles.root} data-studio>
        {themeStyle !== 'modern' && (
          <PageHeader
            title="Studio"
            description="Your collection, at a glance."
            breadcrumbs={[{ label: 'Studio' }]}
            actions={headerActions}
          />
        )}
        <div className={styles.toolbar} aria-label="Studio controls">
          <div className={styles.toolbarLeft}>
            <div
              className={styles.segmented}
              role="group"
              aria-label="Filter collection"
            >
              {(['all', 'folding', 'fixed', 'pinned'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {value[0].toUpperCase() + value.slice(1)}
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
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
          <div className={styles.toolbarRight}>
            <span className={styles.count} role="status">
              {isLoading
                ? 'Loading…'
                : `${visible.length} ${visible.length === 1 ? 'knife' : 'knives'}`}
            </span>
            <label className={styles.sort}>
              <span className="sr-only">Sort knives</span>
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as StudioSort)}
              >
                <option value="random">Featured</option>
                <option value="name">Name</option>
                <option value="maker">Maker</option>
              </select>
            </label>
            <div
              className={styles.segmented}
              role="group"
              aria-label="Tile size"
            >
              <button
                type="button"
                aria-label="Regular size"
                aria-pressed={size === 'regular'}
                onClick={() => setSize('regular')}
              >
                <Grid2X2 />
              </button>
              <button
                type="button"
                aria-label="Large size"
                aria-pressed={size === 'large'}
                onClick={() => setSize('large')}
              >
                <LayoutDashboard />
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
          className={cn(styles.focus, 'translate-x-0 translate-y-0')}
          showCloseButton={false}
          finalFocus={focusButton}
        >
          <DialogTitle className="sr-only">Studio focus mode</DialogTitle>
          <DialogDescription className="sr-only">
            Browse your collection without distractions. Press Escape to exit.
          </DialogDescription>
          <Button
            className={styles.exitFocus}
            variant="outline"
            onClick={() => setFocus(false)}
          >
            <X />
            Exit focus
          </Button>
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
                      compactMeasurement(selectedKnife.specs.bladeLength, ''),
                    ],
                    [
                      'Weight',
                      compactMeasurement(selectedKnife.specs.weight, ''),
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
                    <Scale />
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

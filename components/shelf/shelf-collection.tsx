'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Dialog } from '@base-ui/react/dialog'
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Search,
} from 'lucide-react'
import { useKnives } from '@/components/providers/knives-provider'
import { KnifePhoto } from '@/components/lumen/knife-photo'
import {
  useLumenCollection,
  useLumenKnifeActions,
} from '@/components/lumen/use-lumen-collection'
import { useKnifeDetail } from '@/components/lumen/use-knife-detail'
import { InspectorTabs } from '@/components/inspector-tabs'
import type { Knife } from '@/lib/data'
import { formatDimension, formatWeight } from '@/lib/measurements'
import {
  countAddedByMonth,
  countFacet,
  formatMoney,
  formatShortDate,
  sortLumenKnives,
  summarizeCollectionValue,
} from '@/lib/lumen-collection'

const SHELF_SIZE = 12
const HERO_INTERVAL_MS = 7000

type Shelf = { title: string; knives: Knife[]; href: string }

function allHref(key?: string, value?: string) {
  const params = new URLSearchParams({ all: '1' })
  if (key && value) params.set(key, value)
  return `/collection?${params}`
}

export function ShelfCollection() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const collection = useLumenCollection()
  const focusId = params.get('focus')
  const isAll = params.get('all') === '1'

  // The focus view steps through the sorted list (filtered on All knives).
  const context = collection.filtered
  const focusIndex = context.findIndex((knife) => knife.id === focusId)
  const focusKnife =
    focusIndex >= 0
      ? context[focusIndex]
      : (collection.knives.find((knife) => knife.id === focusId) ?? null)

  const focusHref = (id: string) => {
    const next = new URLSearchParams(params.toString())
    next.set('focus', id)
    return `/collection?${next}`
  }

  const setFocus = (id: string | null) => {
    const next = new URLSearchParams(params.toString())
    if (id) next.set('focus', id)
    else next.delete('focus')
    const query = next.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }

  return (
    <>
      {isAll ? (
        <ShelfAllKnives collection={collection} focusHref={focusHref} />
      ) : (
        <ShelfHome
          knives={collection.knives}
          isLoading={collection.isLoading}
          focusHref={focusHref}
        />
      )}
      <ShelfFocus
        knife={focusKnife}
        hasPrevious={focusIndex > 0}
        hasNext={focusIndex >= 0 && focusIndex < context.length - 1}
        onStep={(delta) => {
          const next = context[focusIndex + delta]
          if (next) setFocus(next.id)
        }}
        onClose={() => setFocus(null)}
      />
    </>
  )
}

type FocusHref = (id: string) => string

function ShelfHome({
  knives,
  isLoading,
  focusHref,
}: {
  knives: Knife[]
  isLoading: boolean
  focusHref: FocusHref
}) {
  const newest = useMemo(
    () => sortLumenKnives(knives, 'newest', false),
    [knives],
  )
  const featured = useMemo(() => {
    const pinned = newest.filter((knife) => knife.pinned)
    return (pinned.length ? pinned : newest).slice(0, 6)
  }, [newest])
  const value = useMemo(
    () => summarizeCollectionValue(knives.filter((knife) => !knife.sold)),
    [knives],
  )
  const topBrand = useMemo(
    () => countFacet(knives, (knife) => knife.brand)[0]?.value,
    [knives],
  )
  const newestSteel = newest.find((knife) => knife.specs.bladeMaterial?.trim())
    ?.specs.bladeMaterial
  const months = useMemo(() => countAddedByMonth(knives, 7), [knives])
  const steels = useMemo(
    () => countFacet(knives, (knife) => knife.specs.bladeMaterial),
    [knives],
  )
  const shelves = useMemo(() => {
    const result: Shelf[] = [
      { title: 'Recently added', knives: newest, href: allHref() },
    ]
    const pinned = newest.filter((knife) => knife.pinned)
    if (pinned.length > 1)
      result.push({
        title: 'Pinned',
        knives: pinned,
        href: allHref('view', 'pinned'),
      })
    const groups: [string, string, (knife: Knife) => string | undefined][] = [
      ['lockingMechanism', 'lock', (knife) => knife.specs.lockingMechanism],
      ['brand', 'brand', (knife) => knife.brand],
      ['bladeStyle', 'style', (knife) => knife.bladeStyle],
    ]
    for (const [key, kind, getValue] of groups) {
      const top = countFacet(knives, getValue)[0]
      if (!top || top.count < 2 || top.count === knives.length) continue
      result.push({
        title:
          kind === 'lock'
            ? /lock/i.test(top.value)
              ? `${top.value}s`
              : `${top.value} locks`
            : kind === 'style'
              ? `${top.value} blades`
              : top.value,
        knives: newest.filter((knife) => getValue(knife)?.trim() === top.value),
        href: allHref(key, top.value),
      })
    }
    return result
  }, [knives, newest])

  if (isLoading) {
    return (
      <div data-shelf-wrap>
        <div data-shelf-hero data-loading aria-busy="true">
          <div data-shelf-hero-art />
        </div>
      </div>
    )
  }

  if (knives.length === 0) {
    return (
      <div data-shelf-wrap>
        <h1 className="sr-only">Home</h1>
        <section data-shelf-empty>
          <p data-shelf-eyebrow>Your vault</p>
          <h2>Start your collection.</h2>
          <p>Add a knife by hand or import it from a product page.</p>
          <Link href="/add" data-shelf-button="accent">
            Add your first knife
          </Link>
        </section>
      </div>
    )
  }

  const maxMonth = Math.max(1, ...months.map((month) => month.count))
  return (
    <div data-shelf-wrap>
      <h1 className="sr-only">Home</h1>
      <ShelfHero featured={featured} focusHref={focusHref} />
      <section data-shelf-band aria-label="Collection at a glance">
        <div>
          <b>{knives.length}</b>
          <span>Knives in vault</span>
        </div>
        <div>
          <b>{value ? formatMoney(value.total, value.currency) : '—'}</b>
          <span>Estimated value</span>
        </div>
        <div>
          <b>{topBrand ?? '—'}</b>
          <span>Most collected brand</span>
        </div>
        <div>
          <b>{newestSteel ?? '—'}</b>
          <span>Newest steel added</span>
        </div>
        <div>
          <div
            data-shelf-spark
            role="img"
            aria-label={`Additions per month: ${months
              .map((month) => `${month.label} ${month.count}`)
              .join(', ')}`}
          >
            {months.map((month, index) => (
              <i
                key={month.label}
                data-current={index === months.length - 1 || undefined}
                style={{
                  height: `${Math.max(8, (month.count / maxMonth) * 100)}%`,
                }}
              />
            ))}
          </div>
          <span>Additions, last 7 months</span>
        </div>
      </section>
      {shelves.map((shelf, index) => (
        <ShelfRail
          key={shelf.title}
          shelf={shelf}
          eager={index === 0}
          focusHref={focusHref}
        />
      ))}
      {steels.length > 0 && (
        <section data-shelf-section aria-labelledby="shelf-steels">
          <div data-shelf-section-head>
            <h2 id="shelf-steels">Browse by steel</h2>
          </div>
          <div data-shelf-tags>
            {steels.map((steel) => (
              <Link
                key={steel.value}
                href={allHref('bladeMaterial', steel.value)}
              >
                {steel.value}
                <small>{steel.count}</small>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function ShelfHero({
  featured,
  focusHref,
}: {
  featured: Knife[]
  focusHref: FocusHref
}) {
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const current = featured[Math.min(index, featured.length - 1)]

  useEffect(() => {
    if (paused || featured.length < 2) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const timer = window.setInterval(
      () => setIndex((value) => (value + 1) % featured.length),
      HERO_INTERVAL_MS,
    )
    return () => window.clearInterval(timer)
  }, [featured.length, paused])

  if (!current) return null
  return (
    <section
      data-shelf-hero
      aria-roledescription="carousel"
      aria-label="Featured knives"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div data-shelf-hero-media>
        <Link
          href={focusHref(current.id)}
          scroll={false}
          data-shelf-hero-art
          aria-label={`View ${current.name}`}
        >
          <KnifePhoto
            key={current.id}
            knife={current}
            sizes="(max-width: 860px) 100vw, 58vw"
            priority
          />
        </Link>
        {featured.length > 1 && (
          <div data-shelf-dots role="group" aria-label="Choose featured knife">
            {featured.map((knife, dot) => (
              <button
                key={knife.id}
                type="button"
                aria-label={`Show ${knife.name}`}
                aria-pressed={dot === index}
                onClick={() => setIndex(dot)}
              />
            ))}
          </div>
        )}
      </div>
      <div data-shelf-hero-text aria-live={paused ? 'polite' : 'off'}>
        <p data-shelf-eyebrow>
          {current.pinned ? 'Pinned · in rotation' : 'Recently added'}
        </p>
        <h2>{current.name}</h2>
        <p data-shelf-by>
          {[current.brand, current.bladeStyle].filter(Boolean).join(' · ')}
        </p>
        <HeroStrip knife={current} />
        <div data-shelf-actions>
          <Link
            href={focusHref(current.id)}
            scroll={false}
            data-shelf-button="accent"
          >
            View knife
          </Link>
          <Link
            href={`/collection/${encodeURIComponent(current.id)}?edit=1`}
            data-shelf-button
          >
            Edit
          </Link>
          <CompareButton knife={current} />
        </div>
      </div>
    </section>
  )
}

function HeroStrip({ knife }: { knife: Knife }) {
  const { dimensionUnit } = useKnives()
  return (
    <dl data-shelf-strip>
      <div>
        <dt>Steel</dt>
        <dd>{knife.specs.bladeMaterial || '—'}</dd>
      </div>
      <div>
        <dt>Blade</dt>
        <dd>
          {formatDimension(knife.specs.bladeLength, dimensionUnit) || '—'}
        </dd>
      </div>
      <div>
        <dt>Weight</dt>
        <dd>{formatWeight(knife.specs.weight, dimensionUnit) || '—'}</dd>
      </div>
      <div>
        <dt>Value</dt>
        <dd>{knife.specs.price || '—'}</dd>
      </div>
    </dl>
  )
}

function CompareButton({ knife }: { knife: Knife }) {
  const actions = useLumenKnifeActions()
  const inCompare = actions.isInCompare(knife.id)
  return (
    <button
      type="button"
      data-shelf-button
      aria-pressed={inCompare}
      disabled={actions.compareUnavailable}
      onClick={() => void actions.compare([knife.id])}
    >
      {inCompare ? 'In comparison' : 'Compare'}
    </button>
  )
}

function ShelfCard({
  knife,
  eager,
  focusHref,
}: {
  knife: Knife
  eager?: boolean
  focusHref: FocusHref
}) {
  return (
    <Link
      href={focusHref(knife.id)}
      scroll={false}
      data-shelf-card
      data-knife-card={knife.id}
    >
      <span data-shelf-card-photo>
        {knife.sold ? (
          <span data-shelf-badge="sold">Sold</span>
        ) : (
          knife.pinned && <span data-shelf-badge>Pinned</span>
        )}
        <KnifePhoto
          knife={knife}
          sizes="(max-width: 860px) 62vw, 240px"
          priority={eager}
        />
      </span>
      <span data-shelf-card-title>{knife.name}</span>
      <span data-shelf-card-sub>
        <span>{knife.brand}</span>
        {knife.specs.price && <b>{knife.specs.price}</b>}
      </span>
    </Link>
  )
}

function ShelfRail({
  shelf,
  eager,
  focusHref,
}: {
  shelf: Shelf
  eager: boolean
  focusHref: FocusHref
}) {
  const railRef = useRef<HTMLDivElement>(null)
  const id = `shelf-${shelf.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  const scroll = (direction: number) =>
    railRef.current?.scrollBy({
      left: direction * Math.max(240, railRef.current.clientWidth * 0.8),
      behavior: 'smooth',
    })
  return (
    <section data-shelf-section aria-labelledby={id}>
      <div data-shelf-section-head>
        <h2 id={id}>{shelf.title}</h2>
        <span data-shelf-count>{shelf.knives.length}</span>
        <Link href={shelf.href} data-shelf-more>
          See all →
        </Link>
        <span data-shelf-arrows>
          <button
            type="button"
            aria-label={`Scroll ${shelf.title} left`}
            onClick={() => scroll(-1)}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={`Scroll ${shelf.title} right`}
            onClick={() => scroll(1)}
          >
            <ChevronRight aria-hidden="true" />
          </button>
        </span>
      </div>
      <div data-shelf-rail ref={railRef}>
        {shelf.knives.slice(0, SHELF_SIZE).map((knife, index) => (
          <ShelfCard
            key={knife.id}
            knife={knife}
            eager={eager && index < 4}
            focusHref={focusHref}
          />
        ))}
        {shelf.knives.length > SHELF_SIZE && (
          <Link href={shelf.href} data-shelf-card data-shelf-card-more>
            <span data-shelf-card-photo>
              +{shelf.knives.length - SHELF_SIZE}
            </span>
            <span data-shelf-card-title>See all</span>
          </Link>
        )}
      </div>
    </section>
  )
}

function ShelfAllKnives({
  collection,
  focusHref,
}: {
  collection: ReturnType<typeof useLumenCollection>
  focusHref: FocusHref
}) {
  const { knives, filtered, getValues, toggleSingle, replaceParams } =
    collection
  const [visible, setVisible] = useState(48)
  const styles = useMemo(
    () => countFacet(knives, (knife) => knife.bladeStyle).slice(0, 8),
    [knives],
  )
  const activeStyle = getValues('bladeStyle')[0] ?? null
  const activeFilters = [
    ['brand', 'Brand'],
    ['bladeMaterial', 'Steel'],
    ['lockingMechanism', 'Lock'],
    ['view', 'View'],
  ]
    .map(([key, label]) => ({ key, label, value: getValues(key)[0] }))
    .filter((item) => item.value)
  const clear = () =>
    replaceParams((params) => {
      for (const key of [...params.keys()])
        if (key !== 'all') params.delete(key)
    })

  return (
    <div data-shelf-wrap>
      <section data-shelf-all-head>
        <div>
          <p data-shelf-eyebrow>Collection</p>
          <h1>
            All knives <small>{filtered.length}</small>
          </h1>
        </div>
        <label data-shelf-all-search>
          <Search aria-hidden="true" />
          <input
            type="search"
            value={collection.query}
            onChange={(event) => collection.setQuery(event.target.value)}
            placeholder="Filter by name, maker, steel…"
            aria-label="Filter knives"
          />
        </label>
      </section>
      <div data-shelf-tags role="group" aria-label="Blade style">
        {styles.map((style) => (
          <button
            key={style.value}
            type="button"
            aria-pressed={activeStyle === style.value}
            onClick={() => toggleSingle('bladeStyle', style.value)}
          >
            {style.value}
            <small>{style.count}</small>
          </button>
        ))}
        {activeFilters.map((filter) => (
          <button
            key={filter.key}
            type="button"
            aria-pressed="true"
            onClick={() => toggleSingle(filter.key, null)}
            aria-label={`Remove ${filter.label} filter ${filter.value}`}
          >
            {filter.label}:{' '}
            {filter.value === 'pinned' ? 'Pinned' : filter.value}
            <small aria-hidden="true">✕</small>
          </button>
        ))}
        {(activeStyle || activeFilters.length > 0 || collection.query) && (
          <button type="button" data-shelf-clear onClick={clear}>
            Clear filters
          </button>
        )}
      </div>
      {filtered.length === 0 ? (
        <section data-shelf-empty>
          <p>No knives match these filters.</p>
          <button type="button" data-shelf-button onClick={clear}>
            Clear filters
          </button>
        </section>
      ) : (
        <>
          <div data-shelf-grid>
            {filtered.slice(0, visible).map((knife, index) => (
              <ShelfCard
                key={knife.id}
                knife={knife}
                eager={index < 6}
                focusHref={focusHref}
              />
            ))}
          </div>
          {visible < filtered.length && (
            <div data-shelf-more-row>
              <button
                type="button"
                data-shelf-button
                onClick={() => setVisible((count) => count + 48)}
              >
                Show more ({filtered.length - visible} left)
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ShelfFocus({
  knife: summary,
  hasPrevious,
  hasNext,
  onStep,
  onClose,
}: {
  knife: Knife | null
  hasPrevious: boolean
  hasNext: boolean
  onStep: (delta: number) => void
  onClose: () => void
}) {
  const { dimensionUnit } = useKnives()
  const actions = useLumenKnifeActions()
  const knife = useKnifeDetail(summary)
  const [photo, setPhoto] = useState<{ id: string; index: number } | null>(null)
  const photoIndex = photo && photo.id === knife?.id ? photo.index : 0

  return (
    <Dialog.Root
      open={Boolean(summary)}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Popup
          data-shelf-focus
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' && hasPrevious) onStep(-1)
            if (event.key === 'ArrowRight' && hasNext) onStep(1)
          }}
        >
          {knife && (
            <>
              <div data-shelf-focus-art>
                <Dialog.Close data-shelf-button data-shelf-focus-back>
                  <ArrowLeft aria-hidden="true" /> Back
                </Dialog.Close>
                <KnifePhoto
                  knife={knife}
                  src={knife.images[photoIndex]}
                  sizes="(max-width: 860px) 100vw, 58vw"
                  priority
                />
                {knife.images.length > 1 && (
                  <div data-shelf-dots role="group" aria-label="Photos">
                    {knife.images.slice(0, 10).map((path, index) => (
                      <button
                        key={`${path}-${index}`}
                        type="button"
                        aria-label={`Photo ${index + 1}`}
                        aria-pressed={index === photoIndex}
                        onClick={() => setPhoto({ id: knife.id, index })}
                      />
                    ))}
                  </div>
                )}
              </div>
              <div data-shelf-focus-text>
                <p data-shelf-eyebrow>{knife.brand}</p>
                <Dialog.Title data-shelf-focus-title>{knife.name}</Dialog.Title>
                <p data-shelf-by>
                  {[
                    knife.bladeStyle,
                    knife.handleMaterial && `${knife.handleMaterial} handle`,
                    `added ${formatShortDate(knife.addedAt, true)}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                <dl data-shelf-focus-specs>
                  <FocusSpec
                    label="Blade steel"
                    value={knife.specs.bladeMaterial}
                  />
                  <FocusSpec
                    label="Lock"
                    value={knife.specs.lockingMechanism}
                  />
                  <FocusSpec
                    label="Blade"
                    value={formatDimension(
                      knife.specs.bladeLength,
                      dimensionUnit,
                    )}
                  />
                  <FocusSpec
                    label="Overall"
                    value={formatDimension(
                      knife.specs.overallLength,
                      dimensionUnit,
                    )}
                  />
                  <FocusSpec
                    label="Weight"
                    value={formatWeight(knife.specs.weight, dimensionUnit)}
                  />
                  <FocusSpec label="Price" value={knife.specs.price} />
                </dl>
                <div data-shelf-actions>
                  <Link
                    href={`/collection/${encodeURIComponent(knife.id)}?edit=1`}
                    data-shelf-button="accent"
                  >
                    Edit
                  </Link>
                  <button
                    type="button"
                    data-shelf-button
                    aria-pressed={knife.pinned}
                    disabled={actions.busy === `pin:${knife.id}`}
                    onClick={() => void actions.togglePin(knife)}
                  >
                    {knife.pinned ? 'Unpin' : 'Pin'}
                  </button>
                  <button
                    type="button"
                    data-shelf-button
                    aria-pressed={actions.isInCompare(knife.id)}
                    disabled={actions.compareUnavailable}
                    onClick={() => void actions.compare([knife.id])}
                  >
                    {actions.isInCompare(knife.id)
                      ? 'In comparison'
                      : 'Compare'}
                  </button>
                  <button
                    type="button"
                    data-shelf-button
                    disabled={actions.busy === `sold:${knife.id}`}
                    onClick={() => void actions.toggleSold(knife)}
                  >
                    {knife.sold ? 'Mark owned' : 'Mark sold'}
                  </button>
                  {knife.sourceUrl && (
                    <a
                      href={knife.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      data-shelf-button
                    >
                      Source page <ExternalLink aria-hidden="true" />
                    </a>
                  )}
                  <Link
                    href={`/collection/${encodeURIComponent(knife.id)}`}
                    data-shelf-button
                  >
                    Full page
                  </Link>
                </div>
                <div data-shelf-focus-tabs>
                  <InspectorTabs knife={knife} dimensionUnit={dimensionUnit} />
                </div>
                <div data-shelf-focus-nav>
                  <button
                    type="button"
                    data-shelf-button
                    disabled={!hasPrevious}
                    onClick={() => onStep(-1)}
                  >
                    <ChevronLeft aria-hidden="true" /> Previous
                  </button>
                  <span>
                    {knife.images.length}{' '}
                    {knife.images.length === 1 ? 'photo' : 'photos'} · ← → to
                    move between knives
                  </span>
                  <button
                    type="button"
                    data-shelf-button
                    disabled={!hasNext}
                    onClick={() => onStep(1)}
                  >
                    Next <ChevronRight aria-hidden="true" />
                  </button>
                </div>
              </div>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function FocusSpec({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value?.trim() || '—'}</dd>
    </div>
  )
}

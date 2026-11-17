import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { ArrowUpRight, Eye, ImageIcon, Shuffle } from 'lucide-react'
import Image from '@/components/vault-image'
import { getImageUrl, type Knife } from '@/lib/data'
import { formatDimension } from '@/lib/measurements'
import type { DimensionUnit } from '@/lib/settings-shared'
import { pickSpotlight, spotlightDateKey, spotlightPool } from '@/lib/spotlight'
import styles from './studio-spotlight.module.css'

const STORAGE_KEY = 'bladevault-studio-spotlight'
// Shuffle tries a few seeds so it never lands on the knife already shown.
const SHUFFLE_ATTEMPTS = 8

type StoredPick = { date: string; knifeId: string; nonce: number }

const listeners = new Set<() => void>()
// Holds the pick when storage is unavailable, so a shuffle lasts the visit.
let memory: string | null = null

function notify() {
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  // Re-read the day when the tab returns, so a page left open rolls over.
  window.addEventListener('storage', listener)
  window.addEventListener('focus', listener)
  document.addEventListener('visibilitychange', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', listener)
    window.removeEventListener('focus', listener)
    document.removeEventListener('visibilitychange', listener)
  }
}

function readStored(): string | null {
  if (memory !== null) return memory
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStored(pick: StoredPick) {
  const value = JSON.stringify(pick)
  try {
    window.localStorage.setItem(STORAGE_KEY, value)
    memory = null
  } catch {
    memory = value
  }
  notify()
}

function parseStored(raw: string | null): StoredPick | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (
      value &&
      typeof value === 'object' &&
      'date' in value &&
      'knifeId' in value &&
      'nonce' in value &&
      typeof value.date === 'string' &&
      typeof value.knifeId === 'string' &&
      typeof value.nonce === 'number' &&
      Number.isInteger(value.nonce)
    ) {
      return { date: value.date, knifeId: value.knifeId, nonce: value.nonce }
    }
  } catch {}
  return null
}

const serverSnapshot = () => null

function formatDay(dateKey: string) {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

function SpotlightImage({ knife }: { knife: Knife }) {
  const [failed, setFailed] = useState(false)
  return knife.images[0] && !failed ? (
    <Image
      src={getImageUrl(knife.images[0])}
      alt={`${knife.brand} ${knife.name}`.trim()}
      fill
      sizes="(max-width: 900px) 100vw, 1100px"
      className={styles.image}
      fetchPriority="high"
      loading="eager"
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

/** Knife of the day: one knife per calendar day, re-rollable with Shuffle. */
export function StudioSpotlight({
  knives,
  dimensionUnit,
  onQuickLook,
}: {
  knives: Knife[]
  dimensionUnit?: DimensionUnit
  onQuickLook: (knifeId: string, trigger: HTMLElement) => void
}) {
  const dateKey = useSyncExternalStore(
    subscribe,
    spotlightDateKey,
    serverSnapshot,
  )
  const raw = useSyncExternalStore(subscribe, readStored, serverSnapshot)
  const stored = useMemo(() => parseStored(raw), [raw])
  const today = stored?.date === dateKey ? stored : null
  const nonce = today?.nonce ?? 0
  const knife = useMemo(() => {
    if (!dateKey) return undefined
    // A stored pick holds for the day even if knives are added or removed.
    const kept = today && knives.find((item) => item.id === today.knifeId)
    return kept || pickSpotlight(knives, dateKey, nonce)
  }, [knives, dateKey, today, nonce])
  const canShuffle = useMemo(() => spotlightPool(knives).length > 1, [knives])

  useEffect(() => {
    if (dateKey && knife && today?.knifeId !== knife.id) {
      writeStored({ date: dateKey, knifeId: knife.id, nonce })
    }
  }, [dateKey, knife, today, nonce])

  if (!dateKey || !knife) return null

  function shuffle() {
    if (!dateKey || !knife) return
    for (let next = nonce + 1; next <= nonce + SHUFFLE_ATTEMPTS; next += 1) {
      const candidate = pickSpotlight(knives, dateKey, next)
      if (candidate && candidate.id !== knife.id) {
        writeStored({ date: dateKey, knifeId: candidate.id, nonce: next })
        return
      }
    }
  }

  const meta = [
    knife.brand,
    knife.specs.bladeMaterial,
    formatDimension(knife.specs.bladeLength, dimensionUnit),
    knife.handleMaterial,
  ]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join(' · ')

  return (
    <section
      className={styles.hero}
      aria-label="Knife of the day"
      data-studio-spotlight={knife.id}
    >
      <div key={knife.id} className={styles.plate}>
        <SpotlightImage key={knife.images[0] ?? knife.id} knife={knife} />
      </div>
      <p className={styles.kicker}>
        <b>Knife of the day</b>
        <span aria-hidden="true">·</span>
        <time dateTime={dateKey}>{formatDay(dateKey)}</time>
      </p>
      {knife.sold && <span className={styles.sold}>Sold</span>}
      <div className={styles.caption}>
        <div className={styles.identity}>
          <h2>{knife.name || 'Untitled knife'}</h2>
          {meta && <p>{meta}</p>}
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.action}
            aria-label="Shuffle today’s pick"
            title="Shuffle today’s pick"
            disabled={!canShuffle}
            onClick={shuffle}
          >
            <Shuffle aria-hidden="true" />
            <span>Shuffle</span>
          </button>
          <button
            type="button"
            className={styles.action}
            onClick={(event) => onQuickLook(knife.id, event.currentTarget)}
          >
            <Eye aria-hidden="true" />
            <span>Quick look</span>
          </button>
          <Link
            href={`/collection/${encodeURIComponent(knife.id)}`}
            className={styles.action}
            data-primary
          >
            <span>View knife</span>
            <ArrowUpRight aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  )
}

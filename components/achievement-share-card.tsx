'use client'

import { useEffect, useState } from 'react'
import { Download, Share2 } from 'lucide-react'
import {
  ACHIEVEMENT_CATEGORY_ICONS,
  ACHIEVEMENT_TIER_COLORS,
  ACHIEVEMENT_TIER_LABELS,
} from '@/components/achievement-badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  achievementPoints,
  ACHIEVEMENTS,
  ACHIEVEMENTS_BY_ID,
  type AchievementTier,
} from '@/lib/achievements/catalog'
import type { AchievementState } from '@/lib/achievements/unlocks'

const WIDTH = 1200
const HEIGHT = 630
const SHOWCASE = 8
const FILENAME = 'bladevault-trophy-case.png'
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
const TIERS: AchievementTier[] = ['bronze', 'silver', 'gold', 'platinum']
const number = new Intl.NumberFormat('en-US')

/** Best badges first (highest tier, then newest), for the card's showcase. */
export function showcaseUnlocks(
  unlocks: AchievementState['unlocks'],
  limit = SHOWCASE,
): string[] {
  return unlocks
    .filter((unlock) => ACHIEVEMENTS_BY_ID.has(unlock.id))
    .sort(
      (left, right) =>
        achievementPoints(right.id) - achievementPoints(left.id) ||
        right.unlockedAt.localeCompare(left.unlockedAt),
    )
    .slice(0, limit)
    .map((unlock) => unlock.id)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Could not draw a badge icon.'))
    image.src = src
  })
}

/** The category icon as an image, drawn from the same Lucide icon as the app. */
async function iconImage(id: string, color: string) {
  const achievement = ACHIEVEMENTS_BY_ID.get(id)
  if (!achievement) return null
  const Icon = ACHIEVEMENT_CATEGORY_ICONS[achievement.category]
  const { renderToStaticMarkup } = await import('react-dom/server')
  const svg = renderToStaticMarkup(
    <Icon
      xmlns="http://www.w3.org/2000/svg"
      color={color}
      size={64}
      strokeWidth={2.2}
    />,
  )
  return loadImage(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
  )
}

function hexagon(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
) {
  // Matches the badge's clip-path in achievement-badge.module.css.
  const points = [
    [0.5, 0],
    [0.93, 0.25],
    [0.93, 0.75],
    [0.5, 1],
    [0.07, 0.75],
    [0.07, 0.25],
  ]
  context.beginPath()
  points.forEach(([px, py], index) => {
    const method = index === 0 ? 'moveTo' : 'lineTo'
    context[method](x + px * size, y + py * size)
  })
  context.closePath()
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath()
  context.roundRect(x, y, width, height, radius)
}

function fitText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (context.measureText(text).width <= maxWidth) return text
  let cut = text
  while (cut.length > 1 && context.measureText(`${cut}…`).width > maxWidth) {
    cut = cut.slice(0, -1)
  }
  return `${cut.trimEnd()}…`
}

async function drawBadge(
  context: CanvasRenderingContext2D,
  id: string,
  x: number,
  y: number,
  size: number,
) {
  const achievement = ACHIEVEMENTS_BY_ID.get(id)
  if (!achievement) return
  const color = ACHIEVEMENT_TIER_COLORS[achievement.tier]
  const ring = context.createLinearGradient(x, y, x + size, y + size)
  ring.addColorStop(0, color)
  ring.addColorStop(0.5, '#f5efe4')
  ring.addColorStop(1, color)
  hexagon(context, x, y, size)
  context.fillStyle = ring
  context.fill()
  const inset = 5
  hexagon(context, x + inset, y + inset, size - inset * 2)
  const inner = context.createRadialGradient(
    x + size / 2,
    y + size * 0.3,
    2,
    x + size / 2,
    y + size / 2,
    size * 0.6,
  )
  inner.addColorStop(0, '#2c261d')
  inner.addColorStop(1, '#16130f')
  context.fillStyle = inner
  context.fill()
  const icon = await iconImage(id, color).catch(() => null)
  if (icon) {
    const iconSize = size * 0.46
    context.drawImage(
      icon,
      x + (size - iconSize) / 2,
      y + (size - iconSize) / 2,
      iconSize,
      iconSize,
    )
  }
}

/** Draws the shareable 1200×630 trophy card and returns it as a PNG. */
export async function renderTrophyCard(state: AchievementState): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser cannot draw the trophy card.')

  const { summary } = state
  const accent = ACHIEVEMENT_TIER_COLORS.gold

  // Background
  const background = context.createLinearGradient(0, 0, WIDTH, HEIGHT)
  background.addColorStop(0, '#1d1913')
  background.addColorStop(1, '#0e0d0b')
  context.fillStyle = background
  context.fillRect(0, 0, WIDTH, HEIGHT)
  const glow = context.createRadialGradient(980, 40, 10, 980, 40, 520)
  glow.addColorStop(0, 'rgba(201, 154, 23, 0.22)')
  glow.addColorStop(1, 'rgba(201, 154, 23, 0)')
  context.fillStyle = glow
  context.fillRect(0, 0, WIDTH, HEIGHT)
  context.strokeStyle = 'rgba(245, 239, 228, 0.12)'
  context.lineWidth = 2
  roundedRect(context, 16, 16, WIDTH - 32, HEIGHT - 32, 24)
  context.stroke()

  // Heading, rank and score
  context.textBaseline = 'alphabetic'
  context.fillStyle = accent
  context.font = `700 20px ${FONT}`
  context.letterSpacing = '4px'
  context.fillText('BLADEVAULT · TROPHY CASE', 64, 88)
  context.letterSpacing = '0px'

  context.fillStyle = '#f5efe4'
  context.font = `700 72px ${FONT}`
  context.fillText(fitText(context, summary.rank.title, 620), 64, 172)

  context.fillStyle = 'rgba(245, 239, 228, 0.72)'
  context.font = `500 26px ${FONT}`
  context.fillText(
    `${number.format(summary.score)} points · ${summary.unlockedCount} of ${summary.total} achievements`,
    64,
    218,
  )

  // Progress to the next rank
  const barWidth = 560
  const rankPercent = summary.nextRank
    ? (summary.score - summary.rank.minScore) /
      (summary.nextRank.minScore - summary.rank.minScore)
    : 1
  context.fillStyle = 'rgba(245, 239, 228, 0.12)'
  roundedRect(context, 64, 246, barWidth, 10, 5)
  context.fill()
  context.fillStyle = accent
  roundedRect(
    context,
    64,
    246,
    Math.max(10, barWidth * Math.min(1, rankPercent)),
    10,
    5,
  )
  context.fill()
  context.fillStyle = 'rgba(245, 239, 228, 0.55)'
  context.font = `500 18px ${FONT}`
  context.fillText(
    summary.nextRank
      ? `${number.format(summary.nextRank.minScore - summary.score)} points to ${summary.nextRank.title}`
      : 'Top rank reached',
    64,
    286,
  )

  // Tier counts, top right
  const unlockedIds = new Set(state.unlocks.map((unlock) => unlock.id))
  TIERS.forEach((tier, index) => {
    const inTier = ACHIEVEMENTS.filter((entry) => entry.tier === tier)
    const earned = inTier.filter((entry) => unlockedIds.has(entry.id)).length
    const x = 770 + (index % 2) * 190
    const y = 120 + Math.floor(index / 2) * 84
    context.fillStyle = 'rgba(245, 239, 228, 0.06)'
    roundedRect(context, x, y, 174, 68, 14)
    context.fill()
    context.fillStyle = ACHIEVEMENT_TIER_COLORS[tier]
    context.beginPath()
    context.arc(x + 24, y + 34, 8, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = 'rgba(245, 239, 228, 0.65)'
    context.font = `500 17px ${FONT}`
    context.fillText(ACHIEVEMENT_TIER_LABELS[tier], x + 42, y + 30)
    context.fillStyle = '#f5efe4'
    context.font = `700 22px ${FONT}`
    context.fillText(`${earned} / ${inTier.length}`, x + 42, y + 55)
  })

  // Showcase: the best badges
  const showcase = showcaseUnlocks(state.unlocks)
  const badgeSize = 96
  const slot = 134
  const startX = (WIDTH - slot * SHOWCASE) / 2 + (slot - badgeSize) / 2
  if (showcase.length === 0) {
    context.fillStyle = 'rgba(245, 239, 228, 0.55)'
    context.font = `500 24px ${FONT}`
    context.textAlign = 'center'
    context.fillText('The first badge is on its way.', WIDTH / 2, 450)
    context.textAlign = 'start'
  }
  for (const [index, id] of showcase.entries()) {
    const x = startX + index * slot
    await drawBadge(context, id, x, 360, badgeSize)
    const achievement = ACHIEVEMENTS_BY_ID.get(id)!
    context.textAlign = 'center'
    context.fillStyle = '#f5efe4'
    context.font = `600 16px ${FONT}`
    context.fillText(
      fitText(context, achievement.title, slot - 12),
      x + badgeSize / 2,
      486,
    )
    context.fillStyle = ACHIEVEMENT_TIER_COLORS[achievement.tier]
    context.font = `600 13px ${FONT}`
    context.fillText(
      ACHIEVEMENT_TIER_LABELS[achievement.tier].toUpperCase(),
      x + badgeSize / 2,
      506,
    )
    context.textAlign = 'start'
  }

  // Footer
  context.fillStyle = 'rgba(245, 239, 228, 0.4)'
  context.font = `500 16px ${FONT}`
  context.fillText(
    new Date().toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }),
    64,
    574,
  )

  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error('Could not create the PNG.')),
      'image/png',
    ),
  )
}

function canShareFile(file: File): boolean {
  return (
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [file] })
  )
}

/** "Share card": previews the trophy card, then saves or shares the PNG. */
export function AchievementShareButton({ state }: { state: AchievementState }) {
  // The state as it was when opened, so a background sync does not redraw.
  const [snapshot, setSnapshot] = useState<AchievementState | null>(null)
  const open = snapshot !== null
  const [card, setCard] = useState<{ blob: Blob; url: string } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!snapshot) return
    let cancelled = false
    let url: string | null = null
    renderTrophyCard(snapshot)
      .then((blob) => {
        if (cancelled) return
        url = URL.createObjectURL(blob)
        setCard({ blob, url })
        setError('')
      })
      .catch((renderError: unknown) => {
        if (cancelled) return
        setError(
          renderError instanceof Error
            ? renderError.message
            : 'Could not create the trophy card.',
        )
      })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
      setCard(null)
    }
  }, [snapshot])

  const file = card
    ? new File([card.blob], FILENAME, { type: 'image/png' })
    : null
  const shareable = file ? canShareFile(file) : false

  const save = () => {
    if (!card) return
    const link = document.createElement('a')
    link.href = card.url
    link.download = FILENAME
    document.body.append(link)
    link.click()
    link.remove()
  }

  const share = async () => {
    if (!file) return
    try {
      await navigator.share({
        files: [file],
        title: 'My BladeVault trophy case',
      })
    } catch (shareError) {
      if (
        shareError instanceof DOMException &&
        shareError.name === 'AbortError'
      )
        return
      setError('Sharing failed. Save the PNG instead.')
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setSnapshot(state)}
      >
        <Share2 className="size-4" aria-hidden="true" /> Share card
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) setSnapshot(null)
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Your trophy card</DialogTitle>
            <DialogDescription>
              A picture of your rank, score and best badges to share. It shows
              no knives, prices or other vault details.
            </DialogDescription>
          </DialogHeader>
          {card ? (
            // A blob URL from this tab, so next/image adds nothing here.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={card.url}
              alt={`Trophy card: ${state.summary.rank.title}, ${state.summary.score} points, ${state.summary.unlockedCount} of ${state.summary.total} achievements`}
              className="aspect-[1200/630] w-full rounded-lg border border-border"
              data-trophy-card
            />
          ) : error ? null : (
            <div
              role="status"
              aria-label="Drawing the trophy card"
              className="aspect-[1200/630] w-full animate-pulse rounded-lg bg-muted"
            />
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            {shareable && (
              <Button
                type="button"
                variant="outline"
                onClick={() => void share()}
              >
                <Share2 className="size-4" aria-hidden="true" /> Share…
              </Button>
            )}
            <Button type="button" disabled={!card} onClick={save}>
              <Download className="size-4" aria-hidden="true" /> Save PNG
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

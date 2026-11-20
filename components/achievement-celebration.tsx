'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import {
  AchievementBadge,
  ACHIEVEMENT_TIER_COLORS,
  ACHIEVEMENT_TIER_LABELS,
} from '@/components/achievement-badge'
import { useAchievements } from '@/components/providers/achievements-provider'
import {
  ACHIEVEMENT_TIER_POINTS,
  ACHIEVEMENTS_BY_ID,
} from '@/lib/achievements/catalog'
import { ACHIEVEMENTS_HREF } from '@/lib/achievements/messages'
import { cn } from '@/lib/utils'

const SHOW_MS = 6000
const MAX_GROUP = 5

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * A short confetti burst from the top centre in the group's Gold and Platinum
 * colours. Keyed by the group's ids, so re-renders do not restart it.
 */
function Confetti({ groupKey }: { groupKey: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const colors = [
      ...groupKey
        .split(',')
        .map((id) => ACHIEVEMENTS_BY_ID.get(id)?.tier)
        .filter((tier) => tier === 'gold' || tier === 'platinum')
        .map((tier) => ACHIEVEMENT_TIER_COLORS[tier]),
      '#c2410c',
      '#b0703a',
    ]
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context || prefersReducedMotion()) return
    canvas.width = window.innerWidth
    canvas.height = window.innerHeight
    const pieces = Array.from({ length: 120 }, () => ({
      x: canvas.width / 2 + (Math.random() - 0.5) * 240,
      y: 70,
      vx: (Math.random() - 0.5) * 12,
      vy: Math.random() * -6 - 2,
      size: Math.random() * 6 + 4,
      angle: Math.random() * Math.PI,
      color: colors[Math.floor(Math.random() * colors.length)],
    }))
    let frame = 0
    let handle = 0
    const tick = () => {
      context.clearRect(0, 0, canvas.width, canvas.height)
      for (const piece of pieces) {
        piece.vy += 0.3
        piece.x += piece.vx
        piece.y += piece.vy
        piece.angle += 0.2
        context.save()
        context.translate(piece.x, piece.y)
        context.rotate(piece.angle)
        context.fillStyle = piece.color
        context.fillRect(
          -piece.size / 2,
          -piece.size / 4,
          piece.size,
          piece.size / 2,
        )
        context.restore()
      }
      frame += 1
      if (frame < 120) handle = window.requestAnimationFrame(tick)
      else context.clearRect(0, 0, canvas.width, canvas.height)
    }
    handle = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(handle)
  }, [groupKey])
  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      // Behind the card (z-60), so the burst never covers its text.
      className="pointer-events-none fixed inset-0 z-[55]"
    />
  )
}

/**
 * Announces new achievements at the top of the screen. Unlocks that arrive
 * together share one card. Each shows for six seconds (paused while hovered
 * or focused) and is marked celebrated when it closes, so it never replays.
 */
export function AchievementCelebration() {
  const { celebrations, markCelebrated } = useAchievements()
  const [paused, setPaused] = useState(false)
  const group = celebrations.slice(0, MAX_GROUP).flatMap((unlock) => {
    const achievement = ACHIEVEMENTS_BY_ID.get(unlock.id)
    return achievement ? [achievement] : []
  })
  const groupKey = group.map((achievement) => achievement.id).join(',')
  const hasConfetti = group.some(
    (achievement) =>
      achievement.tier === 'gold' || achievement.tier === 'platinum',
  )

  useEffect(() => {
    if (!groupKey || paused) return
    const timer = window.setTimeout(
      () => markCelebrated(groupKey.split(',')),
      SHOW_MS,
    )
    return () => window.clearTimeout(timer)
  }, [groupKey, paused, markCelebrated])

  if (group.length === 0) return null

  const first = group[0]
  const points = group.reduce(
    (sum, achievement) => sum + ACHIEVEMENT_TIER_POINTS[achievement.tier],
    0,
  )
  const close = () => markCelebrated(group.map((achievement) => achievement.id))
  const single = group.length === 1

  return (
    <>
      {hasConfetti && <Confetti key={groupKey} groupKey={groupKey} />}
      <div className="pointer-events-none fixed inset-x-0 top-4 z-[60] flex justify-center px-4">
        <div
          key={groupKey}
          role="status"
          aria-live="polite"
          data-achievement-celebration
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocus={() => setPaused(true)}
          onBlur={() => setPaused(false)}
          style={{ ['--tier' as string]: ACHIEVEMENT_TIER_COLORS[first.tier] }}
          className={cn(
            'pointer-events-auto flex w-full max-w-[380px] items-center gap-3 rounded-xl border border-border bg-card p-3.5 text-card-foreground',
            'shadow-[0_18px_50px_rgba(0,0,0,0.25),0_0_0_1px_var(--tier),0_0_28px_-6px_var(--tier)]',
            'animate-in fade-in slide-in-from-top-4 duration-300 motion-reduce:animate-none',
          )}
        >
          {single ? (
            <AchievementBadge id={first.id} size="lg" animate />
          ) : (
            <span className="flex shrink-0">
              {group.slice(0, 3).map((achievement, index) => (
                <AchievementBadge
                  key={achievement.id}
                  id={achievement.id}
                  animate
                  className={index > 0 ? '-ml-3' : undefined}
                />
              ))}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-[color:var(--tier)]">
              {single
                ? first.secret
                  ? 'Secret achievement unlocked'
                  : 'Achievement unlocked'
                : `${group.length} achievements unlocked`}
            </p>
            <p className="truncate text-base font-semibold">
              {group.map((achievement) => achievement.title).join(', ')}
            </p>
            {single && (
              <p className="text-xs text-muted-foreground">
                {first.description}
              </p>
            )}
            <p className="mt-1 text-xs">
              <span className="font-semibold text-[color:var(--tier)]">
                {single ? `${ACHIEVEMENT_TIER_LABELS[first.tier]} · ` : ''}+
                {points} points
              </span>
              {' · '}
              <Link
                href={ACHIEVEMENTS_HREF}
                onClick={close}
                className="font-semibold underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                View
              </Link>
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close achievement message"
            className="self-start rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>
    </>
  )
}

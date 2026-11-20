import {
  Camera,
  Clock,
  Globe,
  Hammer,
  Hand,
  Lock,
  Repeat,
  Ruler,
  Shapes,
  Sword,
  Tag,
  TrendingDown,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import {
  ACHIEVEMENTS_BY_ID,
  type AchievementCategory,
  type AchievementTier,
} from '@/lib/achievements/catalog'
import { cn } from '@/lib/utils'
import styles from './achievement-badge.module.css'

export const ACHIEVEMENT_CATEGORY_ICONS: Record<
  AchievementCategory,
  LucideIcon
> = {
  size: Sword,
  makers: Tag,
  steel: Hammer,
  handles: Hand,
  shapes: Shapes,
  dimensions: Ruler,
  world: Globe,
  catalogue: Camera,
  care: Wrench,
  habits: Clock,
  market: TrendingDown,
  rotation: Repeat,
}

export const ACHIEVEMENT_TIER_LABELS: Record<AchievementTier, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
  platinum: 'Platinum',
}

/** Tier colours for places outside the badge (dots, confetti, glow). */
export const ACHIEVEMENT_TIER_COLORS: Record<AchievementTier, string> = {
  bronze: '#b0703a',
  silver: '#7f8b98',
  gold: '#c99a17',
  platinum: '#3f9bb2',
}

/** A hexagonal badge in the tier's colour with the category's icon. */
export function AchievementBadge({
  id,
  size = 'md',
  locked = false,
  animate = false,
  className,
}: {
  id: string
  size?: 'sm' | 'md' | 'lg'
  locked?: boolean
  animate?: boolean
  className?: string
}) {
  const achievement = ACHIEVEMENTS_BY_ID.get(id)
  if (!achievement) return null
  const Icon =
    locked && achievement.secret
      ? Lock
      : ACHIEVEMENT_CATEGORY_ICONS[achievement.category]
  return (
    <span
      aria-hidden="true"
      className={cn(
        styles.badge,
        styles[achievement.tier],
        size !== 'md' && styles[size],
        locked && styles.locked,
        animate && styles.pop,
        className,
      )}
    >
      <Icon className={styles.icon} strokeWidth={2.2} />
    </span>
  )
}

import {
  ACHIEVEMENTS_BY_ID,
  type AchievementProgress,
} from '@/lib/achievements/catalog'

const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const oneDecimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

/** Progress as a 0–100 percentage, capped at 100. */
export function achievementPercent(entry: AchievementProgress): number {
  if (entry.done) return 100
  if (entry.target <= 0) return 0
  return Math.min(100, Math.max(0, (entry.current / entry.target) * 100))
}

/** "37 / 100", "6.4 / 10 kg", "92% / 100%": capped at the target. */
export function formatAchievementProgress(entry: AchievementProgress): string {
  const unit = ACHIEVEMENTS_BY_ID.get(entry.id)?.unit
  const current = Math.min(Math.max(entry.current, 0), entry.target)
  switch (unit) {
    case 'percent':
      return `${whole.format(current)}% / ${whole.format(entry.target)}%`
    case 'cm':
      return entry.target >= 100
        ? `${oneDecimal.format(current / 100)} / ${oneDecimal.format(entry.target / 100)} m`
        : `${whole.format(current)} / ${whole.format(entry.target)} cm`
    case 'grams':
      return entry.target >= 1000
        ? `${oneDecimal.format(current / 1000)} / ${oneDecimal.format(entry.target / 1000)} kg`
        : `${whole.format(current)} / ${whole.format(entry.target)} g`
    case 'years':
      return `${whole.format(current)} / ${whole.format(entry.target)} ${entry.target === 1 ? 'year' : 'years'}`
    default:
      return `${whole.format(current)} / ${whole.format(entry.target)}`
  }
}

/** Inbox message key for an unlocked achievement. */
export function achievementMessageKey(id: string): string {
  return `unlock:${id}`
}

/** Keys of the one-off "already meets N achievements" summaries. */
export const ACHIEVEMENT_BACKFILL_KEY_PREFIX = 'backfill:'

/** The achievement id behind an Inbox message key, if it is an unlock. */
export function achievementIdFromMessageKey(key: string | null): string | null {
  return key?.startsWith('unlock:') ? key.slice('unlock:'.length) : null
}

/** Where the celebration and Inbox messages lead. */
export const ACHIEVEMENTS_HREF = '/insights/achievements'

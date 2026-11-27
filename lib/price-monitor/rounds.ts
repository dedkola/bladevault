/**
 * The retry list's keys and reasons. Checks set aside in a cycle (deferred
 * ones and problems for AI) wait there; see cycle.ts and round-store.ts.
 */
export const RETRY_REASONS = [
  'failed',
  'blocked',
  'no_price',
  /** Older rounds only: the store was not ready for a knife's step. */
  'store_not_ready',
  'supervisor',
] as const
export type RetryReason = (typeof RETRY_REASONS)[number]

export function retryKey(
  task:
    | { kind: 'check'; sourceId: number }
    | { kind: 'search'; knifeId: string; store: string },
): string {
  return task.kind === 'check'
    ? `check:${task.sourceId}`
    : `search:${task.knifeId}:${task.store}`
}

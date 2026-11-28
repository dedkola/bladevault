/**
 * The retry list's vocabulary. Scheduled checks run store by store
 * (store-queue.ts); the retry list only carries the supervisor's Retry with
 * AI, kept in round-store.ts.
 */
export const RETRY_REASONS = [
  'failed',
  'blocked',
  'no_price',
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

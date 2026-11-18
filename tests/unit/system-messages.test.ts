import { describe, expect, it } from 'vitest'
import {
  applySystemMessageAction,
  getSystemMessageBox,
  isSystemMessageUnread,
  mergeSystemMessageChanges,
  parseSystemMessageAction,
  planSystemMessageReport,
  planSystemMessageResolve,
  sortSystemMessages,
  type SystemMessage,
} from '@/lib/system-messages'

const now = new Date('2026-11-18T10:00:00.000Z')
const report = {
  kind: 'backup-failed' as const,
  title: 'Google Drive backup failed',
  detail: 'Google Drive upload failed (503).',
}

function message(overrides: Partial<SystemMessage> = {}): SystemMessage {
  return {
    id: 1,
    kind: 'backup-failed',
    title: 'Google Drive backup failed',
    detail: 'Network error',
    occurrences: 1,
    occurredAt: '2026-11-17T08:00:00.000Z',
    createdAt: '2026-11-17T08:00:00.000Z',
    updatedAt: '2026-11-17T08:00:00.000Z',
    readAt: null,
    dismissedAt: null,
    resolvedAt: null,
    ...overrides,
  }
}

describe('system messages', () => {
  it('starts a new unread message for a first failure', () => {
    const changes = planSystemMessageReport([], report, now)
    expect(changes.update).toEqual([])
    expect(changes.create).toEqual([
      expect.objectContaining({
        ...report,
        occurrences: 1,
        occurredAt: now.toISOString(),
        readAt: null,
      }),
    ])
  })

  it('folds a repeat into the open message and marks it unread again', () => {
    const existing = message({
      readAt: '2026-11-17T09:00:00.000Z',
      dismissedAt: '2026-11-17T09:00:00.000Z',
    })
    const changes = planSystemMessageReport([existing], report, now)
    expect(changes.create).toEqual([])
    expect(changes.update).toEqual([
      expect.objectContaining({
        id: 1,
        detail: report.detail,
        occurrences: 2,
        occurredAt: now.toISOString(),
        createdAt: existing.createdAt,
        readAt: null,
        dismissedAt: null,
      }),
    ])
  })

  it('starts a fresh message once the earlier one was resolved', () => {
    const resolved = message({ resolvedAt: '2026-11-17T09:00:00.000Z' })
    const changes = planSystemMessageReport([resolved], report, now)
    expect(changes.update).toEqual([])
    expect(changes.create).toHaveLength(1)
  })

  it('resolves only unresolved messages of the kind and purges old ones', () => {
    const open = message({ id: 1 })
    const stale = message({
      id: 2,
      resolvedAt: '2026-07-01T00:00:00.000Z',
    })
    const changes = planSystemMessageResolve(
      [open, stale],
      'backup-failed',
      now,
    )
    expect(changes.update).toEqual([
      expect.objectContaining({ id: 1, resolvedAt: now.toISOString() }),
    ])
    expect(changes.deleteIds).toEqual([2])
    const merged = mergeSystemMessageChanges([open, stale], changes)
    expect(merged.map((row) => getSystemMessageBox(row))).toEqual(['done'])
  })

  it('reads, dismisses and restores messages', () => {
    const open = message()
    const [dismissed] = applySystemMessageAction(
      [open],
      { action: 'dismiss', ids: [1] },
      now,
    )
    expect(getSystemMessageBox(dismissed)).toBe('done')
    expect(isSystemMessageUnread(dismissed)).toBe(false)
    const [restored] = applySystemMessageAction(
      [dismissed],
      { action: 'restore', ids: [1] },
      now,
    )
    expect(isSystemMessageUnread(restored)).toBe(true)
    expect(
      applySystemMessageAction([restored], { action: 'read-all' }, now),
    ).toEqual([expect.objectContaining({ readAt: now.toISOString() })])
  })

  it('sorts the latest occurrence first', () => {
    const older = message({ id: 1 })
    const newer = message({ id: 2, occurredAt: '2026-11-18T08:00:00.000Z' })
    expect(sortSystemMessages([older, newer]).map((row) => row.id)).toEqual([
      2, 1,
    ])
  })

  it('validates PATCH bodies', () => {
    expect(parseSystemMessageAction({ action: 'read-all' })).toEqual({
      action: 'read-all',
    })
    expect(parseSystemMessageAction({ action: 'dismiss', ids: [3] })).toEqual({
      action: 'dismiss',
      ids: [3],
    })
    expect(() =>
      parseSystemMessageAction({ action: 'snooze', ids: [1] }),
    ).toThrow()
    expect(() =>
      parseSystemMessageAction({ action: 'read', ids: [] }),
    ).toThrow()
  })
})

import { describe, expect, it } from 'vitest'
import {
  applySystemMessageAction,
  getSystemMessageBox,
  isSystemMessageUnread,
  mergeSystemMessageChanges,
  parseSystemMessageAction,
  planSystemMessageReport,
  planSystemMessageResolve,
  readPriceAgentNote,
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
    key: null,
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

describe('keyed system messages', () => {
  const unlock = {
    kind: 'achievement' as const,
    key: 'unlock:collector',
    title: 'Achievement unlocked: Collector',
    detail: '100 knives in the vault',
  }

  it('creates one message per key and ignores repeats of a key', () => {
    const first = planSystemMessageReport([], unlock, now)
    expect(first.create).toHaveLength(1)
    expect(first.create[0]).toMatchObject({ key: 'unlock:collector' })

    const stored = message({ kind: 'achievement', key: 'unlock:collector' })
    // Even dismissed, the same key is never reported twice.
    for (const row of [stored, { ...stored, dismissedAt: now.toISOString() }]) {
      const repeat = planSystemMessageReport([row], unlock, now)
      expect(repeat.create).toEqual([])
      expect(repeat.update).toEqual([])
    }

    const other = planSystemMessageReport(
      [stored],
      { ...unlock, key: 'unlock:armory' },
      now,
    )
    expect(other.create).toHaveLength(1)
  })

  it('keeps keyed and unkeyed messages apart', () => {
    const keyed = message({ id: 1, kind: 'achievement', key: 'unlock:a' })
    const unkeyed = planSystemMessageReport(
      [keyed],
      { kind: 'achievement', title: 'Plain', detail: '' },
      now,
    )
    expect(unkeyed.update).toEqual([])
    expect(unkeyed.create[0]).toMatchObject({ key: null })

    const resolve = planSystemMessageResolve([keyed], 'achievement', now)
    expect(resolve.update).toEqual([])
  })
})

describe('AI supervisor questions', () => {
  const question = message({
    id: 7,
    kind: 'price-question',
    key: 'ask:k1:2026-11-18T09:00:00.000Z',
    title: 'Set a 95.00 USD target for Kizer Drop Bear?',
    detail: 'It sold for 95.00 USD twice this year.',
    payload: {
      type: 'question',
      knifeId: 'k1',
      ask: 'set_target',
      priceMinor: 9500,
      currency: 'USD',
    },
    answer: null,
  })

  it('closes a question for good with its answer', () => {
    const [answered] = applySystemMessageAction(
      [question],
      { action: 'answer', id: 7, answer: 'yes' },
      now,
    )
    expect(answered).toMatchObject({
      answer: 'yes',
      resolvedAt: now.toISOString(),
      readAt: now.toISOString(),
      dismissedAt: null,
    })
    expect(getSystemMessageBox(answered)).toBe('done')
    // Answered, dismissed or not a question: nothing to answer.
    for (const row of [
      answered,
      { ...question, dismissedAt: now.toISOString() },
      message({ id: 7 }),
    ])
      expect(
        applySystemMessageAction(
          [row],
          { action: 'answer', id: 7, answer: 'no' },
          now,
        ),
      ).toEqual([])
  })

  it('validates answers and stored payloads', () => {
    expect(
      parseSystemMessageAction({ action: 'answer', id: 7, answer: 'no' }),
    ).toEqual({ action: 'answer', id: 7, answer: 'no' })
    expect(() =>
      parseSystemMessageAction({ action: 'answer', id: 7, answer: 'maybe' }),
    ).toThrow('answer must be yes or no')
    expect(() =>
      parseSystemMessageAction({ action: 'answer', id: 0, answer: 'yes' }),
    ).toThrow('id must be a message id')

    expect(readPriceAgentNote(question.payload)).toEqual(question.payload)
    expect(
      readPriceAgentNote({ type: 'advice', knifeId: 'k1', topic: 'deal' }),
    ).toEqual({ type: 'advice', knifeId: 'k1', topic: 'deal' })
    for (const bad of [
      null,
      { type: 'advice', knifeId: 'k1', topic: 'gossip' },
      { type: 'question', knifeId: 'k1', ask: 'set_target', priceMinor: -1 },
      {
        type: 'question',
        knifeId: 'k1',
        ask: 'set_target',
        priceMinor: 9500,
        currency: 'usd',
      },
      { type: 'question', knifeId: '', ask: 'watch_closely', hours: 1 },
      { type: 'question', knifeId: 'k1', ask: 'keep_listing', sourceId: 2.5 },
    ])
      expect(readPriceAgentNote(bad)).toBeNull()
  })

  it('stores the payload of a new report', () => {
    const changes = planSystemMessageReport(
      [],
      {
        kind: 'price-advice',
        key: 'advise:k1:now',
        title: 'Kizer Drop Bear is at its 90-day low',
        detail: '99.00 USD at Kizer.',
        payload: { type: 'advice', knifeId: 'k1', topic: 'deal' },
      },
      now,
    )
    expect(changes.create[0]).toMatchObject({
      payload: { type: 'advice', knifeId: 'k1', topic: 'deal' },
      answer: null,
    })
  })
})

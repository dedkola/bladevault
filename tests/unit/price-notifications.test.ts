import { describe, expect, it } from 'vitest'
import {
  applyPriceNotificationAction,
  expiredPriceNotificationIds,
  getPriceNotificationBox,
  isPriceNotificationUnread,
  meetsPriceThreshold,
  mergePriceNotificationUpdates,
  parsePriceNotificationAction,
  planPriceNotifications,
  sortPriceNotifications,
  type PriceNotification,
  type PriceNotificationEvent,
  type PriceNotificationSettings,
} from '@/lib/price-monitor/notifications'
import { DEFAULT_PRICE_MONITORING } from '@/lib/settings-shared'

const NOW = new Date('2026-11-18T12:00:00.000Z')
const EARLIER = '2026-11-10T09:00:00.000Z'
const DAY_MS = 86_400_000

const DEFAULTS: PriceNotificationSettings = {
  notify: DEFAULT_PRICE_MONITORING.notify,
  thresholds: DEFAULT_PRICE_MONITORING.thresholds,
}

function settings(
  patch: {
    notify?: Partial<PriceNotificationSettings['notify']>
    thresholds?: Partial<PriceNotificationSettings['thresholds']>
  } = {},
): PriceNotificationSettings {
  return {
    notify: { ...DEFAULTS.notify, ...patch.notify },
    thresholds: { ...DEFAULTS.thresholds, ...patch.thresholds },
  }
}

function priceEvent(
  deltaMinor: number,
  deltaPct: number,
  extra: Partial<Extract<PriceNotificationEvent, { currency: string }>> = {},
): PriceNotificationEvent {
  return {
    kind: deltaMinor < 0 ? 'drop' : 'increase',
    eventId: 10,
    knifeId: 'knife-1',
    sourceId: 1,
    currency: 'USD',
    deltaMinor,
    deltaPct,
    ...extra,
  }
}

function stockEvent(
  kind: 'out_of_stock' | 'back_in_stock',
  eventId = 20,
  sourceId = 1,
): PriceNotificationEvent {
  return { kind, eventId, knifeId: 'knife-1', sourceId }
}

function stored(patch: Partial<PriceNotification> = {}): PriceNotification {
  return {
    id: 1,
    knifeId: 'knife-1',
    sourceId: 1,
    eventId: 5,
    kind: 'drop',
    occurrences: 1,
    occurredAt: EARLIER,
    createdAt: EARLIER,
    updatedAt: EARLIER,
    readAt: null,
    dismissedAt: null,
    resolvedAt: null,
    ...patch,
  }
}

const nowIso = NOW.toISOString()

describe('meetsPriceThreshold', () => {
  const change = (deltaMinor: number, deltaPct: number, currency = 'USD') => ({
    currency,
    deltaMinor,
    deltaPct,
  })

  it('uses the percent threshold alone when the amount is off', () => {
    const thresholds = { minPercent: 5, minAbsolute: 0 }
    expect(meetsPriceThreshold(change(-500, -5), thresholds)).toBe(true)
    expect(meetsPriceThreshold(change(-490, -4.9), thresholds)).toBe(false)
    expect(meetsPriceThreshold(change(700, 7), thresholds)).toBe(true)
  })

  it('notifies when either threshold is met', () => {
    const thresholds = { minPercent: 10, minAbsolute: 20 }
    // 3% but 30.00 USD: the amount is enough.
    expect(meetsPriceThreshold(change(-3000, -3), thresholds)).toBe(true)
    // 12% of a cheap knife: the percent is enough.
    expect(meetsPriceThreshold(change(-600, -12), thresholds)).toBe(true)
    expect(meetsPriceThreshold(change(-1999, -9.99), thresholds)).toBe(false)
  })

  it('converts the amount with the currency’s minor unit', () => {
    const thresholds = { minPercent: 0, minAbsolute: 500 }
    expect(meetsPriceThreshold(change(-500, -2, 'JPY'), thresholds)).toBe(true)
    expect(meetsPriceThreshold(change(-499, -2, 'JPY'), thresholds)).toBe(false)
    expect(meetsPriceThreshold(change(-50_000, -2, 'USD'), thresholds)).toBe(
      true,
    )
  })

  it('lets every change through when both thresholds are off', () => {
    expect(
      meetsPriceThreshold(change(-1, -0.01), { minPercent: 0, minAbsolute: 0 }),
    ).toBe(true)
  })
})

describe('planPriceNotifications', () => {
  it('creates nothing without events, so an unchanged price never notifies', () => {
    expect(planPriceNotifications([], [], DEFAULTS, NOW)).toEqual({
      create: [],
      update: [],
      deleteIds: [],
    })
  })

  it('creates an unread notification for a drop over the threshold', () => {
    const plan = planPriceNotifications(
      [priceEvent(-2000, -20)],
      [],
      DEFAULTS,
      NOW,
    )
    expect(plan.create).toEqual([
      {
        knifeId: 'knife-1',
        sourceId: 1,
        eventId: 10,
        kind: 'drop',
        occurrences: 1,
        occurredAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
        readAt: null,
        dismissedAt: null,
        resolvedAt: null,
      },
    ])
    expect(plan.update).toEqual([])
  })

  it('skips changes below the threshold and disabled categories', () => {
    expect(
      planPriceNotifications([priceEvent(-300, -3)], [], DEFAULTS, NOW).create,
    ).toEqual([])
    // Increases and out-of-stock are off by default.
    expect(
      planPriceNotifications(
        [priceEvent(2000, 20), stockEvent('out_of_stock')],
        [],
        DEFAULTS,
        NOW,
      ).create,
    ).toEqual([])
    expect(
      planPriceNotifications(
        [priceEvent(-2000, -20)],
        [],
        settings({ notify: { drop: false } }),
        NOW,
      ).create,
    ).toEqual([])
  })

  it('ignores thresholds for stock changes', () => {
    const plan = planPriceNotifications(
      [stockEvent('back_in_stock'), stockEvent('out_of_stock', 21, 2)],
      [],
      settings({
        notify: { outOfStock: true },
        thresholds: { minPercent: 100, minAbsolute: 1000 },
      }),
      NOW,
    )
    expect(plan.create.map((row) => [row.kind, row.sourceId])).toEqual([
      ['back_in_stock', 1],
      ['out_of_stock', 2],
    ])
  })

  it('updates the open notification of the same source and kind', () => {
    const open = stored({ readAt: EARLIER })
    const plan = planPriceNotifications(
      [priceEvent(-800, -8, { eventId: 11 })],
      [open],
      DEFAULTS,
      NOW,
    )
    expect(plan.create).toEqual([])
    expect(plan.update).toEqual([
      {
        ...open,
        eventId: 11,
        occurrences: 2,
        occurredAt: nowIso,
        updatedAt: nowIso,
        readAt: null,
      },
    ])
  })

  it('reopens a dismissed notification instead of adding a second one', () => {
    const dismissed = stored({ dismissedAt: EARLIER, readAt: EARLIER })
    const plan = planPriceNotifications(
      [priceEvent(-800, -8, { eventId: 11 })],
      [dismissed],
      DEFAULTS,
      NOW,
    )
    expect(plan.create).toEqual([])
    expect(plan.update).toEqual([
      expect.objectContaining({
        id: 1,
        eventId: 11,
        occurrences: 2,
        readAt: null,
        dismissedAt: null,
      }),
    ])
  })

  it('starts a new notification once the previous one was resolved', () => {
    const plan = planPriceNotifications(
      [priceEvent(-800, -8, { eventId: 11 })],
      [stored({ resolvedAt: EARLIER })],
      DEFAULTS,
      NOW,
    )
    expect(plan.update).toEqual([])
    expect(plan.create).toEqual([
      expect.objectContaining({ eventId: 11, occurrences: 1 }),
    ])
  })

  it('keeps sources apart', () => {
    const plan = planPriceNotifications(
      [priceEvent(-800, -8, { eventId: 11, sourceId: 2 })],
      [stored()],
      DEFAULTS,
      NOW,
    )
    expect(plan.update).toEqual([])
    expect(plan.create).toEqual([expect.objectContaining({ sourceId: 2 })])
  })

  it('resolves the opposite kind, even when the new event does not notify', () => {
    const drop = stored({ id: 1, kind: 'drop' })
    const outOfStock = stored({ id: 2, kind: 'out_of_stock', eventId: 6 })
    const otherSource = stored({ id: 3, kind: 'drop', sourceId: 9 })
    const plan = planPriceNotifications(
      // A small increase (increases are off) and a restock.
      [priceEvent(100, 1, { eventId: 12 }), stockEvent('back_in_stock', 22)],
      [drop, outOfStock, otherSource],
      DEFAULTS,
      NOW,
    )
    expect(plan.update).toEqual([
      { ...drop, resolvedAt: nowIso, updatedAt: nowIso },
      { ...outOfStock, resolvedAt: nowIso, updatedAt: nowIso },
    ])
    expect(plan.create).toEqual([
      expect.objectContaining({ kind: 'back_in_stock', eventId: 22 }),
    ])
  })

  it('resolves a dismissed opposite notification so it stays closed', () => {
    const dismissed = stored({ kind: 'increase', dismissedAt: EARLIER })
    const plan = planPriceNotifications(
      [priceEvent(-2000, -20)],
      [dismissed],
      DEFAULTS,
      NOW,
    )
    expect(plan.update).toEqual([
      { ...dismissed, resolvedAt: nowIso, updatedAt: nowIso },
    ])
    expect(plan.create).toEqual([expect.objectContaining({ kind: 'drop' })])
  })

  it('applies several events in order', () => {
    const plan = planPriceNotifications(
      [
        stockEvent('back_in_stock', 30),
        stockEvent('out_of_stock', 31),
        stockEvent('back_in_stock', 32),
      ],
      [],
      settings({ notify: { outOfStock: true } }),
      NOW,
    )
    expect(
      plan.create.map((row) => [row.kind, row.eventId, row.resolvedAt]),
    ).toEqual([
      // Each change closes the one before it; only the last stays open.
      ['back_in_stock', 30, nowIso],
      ['out_of_stock', 31, nowIso],
      ['back_in_stock', 32, null],
    ])
  })

  it('purges closed notifications after 90 days', () => {
    const old = new Date(NOW.getTime() - 91 * DAY_MS).toISOString()
    const recent = new Date(NOW.getTime() - 89 * DAY_MS).toISOString()
    const existing = [
      stored({ id: 1, resolvedAt: old }),
      stored({ id: 2, dismissedAt: old, kind: 'increase' }),
      stored({ id: 3, resolvedAt: recent, kind: 'back_in_stock' }),
      stored({ id: 4, occurredAt: old, kind: 'out_of_stock' }),
    ]
    expect(expiredPriceNotificationIds(existing, NOW)).toEqual([1, 2])
    const plan = planPriceNotifications(
      [priceEvent(-2000, -20)],
      existing,
      DEFAULTS,
      NOW,
    )
    expect(plan.deleteIds).toEqual([1, 2])
    // The expired dismissed increase is gone, not resolved again.
    expect(plan.update).toEqual([])
    expect(plan.create).toHaveLength(1)
  })
})

describe('applyPriceNotificationAction', () => {
  const open = stored({ id: 1 })
  const read = stored({ id: 2, kind: 'back_in_stock', readAt: EARLIER })
  const dismissed = stored({
    id: 3,
    kind: 'increase',
    dismissedAt: EARLIER,
    readAt: EARLIER,
  })
  const resolved = stored({ id: 4, kind: 'out_of_stock', resolvedAt: EARLIER })
  const all = [open, read, dismissed, resolved]

  it('marks one read', () => {
    expect(
      applyPriceNotificationAction(all, { action: 'read', ids: [1, 2] }, NOW),
    ).toEqual([{ ...open, readAt: nowIso, updatedAt: nowIso }])
  })

  it('marks every unread open notification read', () => {
    expect(
      applyPriceNotificationAction(all, { action: 'read-all' }, NOW),
    ).toEqual([{ ...open, readAt: nowIso, updatedAt: nowIso }])
  })

  it('dismisses open ones and restores dismissed ones', () => {
    expect(
      applyPriceNotificationAction(
        all,
        { action: 'dismiss', ids: [1, 3, 4] },
        NOW,
      ),
    ).toEqual([
      { ...open, dismissedAt: nowIso, readAt: nowIso, updatedAt: nowIso },
    ])
    expect(
      applyPriceNotificationAction(
        all,
        { action: 'restore', ids: [3, 4] },
        NOW,
      ),
    ).toEqual([
      { ...dismissed, dismissedAt: null, readAt: null, updatedAt: nowIso },
    ])
  })

  it('reports boxes, unread state and sorting', () => {
    expect(all.map(getPriceNotificationBox)).toEqual([
      'open',
      'open',
      'done',
      'done',
    ])
    expect(all.map(isPriceNotificationUnread)).toEqual([
      true,
      false,
      false,
      false,
    ])
    const newer = stored({ id: 5, occurredAt: nowIso })
    expect(sortPriceNotifications([open, newer]).map((row) => row.id)).toEqual([
      5, 1,
    ])
  })

  it('merges action results into loaded rows, keeping extra fields', () => {
    const loaded = [{ ...open, event: 'kept' }]
    expect(
      mergePriceNotificationUpdates(loaded, [{ ...open, readAt: nowIso }]),
    ).toEqual([{ ...open, readAt: nowIso, event: 'kept' }])
  })
})

describe('parsePriceNotificationAction', () => {
  it('accepts known actions and rejects bad ids', () => {
    expect(parsePriceNotificationAction({ action: 'read-all' })).toEqual({
      action: 'read-all',
    })
    expect(
      parsePriceNotificationAction({ action: 'dismiss', ids: [3] }),
    ).toEqual({ action: 'dismiss', ids: [3] })
    expect(() =>
      parsePriceNotificationAction({ action: 'read', ids: [] }),
    ).toThrow(/ids/)
    expect(() =>
      parsePriceNotificationAction({ action: 'read', ids: [1.5] }),
    ).toThrow(/ids/)
    expect(() => parsePriceNotificationAction({ action: 'snooze' })).toThrow(
      /Unknown/,
    )
    expect(() => parsePriceNotificationAction([])).toThrow(/object/)
  })
})

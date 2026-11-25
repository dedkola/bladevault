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
  selectDesktopPriceAlerts,
  shouldNotify,
  sortPriceNotifications,
  type PriceAlertContext,
  type PriceNotification,
  type PriceNotificationView,
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
    priceMinor: 10_000 + deltaMinor,
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
    snoozedUntil: null,
    superSale: false,
    ...patch,
  }
}

const nowIso = NOW.toISOString()

describe('meetsPriceThreshold', () => {
  const change = (deltaPct: number) => ({
    deltaPct,
    deltaMinor: deltaPct * 100,
    currency: 'USD',
  })
  const percent = (minPercent: number) => ({
    minPercent,
    minAmount: 0,
    allTimeLow: false,
  })

  it('notifies when the change reaches the percent in either direction', () => {
    const thresholds = percent(5)
    expect(meetsPriceThreshold(change(-5), thresholds)).toBe(true)
    expect(meetsPriceThreshold(change(-4.9), thresholds)).toBe(false)
    expect(meetsPriceThreshold(change(1), thresholds)).toBe(false)
    expect(meetsPriceThreshold(change(7), thresholds)).toBe(true)
  })

  it('lets every change through when the threshold is 0', () => {
    expect(meetsPriceThreshold(change(-0.01), percent(0))).toBe(true)
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
        snoozedUntil: null,
        superSale: false,
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
        thresholds: { minPercent: 100 },
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

  it("treats stock as the knife's: another store selling it means no change", () => {
    const on = settings({ notify: { outOfStock: true, backInStock: true } })
    const elsewhere: PriceAlertContext = {
      rules: { muted: false, targetPrice: null, belowPaid: false },
      paidMinor: null,
      sourceMutedUntil: null,
      lowestBeforeMinor: null,
      otherStoresInStock: 1,
    }
    const nowhere: PriceAlertContext = { ...elsewhere, otherStoresInStock: 0 }
    for (const kind of ['out_of_stock', 'back_in_stock'] as const) {
      expect(shouldNotify(stockEvent(kind), on, elsewhere, NOW)).toBe(false)
      expect(shouldNotify(stockEvent(kind), on, nowhere, NOW)).toBe(true)
    }
    // An open restock of this store still closes when it sells out.
    const restock = stored({ kind: 'back_in_stock' })
    const plan = planPriceNotifications(
      [stockEvent('out_of_stock')],
      [restock],
      on,
      NOW,
      () => elsewhere,
    )
    expect(plan.update).toEqual([
      { ...restock, resolvedAt: nowIso, updatedAt: nowIso },
    ])
    expect(plan.create).toEqual([])
  })

  it("closes the knife's out of stock at every store when one has it again", () => {
    const ownStore = stored({ id: 1, kind: 'out_of_stock', sourceId: 1 })
    const otherStore = stored({ id: 2, kind: 'out_of_stock', sourceId: 2 })
    const otherKnife = stored({
      id: 3,
      kind: 'out_of_stock',
      sourceId: 3,
      knifeId: 'knife-2',
    })
    const plan = planPriceNotifications(
      [stockEvent('back_in_stock', 22, 2)],
      [ownStore, otherStore, otherKnife],
      DEFAULTS,
      NOW,
    )
    expect(plan.update).toEqual([
      { ...ownStore, resolvedAt: nowIso, updatedAt: nowIso },
      { ...otherStore, resolvedAt: nowIso, updatedAt: nowIso },
    ])
    expect(plan.create).toEqual([
      expect.objectContaining({ kind: 'back_in_stock', sourceId: 2 }),
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
    expect(all.map((row) => getPriceNotificationBox(row, NOW))).toEqual([
      'open',
      'open',
      'done',
      'done',
    ])
    expect(all.map((row) => isPriceNotificationUnread(row, NOW))).toEqual([
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
    expect(() => parsePriceNotificationAction({ action: 'archive' })).toThrow(
      /Unknown/,
    )
    expect(() => parsePriceNotificationAction([])).toThrow(/object/)
  })
})

function alertContext(
  patch: Partial<Omit<PriceAlertContext, 'rules'>> & {
    rules?: Partial<PriceAlertContext['rules']>
  } = {},
): PriceAlertContext {
  return {
    paidMinor: null,
    sourceMutedUntil: null,
    lowestBeforeMinor: null,
    ...patch,
    rules: {
      muted: false,
      targetPrice: null,
      belowPaid: false,
      ...patch.rules,
    },
  }
}

/** A drop from `from` to `to` (USD minor units). */
function drop(from: number, to: number): PriceNotificationEvent {
  return priceEvent(
    to - from,
    Math.round(((to - from) / from) * 10_000) / 100,
    {
      priceMinor: to,
    },
  )
}

describe('alert rules (shouldNotify)', () => {
  it('mutes a knife and a source until its time, for every kind', () => {
    const big = drop(10_000, 8_000)
    expect(
      shouldNotify(
        big,
        DEFAULTS,
        alertContext({ rules: { muted: true } }),
        NOW,
      ),
    ).toBe(false)
    expect(
      shouldNotify(
        stockEvent('back_in_stock'),
        DEFAULTS,
        alertContext({ rules: { muted: true } }),
        NOW,
      ),
    ).toBe(false)
    const later = new Date(NOW.getTime() + DAY_MS).toISOString()
    const past = new Date(NOW.getTime() - DAY_MS).toISOString()
    expect(
      shouldNotify(
        big,
        DEFAULTS,
        alertContext({ sourceMutedUntil: later }),
        NOW,
      ),
    ).toBe(false)
    expect(
      shouldNotify(
        big,
        DEFAULTS,
        alertContext({ sourceMutedUntil: past }),
        NOW,
      ),
    ).toBe(true)
  })

  it('needs a target price to be reached and notifies when crossing it', () => {
    const target = alertContext({
      rules: { targetPrice: { minor: 9_000, currency: 'USD' } },
    })
    // 100 → 92: above the target.
    expect(shouldNotify(drop(10_000, 9_200), DEFAULTS, target, NOW)).toBe(false)
    // 92 → 90 (-2%): under the 5% threshold, but it crosses the target.
    expect(shouldNotify(drop(9_200, 9_000), DEFAULTS, target, NOW)).toBe(true)
    // 90 → 89 (-1%): already below the target, so the threshold applies.
    expect(shouldNotify(drop(9_000, 8_900), DEFAULTS, target, NOW)).toBe(false)
    // A target in another currency is not compared.
    const euro = alertContext({
      rules: { targetPrice: { minor: 1_000, currency: 'EUR' } },
    })
    expect(shouldNotify(drop(10_000, 9_000), DEFAULTS, euro, NOW)).toBe(true)
    // The drop switch still decides.
    expect(
      shouldNotify(
        drop(9_200, 9_000),
        settings({ notify: { drop: false } }),
        target,
        NOW,
      ),
    ).toBe(false)
  })

  it('only notifies below what was paid when asked, and when comparable', () => {
    const paid = alertContext({ rules: { belowPaid: true }, paidMinor: 9_000 })
    expect(shouldNotify(drop(10_000, 9_400), DEFAULTS, paid, NOW)).toBe(false)
    expect(shouldNotify(drop(10_000, 9_000), DEFAULTS, paid, NOW)).toBe(false)
    expect(shouldNotify(drop(10_000, 8_900), DEFAULTS, paid, NOW)).toBe(true)
    const unknown = alertContext({ rules: { belowPaid: true } })
    expect(shouldNotify(drop(10_000, 9_400), DEFAULTS, unknown, NOW)).toBe(true)
    // Increases are not affected by drop rules.
    expect(
      shouldNotify(
        priceEvent(1_000, 10),
        settings({ notify: { increase: true } }),
        paid,
        NOW,
      ),
    ).toBe(true)
  })

  it('applies the minimum amount in the price currency', () => {
    const amount = settings({ thresholds: { minPercent: 0, minAmount: 3 } })
    expect(shouldNotify(drop(10_000, 9_750), amount, null, NOW)).toBe(false)
    expect(shouldNotify(drop(10_000, 9_700), amount, null, NOW)).toBe(true)
    // JPY has no minor unit: 3 means ¥3.
    const yen = priceEvent(-2, -0.5, { currency: 'JPY', priceMinor: 398 })
    expect(shouldNotify(yen, amount, null, NOW)).toBe(false)
  })

  it('notifies a new all-time low below the percent when the setting is on', () => {
    const low = alertContext({ lowestBeforeMinor: 9_900 })
    const small = drop(10_000, 9_800) // -2%, a new low
    expect(shouldNotify(small, DEFAULTS, low, NOW)).toBe(false)
    const on = settings({ thresholds: { allTimeLow: true } })
    expect(shouldNotify(small, on, low, NOW)).toBe(true)
    // Not a new low.
    expect(shouldNotify(drop(10_000, 9_900), on, low, NOW)).toBe(false)
    // No history yet.
    expect(shouldNotify(small, on, alertContext(), NOW)).toBe(false)
    // The minimum amount still applies.
    expect(
      shouldNotify(
        small,
        settings({ thresholds: { allTimeLow: true, minAmount: 5 } }),
        low,
        NOW,
      ),
    ).toBe(false)
    // The drop switch still applies.
    expect(
      shouldNotify(
        small,
        settings({ notify: { drop: false }, thresholds: { allTimeLow: true } }),
        low,
        NOW,
      ),
    ).toBe(false)
  })

  it('lets the planner resolve an open message even while muted', () => {
    const open = stored({ id: 3, kind: 'drop', sourceId: 1 })
    const plan = planPriceNotifications(
      [priceEvent(1_000, 10)],
      [open],
      settings({ notify: { increase: true } }),
      NOW,
      () => alertContext({ rules: { muted: true } }),
    )
    expect(plan.create).toEqual([])
    expect(plan.update).toEqual([
      { ...open, resolvedAt: nowIso, updatedAt: nowIso },
    ])
  })
})

describe('collection pass: super sales only', () => {
  const COLLECTION: PriceNotificationSettings = {
    ...DEFAULTS,
    collectionPass: { enabled: true, superSalePercent: 50 },
  }
  // Regular price $200: the super-sale line is $100.
  const collection = (patch: Parameters<typeof alertContext>[0] = {}) =>
    alertContext({ paidMinor: 20_000, tier: 'collection', ...patch })

  it('ignores ordinary drops, increases and stock changes', () => {
    // 200 → 180 (-10%) and 160 → 120 (-25%): far from the line.
    expect(
      shouldNotify(drop(20_000, 18_000), COLLECTION, collection(), NOW),
    ).toBe(false)
    expect(
      shouldNotify(drop(16_000, 12_000), COLLECTION, collection(), NOW),
    ).toBe(false)
    expect(
      shouldNotify(priceEvent(3_000, 30), COLLECTION, collection(), NOW),
    ).toBe(false)
    expect(
      shouldNotify(stockEvent('back_in_stock'), COLLECTION, collection(), NOW),
    ).toBe(false)
    expect(
      shouldNotify(stockEvent('out_of_stock'), COLLECTION, collection(), NOW),
    ).toBe(false)
  })

  it('notifies a drop that crosses the super-sale line, marked as a super sale', () => {
    // 120 → 90: 55% below the regular price.
    const event = drop(12_000, 9_000)
    expect(shouldNotify(event, COLLECTION, collection(), NOW)).toBe(true)
    // Exactly on the line counts.
    expect(
      shouldNotify(drop(12_000, 10_000), COLLECTION, collection(), NOW),
    ).toBe(true)
    const plan = planPriceNotifications([event], [], COLLECTION, NOW, () =>
      collection(),
    )
    expect(plan.create).toHaveLength(1)
    expect(plan.create[0]).toMatchObject({ kind: 'drop', superSale: true })
  })

  it('below the line, a further drop needs the usual minimums', () => {
    // 90 → 88 (-2%): under the 5% minimum.
    expect(
      shouldNotify(drop(9_000, 8_800), COLLECTION, collection(), NOW),
    ).toBe(false)
    // 90 → 80 (-11%): a further real drop.
    expect(
      shouldNotify(drop(9_000, 8_000), COLLECTION, collection(), NOW),
    ).toBe(true)
  })

  it('follows the configured percent', () => {
    const forty: PriceNotificationSettings = {
      ...DEFAULTS,
      collectionPass: { enabled: true, superSalePercent: 40 },
    }
    // 140 → 115: 42.5% below $200.
    expect(shouldNotify(drop(14_000, 11_500), forty, collection(), NOW)).toBe(
      true,
    )
    expect(
      shouldNotify(drop(14_000, 11_500), COLLECTION, collection(), NOW),
    ).toBe(false)
  })

  it('needs a comparable regular price, and respects mute', () => {
    expect(
      shouldNotify(
        drop(12_000, 5_000),
        COLLECTION,
        collection({ paidMinor: null }),
        NOW,
      ),
    ).toBe(false)
    expect(
      shouldNotify(
        drop(12_000, 9_000),
        COLLECTION,
        collection({ rules: { muted: true } }),
        NOW,
      ),
    ).toBe(false)
  })

  it('still lets the knife’s own target price notify', () => {
    const target = collection({
      rules: { targetPrice: { minor: 15_000, currency: 'USD' } },
    })
    expect(shouldNotify(drop(16_000, 14_900), COLLECTION, target, NOW)).toBe(
      true,
    )
    const plan = planPriceNotifications(
      [drop(16_000, 14_900)],
      [],
      COLLECTION,
      NOW,
      () => target,
    )
    expect(plan.create[0]).toMatchObject({ superSale: false })
  })

  it('an increase still closes an open super-sale drop', () => {
    const open = stored({ id: 7, superSale: true })
    const plan = planPriceNotifications(
      [priceEvent(3_000, 30)],
      [open],
      COLLECTION,
      NOW,
      () => collection(),
    )
    expect(plan.create).toEqual([])
    expect(plan.update).toEqual([
      { ...open, resolvedAt: nowIso, updatedAt: nowIso },
    ])
  })

  it('uses the usual rules for What to monitor and while the pass is off', () => {
    const scope = alertContext({ paidMinor: 20_000, tier: 'scope' })
    expect(shouldNotify(drop(20_000, 18_000), COLLECTION, scope, NOW)).toBe(
      true,
    )
    expect(
      shouldNotify(drop(20_000, 18_000), DEFAULTS, collection(), NOW),
    ).toBe(true)
  })
})

describe('snooze and bulk actions', () => {
  it('snoozes, keeps a repeat snoozed, and shows it again', () => {
    const open = stored({ id: 1, readAt: EARLIER })
    const [snoozed] = applyPriceNotificationAction(
      [open],
      { action: 'snooze', ids: [1], days: 3 },
      NOW,
    )
    expect(snoozed.snoozedUntil).toBe(
      new Date(NOW.getTime() + 3 * DAY_MS).toISOString(),
    )
    expect(snoozed.readAt).toBeNull()
    expect(getPriceNotificationBox(snoozed, NOW)).toBe('snoozed')
    expect(isPriceNotificationUnread(snoozed, NOW)).toBe(false)
    const later = new Date(NOW.getTime() + 4 * DAY_MS)
    expect(getPriceNotificationBox(snoozed, later)).toBe('open')
    expect(isPriceNotificationUnread(snoozed, later)).toBe(true)

    const repeat = planPriceNotifications(
      [drop(10_000, 8_000)],
      [snoozed],
      DEFAULTS,
      NOW,
    )
    expect(repeat.update[0].snoozedUntil).toBe(snoozed.snoozedUntil)
    expect(repeat.update[0].occurrences).toBe(2)

    const [shown] = applyPriceNotificationAction(
      [snoozed],
      { action: 'unsnooze', ids: [1] },
      NOW,
    )
    expect(shown.snoozedUntil).toBeNull()
    expect(getPriceNotificationBox(shown, NOW)).toBe('open')
  })

  it('dismisses every open message, not snoozed or closed ones', () => {
    const rows = [
      stored({ id: 1 }),
      stored({ id: 2, readAt: EARLIER }),
      stored({
        id: 3,
        snoozedUntil: new Date(NOW.getTime() + DAY_MS).toISOString(),
      }),
      stored({ id: 4, resolvedAt: EARLIER }),
      stored({ id: 5, dismissedAt: EARLIER }),
    ]
    const changed = applyPriceNotificationAction(
      rows,
      { action: 'dismiss-all' },
      NOW,
    )
    expect(changed.map((row) => row.id)).toEqual([1, 2])
    expect(changed[0]).toMatchObject({ dismissedAt: nowIso, readAt: nowIso })
    expect(changed[1]).toMatchObject({ dismissedAt: nowIso, readAt: EARLIER })
  })

  it('validates snooze and bulk requests', () => {
    expect(parsePriceNotificationAction({ action: 'dismiss-all' })).toEqual({
      action: 'dismiss-all',
    })
    expect(
      parsePriceNotificationAction({ action: 'snooze', ids: [1], days: 7 }),
    ).toEqual({ action: 'snooze', ids: [1], days: 7 })
    expect(() =>
      parsePriceNotificationAction({ action: 'snooze', ids: [1], days: 0 }),
    ).toThrow(/days/)
    expect(() =>
      parsePriceNotificationAction({ action: 'unsnooze', ids: [] }),
    ).toThrow(/ids/)
  })
})

describe('selectDesktopPriceAlerts', () => {
  const view = (
    patch: Partial<PriceNotification>,
    event: Partial<PriceNotificationView['event']> = {},
  ): PriceNotificationView => ({
    ...stored(patch),
    event: {
      id: 'price-1',
      type: 'price',
      kind: patch.kind ?? 'drop',
      knife: {
        id: 'knife-1',
        name: 'Bugout',
        brand: 'Benchmade',
        image: null,
        subtitle: null,
      },
      sourceId: 1,
      storeName: 'example.com',
      sourceUrl: 'https://example.com/p',
      previousPriceMinor: 15_000,
      priceMinor: 12_900,
      currency: 'USD',
      deltaMinor: -2_100,
      deltaPct: -14,
      occurredAt: nowIso,
      ...event,
    },
    context: {
      paidMinor: null,
      lowestMinor: null,
      sourceMutedUntil: null,
      knifeMuted: false,
    },
  })

  it('picks new unread drops and restocks, oldest first', () => {
    const since = '2026-11-18T11:00:00.000Z'
    const alerts = selectDesktopPriceAlerts(
      [
        view({ id: 1, occurredAt: nowIso }),
        view(
          {
            id: 2,
            kind: 'back_in_stock',
            occurredAt: '2026-11-18T11:30:00.000Z',
          },
          { type: 'stock', previousPriceMinor: null },
        ),
        view({ id: 3, kind: 'increase', occurredAt: nowIso }),
        view({ id: 4, occurredAt: '2026-11-18T10:00:00.000Z' }),
        view({ id: 5, occurredAt: nowIso, readAt: nowIso }),
        view({ id: 6, occurredAt: nowIso, dismissedAt: nowIso }),
      ],
      since,
      NOW,
    )
    expect(alerts.map((alert) => alert.id)).toEqual([2, 1])
    expect(alerts[1]).toMatchObject({
      knifeId: 'knife-1',
      title: 'Price dropped: Benchmade Bugout',
      body: 'example.com · $150.00 → $129.00',
    })
    expect(alerts[0].title).toBe('Back in stock: Benchmade Bugout')
    expect(alerts[0].body).toBe('example.com · $129.00')
  })

  it('titles a super sale as such', () => {
    const [alert] = selectDesktopPriceAlerts(
      [view({ id: 1, occurredAt: nowIso, superSale: true })],
      '2026-11-18T11:00:00.000Z',
      NOW,
    )
    expect(alert.title).toBe('Super sale: Benchmade Bugout')
  })
})

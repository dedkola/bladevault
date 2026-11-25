import { describe, expect, it } from 'vitest'
import type { CareNotification } from '@/lib/care-notifications'
import {
  collectPopupCandidates,
  nextPopupQueue,
  selectNewPopups,
  type InboxPopupType,
} from '@/lib/inbox-popups'
import type { PriceNotification } from '@/lib/price-monitor/notifications'
import {
  DEFAULT_POPUP_NOTIFICATIONS,
  normalizePopupNotificationSettings,
} from '@/lib/settings-shared'
import type { SystemMessage } from '@/lib/system-messages'

const now = new Date('2026-11-25T12:00:00Z')
const at = '2026-11-25T11:00:00.000Z'

function care(id: number, patch: Partial<CareNotification> = {}) {
  return {
    id,
    knifeId: `k${id}`,
    track: 'sharpening',
    lastAt: at,
    dueOn: '2026-11-25',
    level: 'due-soon',
    createdAt: at,
    updatedAt: at,
    readAt: null,
    snoozedUntil: null,
    dismissedAt: null,
    resolvedAt: null,
    resolution: null,
    ...patch,
  } as CareNotification
}

function system(id: number, patch: Partial<SystemMessage> = {}) {
  return {
    id,
    kind: 'backup-failed',
    key: null,
    title: 'Backup failed',
    detail: '',
    occurrences: 1,
    occurredAt: at,
    createdAt: at,
    updatedAt: at,
    readAt: null,
    dismissedAt: null,
    resolvedAt: null,
    ...patch,
  } as SystemMessage
}

function price(id: number, patch: Partial<PriceNotification> = {}) {
  return {
    id,
    knifeId: `k${id}`,
    sourceId: 1,
    eventId: id,
    kind: 'drop',
    occurrences: 1,
    occurredAt: at,
    createdAt: at,
    updatedAt: at,
    readAt: null,
    dismissedAt: null,
    resolvedAt: null,
    snoozedUntil: null,
    ...patch,
  } as PriceNotification
}

const none = new Set<InboxPopupType>()

function candidates(
  rows: {
    care?: CareNotification[]
    system?: SystemMessage[]
    price?: PriceNotification[]
  },
  careEnabled = true,
) {
  return collectPopupCandidates({
    care: rows.care ?? [],
    careEnabled,
    system: rows.system ?? [],
    price: rows.price ?? [],
    now,
  })
}

describe('popup notification settings', () => {
  it('turns every kind on by default', () => {
    expect(DEFAULT_POPUP_NOTIFICATIONS).toEqual({
      enabled: true,
      price: true,
      care: true,
      system: true,
    })
    expect(normalizePopupNotificationSettings(undefined)).toEqual(
      DEFAULT_POPUP_NOTIFICATIONS,
    )
  })

  it('keeps saved flags and falls back for missing or invalid ones', () => {
    expect(
      normalizePopupNotificationSettings({ care: false, price: 'no' }),
    ).toEqual({ enabled: true, price: true, care: false, system: true })
  })
})

describe('collectPopupCandidates', () => {
  it('lists unread open messages of every kind', () => {
    const list = candidates({
      care: [care(1)],
      system: [system(2)],
      price: [price(3)],
    })
    expect(list.map((row) => row.key)).toEqual([
      `price:3:${at}`,
      `system:2:${at}`,
      'care:1:2026-11-25',
    ])
  })

  it('skips read, done, snoozed and achievement messages', () => {
    const list = candidates({
      care: [
        care(1, { readAt: at }),
        care(2, { snoozedUntil: '2026-11-26T00:00:00Z' }),
      ],
      system: [
        system(3, { kind: 'achievement', key: 'first-knife' }),
        system(4, { resolvedAt: at }),
      ],
      price: [price(5, { dismissedAt: at })],
    })
    expect(list).toEqual([])
  })

  it('leaves out care messages while care reminders are off', () => {
    expect(candidates({ care: [care(1)] }, false)).toEqual([])
  })
})

describe('selectNewPopups', () => {
  it('pops up only messages not seen before', () => {
    const first = selectNewPopups(
      new Set(),
      candidates({ price: [price(1)] }),
      {
        settings: DEFAULT_POPUP_NOTIFICATIONS,
        quiet: none,
      },
    )
    expect(first.fresh.map((row) => row.id)).toEqual([1])

    const second = selectNewPopups(
      first.seen,
      candidates({ price: [price(1), price(2)] }),
      { settings: DEFAULT_POPUP_NOTIFICATIONS, quiet: none },
    )
    expect(second.fresh.map((row) => row.id)).toEqual([2])
  })

  it('seeds quiet types without popping them up', () => {
    const list = candidates({ care: [care(1)], price: [price(2)] })
    const result = selectNewPopups(new Set(), list, {
      settings: DEFAULT_POPUP_NOTIFICATIONS,
      quiet: new Set<InboxPopupType>(['care']),
    })
    expect(result.fresh.map((row) => row.type)).toEqual(['price'])
    // The seeded care message never pops up later either.
    const again = selectNewPopups(result.seen, list, {
      settings: DEFAULT_POPUP_NOTIFICATIONS,
      quiet: none,
    })
    expect(again.fresh).toEqual([])
  })

  it('respects the master switch and each kind', () => {
    const list = candidates({
      care: [care(1)],
      system: [system(2)],
      price: [price(3)],
    })
    const off = selectNewPopups(new Set(), list, {
      settings: { ...DEFAULT_POPUP_NOTIFICATIONS, enabled: false },
      quiet: none,
    })
    expect(off.fresh).toEqual([])
    // Turning pop-ups back on does not replay what arrived while off.
    expect(
      selectNewPopups(off.seen, list, {
        settings: DEFAULT_POPUP_NOTIFICATIONS,
        quiet: none,
      }).fresh,
    ).toEqual([])

    const noPrices = selectNewPopups(new Set(), list, {
      settings: { ...DEFAULT_POPUP_NOTIFICATIONS, price: false },
      quiet: none,
    })
    expect(noPrices.fresh.map((row) => row.type)).toEqual(['system', 'care'])
  })

  it('pops up a repeat price change again', () => {
    const first = selectNewPopups(
      new Set(),
      candidates({ price: [price(1)] }),
      {
        settings: DEFAULT_POPUP_NOTIFICATIONS,
        quiet: none,
      },
    )
    const repeat = selectNewPopups(
      first.seen,
      candidates({
        price: [price(1, { occurredAt: '2026-11-25T11:30:00.000Z' })],
      }),
      { settings: DEFAULT_POPUP_NOTIFICATIONS, quiet: none },
    )
    expect(repeat.fresh.map((row) => row.id)).toEqual([1])
  })
})

describe('nextPopupQueue', () => {
  it('puts fresh pop-ups on top and replaces one for the same message', () => {
    const old = candidates({ price: [price(1)], system: [system(2)] })
    const repeat = candidates({
      price: [price(1, { occurredAt: '2026-11-25T11:30:00.000Z' })],
      system: [system(2)],
    })
    const queue = nextPopupQueue(
      old,
      [repeat[0]],
      repeat,
      DEFAULT_POPUP_NOTIFICATIONS,
    )
    expect(queue.map((row) => row.key)).toEqual([
      'price:1:2026-11-25T11:30:00.000Z',
      `system:2:${at}`,
    ])
  })

  it('drops pop-ups that were read elsewhere or whose kind was turned off', () => {
    const queue = candidates({ price: [price(1)], system: [system(2)] })
    const afterRead = candidates({ system: [system(2)] })
    expect(
      nextPopupQueue(queue, [], afterRead, DEFAULT_POPUP_NOTIFICATIONS).map(
        (row) => row.id,
      ),
    ).toEqual([2])
    expect(
      nextPopupQueue(queue, [], queue, {
        ...DEFAULT_POPUP_NOTIFICATIONS,
        system: false,
      }).map((row) => row.id),
    ).toEqual([1])
  })
})

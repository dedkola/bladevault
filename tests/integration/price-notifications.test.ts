import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as knivesRoute from '@/app/api/knives/route'
import * as knifeRoute from '@/app/api/knives/[id]/route'
import * as priceWatchRoute from '@/app/api/knives/[id]/price-watch/route'
import * as notificationsRoute from '@/app/api/price-notifications/route'
import * as desktopRoute from '@/app/api/price-notifications/desktop/route'
import { getLocalDb } from '@/lib/local-db'
import { checkPriceSource } from '@/lib/price-monitor/engine'
import type { PriceNotificationView } from '@/lib/price-monitor/notifications'
import type { PriceWatchView } from '@/lib/price-monitor/shared'
import type { ExtractedOffer } from '@/lib/scrape-offer'
import { getSettings, saveSettings } from '@/lib/settings'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

const mocks = vi.hoisted(() => ({
  browser: vi.fn(),
  http: vi.fn(),
}))

vi.mock('@/lib/price-monitor/fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/price-monitor/fetch')>()),
  checkViaBrowser: mocks.browser,
  checkViaHttp: mocks.http,
}))
vi.mock('@/lib/url-validation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/url-validation')>()),
  validateExternalUrl: async (value: string) => ({
    ok: true,
    url: new URL(value),
  }),
}))

let vault: TempVault | null = null

beforeEach(async () => {
  vault = await createTempVault()
  vi.resetAllMocks()
})
afterEach(async () => {
  await vault?.cleanup()
  vault = null
})

const PRODUCT_URL = 'https://shop.example/products/raccoon'

function offer(
  amount: number | null,
  availability: ExtractedOffer['availability'] = 'in_stock',
): ExtractedOffer {
  return { amount, currency: 'USD', availability, method: 'jsonld' }
}

function json(url: string, method: string, body: unknown) {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })

async function createKnife() {
  const response = await knivesRoute.POST(
    json('http://localhost/api/knives', 'POST', {
      name: 'Raccoon',
      brand: 'Vosteed',
      specs: { price: '129.00 USD' },
      sourceUrl: PRODUCT_URL,
    }),
  )
  const id = ((await response.json()) as { knife: { id: string } }).knife.id
  getLocalDb()
    .prepare('UPDATE knives SET images = ? WHERE id = ?')
    .run(JSON.stringify(['knives/raccoon.webp']), id)
  return id
}

async function sourceIdFor(knifeId: string) {
  const response = await priceWatchRoute.GET(
    new Request(`http://localhost/api/knives/${knifeId}/price-watch`),
    params(knifeId),
  )
  return ((await response.json()) as { watch: PriceWatchView }).watch.sources[0]
    .id
}

/** Runs one check per reading, in order. */
async function check(sourceId: number, ...readings: ExtractedOffer[]) {
  for (const reading of readings) {
    mocks.browser.mockResolvedValueOnce({
      offer: reading,
      serverOffer: null,
      finalUrl: PRODUCT_URL,
      isShopify: false,
    })
    await checkPriceSource(sourceId, { trigger: 'manual' })
  }
}

function notificationRows() {
  return getLocalDb()
    .prepare(
      `SELECT kind, occurrences, read_at IS NOT NULL AS read,
              dismissed_at IS NOT NULL AS dismissed,
              resolved_at IS NOT NULL AS resolved
       FROM price_notifications ORDER BY id`,
    )
    .all()
}

async function getNotifications() {
  const response = await notificationsRoute.GET(
    new Request('http://localhost/api/price-notifications'),
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { notifications: PriceNotificationView[] })
    .notifications
}

async function patch(body: unknown) {
  const response = await notificationsRoute.PATCH(
    json('http://localhost/api/price-notifications', 'PATCH', body),
  )
  return {
    status: response.status,
    body: (await response.json()) as {
      notifications?: PriceNotificationView[]
      error?: string
    },
  }
}

describe('price notifications', () => {
  it('turns stored changes into Inbox notifications with the default settings', async () => {
    const knifeId = await createKnife()
    const sourceId = await sourceIdFor(knifeId)

    // First reading and an unchanged price: no events, no notifications.
    await check(sourceId, offer(100), offer(100))
    expect(notificationRows()).toEqual([])

    // A 2% drop is an event but stays under the 5% threshold.
    await check(sourceId, offer(98))
    expect(notificationRows()).toEqual([])

    // Two drops over the threshold share one notification.
    await check(sourceId, offer(80), offer(75))
    expect(notificationRows()).toEqual([
      { kind: 'drop', occurrences: 2, read: 0, dismissed: 0, resolved: 0 },
    ])

    // Out of stock is off by default; back in stock is on.
    await check(sourceId, offer(null, 'out_of_stock'), offer(75))
    expect(notificationRows()).toEqual([
      { kind: 'drop', occurrences: 2, read: 0, dismissed: 0, resolved: 0 },
      {
        kind: 'back_in_stock',
        occurrences: 1,
        read: 0,
        dismissed: 0,
        resolved: 0,
      },
    ])

    // Increases are off, but one still closes the open drop.
    await check(sourceId, offer(90))
    expect(notificationRows()).toEqual([
      { kind: 'drop', occurrences: 2, read: 0, dismissed: 0, resolved: 1 },
      {
        kind: 'back_in_stock',
        occurrences: 1,
        read: 0,
        dismissed: 0,
        resolved: 0,
      },
    ])

    const list = await getNotifications()
    expect(list.map((row) => row.kind)).toEqual(['drop', 'back_in_stock'])
    const drop = list.find((row) => row.kind === 'drop')!
    expect(drop.event).toMatchObject({
      type: 'price',
      kind: 'drop',
      knife: {
        id: knifeId,
        name: 'Raccoon',
        brand: 'Vosteed',
        image: 'knives/raccoon.webp',
      },
      storeName: 'shop.example',
      sourceUrl: PRODUCT_URL,
      previousPriceMinor: 8000,
      priceMinor: 7500,
      currency: 'USD',
      deltaMinor: -500,
      deltaPct: -6.25,
    })
    const restock = list.find((row) => row.kind === 'back_in_stock')!
    expect(restock.event).toMatchObject({
      type: 'stock',
      priceMinor: 7500,
      currency: 'USD',
    })
  })

  it('follows the category and threshold settings', async () => {
    saveSettings({
      priceMonitoring: {
        ...getSettings().priceMonitoring,
        notify: {
          drop: false,
          increase: true,
          outOfStock: true,
          backInStock: false,
        },
        thresholds: { minPercent: 15, minAmount: 0, allTimeLow: false },
      },
    })
    const knifeId = await createKnife()
    const sourceId = await sourceIdFor(knifeId)

    // +10% is under 15%; 110 → 130 (+18%) notifies; drops are off.
    await check(sourceId, offer(100), offer(110), offer(130), offer(100))
    await check(sourceId, offer(null, 'out_of_stock'))
    expect(notificationRows()).toEqual([
      { kind: 'increase', occurrences: 1, read: 0, dismissed: 0, resolved: 1 },
      {
        kind: 'out_of_stock',
        occurrences: 1,
        read: 0,
        dismissed: 0,
        resolved: 0,
      },
    ])
  })

  it('marks read, dismisses and restores through the API', async () => {
    const knifeId = await createKnife()
    const sourceId = await sourceIdFor(knifeId)
    await check(sourceId, offer(100), offer(80))
    const [drop] = await getNotifications()

    expect((await patch({ action: 'read', ids: [drop.id] })).status).toBe(200)
    expect(notificationRows()).toEqual([
      { kind: 'drop', occurrences: 1, read: 1, dismissed: 0, resolved: 0 },
    ])

    const dismissed = await patch({ action: 'dismiss', ids: [drop.id] })
    expect(dismissed.body.notifications?.[0]).toMatchObject({
      id: drop.id,
      dismissedAt: expect.any(String),
    })

    // A further drop reopens the dismissed notification as unread.
    await check(sourceId, offer(70))
    expect(notificationRows()).toEqual([
      { kind: 'drop', occurrences: 2, read: 0, dismissed: 0, resolved: 0 },
    ])

    await patch({ action: 'dismiss', ids: [drop.id] })
    await patch({ action: 'restore', ids: [drop.id] })
    await patch({ action: 'read-all' })
    expect(notificationRows()).toEqual([
      { kind: 'drop', occurrences: 2, read: 1, dismissed: 0, resolved: 0 },
    ])

    expect((await patch({ action: 'read', ids: [] })).status).toBe(400)
    expect((await patch({ action: 'snooze', ids: [1] })).status).toBe(400)
  })

  it('purges closed notifications after 90 days and deletes them with the knife', async () => {
    const knifeId = await createKnife()
    const sourceId = await sourceIdFor(knifeId)
    await check(sourceId, offer(100), offer(80), offer(100))
    const old = new Date(Date.now() - 91 * 86_400_000).toISOString()
    getLocalDb()
      .prepare('UPDATE price_notifications SET resolved_at = ?')
      .run(old)
    await patch({ action: 'read-all' })
    expect(notificationRows()).toEqual([])

    await check(sourceId, offer(80))
    expect(notificationRows()).toHaveLength(1)
    await knifeRoute.DELETE(
      new Request(`http://localhost/api/knives/${knifeId}`, {
        method: 'DELETE',
      }),
      params(knifeId),
    )
    expect(notificationRows()).toEqual([])
    expect(await getNotifications()).toEqual([])
  })

  it('applies per-knife rules, store mutes, snooze and bulk dismiss', async () => {
    const knifeId = await createKnife() // paid 129.00 USD
    const sourceId = await sourceIdFor(knifeId)
    const put = async (body: unknown) => {
      const response = await priceWatchRoute.PUT(
        json(`http://localhost/api/knives/${knifeId}/price-watch`, 'PUT', body),
        params(knifeId),
      )
      return {
        status: response.status,
        watch: ((await response.json()) as { watch: PriceWatchView }).watch,
      }
    }

    // Target price: 150 → 140 does not reach 120; 140 → 119 does.
    const saved = await put({
      alerts: {
        targetPrice: { amount: 120, currency: 'usd' },
        belowPaid: true,
      },
    })
    expect(saved.watch.alerts).toEqual({
      muted: false,
      belowPaid: true,
      targetPrice: { minor: 12_000, currency: 'USD' },
    })
    expect(saved.watch.paid).toEqual({ amount: 129, currency: 'USD' })
    expect((await put({ alerts: { targetPrice: { amount: 0 } } })).status).toBe(
      400,
    )
    await check(sourceId, offer(150), offer(140))
    expect(notificationRows()).toEqual([])
    await check(sourceId, offer(119))
    expect(notificationRows()).toHaveLength(1)

    // The Inbox view carries what was paid and the lowest earlier price.
    const [view] = await getNotifications()
    expect(view.context).toEqual({
      paidMinor: 12_900,
      lowestMinor: 11_900,
      sourceMutedUntil: null,
      knifeMuted: false,
    })

    // Desktop alerts list it while new and unread.
    const desktop = await desktopRoute.GET(
      new Request(
        'http://localhost/api/price-notifications/desktop?since=2000-01-01T00:00:00Z',
      ),
    )
    const alerts = (
      (await desktop.json()) as { alerts: Array<{ title: string }> }
    ).alerts
    expect(alerts.map((alert) => alert.title)).toEqual([
      'Price dropped: Vosteed Raccoon',
    ])
    expect(
      (
        await desktopRoute.GET(
          new Request('http://localhost/api/price-notifications/desktop'),
        )
      ).status,
    ).toBe(400)

    // Snooze hides it; a repeat keeps it snoozed.
    const snoozed = await patch({ action: 'snooze', ids: [view.id], days: 3 })
    expect(snoozed.body.notifications?.[0].snoozedUntil).toBeTruthy()
    await put({ alerts: { targetPrice: null, belowPaid: false } })
    await check(sourceId, offer(100))
    const [repeat] = await getNotifications()
    expect(repeat.occurrences).toBe(2)
    expect(repeat.snoozedUntil).toBe(
      snoozed.body.notifications?.[0].snoozedUntil,
    )
    await patch({ action: 'unsnooze', ids: [view.id] })

    // Muting the store stops new messages, but an increase still resolves.
    const muted = await put({ update: [{ id: sourceId, muteDays: 7 }] })
    expect(muted.watch.sources[0].notifyMutedUntil).toBeTruthy()
    await check(sourceId, offer(110), offer(95))
    expect(notificationRows()).toEqual([
      { kind: 'drop', occurrences: 2, read: 0, dismissed: 0, resolved: 1 },
    ])
    expect((await getNotifications())[0].context.sourceMutedUntil).toBeTruthy()
    await put({ update: [{ id: sourceId, muteDays: 0 }] })

    // Muting the knife does the same; unmuting lets drops through again.
    await put({ alerts: { muted: true } })
    await check(sourceId, offer(105), offer(90))
    expect(notificationRows()).toHaveLength(1)
    await put({ alerts: { muted: false } })
    await check(sourceId, offer(100), offer(85))
    expect(notificationRows()).toHaveLength(2)

    // Dismiss all closes every open message.
    const dismissed = await patch({ action: 'dismiss-all' })
    expect(dismissed.status).toBe(200)
    expect(
      dismissed.body.notifications?.every(
        (row) => row.dismissedAt || row.resolvedAt,
      ),
    ).toBe(true)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as knivesRoute from '@/app/api/knives/route'
import * as priceWatchRoute from '@/app/api/knives/[id]/price-watch/route'
import * as exportRoute from '@/app/api/prices/export/route'
import * as appLockRoute from '@/app/api/app-lock/route'
import { getLocalDb } from '@/lib/local-db'
import { checkPriceSource } from '@/lib/price-monitor/engine'
import type { PriceWatchView } from '@/lib/price-monitor/shared'
import type { ExtractedOffer } from '@/lib/scrape-offer'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

const mocks = vi.hoisted(() => ({ browser: vi.fn() }))
vi.mock('@/lib/price-monitor/fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/price-monitor/fetch')>()),
  checkViaBrowser: mocks.browser,
}))
vi.mock('@/lib/url-validation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/url-validation')>()),
  validateExternalUrl: async (value: string) => ({
    ok: true,
    url: new URL(value),
  }),
}))

const DAY = 24 * 60 * 60 * 1000
const START = Date.UTC(2026, 7, 1, 12)
let vault: TempVault | null = null

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(START)
  vault = await createTempVault()
  vi.resetAllMocks()
})
afterEach(async () => {
  vi.useRealTimers()
  await vault?.cleanup()
  vault = null
})

function json(url: string, method: string, body: unknown) {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function createKnife(
  name: string,
  brand: string,
  price: string,
  url: string,
) {
  const response = await knivesRoute.POST(
    json('http://localhost/api/knives', 'POST', {
      name,
      brand,
      specs: { price },
      sourceUrl: url,
    }),
  )
  const id = ((await response.json()) as { knife: { id: string } }).knife.id
  const watch = (
    (await (
      await priceWatchRoute.GET(new Request('http://localhost/x'), {
        params: Promise.resolve({ id }),
      })
    ).json()) as { watch: PriceWatchView }
  ).watch
  return { id, sourceId: watch.sources[0].id }
}

function offer(
  amount: number | null,
  availability: ExtractedOffer['availability'] = 'in_stock',
): ExtractedOffer {
  return { amount, currency: 'USD', availability, method: 'jsonld' }
}

async function checkAt(
  dayOffset: number,
  sourceId: number,
  reading: ExtractedOffer,
) {
  vi.setSystemTime(START + dayOffset * DAY)
  mocks.browser.mockResolvedValueOnce({
    offer: reading,
    serverOffer: null,
    finalUrl: 'https://shop.example/p',
    isShopify: false,
  })
  await checkPriceSource(sourceId, { trigger: 'manual' })
}

async function exportCsv(query = '') {
  const response = await exportRoute.GET(
    new Request(`http://localhost/api/prices/export${query}`),
  )
  // response.text() would drop the byte-order mark; keep it to check it.
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
    await response.arrayBuffer(),
  )
  return { response, text, rows: text.replace(/^﻿/, '').split('\r\n') }
}

const iso = (dayOffset: number) =>
  new Date(START + dayOffset * DAY).toISOString()

describe('price history CSV export', () => {
  it('exports snapshots for every knife, one knife, or a range', async () => {
    const raccoon = await createKnife(
      'Raccoon, large',
      'Vosteed',
      '129.00 USD',
      'https://shop.example/raccoon',
    )
    const formula = await createKnife(
      '=HYPERLINK("http://evil.example","x")',
      '+Brand',
      '45.00 USD',
      'https://other.example/bean',
    )
    await checkAt(0, raccoon.sourceId, offer(129.99))
    await checkAt(1, raccoon.sourceId, offer(129.99))
    await checkAt(10, raccoon.sourceId, offer(109.5))
    await checkAt(20, raccoon.sourceId, offer(null, 'out_of_stock'))
    await checkAt(21, formula.sourceId, offer(45))
    vi.setSystemTime(START + 25 * DAY)

    const all = await exportCsv()
    expect(all.response.status).toBe(200)
    expect(all.response.headers.get('Content-Type')).toBe(
      'text/csv; charset=utf-8',
    )
    expect(all.response.headers.get('Content-Disposition')).toMatch(
      /^attachment; filename="bladevault-price-history-\d{4}-\d{2}-\d{2}\.csv"$/,
    )
    expect(all.text.startsWith('﻿')).toBe(true)
    expect(all.rows[0]).toBe(
      'observed_at,last_seen_at,observations,knife_id,knife_brand,knife_name,store,url,price,currency,availability,extraction_method,ai_review',
    )
    expect(all.rows.slice(1)).toEqual([
      `${iso(0)},${iso(1)},2,${raccoon.id},Vosteed,"Raccoon, large",shop.example,https://shop.example/raccoon,129.99,USD,in_stock,jsonld,`,
      `${iso(10)},${iso(10)},1,${raccoon.id},Vosteed,"Raccoon, large",shop.example,https://shop.example/raccoon,109.5,USD,in_stock,jsonld,`,
      `${iso(20)},${iso(20)},1,${raccoon.id},Vosteed,"Raccoon, large",shop.example,https://shop.example/raccoon,,,out_of_stock,jsonld,`,
      `${iso(21)},${iso(21)},1,${formula.id},'+Brand,"'=HYPERLINK(""http://evil.example"",""x"")",other.example,https://other.example/bean,45,USD,in_stock,jsonld,`,
      '',
    ])

    const one = await exportCsv(`?knifeId=${formula.id}`)
    expect(one.rows).toHaveLength(3)
    expect(one.response.headers.get('Content-Disposition')).toContain(
      'bladevault-price-history-brand-hyperlink-http-evil-example-x-',
    )

    // 7 days back from day 25 starts at day 18: the out-of-stock state
    // is inside, and the 109.50 state was current when the range began.
    const week = await exportCsv(`?knifeId=${raccoon.id}&range=7d`)
    expect(week.rows.slice(1, -1).map((row) => row.split(',')[0])).toEqual([
      iso(10),
      iso(20),
    ])
    expect(week.response.headers.get('Content-Disposition')).toContain('-7d-')
  })

  it('exports price and stock events in time order', async () => {
    const raccoon = await createKnife(
      'Raccoon',
      'Vosteed',
      '129.00 USD',
      'https://shop.example/raccoon',
    )
    await checkAt(0, raccoon.sourceId, offer(120))
    await checkAt(5, raccoon.sourceId, offer(80))
    await checkAt(6, raccoon.sourceId, offer(null, 'out_of_stock'))
    await checkAt(7, raccoon.sourceId, offer(90))

    const events = await exportCsv('?kind=events')
    expect(events.response.headers.get('Content-Disposition')).toContain(
      'bladevault-price-events-',
    )
    expect(events.rows[0]).toBe(
      'occurred_at,type,kind,knife_id,knife_brand,knife_name,store,url,previous_price,price,currency,change,change_pct,previous_availability,availability,extraction_method',
    )
    const body = events.rows.slice(1, -1)
    expect(body[0]).toBe(
      `${iso(5)},price,drop,${raccoon.id},Vosteed,Raccoon,shop.example,https://shop.example/raccoon,120,80,USD,-40,-33.33,,in_stock,jsonld`,
    )
    expect(body.map((row) => row.split(',').slice(1, 3).join(' '))).toEqual(
      expect.arrayContaining(['stock out_of_stock', 'stock back_in_stock']),
    )
    expect(body.map((row) => row.split(',')[0])).toEqual(
      [...body.map((row) => row.split(',')[0])].sort(),
    )
  })

  it('streams every row across pages', async () => {
    const raccoon = await createKnife(
      'Raccoon',
      'Vosteed',
      '129.00 USD',
      'https://shop.example/raccoon',
    )
    await checkAt(0, raccoon.sourceId, offer(100))
    const database = getLocalDb()
    const insert = database.prepare(
      `INSERT INTO price_snapshots
        (knife_id, source_id, price_minor, currency, availability,
         extraction_status, extraction_method, observed_at, last_seen_at)
       VALUES (?, ?, ?, 'USD', 'in_stock', 'ok', 'jsonld', ?, ?)`,
    )
    database.transaction(() => {
      for (let index = 1; index <= 1200; index += 1) {
        const at = new Date(START + index * 60_000).toISOString()
        insert.run(raccoon.id, raccoon.sourceId, 10_000 + index, at, at)
      }
    })()

    const { rows } = await exportCsv()
    // Header, 1201 snapshots and the empty string after the last CRLF.
    expect(rows).toHaveLength(1203)
    expect(rows.at(-2)).toContain(',112,USD,')
  })

  it('validates parameters and leaves out the purchase price', async () => {
    const raccoon = await createKnife(
      'Raccoon',
      'Vosteed',
      '129.00 USD',
      'https://shop.example/raccoon',
    )
    await checkAt(0, raccoon.sourceId, offer(100))

    expect((await exportCsv('?kind=notes')).response.status).toBe(400)
    expect((await exportCsv('?range=2w')).response.status).toBe(400)
    expect((await exportCsv('?knifeId=missing')).response.status).toBe(404)
    const all = await exportCsv()
    expect(all.text).not.toContain('129')
  })

  it('requires the app to be unlocked', async () => {
    const response = await appLockRoute.POST(
      new Request('http://localhost/api/app-lock', {
        method: 'POST',
        headers: {
          host: 'localhost',
          origin: 'http://localhost',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'set-password',
          password: 'test',
          confirmPassword: 'test',
        }),
      }),
    )
    expect(response.ok).toBe(true)
    const locked = await exportCsv()
    expect(locked.response.status).toBe(401)
  })
})

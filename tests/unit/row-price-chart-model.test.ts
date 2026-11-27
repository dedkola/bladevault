import { describe, expect, it } from 'vitest'
import {
  cachedRowChartStores,
  priceAt,
  priceLineVisualMap,
  rowChartDirection,
  rowChartOption,
  rowChartReadings,
  rowChartRange,
  rowChartTooltip,
  rowChartTooltipPosition,
  storeColor,
  type RowChartColors,
  type RowChartStore,
} from '@/components/price-drops/row-price-chart-model'
import type { WishlistTrend } from '@/lib/wishlist'

const at = (iso: string) => Date.parse(iso)

function trend(
  steps: Array<[string, number | null]>,
  until = '2026-11-26T22:00:00Z',
  currency = 'USD',
): WishlistTrend {
  return {
    currency,
    daily: [],
    steps: steps.map(([iso, price]) => ({ at: at(iso), price })),
    since: at(steps[0][0]),
    until: at(until),
    lowMinor: null,
    highMinor: null,
  }
}

// Porcupine TiSlim (real readings): Vosteed $139, Amazon on sale for a
// night at $111.20, then back to $139.
const vosteed = trend([['2026-11-19T08:45:00Z', 13900]])
const amazon = trend(
  [
    ['2026-11-24T17:54:00Z', 11120],
    ['2026-11-25T04:52:00Z', 13900],
  ],
  '2026-11-26T22:00:00Z',
)
const best = trend([
  ['2026-11-19T08:45:00Z', 13900],
  ['2026-11-24T17:54:00Z', 11120],
  ['2026-11-25T04:52:00Z', 13900],
])
const stores: RowChartStore[] = [
  { key: 'vosteed.com', label: 'Vosteed', trend: vosteed },
  { key: 'amazon.com', label: 'Amazon', trend: amazon },
]
const colors: RowChartColors = {
  down: 'green',
  up: 'red',
  flat: 'grey',
  card: '#fff',
  foreground: '#111',
  muted: '#888',
  dark: false,
}

// Kizer Drop Bear (real readings): Kizer at $42, its regular price; Blade
// HQ first seen two days in at $59.99; SMKW at $42 later.
const BEAR_END = '2026-11-27T09:00:00Z'
const kizer = trend([['2026-11-19T12:05:00Z', 4200]], BEAR_END)
const dropBearStores: RowChartStore[] = [
  { key: 'kizerknives.com', label: 'Kizer', trend: kizer },
  {
    key: 'bladehq.com',
    label: 'Blade HQ',
    trend: trend([['2026-11-21T06:26:00Z', 5999]], BEAR_END),
  },
  {
    key: 'smkw.com',
    label: 'SMKW',
    trend: trend([['2026-11-25T16:00:00Z', 4200]], BEAR_END),
  },
]

describe('rowChartReadings', () => {
  it('runs through every store reading in time order to the end', () => {
    expect(rowChartReadings(kizer, dropBearStores)).toEqual([
      [at('2026-11-19T12:05:00Z'), 4200],
      [at('2026-11-21T06:26:00Z'), 5999],
      [at('2026-11-25T16:00:00Z'), 4200],
      [at(BEAR_END), 4200],
    ])
  })

  it('skips out-of-stock readings and other currencies', () => {
    const gap = trend([
      ['2026-11-25T01:00:00Z', 12757],
      ['2026-11-25T02:00:00Z', null],
      ['2026-11-25T03:00:00Z', 12800],
    ])
    const euro: RowChartStore = {
      key: 'example.eu',
      label: 'EU',
      trend: trend([['2026-11-25T01:30:00Z', 9000]], undefined, 'EUR'),
    }
    expect(
      rowChartReadings(gap, [
        { key: 'a.com', label: 'A', trend: gap },
        euro,
      ]).map((point) => point[1]),
    ).toEqual([12757, 12800, 12800])
  })

  it("uses the trend's own steps without stores", () => {
    expect(rowChartReadings(best, [])).toEqual([
      [at('2026-11-19T08:45:00Z'), 13900],
      [at('2026-11-24T17:54:00Z'), 11120],
      [at('2026-11-25T04:52:00Z'), 13900],
      [best.until, 13900],
    ])
  })

  it('counts prices shown while out of stock', () => {
    const artisan = {
      ...trend([['2026-11-18T20:33:00Z', null]], BEAR_END),
      readings: [{ at: at('2026-11-18T20:33:00Z'), price: 12855 }],
    }
    const bladehq = trend([['2026-11-25T15:25:00Z', 19995]], BEAR_END)
    expect(
      rowChartReadings({ ...artisan, steps: [] }, [
        { key: 'artisancutlery.net', label: 'Artisan', trend: artisan },
        { key: 'bladehq.com', label: 'Blade HQ', trend: bladehq },
      ]).map((point) => point[1]),
    ).toEqual([12855, 19995, 19995])
  })

  it('counts a store price set before the window as its first reading', () => {
    const window = { ...kizer, since: at('2026-11-22T00:00:00Z') }
    expect(rowChartReadings(window, dropBearStores).slice(0, 2)).toEqual([
      [window.since, 4200],
      [window.since, 5999],
    ])
  })
})

describe('priceLineVisualMap', () => {
  it('colours the line green at the lowest reading, red at the highest', () => {
    expect(
      priceLineVisualMap(rowChartReadings(kizer, dropBearStores), colors),
    ).toMatchObject({
      show: false,
      seriesIndex: 0,
      dimension: 1,
      min: 4200,
      max: 5999,
      inRange: { color: ['green', 'red'] },
    })
    expect(priceLineVisualMap(rowChartReadings(kizer, []), colors)).toBeNull()
  })
})

describe('rowChartDirection', () => {
  it('follows the latest move of the best price', () => {
    expect(rowChartDirection(best)).toBe('up')
    expect(rowChartDirection(amazon)).toBe('up')
    expect(
      rowChartDirection(
        trend([
          ['2026-11-25T01:00:00Z', 16125],
          ['2026-11-25T03:00:00Z', 12200],
        ]),
      ),
    ).toBe('down')
    expect(rowChartDirection(vosteed)).toBe('flat')
  })
})

describe('rowChartRange', () => {
  it('starts at zero so heights are in proportion to prices', () => {
    expect(rowChartRange([12200, 21500])).toEqual({
      min: 0,
      max: 21500 * 1.08,
    })
    // A flat price sits near the top, not on the floor.
    const flat = rowChartRange([4200])
    expect(flat.min).toBe(0)
    expect(flat.max).toBeGreaterThan(4200)
    expect(rowChartRange([5, 10]).max).toBeGreaterThan(10)
  })
})

describe('storeColor', () => {
  it('gives a store the same colour on every chart', () => {
    expect(storeColor('amazon')).toBe('#2a78d6')
    expect(storeColor('amazon.com')).toBe('#2a78d6')
    expect(storeColor('bladehq.com')).toBe('#eb6834')
    expect(storeColor('kizerknives.com')).toBe(storeColor('kizerknives.com'))
    expect(storeColor('amazon.com', true)).toBe('#3987e5')
  })
})

describe('rowChartOption', () => {
  it('draws a smooth price line through every reading and the store dots', () => {
    const option = rowChartOption(
      { trend: kizer, stores: dropBearStores, regularMinor: 4200 },
      colors,
    )
    const series = option.series as Array<Record<string, unknown>>
    expect(series[0]).toMatchObject({
      type: 'line',
      showSymbol: false,
      smooth: 0.4,
      smoothMonotone: 'x',
    })
    expect(series[0].areaStyle).toEqual({ opacity: 0.12 })
    expect(series[0].markLine).toBeUndefined()
    expect((series[0].data as number[][]).map((point) => point[1])).toEqual([
      4200, 5999, 4200, 4200,
    ])
    expect(option.visualMap).toMatchObject({ min: 4200, max: 5999 })
    expect(
      series.slice(1).map((s) => [s.name, (s.data as unknown[]).length]),
    ).toEqual([
      ['Kizer', 1],
      ['Blade HQ', 1],
      ['SMKW', 1],
    ])
    const y = option.yAxis as { min: number; max: number }
    expect(y.min).toBeLessThan(4200)
    expect(y.max).toBeGreaterThan(5999)
  })

  it('draws a grey line when every reading is the same price', () => {
    const option = rowChartOption(
      { trend: kizer, stores: [], regularMinor: 4200 },
      colors,
    )
    const series = option.series as Array<Record<string, unknown>>
    expect(option.visualMap).toBeUndefined()
    expect(series[0]).toMatchObject({ lineStyle: { color: 'grey' } })
  })

  it('fits the scale to the readings, not your price', () => {
    const option = rowChartOption(
      { trend: best, stores, regularMinor: 21500 },
      colors,
    )
    expect((option.yAxis as { max: number }).max).toBeLessThan(21500)
  })

  it('leaves out stores in other currencies', () => {
    const euro: RowChartStore = {
      key: 'example.eu',
      label: 'Euro store',
      trend: { ...amazon, currency: 'EUR' },
    }
    const option = rowChartOption(
      { trend: best, stores: [euro], regularMinor: null },
      colors,
    )
    expect(option.series as unknown[]).toHaveLength(1)
  })
})

describe('rowChartTooltip', () => {
  it('lists the best price and every store at that moment', () => {
    const night = at('2026-11-25T00:00:00Z')
    const html = rowChartTooltip(
      { trend: best, stores, regularMinor: 13900 },
      night,
    )
    expect(html).toContain('Best <b>$111.20</b> · Amazon')
    expect(html.indexOf('Amazon</span>')).toBeLessThan(
      html.indexOf('Vosteed</span>'),
    )
    expect(html).toContain('$139.00')
    expect(html).toContain('Your price $139.00')
  })

  it('skips stores not tracked yet and escapes store names', () => {
    const early = at('2026-11-20T00:00:00Z')
    const html = rowChartTooltip(
      {
        trend: best,
        stores: [{ ...stores[0], label: '<b>Vosteed</b>' }, stores[1]],
        regularMinor: null,
      },
      early,
    )
    expect(html).not.toContain('Amazon')
    expect(html).not.toContain('<b>Vosteed</b>')
    expect(priceAt(amazon, early)).toBeNull()
  })
})

describe('cachedRowChartStores', () => {
  it('returns the same list while the trends stay the same', () => {
    const owner = {}
    const first = cachedRowChartStores(owner, '1,2', () => stores)
    expect(cachedRowChartStores(owner, '1,2', () => [])).toBe(first)
    expect(cachedRowChartStores({}, '1,2', () => [])).not.toBe(first)
  })
})

describe('rowChartTooltipPosition', () => {
  const size = { contentSize: [170, 140], viewSize: [260, 54] }

  it('puts the tooltip right of the chart, centred on it', () => {
    expect(rowChartTooltipPosition(size, 900, 1440)).toEqual([270, -43])
  })

  it('moves it left of the chart when the window has no room', () => {
    expect(rowChartTooltipPosition(size, 1188, 1284)).toEqual([-180, -43])
  })
})

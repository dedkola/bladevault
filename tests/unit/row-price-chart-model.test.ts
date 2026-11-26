import { describe, expect, it } from 'vitest'
import {
  ROW_CHART_HOLD_MS,
  cachedRowChartStores,
  priceAt,
  rowChartDirection,
  rowChartLine,
  rowChartOption,
  rowChartRange,
  rowChartTooltip,
  rowChartTooltipPosition,
  storeColor,
  type RowChartColors,
  type RowChartStore,
} from '@/components/price-drops/row-price-chart-model'
import type { WishlistTrend } from '@/lib/wishlist'

const at = (iso: string) => Date.parse(iso)
const H = 3_600_000

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

describe('rowChartLine', () => {
  it('holds each price until just before the next move (smooth steps)', () => {
    const points = rowChartLine(best)
    expect(points.map((point) => point.value)).toEqual([
      [at('2026-11-19T08:45:00Z'), 13900],
      [at('2026-11-24T17:54:00Z') - ROW_CHART_HOLD_MS, 13900],
      [at('2026-11-24T17:54:00Z'), 11120],
      [at('2026-11-25T04:52:00Z') - ROW_CHART_HOLD_MS, 11120],
      [at('2026-11-25T04:52:00Z'), 13900],
      [best.until, 13900],
    ])
    // Bend and end points carry no dot.
    expect(points.filter((point) => point.symbol === 'none')).toHaveLength(3)
  })

  it('bends over at most 40% of a short gap', () => {
    const quick = trend([
      ['2026-11-25T10:00:00Z', 12776],
      ['2026-11-25T12:00:00Z', 12790],
    ])
    expect(rowChartLine(quick)[1].value[0]).toBe(
      at('2026-11-25T12:00:00Z') - 0.4 * 2 * H,
    )
  })

  it('keeps the line unbroken through out-of-stock readings', () => {
    const gap = trend([
      ['2026-11-25T01:00:00Z', 12757],
      ['2026-11-25T02:00:00Z', null],
      ['2026-11-25T03:00:00Z', 12757],
    ])
    expect(rowChartLine(gap).every((point) => point.value[1] === 12757)).toBe(
      true,
    )
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
  it('fits every price with some room, never below 0', () => {
    expect(rowChartRange([12200, 21500])).toEqual({
      min: 12200 - 0.12 * 9300,
      max: 21500 + 0.12 * 9300,
    })
    // A flat price still gets room above and below.
    const flat = rowChartRange([4200])
    expect(flat.min).toBeLessThan(4200)
    expect(flat.max).toBeGreaterThan(4200)
    expect(rowChartRange([5, 10]).min).toBeGreaterThanOrEqual(0)
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
  it('draws the best price, a dot per store reading and your price', () => {
    const option = rowChartOption(
      { trend: best, stores, regularMinor: 13900 },
      colors,
    )
    const series = option.series as Array<Record<string, unknown>>
    expect(series[0]).toMatchObject({
      type: 'line',
      smooth: 0.35,
      lineStyle: { color: 'red' },
      areaStyle: { color: 'red' },
      markLine: { data: [{ yAxis: 13900 }] },
    })
    expect(
      series.slice(1).map((s) => [s.name, (s.data as unknown[]).length]),
    ).toEqual([
      ['Vosteed', 1],
      ['Amazon', 2],
    ])
    const y = option.yAxis as { min: number; max: number }
    expect(y.min).toBeLessThan(11120)
    expect(y.max).toBeGreaterThan(13900)
  })

  it('puts your price at its true position on the scale', () => {
    const chief = trend([
      ['2026-11-23T18:05:00Z', 16125],
      ['2026-11-24T21:35:00Z', 12200],
    ])
    const option = rowChartOption(
      { trend: chief, stores: [], regularMinor: 21500 },
      colors,
    )
    expect((option.yAxis as { max: number }).max).toBeGreaterThan(21500)
  })

  it('leaves out your price line without one, and other currencies', () => {
    const euro: RowChartStore = {
      key: 'example.eu',
      label: 'Euro store',
      trend: { ...amazon, currency: 'EUR' },
    }
    const option = rowChartOption(
      { trend: best, stores: [euro], regularMinor: null },
      colors,
    )
    const series = option.series as Array<Record<string, unknown>>
    expect(series[0].markLine).toBeUndefined()
    expect(series).toHaveLength(1)
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

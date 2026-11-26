import { describe, expect, it } from 'vitest'
import { ROW_CHART_MIN_GAP, rowChartScale } from '@/lib/wishlist'

const box = { top: 3, bottom: 33, minSpread: 0.04 }

describe('rowChartScale', () => {
  it('pins a far regular price to the top edge so Amazon moves show', () => {
    // Para Military 2 at Amazon: $127.76–$130.46 against a $202 regular.
    const readings = [12776, 12788, 12812, 12946, 13046, 12990]
    const { y, regularY, pinned } = rowChartScale({
      readings,
      regular: 20200,
      ...box,
    })
    expect(pinned).toBe('top')
    expect(regularY).toBeLessThan(box.top)
    // Every move is a visible step in its own direction.
    const sorted = [...new Set(readings)].sort((a, b) => a - b)
    for (let index = 1; index < sorted.length; index++)
      expect(y(sorted[index - 1]) - y(sorted[index])).toBeGreaterThanOrEqual(
        ROW_CHART_MIN_GAP - 0.01,
      )
    // Readings stay inside the chart, below the pinned regular price.
    for (const price of readings) {
      expect(y(price)).toBeLessThanOrEqual(box.bottom)
      expect(y(price)).toBeGreaterThan(regularY!)
    }
  })

  it('keeps the regular price in scale when the moves already have room', () => {
    // Native Chief Lightweight: $122–$161.25 against a $215 regular.
    const { y, regularY, pinned } = rowChartScale({
      readings: [16125, 12200, 12974, 12850, 13998],
      regular: 21500,
      ...box,
    })
    expect(pinned).toBeNull()
    expect(regularY).toBeCloseTo(box.top, 5)
    expect(y(12200)).toBeCloseTo(box.bottom, 5)
    // Bigger moves stay bigger: $161.25 → $122 beats $129.74 → $128.50.
    expect(y(12200) - y(16125)).toBeGreaterThan(y(12850) - y(12974))
  })

  it('gives a tiny move the least gap and keeps the same price level', () => {
    const { y } = rowChartScale({
      readings: [13900, 13888, 13900],
      regular: 13900,
      ...box,
    })
    expect(y(13888) - y(13900)).toBeGreaterThanOrEqual(ROW_CHART_MIN_GAP)
  })

  it('pins a regular price far below the readings to the bottom edge', () => {
    const { regularY, pinned, y } = rowChartScale({
      readings: [20000, 20500],
      regular: 6900,
      ...box,
    })
    expect(pinned).toBe('bottom')
    expect(regularY).toBeGreaterThan(box.bottom)
    expect(y(20000)).toBeLessThan(box.bottom)
  })

  it('does not pin when only one price was read', () => {
    const { pinned, regularY, y } = rowChartScale({
      readings: [22050],
      regular: 29400,
      ...box,
    })
    expect(pinned).toBeNull()
    expect(regularY).toBeLessThan(y(22050))
  })
})

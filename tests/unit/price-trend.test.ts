import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  PriceTrend,
  regularChipLabel,
  regularGap,
  trendNetChange,
} from '@/components/price-drops/price-trend'
import type { WishlistTrend } from '@/lib/wishlist'

const at = (iso: string) => Date.parse(iso)

/**
 * An Amazon listing first seen already on sale ($202 regular): it only moved
 * between $127.76 and $130.46, with a stretch where no price was read.
 */
const amazon: WishlistTrend = {
  currency: 'USD',
  daily: [],
  steps: [
    { at: at('2026-11-25T05:06:26Z'), price: 12776 },
    { at: at('2026-11-25T08:47:58Z'), price: 12788 },
    { at: at('2026-11-25T11:31:59Z'), price: 12812 },
    { at: at('2026-11-25T14:38:02Z'), price: 12946 },
    { at: at('2026-11-25T17:36:47Z'), price: null },
    { at: at('2026-11-26T08:03:58Z'), price: 13046 },
    { at: at('2026-11-26T15:09:50Z'), price: 12990 },
  ],
  since: at('2026-11-25T05:06:26Z'),
  until: at('2026-11-26T18:00:00Z'),
  lowMinor: 12776,
  highMinor: 13046,
}

describe('row chart chip against the regular price', () => {
  it('shows the current discount in money and percent', () => {
    const gap = regularGap(12990, 20200)
    expect(gap).toEqual({ delta: -7210, share: 36, direction: 'down' })
    expect(regularChipLabel(gap!, 'USD')).toBe('▼ $72.10 · 36%')
  })

  it('shows a price above regular as a rise', () => {
    const gap = regularGap(21400, 20200)
    expect(gap).toEqual({ delta: 1200, share: 6, direction: 'up' })
    expect(regularChipLabel(gap!, 'USD')).toBe('▲ $12.00 · 6%')
  })

  it('treats half a percent either way as the regular price', () => {
    expect(regularGap(20150, 20200)?.direction).toBe('flat')
    expect(regularChipLabel(regularGap(20200, 20200)!, 'USD')).toBe('regular')
    // Just past the tolerance still names a whole percent.
    expect(regularGap(20090, 20200)).toEqual({
      delta: -110,
      share: 1,
      direction: 'down',
    })
  })

  it('has no chip without a price or a regular price', () => {
    expect(regularGap(null, 20200)).toBeNull()
    expect(regularGap(12990, null)).toBeNull()
    expect(regularGap(12990, 0)).toBeNull()
  })
})

describe('row chart window change', () => {
  it('measures the window from the first store reading, not the regular price', () => {
    // $127.76 → $129.90: up about 1.7%, though the listing is on sale.
    expect(trendNetChange(amazon)).toBeCloseTo(2.14 / 127.76)
  })

  it('is null without an in-stock price', () => {
    expect(trendNetChange(undefined)).toBeNull()
    expect(
      trendNetChange({ ...amazon, steps: [{ at: amazon.since, price: null }] }),
    ).toBeNull()
  })
})

describe('PriceTrend', () => {
  const render = (props: Parameters<typeof PriceTrend>[0]) =>
    renderToStaticMarkup(createElement(PriceTrend, props))

  it('puts one headline on the chip and the regular price under the chart', () => {
    const html = render({
      trend: amazon,
      currentMinor: 12990,
      regularMinor: 20200,
      label: 'Price at Amazon',
    })
    expect(html).toContain('data-trend-chip="down"')
    expect(html).toContain('▼ $72.10 · 36%')
    expect(html).toContain('data-trend-spark="down"')
    expect(html).toContain('data-trend-regular="true"')
    expect(html).toContain('regular $202.00')
    // The last small move belongs to the price cell, not the chart.
    expect(html).not.toContain('$0.56 ·')
    expect(html).toContain(
      'now $129.90, $72.10 (36%) below the regular price $202.00',
    )
  })

  it('starts the line at the first store reading', () => {
    const html = render({
      trend: amazon,
      currentMinor: 12990,
      regularMinor: 20200,
    })
    const line = html.match(/data-trend-line="true" d="M([\d.]+),/)
    expect(Number(line?.[1])).toBe(2)
  })

  it('drops the chip and the dashed line without a regular price', () => {
    const html = render({ trend: amazon, currentMinor: 12990 })
    expect(html).not.toContain('data-trend-chip')
    expect(html).not.toContain('data-trend-regular')
    // The colour then follows the window: up from $127.76.
    expect(html).toContain('data-trend-spark="up"')
  })

  it('drops the chip when the price is not buyable now', () => {
    const html = render({
      trend: amazon,
      currentMinor: null,
      regularMinor: 20200,
    })
    expect(html).not.toContain('data-trend-chip')
    expect(html).toContain('data-trend-regular="true"')
  })
})

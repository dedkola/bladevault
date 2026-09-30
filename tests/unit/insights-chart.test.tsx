// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InsightsChart } from '@/components/insights-chart'

const { chart, init } = vi.hoisted(() => {
  const chart = {
    containPixel: vi.fn(() => false),
    convertFromPixel: vi.fn(),
    dispatchAction: vi.fn(),
    dispose: vi.fn(),
    getZr: vi.fn(() => ({ on: vi.fn() })),
    on: vi.fn(),
    resize: vi.fn(),
    setOption: vi.fn(),
  }
  return { chart, init: vi.fn(() => chart) }
})

vi.mock('@/lib/echarts-client', () => ({ init }))

let visibilityCallback: IntersectionObserverCallback

class TestIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    visibilityCallback = callback
  }

  disconnect = vi.fn()
  observe = vi.fn()
  takeRecords = vi.fn(() => [])
  unobserve = vi.fn()
  root = null
  rootMargin = '300px 0px'
  thresholds = [0]
}

class TestResizeObserver {
  disconnect = vi.fn()
  observe = vi.fn()
  unobserve = vi.fn()
}

beforeEach(() => {
  init.mockClear()
  chart.dispose.mockClear()
  vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('InsightsChart', () => {
  it('initializes only after the chart approaches the viewport', async () => {
    const view = render(
      <InsightsChart
        ariaLabel="Deferred chart"
        buildOption={() => ({ series: [] })}
      />,
    )

    expect(init).not.toHaveBeenCalled()

    act(() => {
      visibilityCallback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      )
    })

    await waitFor(() => expect(init).toHaveBeenCalledOnce())
    view.unmount()
    expect(chart.dispose).toHaveBeenCalledOnce()
  })
})

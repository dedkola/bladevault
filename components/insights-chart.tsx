'use client'

import { useEffect, useRef } from 'react'
import type { ECharts, EChartsOption } from 'echarts'
import { cn } from '@/lib/utils'

export type InsightsChartClick = {
  name?: string
  dataIndex?: number
  seriesName?: string
  data?: unknown
  value?: unknown
}

export type InsightsChartPalette = {
  card: string
  foreground: string
  muted: string
  surface: string
  line: string
  ringTrack: string
  chartPrimary: string
  chartSecondary: string
}

function getPalette(): InsightsChartPalette {
  const style = getComputedStyle(document.documentElement)
  const get = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback

  return {
    card: get('--card', '#fffdf8'),
    foreground: get('--foreground', '#2f2a20'),
    muted: get('--muted-foreground', '#6f6751'),
    surface: get('--bladevault-surface-soft', '#f7f1e5'),
    line: get('--bladevault-line', '#d3c097'),
    ringTrack: document.documentElement.classList.contains('dark')
      ? '#40371f'
      : '#eee6d7',
    chartPrimary: document.documentElement.classList.contains('dark')
      ? '#c89c3d'
      : '#2e3417',
    chartSecondary: document.documentElement.classList.contains('dark')
      ? '#947535'
      : '#79824a',
  }
}

export function InsightsChart({
  buildOption,
  ariaLabel,
  className,
  onChartClick,
}: {
  buildOption: (palette: InsightsChartPalette) => EChartsOption
  ariaLabel: string
  className?: string
  onChartClick?: (event: InsightsChartClick) => void
}) {
  const chartRef = useRef<HTMLDivElement>(null)
  const chartInstanceRef = useRef<ECharts | undefined>(undefined)
  const buildOptionRef = useRef(buildOption)
  const clickHandlerRef = useRef(onChartClick)

  useEffect(() => {
    let chart: ECharts | undefined
    let resizeObserver: ResizeObserver | undefined
    let themeObserver: MutationObserver | undefined
    let cancelled = false

    const updateOption = () => {
      chart?.setOption(buildOptionRef.current(getPalette()), true)
    }

    void import('echarts').then((echarts) => {
      if (!chartRef.current || cancelled) return
      chart = echarts.init(chartRef.current, undefined, { renderer: 'svg' })
      chartInstanceRef.current = chart
      updateOption()
      chart.on('click', (event) => {
        clickHandlerRef.current?.(event as InsightsChartClick)
      })

      resizeObserver = new ResizeObserver(() => chart?.resize())
      resizeObserver.observe(chartRef.current)

      themeObserver = new MutationObserver(updateOption)
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class'],
      })
    })

    return () => {
      cancelled = true
      resizeObserver?.disconnect()
      themeObserver?.disconnect()
      chart?.dispose()
      chartInstanceRef.current = undefined
    }
  }, [])

  useEffect(() => {
    buildOptionRef.current = buildOption
    chartInstanceRef.current?.setOption(buildOption(getPalette()), true)
  }, [buildOption])

  useEffect(() => {
    clickHandlerRef.current = onChartClick
  }, [onChartClick])

  return (
    <div
      ref={chartRef}
      role="img"
      aria-label={ariaLabel}
      className={cn('min-w-0', className)}
    />
  )
}

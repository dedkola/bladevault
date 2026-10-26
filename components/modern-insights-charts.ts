import type {
  EChartsOption,
  TooltipComponentFormatterCallbackParams,
} from 'echarts'
import type { InsightsChartPalette } from '@/components/insights-chart'
import type { CataloguePoint, CarryPoint } from '@/lib/modern-insights'

const fontFamily =
  '"BladeVault Inter", Inter, ui-sans-serif, system-ui, sans-serif'

function tooltipAppearance(palette: InsightsChartPalette) {
  return {
    renderMode: 'richText' as const,
    confine: true,
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderWidth: 1,
    padding: [10, 12],
    textStyle: {
      color: palette.foreground,
      fontFamily,
      fontSize: 13,
      lineHeight: 20,
    },
  }
}

function firstDatum(params: TooltipComponentFormatterCallbackParams) {
  return Array.isArray(params) ? params[0] : params
}

// Keep collection text literal inside ECharts' rich-text tooltip syntax.
function literalLabel(value: string) {
  return value
    .replace(/[{}\r\n\t]/g, ' ')
    .trim()
    .slice(0, 80)
}

export function buildCatalogueOption(
  palette: InsightsChartPalette,
  points: CataloguePoint[],
): EChartsOption {
  return {
    animationDuration: 350,
    textStyle: { fontFamily },
    grid: { left: 12, right: 16, top: 24, bottom: 8, containLabel: true },
    tooltip: {
      ...tooltipAppearance(palette),
      trigger: 'axis',
      axisPointer: {
        type: 'line',
        lineStyle: {
          color: palette.chartPrimary,
          opacity: 0.35,
          type: 'dashed',
        },
      },
      formatter(params) {
        const datum = firstDatum(params)
        const point = datum ? points[datum.dataIndex] : undefined
        if (!point) return ''
        return `${point.label}\n${point.total.toLocaleString()} catalogued\n${point.added.toLocaleString()} added this month`
      },
    },
    xAxis: {
      type: 'category',
      boundaryGap: points.length === 1,
      data: points.map((point) => point.label),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: palette.muted,
        fontSize: 12,
        margin: 14,
        hideOverlap: true,
        interval: Math.max(0, Math.ceil(points.length / 5) - 1),
        showMinLabel: true,
        showMaxLabel: true,
      },
    },
    yAxis: {
      type: 'value',
      min: 0,
      minInterval: 1,
      splitNumber: 3,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: palette.muted, fontSize: 12, margin: 12 },
      splitLine: { lineStyle: { color: palette.line, opacity: 0.6 } },
    },
    series: [
      {
        name: 'Catalogued knives',
        type: 'line',
        data: points.map((point) => point.total),
        showSymbol: points.length === 1,
        symbol: 'circle',
        symbolSize: 7,
        lineStyle: { color: palette.chartPrimary, width: 2.5 },
        itemStyle: {
          color: palette.chartPrimary,
          borderColor: palette.card,
          borderWidth: 2,
        },
        areaStyle: { color: palette.chartPrimary, opacity: 0.07 },
        emphasis: { focus: 'series' },
      },
    ],
  }
}

export function buildCarryOption(
  palette: InsightsChartPalette,
  points: CarryPoint[],
): EChartsOption {
  return {
    animationDuration: 350,
    textStyle: { fontFamily },
    grid: { left: 12, right: 18, top: 24, bottom: 8, containLabel: true },
    tooltip: {
      ...tooltipAppearance(palette),
      trigger: 'item',
      formatter(params) {
        const datum = firstDatum(params)
        const point = datum ? points[datum.dataIndex] : undefined
        if (!point) return ''
        const title = [point.brand, point.name].filter(Boolean).join(' · ')
        return `${literalLabel(title)}\n${point.bladeLength.toFixed(2)} in blade · ${point.weight.toFixed(2)} oz\nClick to open knife`
      },
    },
    xAxis: {
      type: 'value',
      min: 0,
      splitNumber: 4,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: palette.muted,
        fontSize: 12,
        margin: 14,
        formatter: '{value} in',
        hideOverlap: true,
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      min: 0,
      splitNumber: 3,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: palette.muted,
        fontSize: 12,
        margin: 12,
        formatter: '{value} oz',
      },
      splitLine: { lineStyle: { color: palette.line, opacity: 0.6 } },
    },
    series: [
      {
        name: 'Blade length and weight',
        type: 'scatter',
        data: points.map((point) => ({
          name: point.name,
          value: [point.bladeLength, point.weight],
          id: point.id,
          brand: point.brand,
        })),
        symbolSize: 9,
        itemStyle: {
          color: palette.chartPrimary,
          opacity: 0.58,
          borderColor: palette.card,
          borderWidth: 1.5,
        },
        emphasis: {
          scale: 1.4,
          itemStyle: { opacity: 1, color: palette.chartPrimary },
        },
      },
    ],
  }
}

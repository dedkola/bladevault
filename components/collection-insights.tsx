'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useCallback, useMemo, useState } from 'react'
import type { EChartsOption } from 'echarts'
import { Download, ImageIcon } from 'lucide-react'
import { useKnives } from '@/components/providers/knives-provider'
import {
  InsightsChart,
  type InsightsChartClick,
  type InsightsChartPalette,
} from '@/components/insights-chart'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getImageUrl, type Knife } from '@/lib/data'
import {
  collapseCategories,
  createCollectionStats,
  type CategoryKey,
  type CategoryStat,
  type MeasurementKey,
  type MeasurementStats,
} from '@/lib/collection-stats'
import { NOT_SET_FILTER_VALUE } from '@/lib/collection-filters'
import { cn } from '@/lib/utils'

const LEGEND_DOT_CLASSES = [
  'bg-[#2e3417] dark:bg-[#c89c3d]',
  'bg-[#79824a] dark:bg-[#947535]',
  'bg-[#c89c3d] dark:bg-[#79824a]',
  'bg-[#dfc78f]',
  'bg-[#eae1cf]',
]
const MEASUREMENT_KEYS: MeasurementKey[] = [
  'bladeLength',
  'overallLength',
  'weight',
  'bladeThickness',
]
const CATEGORY_QUERY_KEYS: Record<CategoryKey, string> = {
  brand: 'brand',
  bladeMaterial: 'bladeMaterial',
  bladeStyle: 'bladeStyle',
  lockingMechanism: 'lockingMechanism',
  handleMaterial: 'handleMaterial',
  designer: 'designer',
}

type Drilldown = {
  eyebrow: string
  title: string
  description: string
  knifeIds: string[]
  collectionHref?: string
}

function formatMetric(value: number | undefined, unit: string): string {
  if (value === undefined) return '—'
  const fractionDigits = unit === 'mm' ? 1 : 2
  return `${value.toLocaleString(undefined, { maximumFractionDigits: fractionDigits })} ${unit}`
}

function categoryHref(key: CategoryKey, category: CategoryStat) {
  if (category.name === 'Other') return undefined
  const params = new URLSearchParams()
  params.set(CATEGORY_QUERY_KEYS[key], category.name)
  return `/collection?${params.toString()}`
}

function getChartColors(palette: InsightsChartPalette) {
  return [
    palette.chartPrimary,
    palette.chartSecondary,
    palette.chartPrimary === '#c89c3d' ? '#79824a' : '#c89c3d',
    '#dfc78f',
    '#eae1cf',
  ]
}

function getTooltipAppearance(palette: InsightsChartPalette) {
  return {
    renderMode: 'html' as const,
    appendTo: 'body',
    confine: false,
    backgroundColor: palette.card,
    borderColor: palette.gold,
    borderWidth: 1,
    textStyle: { color: palette.foreground, fontSize: 11 },
    extraCssText:
      'z-index: 9999999; border-radius: 8px; box-shadow: 0 8px 24px rgba(46, 52, 23, 0.16); pointer-events: none;',
  }
}

function getPieEmphasis(palette: InsightsChartPalette) {
  return {
    itemStyle: {
      borderColor: palette.gold,
      borderWidth: 2,
    },
  }
}

function missingHref(key: CategoryKey | MeasurementKey) {
  const params = new URLSearchParams()
  params.set(key, NOT_SET_FILTER_VALUE)
  return `/collection?${params.toString()}`
}

function getLibraryOption(
  total: number,
  palette: InsightsChartPalette,
): EChartsOption {
  return {
    animation: false,
    series: [
      {
        type: 'gauge',
        silent: true,
        startAngle: 90,
        endAngle: -270,
        center: ['50%', '50%'],
        radius: '88%',
        pointer: { show: false },
        progress: {
          show: true,
          roundCap: true,
          width: 10,
          itemStyle: { color: '#c89c3d' },
        },
        axisLine: {
          lineStyle: { width: 10, color: [[1, palette.ringTrack]] },
        },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        title: {
          offsetCenter: [0, '27%'],
          color: palette.muted,
          fontSize: 9,
        },
        detail: {
          offsetCenter: [0, '-10%'],
          color: palette.foreground,
          fontSize: 27,
          fontWeight: 600,
          formatter: String(total),
        },
        data: [{ value: 100, name: 'knives' }],
      },
    ],
  }
}

function getMakerOption(
  categories: CategoryStat[],
  makerCount: number,
  palette: InsightsChartPalette,
): EChartsOption {
  return {
    animation: false,
    color: getChartColors(palette),
    tooltip: {
      trigger: 'item',
      formatter: '{b}: {c} ({d}%)',
      ...getTooltipAppearance(palette),
    },
    series: [
      {
        name: 'Brands',
        type: 'pie',
        radius: ['50%', '72%'],
        center: ['50%', '50%'],
        label: {
          show: true,
          position: 'center',
          formatter: `{count|${makerCount}}\n{small|makers}`,
          rich: {
            count: {
              color: palette.foreground,
              fontSize: 25,
              fontWeight: 600,
              lineHeight: 27,
            },
            small: { color: palette.muted, fontSize: 8 },
          },
        },
        labelLine: { show: false },
        emphasis: getPieEmphasis(palette),
        data: categories.map(({ name, count }) => ({ name, value: count })),
      },
    ],
  }
}

function getLockTypeOption(
  categories: CategoryStat[],
  lockTypeCount: number,
  palette: InsightsChartPalette,
): EChartsOption {
  return {
    animation: false,
    color: getChartColors(palette),
    tooltip: {
      trigger: 'item',
      formatter: '{b}: {c} knives ({d}%)',
      ...getTooltipAppearance(palette),
    },
    series: [
      {
        name: 'Lock types',
        type: 'pie',
        radius: ['50%', '72%'],
        center: ['50%', '50%'],
        label: {
          show: true,
          position: 'center',
          formatter: `{count|${lockTypeCount}}\n{small|types}`,
          rich: {
            count: {
              color: palette.foreground,
              fontSize: 25,
              fontWeight: 600,
              lineHeight: 27,
            },
            small: { color: palette.muted, fontSize: 8 },
          },
        },
        labelLine: { show: false },
        emphasis: getPieEmphasis(palette),
        data: categories.map(({ name, count }) => ({ name, value: count })),
      },
    ],
  }
}

function getBladeLengthDistributionOption(
  measurement: MeasurementStats,
  palette: InsightsChartPalette,
): EChartsOption {
  const peakCount = Math.max(0, ...measurement.bins.map(({ count }) => count))
  return {
    animation: false,
    grid: { left: 2, right: 2, top: 15, bottom: 25 },
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'shadow',
        shadowStyle: { color: palette.highlightWash },
      },
      ...getTooltipAppearance(palette),
      formatter: (params: unknown) => {
        const item = Array.isArray(params) ? params[0] : undefined
        const index =
          typeof item === 'object' && item && 'dataIndex' in item
            ? Number(item.dataIndex)
            : -1
        const bin = measurement.bins[index]
        if (!bin) return ''
        const percent =
          measurement.knownCount === 0
            ? 0
            : Math.round((bin.count / measurement.knownCount) * 100)
        return `${bin.label}: ${bin.count} ${bin.count === 1 ? 'knife' : 'knives'} (${percent}% of known lengths)`
      },
    },
    xAxis: {
      type: 'category',
      data: measurement.bins.map(({ label }) =>
        label.replace('.0', '').replace('–', '–\n'),
      ),
      axisLine: { lineStyle: { color: palette.line } },
      axisTick: { show: false },
      axisLabel: {
        color: palette.muted,
        fontSize: 7,
        interval: 0,
        lineHeight: 8,
      },
    },
    yAxis: { type: 'value', show: false, minInterval: 1 },
    series: [
      {
        type: 'bar',
        barMaxWidth: 25,
        data: measurement.bins.map(({ count }) => ({
          value: count,
          itemStyle: {
            color:
              count === peakCount
                ? palette.chartPrimary
                : palette.chartSecondary,
            borderRadius: [4, 4, 1, 1],
            opacity: count === 0 ? 0.2 : 1,
          },
        })),
        label: {
          show: true,
          position: 'top',
          color: palette.foreground,
          fontSize: 8,
          formatter: (params: unknown) => {
            const value =
              typeof params === 'object' &&
              params &&
              'value' in params &&
              typeof params.value === 'number'
                ? params.value
                : 0
            return value ? String(value) : ''
          },
        },
        emphasis: { itemStyle: { color: palette.gold } },
      },
    ],
  }
}

function getCompletenessOption(
  value: number,
  palette: InsightsChartPalette,
): EChartsOption {
  return {
    animation: false,
    series: [
      {
        type: 'gauge',
        silent: true,
        startAngle: 90,
        endAngle: -270,
        center: ['50%', '50%'],
        radius: '88%',
        pointer: { show: false },
        progress: {
          show: true,
          roundCap: true,
          width: 10,
          itemStyle: { color: palette.chartPrimary },
        },
        axisLine: {
          lineStyle: { width: 10, color: [[1, palette.ringTrack]] },
        },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        title: {
          offsetCenter: [0, '27%'],
          color: palette.muted,
          fontSize: 8,
        },
        detail: {
          offsetCenter: [0, '-10%'],
          color: palette.foreground,
          fontSize: 26,
          fontWeight: 600,
          formatter: `${value}%`,
        },
        data: [{ value, name: 'complete' }],
      },
    ],
  }
}

function getHorizontalBarOption(
  categories: CategoryStat[],
  palette: InsightsChartPalette,
): EChartsOption {
  return {
    animation: false,
    color: [palette.chartPrimary],
    grid: { left: 74, right: 62, top: 0, bottom: 0 },
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'shadow',
        shadowStyle: { color: palette.highlightWash },
      },
      ...getTooltipAppearance(palette),
      formatter: (params: unknown) => {
        const item = Array.isArray(params) ? params[0] : undefined
        const index =
          typeof item === 'object' && item && 'dataIndex' in item
            ? Number(item.dataIndex)
            : -1
        const category = categories[index]
        return category
          ? `${category.name}: ${category.count} (${category.percent}%)`
          : ''
      },
    },
    xAxis: { type: 'value', show: false, min: 0 },
    yAxis: {
      type: 'category',
      inverse: true,
      data: categories.map(({ name }) => name),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: palette.foreground,
        fontSize: 11,
        fontWeight: 600,
      },
    },
    series: [
      {
        type: 'bar',
        barMaxWidth: 10,
        data: categories.map((category) => ({
          value: category.count,
          itemStyle: {
            color: category.name === 'Other' ? '#a9aa9f' : palette.chartPrimary,
            borderRadius: 8,
          },
        })),
        label: {
          show: true,
          position: 'right',
          distance: 12,
          color: palette.muted,
          fontSize: 10,
          formatter: (params: { dataIndex?: number }) => {
            const category = categories[params.dataIndex ?? -1]
            return category ? `${category.count} · ${category.percent}%` : ''
          },
        },
        emphasis: { itemStyle: { color: palette.gold } },
      },
    ],
  }
}

function getPieOption(
  categories: CategoryStat[],
  total: number,
  palette: InsightsChartPalette,
): EChartsOption {
  return {
    animation: false,
    color: getChartColors(palette),
    tooltip: {
      trigger: 'item',
      formatter: '{b}: {c} ({d}%)',
      ...getTooltipAppearance(palette),
    },
    legend: {
      right: 0,
      top: 'middle',
      orient: 'vertical',
      icon: 'circle',
      itemWidth: 7,
      itemHeight: 7,
      itemGap: 10,
      textStyle: { color: palette.muted, fontSize: 10 },
    },
    series: [
      {
        type: 'pie',
        radius: ['48%', '72%'],
        center: ['31%', '50%'],
        label: {
          show: true,
          position: 'center',
          formatter: `{count|${total}}\n{small|knives}`,
          rich: {
            count: {
              color: palette.foreground,
              fontSize: 27,
              fontWeight: 600,
              lineHeight: 29,
            },
            small: { color: palette.muted, fontSize: 8 },
          },
        },
        labelLine: { show: false },
        emphasis: getPieEmphasis(palette),
        data: categories.map(({ name, count }) => ({ name, value: count })),
      },
    ],
  }
}

function getHistogramOption(
  measurement: MeasurementStats,
  palette: InsightsChartPalette,
): EChartsOption {
  return {
    animation: false,
    grid: { left: 12, right: 12, top: 20, bottom: 38 },
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'shadow',
        shadowStyle: { color: palette.highlightWash },
      },
      ...getTooltipAppearance(palette),
      formatter: (params: unknown) => {
        const item = Array.isArray(params) ? params[0] : undefined
        const index =
          typeof item === 'object' && item && 'dataIndex' in item
            ? Number(item.dataIndex)
            : -1
        const bin = measurement.bins[index]
        return bin ? `${bin.label}: ${bin.count} knives` : ''
      },
    },
    xAxis: {
      type: 'category',
      data: measurement.bins.map(({ label }) => label),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: palette.line } },
      axisLabel: { color: palette.muted, fontSize: 9, interval: 0 },
    },
    yAxis: { type: 'value', show: false, minInterval: 1 },
    series: [
      {
        type: 'bar',
        barMaxWidth: 62,
        data: measurement.bins.map(({ count }) => count),
        itemStyle: { color: '#c89c3d', borderRadius: [6, 6, 1, 1] },
        emphasis: { itemStyle: { color: palette.gold } },
        label: {
          show: true,
          position: 'top',
          color: palette.foreground,
          fontSize: 10,
          fontWeight: 600,
        },
      },
    ],
  }
}

function InsightPanel({
  eyebrow,
  title,
  description,
  action,
  children,
  className,
}: {
  eyebrow: string
  title: string
  description?: string
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <Card
      className={cn('gap-0 py-0 shadow-sm print:break-inside-avoid', className)}
    >
      <div className="flex items-start justify-between gap-4 px-5 pt-5">
        <div className="min-w-0">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--bladevault-title)]">
            {eyebrow}
          </span>
          <h2 className="mt-1 text-base font-semibold tracking-tight">
            {title}
          </h2>
          {description ? (
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      <CardContent className="px-5 pb-5 pt-3">{children}</CardContent>
    </Card>
  )
}

function RecentKnife({ knife }: { knife: Knife }) {
  return (
    <Link
      href={`/collection/${knife.id}`}
      className="grid grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-3 rounded-lg p-2 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="relative grid h-10 w-12 place-items-center overflow-hidden rounded-md bg-muted/70">
        {knife.images[0] ? (
          <Image
            src={getImageUrl(knife.images[0])}
            alt=""
            fill
            sizes="48px"
            className="object-contain"
            referrerPolicy="no-referrer"
          />
        ) : (
          <ImageIcon className="size-4 text-muted-foreground/60" />
        )}
      </span>
      <span className="min-w-0">
        <strong className="block truncate text-xs font-semibold">
          {knife.brand} {knife.name}
        </strong>
        <small className="block truncate text-[10px] text-muted-foreground">
          {[knife.specs.bladeMaterial, knife.bladeStyle]
            .filter(Boolean)
            .join(' · ') || 'Details not set'}
        </small>
      </span>
      <time
        className="text-[9px] text-muted-foreground"
        dateTime={knife.addedAt}
      >
        {new Date(knife.addedAt).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
        })}
      </time>
    </Link>
  )
}

export function CollectionInsights() {
  const { knives, isLoading } = useKnives()
  const [measurementKey, setMeasurementKey] =
    useState<MeasurementKey>('bladeLength')
  const [drilldown, setDrilldown] = useState<Drilldown | null>(null)
  const now = useMemo(() => new Date(), [])
  const allTimeStats = useMemo(
    () => createCollectionStats(knives, 'all', now),
    [knives, now],
  )
  const stats = allTimeStats
  const knivesById = useMemo(
    () => new Map(knives.map((knife) => [knife.id, knife])),
    [knives],
  )
  const selectedKnives = useMemo(
    () =>
      drilldown?.knifeIds
        .map((id) => knivesById.get(id))
        .filter((knife): knife is Knife => Boolean(knife)) ?? [],
    [drilldown, knivesById],
  )
  const makerCategories = useMemo(
    () => collapseCategories(stats.categories.brand, 5, stats.total),
    [stats.categories.brand, stats.total],
  )
  const steelCategories = useMemo(
    () => collapseCategories(stats.categories.bladeMaterial, 6, stats.total),
    [stats.categories.bladeMaterial, stats.total],
  )
  const shapeCategories = useMemo(
    () => collapseCategories(stats.categories.bladeStyle, 5, stats.total),
    [stats.categories.bladeStyle, stats.total],
  )
  const lockCategories = useMemo(
    () => collapseCategories(stats.categories.lockingMechanism, 5, stats.total),
    [stats.categories.lockingMechanism, stats.total],
  )
  const measurement = stats.measurements[measurementKey]
  const bladeMeasurement = allTimeStats.measurements.bladeLength
  const bladeLengthPeak = bladeMeasurement.bins.reduce(
    (peak, bin) => (bin.count > peak.count ? bin : peak),
    bladeMeasurement.bins[0],
  )
  const measurementPeak = measurement.bins.reduce(
    (peak, bin) => (bin.count > peak.count ? bin : peak),
    measurement.bins[0],
  )
  const topTwoMakerShare = stats.total
    ? Math.round(
        (makerCategories
          .slice(0, 2)
          .reduce((sum, category) => sum + category.count, 0) /
          stats.total) *
          100,
      )
    : 0
  const activityWeeks = useMemo(
    () =>
      Array.from({ length: 52 }, (_, index) =>
        stats.activity.slice(index * 7, index * 7 + 7),
      ),
    [stats.activity],
  )
  const maxActivityCount = Math.max(
    1,
    ...stats.activity.map(({ count }) => count),
  )

  const openCategory = useCallback(
    (eyebrow: string, key: CategoryKey, category: CategoryStat) => {
      setDrilldown({
        eyebrow,
        title: category.name,
        description: `${category.count} ${category.count === 1 ? 'knife' : 'knives'} · ${category.percent}% of this view`,
        knifeIds: category.knifeIds,
        collectionHref: categoryHref(key, category),
      })
    },
    [],
  )

  const openChartCategory = useCallback(
    (
      event: InsightsChartClick,
      eyebrow: string,
      key: CategoryKey,
      categories: CategoryStat[],
    ) => {
      const category = categories[event.dataIndex ?? -1]
      if (category) openCategory(eyebrow, key, category)
    },
    [openCategory],
  )

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-7xl flex-1 p-6 lg:p-8">
        <div className="h-28 animate-pulse rounded-xl bg-muted" />
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div
              key={index}
              className="h-44 animate-pulse rounded-xl bg-muted"
            />
          ))}
        </div>
      </div>
    )
  }

  if (knives.length === 0) {
    return (
      <div className="mx-auto w-full max-w-7xl flex-1 p-6 lg:p-8">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--bladevault-title)]">
          Your collection, understood
        </span>
        <h1 className="mt-2 font-serif text-4xl tracking-tight">
          Collection Insights
        </h1>
        <Card className="mt-8 border-dashed bg-muted/40">
          <CardContent className="flex flex-col items-center py-16 text-center">
            <h2 className="font-medium">No collection data yet</h2>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Add your first knife to start revealing collection patterns.
            </p>
            <Button
              className="mt-5"
              render={<Link href="/add" />}
              nativeButton={false}
            >
              Add your first knife
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-7xl flex-1 p-6 print:max-w-none print:p-0 lg:p-8">
      <header className="mb-6 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--bladevault-title)]">
            Your collection, understood
          </span>
          <h1 className="mt-2 font-serif text-4xl tracking-[-0.04em] sm:text-5xl">
            Collection Insights
          </h1>
        </div>
        <div className="print:hidden">
          <Button variant="outline" onClick={() => window.print()}>
            <Download className="size-4" /> Export
          </Button>
        </div>
      </header>

      {stats.total === 0 ? (
        <Card className="border-dashed bg-muted/40">
          <CardContent className="flex flex-col items-center py-14 text-center">
            <h2 className="font-medium">No knives in this period</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Add a knife to start building collection insights.
            </p>
            <Button
              className="mt-4"
              render={<Link href="/add" />}
              nativeButton={false}
            >
              Add a knife
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <section
            aria-label="Collection overview"
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            <Card className="min-h-44 gap-0 py-0 print:break-inside-avoid">
              <CardContent className="grid h-full grid-cols-[minmax(0,1fr)_7rem] items-center gap-2 p-4">
                <div>
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--bladevault-title)]">
                    Library
                  </span>
                  <p className="mt-4 text-xs text-muted-foreground">
                    <strong className="text-[var(--bladevault-local)]">
                      +{stats.addedThisYear}
                    </strong>{' '}
                    added in {now.getFullYear()}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {stats.pinnedCount} pinned
                  </p>
                </div>
                <InsightsChart
                  buildOption={(palette) =>
                    getLibraryOption(stats.total, palette)
                  }
                  ariaLabel={`${stats.total} knives catalogued`}
                  className="h-28 w-28"
                />
              </CardContent>
            </Card>

            <Card className="min-h-44 gap-0 py-0 print:break-inside-avoid">
              <CardContent className="grid h-full grid-cols-[minmax(0,1fr)_7rem] grid-rows-[1fr_auto] items-center gap-x-2 gap-y-1 p-4">
                <div>
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--bladevault-title)]">
                    Maker mix
                  </span>
                  <p className="mt-4 text-xs text-muted-foreground">
                    The top two hold{' '}
                    <strong className="text-foreground">
                      {topTwoMakerShare}%
                    </strong>{' '}
                    of collection
                  </p>
                </div>
                <InsightsChart
                  buildOption={(palette) =>
                    getMakerOption(
                      makerCategories,
                      stats.categories.brand.length,
                      palette,
                    )
                  }
                  ariaLabel={`${stats.categories.brand.length} makers represented`}
                  className="h-24 w-24 justify-self-end"
                  onChartClick={(event) =>
                    openChartCategory(event, 'Brand', 'brand', makerCategories)
                  }
                />
                <div
                  aria-label="Leading brands"
                  className="col-span-2 flex flex-nowrap items-center justify-between gap-1 border-t border-border/70 pt-2"
                >
                  {makerCategories.map((category, index) => (
                    <button
                      key={category.name}
                      type="button"
                      onClick={() => openCategory('Brand', 'brand', category)}
                      className="inline-flex min-w-0 items-center gap-0.5 whitespace-nowrap text-[8px] tracking-tight text-muted-foreground transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          'size-1.5 shrink-0 rounded-full',
                          LEGEND_DOT_CLASSES[index],
                        )}
                      />
                      {category.name}
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className="min-h-44 gap-0 py-0 print:break-inside-avoid">
              <CardContent className="p-4">
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--bladevault-title)]">
                  Blade lengths
                </span>
                <div className="mt-2 flex items-baseline justify-between gap-2">
                  <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Most common
                  </span>
                  <strong className="font-serif text-xl font-medium">
                    {bladeLengthPeak?.count
                      ? bladeLengthPeak.label
                      : 'Not enough data'}
                  </strong>
                </div>
                <InsightsChart
                  buildOption={(palette) =>
                    getBladeLengthDistributionOption(bladeMeasurement, palette)
                  }
                  ariaLabel={`Blade length distribution for the full collection${bladeLengthPeak?.count ? `; most common range ${bladeLengthPeak.label} with ${bladeLengthPeak.count} knives` : ''}`}
                  className="mt-1 h-20 w-full"
                />
              </CardContent>
            </Card>

            <Card className="min-h-44 gap-0 py-0 print:break-inside-avoid">
              <CardContent className="grid h-full grid-cols-[minmax(0,1fr)_7rem] items-center gap-2 p-4">
                <div>
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--bladevault-title)]">
                    Lock types
                  </span>
                  {stats.categories.lockingMechanism[0] ? (
                    <button
                      type="button"
                      onClick={() =>
                        openCategory(
                          'Locking mechanism',
                          'lockingMechanism',
                          stats.categories.lockingMechanism[0],
                        )
                      }
                      className="mt-4 block text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <strong className="block truncate text-sm text-foreground">
                        {stats.categories.lockingMechanism[0].name}
                      </strong>
                      {stats.categories.lockingMechanism[0].count} knives ·{' '}
                      {stats.categories.lockingMechanism[0].percent}%
                    </button>
                  ) : (
                    <p className="mt-4 text-xs text-muted-foreground">
                      No lock types recorded
                    </p>
                  )}
                </div>
                <InsightsChart
                  buildOption={(palette) =>
                    getLockTypeOption(
                      lockCategories,
                      stats.categories.lockingMechanism.length,
                      palette,
                    )
                  }
                  ariaLabel={`${stats.categories.lockingMechanism.length} lock types represented`}
                  className="h-28 w-28"
                  onChartClick={(event) =>
                    openChartCategory(
                      event,
                      'Locking mechanism',
                      'lockingMechanism',
                      lockCategories,
                    )
                  }
                />
              </CardContent>
            </Card>
          </section>

          <section className="mt-3 grid grid-cols-12 gap-3">
            <InsightPanel
              eyebrow="Materials"
              title="Blade steel mix"
              description={
                steelCategories[0]
                  ? `${steelCategories[0].name} is your most represented steel · ${steelCategories[0].percent}% of the collection`
                  : 'No blade steels recorded'
              }
              action={
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() =>
                    setDrilldown({
                      eyebrow: 'Blade material',
                      title: 'All steels',
                      description: `${stats.categories.bladeMaterial.length} steels represented`,
                      knifeIds: stats.categories.bladeMaterial.flatMap(
                        ({ knifeIds }) => knifeIds,
                      ),
                    })
                  }
                >
                  View all
                </Button>
              }
              className="col-span-12 lg:col-span-7"
            >
              <InsightsChart
                buildOption={(palette) =>
                  getHorizontalBarOption(steelCategories, palette)
                }
                ariaLabel="Blade steel distribution"
                className="h-48 w-full"
                onChartClick={(event) =>
                  openChartCategory(
                    event,
                    'Blade material',
                    'bladeMaterial',
                    steelCategories,
                  )
                }
              />
            </InsightPanel>

            <InsightPanel
              eyebrow="Profiles"
              title="Blade shapes"
              description={`${stats.categories.bladeStyle.length} distinct profiles represented`}
              className="col-span-12 lg:col-span-5"
            >
              <InsightsChart
                buildOption={(palette) =>
                  getPieOption(shapeCategories, stats.total, palette)
                }
                ariaLabel="Blade shape distribution"
                className="h-48 w-full"
                onChartClick={(event) =>
                  openChartCategory(
                    event,
                    'Blade style',
                    'bladeStyle',
                    shapeCategories,
                  )
                }
              />
              {stats.categories.lockingMechanism[0] ? (
                <button
                  type="button"
                  onClick={() =>
                    openCategory(
                      'Locking mechanism',
                      'lockingMechanism',
                      stats.categories.lockingMechanism[0],
                    )
                  }
                  className="mt-2 flex w-full items-center justify-between rounded-lg bg-muted px-3 py-2 text-left text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="text-muted-foreground">
                    Most common lock
                    <strong className="block text-foreground">
                      {stats.categories.lockingMechanism[0].name}
                    </strong>
                  </span>
                  <strong>
                    {stats.categories.lockingMechanism[0].count} knives →
                  </strong>
                </button>
              ) : null}
            </InsightPanel>

            <InsightPanel
              eyebrow="Dimensions"
              title={`${measurement.label} distribution`}
              description={`Known values for ${measurement.knownCount} of ${stats.total} knives`}
              action={
                <Tabs
                  value={measurementKey}
                  onValueChange={(value) =>
                    setMeasurementKey(value as MeasurementKey)
                  }
                >
                  <TabsList className="h-8">
                    {MEASUREMENT_KEYS.map((key) => (
                      <TabsTrigger
                        key={key}
                        value={key}
                        className="text-[10px] data-active:bg-[var(--bladevault-gold)] data-active:text-[var(--bladevault-olive)] dark:data-active:border-[var(--bladevault-gold)] dark:data-active:bg-[var(--bladevault-gold)] dark:data-active:text-[var(--bladevault-olive)]"
                      >
                        {key === 'bladeLength'
                          ? 'Blade'
                          : key === 'overallLength'
                            ? 'Overall'
                            : key === 'bladeThickness'
                              ? 'Thickness'
                              : 'Weight'}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              }
              className="col-span-12 lg:col-span-7"
            >
              <InsightsChart
                buildOption={(palette) =>
                  getHistogramOption(measurement, palette)
                }
                ariaLabel={`${measurement.label} distribution`}
                className="h-48 w-full"
                onChartClick={(event) => {
                  const bin = measurement.bins[event.dataIndex ?? -1]
                  if (!bin) return
                  setDrilldown({
                    eyebrow: measurement.label,
                    title: bin.label,
                    description: `${bin.count} ${bin.count === 1 ? 'knife' : 'knives'} in this range`,
                    knifeIds: bin.knifeIds,
                  })
                }}
              />
              <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
                <span>
                  Most common{' '}
                  <strong className="text-foreground">
                    {measurementPeak?.count
                      ? `${measurementPeak.label} · ${measurementPeak.count}`
                      : '—'}
                  </strong>
                </span>
                <span>
                  Range{' '}
                  <strong className="text-foreground">
                    {formatMetric(measurement.min, measurement.unit)}–
                    {formatMetric(measurement.max, measurement.unit)}
                  </strong>
                </span>
              </div>
            </InsightPanel>

            <InsightPanel
              eyebrow="Collection health"
              title="Data completeness"
              className="col-span-12 lg:col-span-5"
            >
              <InsightsChart
                buildOption={(palette) =>
                  getCompletenessOption(stats.completeness, palette)
                }
                ariaLabel={`${stats.completeness}% complete`}
                className="mx-auto h-40 w-40"
              />
              <div className="mt-2 grid gap-1.5">
                {stats.missingFields.slice(0, 3).map((field) => (
                  <button
                    key={field.key}
                    type="button"
                    onClick={() =>
                      setDrilldown({
                        eyebrow: 'Missing field',
                        title: field.label,
                        description: `${field.count} ${field.count === 1 ? 'knife needs' : 'knives need'} this detail`,
                        knifeIds: field.knifeIds,
                        collectionHref: missingHref(field.key),
                      })
                    }
                    className="flex items-center justify-between rounded-md bg-muted px-3 py-2 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span>{field.label} missing</span>
                    <strong>{field.count}</strong>
                  </button>
                ))}
              </div>
            </InsightPanel>

            <InsightPanel
              eyebrow="Brands"
              title="Maker mix"
              className="col-span-12 md:col-span-4"
            >
              <div className="divide-y divide-border/70">
                {collapseCategories(stats.categories.brand, 5, stats.total).map(
                  (category, index) => (
                    <button
                      key={category.name}
                      type="button"
                      onClick={() => openCategory('Brand', 'brand', category)}
                      className="grid w-full grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-1 py-2.5 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="font-serif text-muted-foreground">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <strong className="truncate">{category.name}</strong>
                      <span className="text-[10px] text-muted-foreground">
                        {category.count} · {category.percent}%
                      </span>
                    </button>
                  ),
                )}
              </div>
            </InsightPanel>

            <InsightPanel
              eyebrow="Construction"
              title="Handle materials"
              description={`${stats.categories.handleMaterial.length} materials represented`}
              className="col-span-12 md:col-span-4"
            >
              <div className="flex flex-wrap gap-2">
                {collapseCategories(
                  stats.categories.handleMaterial,
                  7,
                  stats.total,
                ).map((category) => (
                  <button
                    key={category.name}
                    type="button"
                    onClick={() =>
                      openCategory(
                        'Handle material',
                        'handleMaterial',
                        category,
                      )
                    }
                    className="rounded-full border border-[var(--bladevault-line)] px-3 py-1.5 text-[10px] font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {category.name}{' '}
                    <span className="text-[var(--bladevault-title)]">
                      {category.count}
                    </span>
                  </button>
                ))}
              </div>
              <div className="mt-5 border-t border-border pt-4">
                <span className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                  Lock types
                </span>
                <div className="mt-2 flex flex-wrap gap-2">
                  {collapseCategories(
                    stats.categories.lockingMechanism,
                    5,
                    stats.total,
                  ).map((category) => (
                    <button
                      key={category.name}
                      type="button"
                      onClick={() =>
                        openCategory(
                          'Locking mechanism',
                          'lockingMechanism',
                          category,
                        )
                      }
                      className="rounded-full border border-[var(--bladevault-line)] px-3 py-1.5 text-[10px] font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {category.name}{' '}
                      <span className="text-[var(--bladevault-title)]">
                        {category.count}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </InsightPanel>

            <InsightPanel
              eyebrow="People"
              title="Designers"
              className="col-span-12 md:col-span-4"
            >
              <div className="divide-y divide-border/70">
                {collapseCategories(
                  stats.categories.designer,
                  5,
                  stats.total,
                ).map((category, index) => (
                  <button
                    key={category.name}
                    type="button"
                    onClick={() =>
                      openCategory('Designer', 'designer', category)
                    }
                    className="grid w-full grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-1 py-2.5 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="font-serif text-muted-foreground">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <strong className="truncate">{category.name}</strong>
                    <span className="text-[10px] text-muted-foreground">
                      {category.count}
                    </span>
                  </button>
                ))}
              </div>
              {stats.missingFields.find(({ key }) => key === 'designer') ? (
                <button
                  type="button"
                  onClick={() => {
                    const missing = stats.missingFields.find(
                      ({ key }) => key === 'designer',
                    )
                    if (!missing) return
                    setDrilldown({
                      eyebrow: 'Missing field',
                      title: 'Designer not set',
                      description: `${missing.count} knives need this detail`,
                      knifeIds: missing.knifeIds,
                      collectionHref: missingHref('designer'),
                    })
                  }}
                  className="mt-2 flex w-full justify-between rounded-md px-1 py-2 text-xs text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span>— &nbsp; Not set</span>
                  <strong>
                    {
                      stats.missingFields.find(({ key }) => key === 'designer')
                        ?.count
                    }
                  </strong>
                </button>
              ) : null}
            </InsightPanel>

            <InsightPanel
              eyebrow="Activity"
              title="Collection growth"
              description={`${stats.additionsInActivityRange} additions across ${stats.activeDays} active days · darker squares mean more knives added`}
              className="col-span-12 lg:col-span-8"
            >
              <div className="overflow-x-auto pb-2">
                <div className="min-w-[42rem]">
                  <div className="ml-8 grid grid-cols-[repeat(52,minmax(0,1fr))] gap-[3px] text-[8px] text-muted-foreground">
                    {activityWeeks.map((week, index) => {
                      const month = week[0]?.date.getMonth()
                      const previousMonth =
                        activityWeeks[index - 1]?.[0]?.date.getMonth()
                      return (
                        <span key={week[0]?.dateKey}>
                          {index === 0 || month !== previousMonth
                            ? week[0]?.date.toLocaleDateString(undefined, {
                                month: 'short',
                              })
                            : ''}
                        </span>
                      )
                    })}
                  </div>
                  <div className="mt-2 grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2">
                    <div className="grid grid-rows-7 gap-[3px] text-[8px] leading-[11px] text-muted-foreground">
                      <span>Mon</span>
                      <span />
                      <span>Wed</span>
                      <span />
                      <span>Fri</span>
                      <span />
                      <span>Sun</span>
                    </div>
                    <div className="flex gap-[3px]">
                      {activityWeeks.map((week) => (
                        <div
                          key={week[0]?.dateKey}
                          className="grid flex-1 grid-rows-7 gap-[3px]"
                        >
                          {week.map((day) => {
                            const level =
                              day.count === 0
                                ? 0
                                : Math.max(
                                    1,
                                    Math.ceil(
                                      (day.count / maxActivityCount) * 4,
                                    ),
                                  )
                            return day.count === 0 ? (
                              <span
                                key={day.dateKey}
                                className="h-[11px] min-w-[10px] rounded-[2px] bg-muted"
                                aria-hidden="true"
                              />
                            ) : (
                              <button
                                key={day.dateKey}
                                type="button"
                                title={`${day.count} ${day.count === 1 ? 'knife' : 'knives'} added on ${day.date.toLocaleDateString()}`}
                                aria-label={`${day.count} ${day.count === 1 ? 'knife' : 'knives'} added on ${day.date.toLocaleDateString()}`}
                                onClick={() =>
                                  setDrilldown({
                                    eyebrow: 'Added date',
                                    title: day.date.toLocaleDateString(
                                      undefined,
                                      {
                                        dateStyle: 'medium',
                                      },
                                    ),
                                    description: `${day.count} ${day.count === 1 ? 'knife was' : 'knives were'} added`,
                                    knifeIds: day.knifeIds,
                                  })
                                }
                                className={cn(
                                  'h-[11px] min-w-[10px] rounded-[2px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                  level === 1 &&
                                    'bg-[#b7bd86] dark:bg-[#66552c]',
                                  level === 2 &&
                                    'bg-[#79824a] dark:bg-[#947535]',
                                  level === 3 &&
                                    'bg-[#4f5821] dark:bg-[#b78d36]',
                                  level === 4 &&
                                    'bg-[#2e3417] dark:bg-[#c89c3d]',
                                )}
                              />
                            )
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-[9px] text-muted-foreground">
                <span>Last 52 weeks</span>
                <span className="flex items-center gap-1">
                  Less
                  <i className="size-2.5 rounded-[2px] bg-muted" />
                  <i className="size-2.5 rounded-[2px] bg-[#b7bd86] dark:bg-[#66552c]" />
                  <i className="size-2.5 rounded-[2px] bg-[#79824a] dark:bg-[#947535]" />
                  <i className="size-2.5 rounded-[2px] bg-[#4f5821] dark:bg-[#b78d36]" />
                  <i className="size-2.5 rounded-[2px] bg-[#2e3417] dark:bg-[#c89c3d]" />
                  More
                </span>
              </div>
            </InsightPanel>

            <InsightPanel
              eyebrow="Latest"
              title="Recently added"
              description="Kept compact so insights stay primary"
              action={
                <Button
                  variant="ghost"
                  size="xs"
                  render={<Link href="/collection" />}
                  nativeButton={false}
                >
                  Collection
                </Button>
              }
              className="col-span-12 lg:col-span-4"
            >
              <div className="grid gap-1">
                {stats.recent.map((knife) => (
                  <RecentKnife key={knife.id} knife={knife} />
                ))}
              </div>
            </InsightPanel>
          </section>
        </>
      )}

      <Dialog
        open={Boolean(drilldown)}
        onOpenChange={(open) => !open && setDrilldown(null)}
      >
        <DialogContent className="top-0 right-0 bottom-0 left-auto flex h-dvh max-h-dvh w-full max-w-md translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 data-open:slide-in-from-right-4 data-open:zoom-in-100 data-closed:slide-out-to-right-4 data-closed:zoom-out-100 sm:max-w-md">
          <DialogHeader className="border-b p-5 pr-14">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--bladevault-title)]">
              {drilldown?.eyebrow}
            </span>
            <DialogTitle className="font-serif text-2xl">
              {drilldown?.title}
            </DialogTitle>
            <DialogDescription>{drilldown?.description}</DialogDescription>
          </DialogHeader>
          <div className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto p-4">
            {selectedKnives.map((knife) => (
              <Link
                key={knife.id}
                href={`/collection/${knife.id}`}
                className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-3 rounded-lg border border-border bg-card p-2 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="relative grid h-14 w-16 place-items-center overflow-hidden rounded-md bg-muted">
                  {knife.images[0] ? (
                    <Image
                      src={getImageUrl(knife.images[0])}
                      alt=""
                      fill
                      sizes="64px"
                      className="object-contain"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <ImageIcon className="size-5 text-muted-foreground/60" />
                  )}
                </span>
                <span className="min-w-0">
                  <strong className="block truncate text-sm">
                    {knife.brand} {knife.name}
                  </strong>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[knife.specs.bladeMaterial, knife.bladeStyle]
                      .filter(Boolean)
                      .join(' · ') || 'Details not set'}
                  </span>
                </span>
              </Link>
            ))}
          </div>
          {drilldown?.collectionHref ? (
            <DialogFooter className="m-0 rounded-none p-4">
              <Button
                className="w-full"
                render={<Link href={drilldown.collectionHref} />}
                nativeButton={false}
              >
                Open filtered collection
              </Button>
            </DialogFooter>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}

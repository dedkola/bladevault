'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EChartsOption } from 'echarts'
import { ImageIcon } from 'lucide-react'
import { useKnives } from '@/components/providers/knives-provider'
import {
  InsightsChart,
  type InsightsChartClick,
  type InsightsChartPalette,
} from '@/components/insights-chart'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/page-header'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { readJsonResponse } from '@/lib/api-response'
import { getImageUrl, type Knife, type KnifeActivityEvent } from '@/lib/data'
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
import { getMaintenanceRecency } from '@/lib/maintenance-recency'

const LEGEND_DOT_CLASSES = [
  'bg-[#2e3417] dark:bg-[#c89c3d]',
  'bg-[#79824a] dark:bg-[#947535]',
  'bg-[#c89c3d] dark:bg-[#79824a]',
  'bg-[#dfc78f]',
  'bg-[#eae1cf]',
]
export const MEASUREMENT_KEYS: MeasurementKey[] = [
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
  groups?: Array<{
    label: 'Added' | 'Edited' | 'Maintained'
    knifeIds: string[]
  }>
  collectionHref?: string
  categories?: CategoryStat[]
  categoryKey?: CategoryKey
}

export function formatMetric(value: number | undefined, unit: string): string {
  if (value === undefined) return '—'
  const fractionDigits = unit === 'mm' ? 1 : 2
  return `${value.toLocaleString(undefined, { maximumFractionDigits: fractionDigits })} ${unit}`
}

function formatMeasurementAxisLabel(label: string): string {
  return label.replace(/\.0(?=–|″|\s)/g, '')
}

export function getOrdinalDay(day: number): string {
  const lastTwoDigits = day % 100
  if (lastTwoDigits >= 11 && lastTwoDigits <= 13) return `${day}th`
  if (day % 10 === 1) return `${day}st`
  if (day % 10 === 2) return `${day}nd`
  if (day % 10 === 3) return `${day}rd`
  return `${day}th`
}

export function formatActivityCounts(
  addedCount: number,
  editedCount: number,
  maintainedCount = 0,
): string {
  const parts: string[] = []
  if (addedCount > 0) {
    parts.push(`${addedCount} ${addedCount === 1 ? 'knife' : 'knives'} added`)
  }
  if (editedCount > 0) {
    parts.push(
      `${editedCount} ${editedCount === 1 ? 'knife' : 'knives'} edited`,
    )
  }
  if (maintainedCount > 0) {
    parts.push(
      `${maintainedCount} ${maintainedCount === 1 ? 'knife' : 'knives'} maintained`,
    )
  }
  return parts.join(' · ')
}

export function formatActivityDayLabel(
  date: Date,
  addedCount: number,
  editedCount: number,
  maintainedCount = 0,
): string {
  const formattedDate = `${date.toLocaleDateString(undefined, {
    month: 'long',
  })} ${getOrdinalDay(date.getDate())}`
  const counts = formatActivityCounts(addedCount, editedCount, maintainedCount)
  if (!counts)
    return `No knives added, edited, or maintained on ${formattedDate}.`
  return `${counts} on ${formattedDate}.`
}

export function categoryHref(key: CategoryKey, category: CategoryStat) {
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
    renderMode: 'richText' as const,
    confine: true,
    backgroundColor: palette.card,
    borderColor: palette.gold,
    borderWidth: 1,
    textStyle: { color: palette.foreground, fontSize: 11 },
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

export function missingHref(key: CategoryKey | MeasurementKey) {
  const params = new URLSearchParams()
  params.set(key, NOT_SET_FILTER_VALUE)
  return `/collection?${params.toString()}`
}

export function getLibraryOption(
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

export function getCompletenessOption(
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

export function getHorizontalBarOption(
  categories: CategoryStat[],
  palette: InsightsChartPalette,
): EChartsOption {
  const colors = getChartColors(palette)
  return {
    animation: false,
    color: colors,
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
        data: categories.map((category, index) => ({
          value: category.count,
          itemStyle: {
            color:
              category.name === 'Other'
                ? '#a9aa9f'
                : colors[index % colors.length],
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
    series: [
      {
        type: 'pie',
        radius: ['48%', '72%'],
        center: ['50%', '50%'],
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

export function getHistogramOption(
  measurement: MeasurementStats,
  palette: InsightsChartPalette,
): EChartsOption {
  const peakCount = Math.max(0, ...measurement.bins.map(({ count }) => count))
  return {
    animation: false,
    grid: { left: 12, right: 12, top: 20, bottom: 48 },
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
      data: measurement.bins.map(({ label }) =>
        formatMeasurementAxisLabel(label).replace('–', '–\n'),
      ),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: palette.line } },
      axisLabel: {
        color: palette.muted,
        fontSize: 11,
        interval: 0,
        lineHeight: 13,
      },
    },
    yAxis: { type: 'value', show: false, minInterval: 1 },
    series: [
      {
        type: 'bar',
        barMaxWidth: 62,
        data: measurement.bins.map(({ count }) => ({
          value: count,
          itemStyle: {
            color:
              count === peakCount
                ? palette.chartPrimary
                : palette.chartSecondary,
            borderRadius: [6, 6, 1, 1],
          },
        })),
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
  detailHref,
}: {
  eyebrow: string
  title: string
  description?: string
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
  detailHref?: string
}) {
  return (
    <Card
      className={cn('gap-0 py-0 shadow-sm print:break-inside-avoid', className)}
    >
      <div className="flex flex-col items-start justify-between gap-3 px-5 pt-5 sm:flex-row sm:gap-4">
        <div className="min-w-0">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--bladevault-title)]">
            {eyebrow}
          </span>
          <h2 className="mt-1 text-base font-semibold tracking-tight">
            {detailHref ? (
              <Link
                href={detailHref}
                className="rounded-sm transition-colors hover:text-[var(--bladevault-local)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {title}
              </Link>
            ) : (
              title
            )}
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

function CategoryRows({
  categories,
  onSelect,
  label,
  showColors = true,
  neutralOther = false,
}: {
  categories: CategoryStat[]
  onSelect: (category: CategoryStat) => void
  label: string
  showColors?: boolean
  neutralOther?: boolean
}) {
  return (
    <div aria-label={label} className="grid min-w-0 gap-0.5">
      {categories.map((category, index) => (
        <button
          key={category.name}
          type="button"
          onClick={() => onSelect(category)}
          className="flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {showColors && (
            <span
              aria-hidden="true"
              className={cn(
                'size-2 shrink-0 rounded-full',
                neutralOther && category.name === 'Other'
                  ? 'bg-[#a9aa9f]'
                  : LEGEND_DOT_CLASSES[index % LEGEND_DOT_CLASSES.length],
              )}
            />
          )}
          <span className="min-w-0 flex-1 break-words">{category.name}</span>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {category.count} · {category.percent}%
          </span>
        </button>
      ))}
    </div>
  )
}

function MeasurementRows({
  measurement,
  onSelect,
}: {
  measurement: MeasurementStats
  onSelect: (bin: MeasurementStats['bins'][number]) => void
}) {
  return (
    <details className="mt-3 text-xs">
      <summary className="w-fit cursor-pointer rounded-sm py-1 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        View data<span className="sr-only">: {measurement.label}</span>
      </summary>
      <div
        aria-label={`${measurement.label} ranges`}
        className="mt-2 grid gap-1 sm:grid-cols-2"
      >
        {measurement.bins.map((bin) => (
          <button
            key={bin.label}
            type="button"
            disabled={!bin.count}
            onClick={() => onSelect(bin)}
            className="flex min-h-9 items-center justify-between gap-3 rounded-md bg-muted px-3 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <span>{bin.label}</span>
            <span className="tabular-nums">
              {bin.count} ·{' '}
              {measurement.knownCount
                ? Math.round((bin.count / measurement.knownCount) * 100)
                : 0}
              %
            </span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-muted-foreground">
        Percentages use {measurement.knownCount} known values;{' '}
        {measurement.missingCount} missing.
      </p>
    </details>
  )
}

export function RecentKnife({ knife }: { knife: Knife }) {
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

export function DrilldownKnife({ knife }: { knife: Knife }) {
  return (
    <Link
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
  )
}

export function CollectionInsights() {
  const { knives, isLoading } = useKnives()
  const [activity, setActivity] = useState<KnifeActivityEvent[]>()
  const [isActivityLoaded, setIsActivityLoaded] = useState(false)
  const [measurementKey, setMeasurementKey] =
    useState<MeasurementKey>('bladeLength')
  const [drilldown, setDrilldown] = useState<Drilldown | null>(null)
  const [now, setNow] = useState(() => new Date())
  const printRequestedRef = useRef(false)

  useEffect(() => {
    let midnightTimeout: number | undefined

    function scheduleNextLocalDay() {
      if (midnightTimeout !== undefined) {
        window.clearTimeout(midnightTimeout)
      }
      const currentTime = new Date()
      const nextLocalDay = new Date(currentTime)
      nextLocalDay.setHours(24, 0, 1, 0)
      midnightTimeout = window.setTimeout(
        refreshCurrentDate,
        Math.max(1_000, nextLocalDay.getTime() - currentTime.getTime()),
      )
    }

    function refreshCurrentDate() {
      setNow(new Date())
      scheduleNextLocalDay()
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        refreshCurrentDate()
      }
    }

    scheduleNextLocalDay()
    window.addEventListener('focus', refreshCurrentDate)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      if (midnightTimeout !== undefined) {
        window.clearTimeout(midnightTimeout)
      }
      window.removeEventListener('focus', refreshCurrentDate)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadActivity() {
      try {
        const response = await fetch('/api/activity', { cache: 'no-store' })
        const data = await readJsonResponse<{
          activity?: KnifeActivityEvent[]
        }>(response)
        if (!cancelled && response.ok && Array.isArray(data.activity)) {
          setActivity(data.activity)
        }
      } catch {
        // Keep the additions-only fallback if activity history cannot load.
      } finally {
        if (!cancelled) {
          setIsActivityLoaded(true)
        }
      }
    }

    void loadActivity()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (
      isLoading ||
      !isActivityLoaded ||
      printRequestedRef.current ||
      new URLSearchParams(window.location.search).get('print') !== '1'
    ) {
      return
    }

    let printTimeout: number | undefined
    const animationFrame = window.requestAnimationFrame(() => {
      printTimeout = window.setTimeout(() => {
        if (printRequestedRef.current) return
        printRequestedRef.current = true

        const url = new URL(window.location.href)
        url.searchParams.delete('print')
        window.history.replaceState(
          window.history.state,
          '',
          `${url.pathname}${url.search}${url.hash}`,
        )
        window.print()
      }, 150)
    })

    return () => {
      window.cancelAnimationFrame(animationFrame)
      if (printTimeout !== undefined) {
        window.clearTimeout(printTimeout)
      }
    }
  }, [isActivityLoaded, isLoading])

  const allTimeStats = useMemo(
    () => createCollectionStats(knives, 'all', now, activity),
    [activity, knives, now],
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
  const selectedGroups = useMemo(
    () =>
      drilldown?.groups
        ?.map((group) => ({
          ...group,
          knives: group.knifeIds
            .map((id) => knivesById.get(id))
            .filter((knife): knife is Knife => Boolean(knife)),
        }))
        .filter(({ knives }) => knives.length > 0),
    [drilldown, knivesById],
  )
  const libraryMonths = useMemo(
    () =>
      Array.from({ length: 6 }, (_, index) => {
        const start = new Date(now.getFullYear(), now.getMonth() - 5 + index, 1)
        const end = new Date(start.getFullYear(), start.getMonth() + 1, 1)
        return {
          key: `${start.getFullYear()}-${start.getMonth()}`,
          label: start.toLocaleDateString(undefined, { month: 'short' }),
          title: start.toLocaleDateString(undefined, {
            month: 'long',
            year: 'numeric',
          }),
          knifeIds: knives
            .filter((knife) => {
              const added = new Date(knife.addedAt)
              return added >= start && added < end && added <= now
            })
            .map((knife) => knife.id),
        }
      }),
    [knives, now],
  )
  const mostMonthlyAdditions = Math.max(
    1,
    ...libraryMonths.map((month) => month.knifeIds.length),
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
  const maintenanceGroups = useMemo(
    () => (activity ? getMaintenanceRecency(knives, activity, now) : undefined),
    [knives, activity, now],
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
      if (category.name === 'Other') {
        const ids = new Set(category.knifeIds)
        setDrilldown({
          eyebrow,
          title: 'Other',
          description: `${category.count} knives · choose a category to view its knives`,
          knifeIds: [],
          categoryKey: key,
          categories: stats.categories[key].filter((item) =>
            item.knifeIds.some((id) => ids.has(id)),
          ),
        })
        return
      }
      setDrilldown({
        eyebrow,
        title: category.name,
        description: `${category.count} ${category.count === 1 ? 'knife' : 'knives'} · ${category.percent}% of this view`,
        knifeIds: category.knifeIds,
        collectionHref: categoryHref(key, category),
      })
    },
    [stats.categories],
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

  const openMeasurementBin = useCallback(
    (
      selectedMeasurement: MeasurementStats,
      bin: MeasurementStats['bins'][number] | undefined,
    ) => {
      if (!bin?.count) return
      setDrilldown({
        eyebrow: selectedMeasurement.label,
        title: bin.label,
        description: `${bin.count} ${bin.count === 1 ? 'knife' : 'knives'} in this range`,
        knifeIds: bin.knifeIds,
      })
    },
    [],
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
        <PageHeader title="Collection Insights" />
        <Card className="border-dashed bg-muted/40">
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
      <PageHeader title="Collection Insights" />

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
              <CardContent className="flex h-full flex-col p-4">
                <Link
                  href="/insights/library"
                  className="w-fit text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--bladevault-title)] hover:text-[var(--bladevault-local)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Library
                </Link>
                <Link
                  href="/collection"
                  className="mt-3 flex w-fit items-baseline gap-2 rounded-sm hover:text-[var(--bladevault-title)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <strong className="text-4xl font-semibold tracking-tight tabular-nums">
                    {stats.total}
                  </strong>
                  <span className="text-xs text-muted-foreground">
                    knives catalogued
                  </span>
                </Link>
                <div className="mt-4 grid grid-cols-3 gap-2 border-y border-border/70 py-3 text-xs">
                  <div>
                    <strong className="block text-base tabular-nums">
                      +{libraryMonths[5].knifeIds.length}
                    </strong>
                    <span className="text-[10px] text-muted-foreground">
                      This month
                    </span>
                  </div>
                  <div>
                    <strong className="block text-base tabular-nums">
                      +{stats.addedThisYear}
                    </strong>
                    <span className="text-[10px] text-muted-foreground">
                      In {now.getFullYear()}
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={!stats.pinnedCount}
                    onClick={() =>
                      setDrilldown({
                        eyebrow: 'Library',
                        title: 'Pinned knives',
                        description: `${stats.pinnedCount} pinned knives`,
                        knifeIds: knives
                          .filter((knife) => knife.pinned)
                          .map((knife) => knife.id),
                      })
                    }
                    className="rounded-sm text-left hover:text-[var(--bladevault-title)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
                  >
                    <strong className="block text-base tabular-nums">
                      {stats.pinnedCount}
                    </strong>
                    <span className="text-[10px] text-muted-foreground">
                      Pinned →
                    </span>
                  </button>
                </div>
                <div className="mt-auto pt-3">
                  <p className="text-[10px] text-muted-foreground">
                    Added by month · last 6 months
                  </p>
                  <div
                    aria-label="Monthly library additions"
                    className="mt-2 grid grid-cols-6 gap-2"
                  >
                    {libraryMonths.map((month, index) => (
                      <button
                        key={month.key}
                        type="button"
                        disabled={!month.knifeIds.length}
                        aria-label={`${month.title}: ${month.knifeIds.length} knives added`}
                        onClick={() =>
                          setDrilldown({
                            eyebrow: 'Added to library',
                            title: month.title,
                            description: `${month.knifeIds.length} knives added`,
                            knifeIds: month.knifeIds,
                          })
                        }
                        className="group flex min-w-0 flex-col items-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                      >
                        <span className="text-[10px] tabular-nums">
                          {month.knifeIds.length}
                        </span>
                        <span
                          aria-hidden="true"
                          className="mt-1 flex h-12 w-full items-end"
                        >
                          <span
                            style={{
                              height: `${Math.max(3, (month.knifeIds.length / mostMonthlyAdditions) * 100)}%`,
                            }}
                            className={cn(
                              'w-full rounded-t-sm transition-colors group-hover:bg-[var(--bladevault-gold)]',
                              month.knifeIds.length === 0
                                ? 'bg-muted'
                                : index === 5
                                  ? 'bg-[#2e3417] dark:bg-[#c89c3d]'
                                  : 'bg-[#79824a] dark:bg-[#947535]',
                            )}
                          />
                        </span>
                        <span className="mt-1 text-[10px] text-muted-foreground">
                          {month.label}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="min-h-44 gap-0 py-0 print:break-inside-avoid">
              <CardContent className="grid h-full grid-cols-[minmax(0,1fr)_7rem] grid-rows-[1fr_auto] items-center gap-x-2 gap-y-1 p-4">
                <div>
                  <Link
                    href="/insights/makers"
                    className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--bladevault-title)] transition-colors hover:text-[var(--bladevault-local)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Maker mix
                  </Link>
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
                  className="h-24 w-24 cursor-pointer justify-self-end"
                  onChartClick={(event) =>
                    openChartCategory(event, 'Brand', 'brand', makerCategories)
                  }
                />
                <div className="col-span-2 border-t border-border/70 pt-2">
                  <CategoryRows
                    categories={makerCategories}
                    label="Leading brands"
                    onSelect={(category) =>
                      openCategory('Brand', 'brand', category)
                    }
                  />
                </div>
              </CardContent>
            </Card>

            <Card className="min-h-44 gap-0 py-0 print:break-inside-avoid">
              <CardContent className="flex h-full flex-col p-4">
                <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--bladevault-title)]">
                  Maintenance
                </h2>
                <p className="mt-3 text-sm font-semibold">Last recorded care</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Knives by most recent maintenance
                </p>
                {!isActivityLoaded ? (
                  <p
                    role="status"
                    className="mt-4 text-xs text-muted-foreground"
                  >
                    Loading maintenance history…
                  </p>
                ) : !maintenanceGroups ? (
                  <p
                    role="status"
                    className="mt-4 text-xs text-muted-foreground"
                  >
                    Maintenance history unavailable. Reload to try again.
                  </p>
                ) : (
                  <div
                    aria-label="Maintenance recency"
                    className="mt-3 grid gap-1"
                  >
                    {maintenanceGroups.map((group, index) => (
                      <button
                        key={group.label}
                        type="button"
                        disabled={!group.count}
                        onClick={() =>
                          setDrilldown({
                            eyebrow: 'Last recorded care',
                            title: group.label,
                            description: `${group.count} ${group.count === 1 ? 'knife' : 'knives'} · ${group.percent}% of collection`,
                            knifeIds: group.knifeIds,
                          })
                        }
                        className="group rounded-md px-1 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
                      >
                        <span className="flex items-start justify-between gap-2 text-xs">
                          <span>{group.label}</span>
                          <span className="shrink-0 tabular-nums text-muted-foreground">
                            {group.count} · {group.percent}%
                          </span>
                        </span>
                        <span
                          aria-hidden="true"
                          className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-muted"
                        >
                          <span
                            style={{ width: `${group.percent}%` }}
                            className={cn(
                              'block h-full rounded-full',
                              [
                                'bg-[#2e3417] dark:bg-[#c89c3d]',
                                'bg-[#79824a] dark:bg-[#947535]',
                                'bg-[#c89c3d] dark:bg-[#dfc78f]',
                                'bg-[#a9aa9f]',
                              ][index],
                            )}
                          />
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="min-h-44 gap-0 py-0 print:break-inside-avoid">
              <CardContent className="grid h-full grid-cols-[minmax(0,1fr)_7rem] items-center gap-2 p-4">
                <div>
                  <Link
                    href="/insights/locks"
                    className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--bladevault-title)] transition-colors hover:text-[var(--bladevault-local)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Lock types
                  </Link>
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
                  className="h-28 w-28 cursor-pointer"
                  onChartClick={(event) =>
                    openChartCategory(
                      event,
                      'Locking mechanism',
                      'lockingMechanism',
                      lockCategories,
                    )
                  }
                />
                <div className="col-span-2 w-full border-t border-border/70 pt-2">
                  <CategoryRows
                    categories={lockCategories}
                    label="Lock types data"
                    onSelect={(category) =>
                      openCategory(
                        'Locking mechanism',
                        'lockingMechanism',
                        category,
                      )
                    }
                  />
                </div>
              </CardContent>
            </Card>
          </section>

          <section className="mt-3 grid grid-cols-12 gap-3">
            <InsightPanel
              eyebrow="Materials"
              title="Blade steel mix"
              detailHref="/insights/blade-steels"
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
                      knifeIds: [],
                      categoryKey: 'bladeMaterial',
                      categories: stats.categories.bladeMaterial,
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
                className="h-48 w-full cursor-pointer"
                areaClickCategoryAxis="y"
                onChartAreaClick={(event) =>
                  openChartCategory(
                    event,
                    'Blade material',
                    'bladeMaterial',
                    steelCategories,
                  )
                }
              />
              <details className="mt-3 text-xs">
                <summary className="w-fit cursor-pointer rounded-sm py-1 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  View data<span className="sr-only">: Blade steels</span>
                </summary>
                <CategoryRows
                  categories={steelCategories}
                  label="Blade steel data"
                  neutralOther
                  onSelect={(category) =>
                    openCategory('Blade material', 'bladeMaterial', category)
                  }
                />
              </details>
            </InsightPanel>

            <InsightPanel
              eyebrow="Profiles"
              title="Blade shapes"
              detailHref="/insights/blade-shapes"
              description={`${stats.categories.bladeStyle.length} distinct profiles represented`}
              className="col-span-12 lg:col-span-5"
            >
              <div className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <InsightsChart
                  buildOption={(palette) =>
                    getPieOption(shapeCategories, stats.total, palette)
                  }
                  ariaLabel="Blade shape distribution"
                  className="h-40 w-full cursor-pointer"
                  onChartClick={(event) =>
                    openChartCategory(
                      event,
                      'Blade style',
                      'bladeStyle',
                      shapeCategories,
                    )
                  }
                />
                <CategoryRows
                  categories={shapeCategories}
                  label="Blade shapes data"
                  onSelect={(category) =>
                    openCategory('Blade style', 'bladeStyle', category)
                  }
                />
              </div>
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
              detailHref="/insights/measurements"
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
              <div
                role="region"
                aria-label={`${measurement.label} chart; scroll to see all ranges`}
                tabIndex={0}
                className="overflow-x-auto rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <InsightsChart
                  buildOption={(palette) =>
                    getHistogramOption(measurement, palette)
                  }
                  ariaLabel={`${measurement.label} distribution`}
                  className="h-52 min-w-[560px] w-full cursor-pointer"
                  onChartAreaClick={(event) =>
                    openMeasurementBin(
                      measurement,
                      measurement.bins[event.dataIndex ?? -1],
                    )
                  }
                />
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground sm:hidden">
                Swipe chart for all ranges, or open View data.
              </p>
              <MeasurementRows
                key={measurementKey}
                measurement={measurement}
                onSelect={(bin) => openMeasurementBin(measurement, bin)}
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
              detailHref="/insights/completeness"
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
              detailHref="/insights/makers"
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
              detailHref="/insights/handle-materials"
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
              detailHref="/insights/designers"
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
              title="Collection activity"
              detailHref="/insights/activity"
              description={`${stats.additionsInActivityRange} additions · ${stats.editsInActivityRange} edited · ${stats.maintainedKnivesInActivityRange} maintained across ${stats.activeDays} active days · darker squares mean more activity`}
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
                            const activityLabel = formatActivityDayLabel(
                              day.date,
                              day.addedCount,
                              day.editedCount,
                              day.maintainedCount,
                            )
                            return (
                              <Tooltip key={day.dateKey}>
                                <TooltipTrigger
                                  type="button"
                                  aria-label={activityLabel}
                                  onClick={
                                    day.count
                                      ? () =>
                                          setDrilldown({
                                            eyebrow: 'Activity date',
                                            title: day.date.toLocaleDateString(
                                              undefined,
                                              {
                                                dateStyle: 'medium',
                                              },
                                            ),
                                            description: formatActivityCounts(
                                              day.addedCount,
                                              day.editedCount,
                                              day.maintainedCount,
                                            ),
                                            knifeIds: day.knifeIds,
                                            groups: [
                                              {
                                                label: 'Added',
                                                knifeIds: day.addedKnifeIds,
                                              },
                                              {
                                                label: 'Edited',
                                                knifeIds: day.editedKnifeIds,
                                              },
                                              {
                                                label: 'Maintained',
                                                knifeIds:
                                                  day.maintainedKnifeIds,
                                              },
                                            ],
                                          })
                                      : undefined
                                  }
                                  className={cn(
                                    'h-[11px] min-w-[10px] rounded-[2px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                    day.count === 0 && 'bg-muted',
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
                                <TooltipContent
                                  sideOffset={8}
                                  className="whitespace-normal border border-[var(--bladevault-line)] bg-[#f7f1e5] text-sm font-semibold text-[var(--bladevault-olive)] shadow-[0_8px_24px_rgba(46,52,23,0.14)] [&>[aria-hidden=true]]:bg-[#f7f1e5] [&>[aria-hidden=true]]:fill-[#f7f1e5]"
                                >
                                  {activityLabel}
                                </TooltipContent>
                              </Tooltip>
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
              detailHref="/insights/recent"
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
          <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto p-4">
            {drilldown?.categories && drilldown.categoryKey ? (
              <CategoryRows
                categories={drilldown.categories}
                label="Other categories"
                showColors={false}
                onSelect={(category) => {
                  setDrilldown({
                    eyebrow: drilldown.eyebrow,
                    title: category.name,
                    description: `${category.count} knives · ${category.percent}% of this view`,
                    knifeIds: category.knifeIds,
                    collectionHref: categoryHref(
                      drilldown.categoryKey!,
                      category,
                    ),
                  })
                }}
              />
            ) : selectedGroups ? (
              selectedGroups.map((group, index) => (
                <section
                  key={group.label}
                  className={cn(
                    'grid gap-2',
                    index > 0 && 'border-t border-border pt-4',
                  )}
                >
                  <div className="flex items-center justify-between px-1">
                    <h3 className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground">
                      <span
                        aria-hidden="true"
                        className={cn(
                          'size-2 rounded-full',
                          group.label === 'Added'
                            ? 'bg-[#c89c3d]'
                            : 'bg-[#79824a]',
                        )}
                      />
                      {group.label}
                    </h3>
                    <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                      {group.knives.length}
                    </span>
                  </div>
                  <div className="grid gap-2">
                    {group.knives.map((knife) => (
                      <DrilldownKnife key={knife.id} knife={knife} />
                    ))}
                  </div>
                </section>
              ))
            ) : (
              selectedKnives.map((knife) => (
                <DrilldownKnife key={knife.id} knife={knife} />
              ))
            )}
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

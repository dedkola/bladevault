'use client'

import Link from 'next/link'
import { useId, useMemo, useState } from 'react'
import { ArrowUpRight, Download } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { useKnives } from '@/components/providers/knives-provider'
import {
  collapseCategories,
  createCollectionStats,
  parseLengthToInches,
  type CategoryStat,
} from '@/lib/collection-stats'
import { groupKnifeFamilies } from '@/lib/knife-families'
import type { Knife } from '@/lib/data'
import { cn } from '@/lib/utils'

type Range = 'season' | 'all'

type MonthlyPoint = {
  label: string
  year: number
  month: number
  count: number
  documented: number
  medianBlade?: number
  missing: number
}

const CHART_COLORS = [
  'var(--bv-chart-1)',
  'var(--bv-chart-2)',
  'var(--bv-chart-3)',
  'var(--bv-chart-4)',
  'var(--bv-chart-5)',
  'var(--bv-chart-6)',
]

function percent(value: number, total: number): number {
  return total === 0 ? 0 : Math.round((value / total) * 100)
}

function isDocumented(knife: Knife): boolean {
  return Boolean(
    knife.specs.designer &&
    knife.specs.bladeLength &&
    knife.handleMaterial &&
    knife.bladeStyle &&
    knife.specs.lockingMechanism,
  )
}

function monthlySeries(knives: Knife[], count: number): MonthlyPoint[] {
  const now = new Date()
  const months = Array.from({ length: count }, (_, index) => {
    const date = new Date(
      now.getFullYear(),
      now.getMonth() - count + 1 + index,
      1,
    )
    return {
      year: date.getFullYear(),
      month: date.getMonth(),
      label: date.toLocaleDateString('en-US', { month: 'short' }),
    }
  })

  return months.map((month) => {
    const entries = knives.filter((knife) => {
      const added = new Date(knife.addedAt)
      return (
        Number.isFinite(added.getTime()) &&
        added.getFullYear() === month.year &&
        added.getMonth() === month.month
      )
    })
    const blades = entries
      .map((knife) => parseLengthToInches(knife.specs.bladeLength))
      .filter((value): value is number => value !== undefined)
      .sort((left, right) => left - right)
    const medianBlade =
      blades.length === 0
        ? undefined
        : blades.length % 2 === 0
          ? (blades[blades.length / 2 - 1] + blades[blades.length / 2]) / 2
          : blades[Math.floor(blades.length / 2)]

    return {
      ...month,
      count: entries.length,
      documented: percent(entries.filter(isDocumented).length, entries.length),
      medianBlade,
      missing: entries.filter((knife) => !knife.specs.designer).length,
    }
  })
}

function sparkPath(values: number[], width = 108, height = 28): string {
  const finite = values.filter((value) => Number.isFinite(value))
  if (finite.length === 0) return ''
  const min = Math.min(...finite)
  const max = Math.max(...finite)
  const span = max - min || 1
  const step = values.length <= 1 ? width : width / (values.length - 1)

  return values
    .map((value, index) => {
      const x = index * step
      const y = height - 3 - ((value - min) / span) * (height - 6)
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
}

function Sparkline({
  values,
  tone = 'blue',
}: {
  values: number[]
  tone?: 'blue' | 'green' | 'orange'
}) {
  const color =
    tone === 'green'
      ? 'var(--green, #2f9e6d)'
      : tone === 'orange'
        ? 'var(--orange, #f6821f)'
        : 'var(--primary)'
  const path = sparkPath(values)
  if (!path) return null

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 108 28"
      className="h-7 w-[108px] overflow-visible"
    >
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function MetricCard({
  label,
  value,
  suffix,
  detail,
  values,
  tone = 'blue',
}: {
  label: string
  value: string | number
  suffix?: string
  detail: string
  values: number[]
  tone?: 'blue' | 'green' | 'orange'
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-3.5 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-medium text-muted-foreground">
            {label}
          </div>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-[25px] font-semibold leading-none tracking-[-0.045em] text-foreground">
              {value}
            </span>
            {suffix ? (
              <span className="text-[12px] font-medium text-muted-foreground">
                {suffix}
              </span>
            ) : null}
          </div>
          <div className="mt-2 text-[9.5px] text-muted-foreground">
            {detail}
          </div>
        </div>
        <Sparkline values={values} tone={tone} />
      </div>
    </div>
  )
}

function AreaChart({
  points,
  rangeLabel,
}: {
  points: MonthlyPoint[]
  rangeLabel: string
}) {
  const gradientId = useId()
  const width = 680
  const height = 196
  const pad = { top: 24, right: 18, bottom: 30, left: 26 }
  const innerWidth = width - pad.left - pad.right
  const innerHeight = height - pad.top - pad.bottom
  const max = Math.max(1, ...points.map((point) => point.count))
  const step =
    points.length <= 1 ? innerWidth : innerWidth / (points.length - 1)
  const pointAt = (point: MonthlyPoint, index: number) => ({
    x: pad.left + index * step,
    y: pad.top + innerHeight - (point.count / max) * innerHeight,
  })
  const line = points
    .map((point, index) => {
      const { x, y } = pointAt(point, index)
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
  const area = `${line} L${pad.left + (points.length - 1) * step} ${pad.top + innerHeight} L${pad.left} ${pad.top + innerHeight} Z`
  const showLabels = points.length <= 6

  return (
    <div className="mt-4">
      <svg
        role="img"
        aria-label={`Monthly additions. ${rangeLabel}.`}
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full overflow-visible"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3].map((lineIndex) => {
          const y = pad.top + (innerHeight / 3) * lineIndex
          return (
            <line
              key={lineIndex}
              x1={pad.left}
              x2={width - pad.right}
              y1={y}
              y2={y}
              stroke="var(--border)"
              strokeDasharray="2 4"
            />
          )
        })}
        <path d={area} fill={`url(#${gradientId})`} />
        <path
          d={line}
          fill="none"
          stroke="var(--primary)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {points.map((point, index) => {
          const { x, y } = pointAt(point, index)
          return (
            <g key={`${point.year}-${point.month}`}>
              <circle
                cx={x}
                cy={y}
                r="3.4"
                fill="var(--card)"
                stroke="var(--primary)"
                strokeWidth="1.8"
              />
              {showLabels ? (
                <text
                  x={x}
                  y={y - 10}
                  textAnchor="middle"
                  fill="var(--muted-foreground)"
                  fontSize="9.5"
                >
                  {point.count}
                </text>
              ) : null}
              <text
                x={x}
                y={height - 8}
                textAnchor="middle"
                fill="var(--muted-foreground)"
                fontSize="9"
              >
                {points.length > 6 && index % 2 !== 0 ? '' : point.label}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function Donut({
  categories,
  centerValue,
  centerLabel,
}: {
  categories: CategoryStat[]
  centerValue: string
  centerLabel: string
}) {
  const stops = categories.map((category, index) => {
    const start = categories
      .slice(0, index)
      .reduce((sum, entry) => sum + entry.percent, 0)
    const end = start + category.percent
    return `${CHART_COLORS[index % CHART_COLORS.length]} ${start}% ${end}%`
  })

  return (
    <div
      className="relative grid size-[104px] shrink-0 place-items-center rounded-full"
      style={{
        background:
          stops.length > 0
            ? `conic-gradient(${stops.join(', ')})`
            : 'var(--muted)',
      }}
      aria-hidden="true"
    >
      <div className="grid size-[76px] place-items-center rounded-full bg-card text-center">
        <div>
          <div className="text-[18px] font-semibold leading-none tracking-[-0.04em] text-foreground">
            {centerValue}
          </div>
          <div className="mt-1 text-[8.5px] text-muted-foreground">
            {centerLabel}
          </div>
        </div>
      </div>
    </div>
  )
}

function HealthRing({ value }: { value: number }) {
  return (
    <div className="relative grid size-[94px] shrink-0 place-items-center">
      <svg
        viewBox="0 0 100 100"
        className="absolute inset-0 size-full -rotate-90"
        aria-hidden="true"
      >
        <circle
          cx="50"
          cy="50"
          r="42"
          fill="none"
          stroke="var(--muted)"
          strokeWidth="8"
        />
        <circle
          cx="50"
          cy="50"
          r="42"
          fill="none"
          stroke="var(--primary)"
          strokeWidth="8"
          pathLength="100"
          strokeDasharray={`${value} ${100 - value}`}
          strokeLinecap="round"
        />
      </svg>
      <div className="text-center">
        <div className="text-[19px] font-semibold leading-none tracking-[-0.04em] text-foreground">
          {value}%
        </div>
        <div className="mt-1 text-[8.5px] text-muted-foreground">complete</div>
      </div>
    </div>
  )
}

function BarRow({
  label,
  count,
  max,
  color,
}: {
  label: string
  count: number
  max: number
  color: string
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate text-[10.5px] text-foreground">{label}</span>
        <span className="shrink-0 text-[9.5px] tabular-nums text-muted-foreground">
          {count}
        </span>
      </div>
      <div className="col-span-2 h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full"
          style={{
            width: `${max === 0 ? 0 : Math.max(4, (count / max) * 100)}%`,
            backgroundColor: color,
          }}
        />
      </div>
    </div>
  )
}

export function ModernInsights() {
  const { knives, isLoading } = useKnives()
  const [range, setRange] = useState<Range>('season')

  const stats = useMemo(() => createCollectionStats(knives, 'all'), [knives])
  const seasonPoints = useMemo(() => monthlySeries(knives, 6), [knives])
  const allPoints = useMemo(() => monthlySeries(knives, 12), [knives])
  const points = range === 'season' ? seasonPoints : allPoints
  const total = knives.length
  const documented = stats.completeness
  const missingDesigner = knives.filter((knife) => !knife.specs.designer).length
  const medianBlade = stats.measurements.bladeLength.median
  const bladeKnown = knives
    .map((knife) => parseLengthToInches(knife.specs.bladeLength))
    .filter((value): value is number => value !== undefined)
  const midBladeCount = bladeKnown.filter(
    (value) => value >= 2.75 && value < 3.5,
  ).length
  const midBladeShare = percent(midBladeCount, bladeKnown.length)
  const currentMonth = seasonPoints.at(-1)?.count ?? 0

  const steelCategories = collapseCategories(
    stats.categories.bladeMaterial,
    5,
    total,
  )
  const steelTop = steelCategories[0]
  const brandCategories = collapseCategories(stats.categories.brand, 3, total)
  const topBrands = brandCategories.filter(
    (category) => category.name !== 'Other',
  )
  const topTwoShare =
    brandCategories.length >= 2
      ? brandCategories[0].percent + brandCategories[1].percent
      : (brandCategories[0]?.percent ?? 0)
  const maxBrand = Math.max(1, ...brandCategories.map((item) => item.count))

  const familyRows = useMemo(
    () =>
      groupKnifeFamilies(knives)
        .sort((left, right) => right.knives.length - left.knives.length)
        .slice(0, 4)
        .map((family) => ({
          name: family.name,
          count: family.knives.length,
        })),
    [knives],
  )
  const maxFamily = Math.max(1, ...familyRows.map((family) => family.count))

  const photos = knives.filter((knife) => knife.images.length > 0).length
  const designers = knives.filter((knife) => knife.specs.designer).length
  const locks = knives.filter((knife) =>
    Boolean(knife.specs.lockingMechanism),
  ).length
  const fixedShare = percent(
    knives.filter((knife) =>
      /^(fix|fixed)$/i.test(knife.specs.lockingMechanism ?? ''),
    ).length,
    total,
  )
  const healthRows = [
    ['Core specs', documented],
    ['Photographs', percent(photos, total)],
    ['Designer', percent(designers, total)],
    ['Lock type', percent(locks, total)],
  ] as const

  const monthRange =
    points.length > 0
      ? `${points[0].label} – ${points.at(-1)?.label} ${points.at(-1)?.year}`
      : 'No dated records'

  if (isLoading) {
    return (
      <div className="flex w-full flex-1 flex-col gap-3 p-4 sm:p-6 lg:p-8">
        <div className="h-16 animate-pulse rounded-xl bg-muted" />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((item) => (
            <div
              key={item}
              className="h-28 animate-pulse rounded-xl bg-muted"
            />
          ))}
        </div>
      </div>
    )
  }

  if (total === 0) {
    return (
      <div className="flex w-full flex-1 flex-col p-4 sm:p-6 lg:p-8">
        <PageHeader
          title="Collection pulse"
          description="What the drawer is telling you."
        />
        <div className="rounded-xl border border-border bg-card p-10 text-center text-xs text-muted-foreground">
          Add a knife to start building your collection pulse.
        </div>
      </div>
    )
  }

  return (
    <div data-modern-insights className="w-full flex-1 p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Collection pulse"
        description="What the drawer is telling you."
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex rounded-full border border-border bg-card p-0.5">
              <button
                type="button"
                onClick={() => setRange('season')}
                aria-pressed={range === 'season'}
                className={cn(
                  'rounded-full px-2.5 py-1 text-[10px] transition-colors',
                  range === 'season'
                    ? 'bg-[var(--bladevault-surface-soft)] font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                Season
              </button>
              <button
                type="button"
                onClick={() => setRange('all')}
                aria-pressed={range === 'all'}
                className={cn(
                  'rounded-full px-2.5 py-1 text-[10px] transition-colors',
                  range === 'all'
                    ? 'bg-[var(--bladevault-surface-soft)] font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                All time
              </button>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => window.print()}
            >
              <Download className="size-3.5" aria-hidden="true" />
              Export
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Objects"
          value={total}
          detail={`+${currentMonth} this month`}
          values={seasonPoints.map((point) => point.count)}
        />
        <MetricCard
          label="Documented"
          value={documented}
          suffix="%"
          detail="Across 9 fields"
          values={seasonPoints.map((point) => point.documented)}
          tone="orange"
        />
        <MetricCard
          label="Median blade"
          value={medianBlade?.toFixed(2) ?? '—'}
          suffix="in"
          detail={`${midBladeShare}% are 2.75–3.5 in`}
          values={seasonPoints.map((point) => point.medianBlade ?? 0)}
        />
        <MetricCard
          label="Needs attention"
          value={missingDesigner}
          detail="Designer missing"
          values={seasonPoints.map((point) => point.missing)}
          tone="orange"
        />
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-[1.9fr_1fr]">
        <section className="rounded-xl border border-border bg-card px-3.5 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">
                Catalogued over time
              </h2>
              <p className="mt-1 text-[9.5px] text-muted-foreground">
                {total} records with a date · {monthRange}
              </p>
            </div>
          </div>
          <AreaChart points={points} rangeLabel={monthRange} />
        </section>

        <section className="rounded-xl border border-border bg-card px-3.5 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <div>
            <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">
              Collection health
            </h2>
            <p className="mt-1 text-[9.5px] text-muted-foreground">
              Where the catalogue is strong.
            </p>
          </div>
          <div className="mt-4 flex items-center gap-4">
            <HealthRing value={documented} />
            <div className="min-w-0 flex-1 space-y-2">
              {healthRows.map(([label, value]) => (
                <div
                  key={label}
                  className="flex items-center justify-between gap-2 border-b border-border/70 pb-1.5 text-[10px] last:border-0 last:pb-0"
                >
                  <span className="text-muted-foreground">{label}</span>
                  <span className="tabular-nums text-foreground">{value}%</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-[1fr_1.15fr_1fr]">
        <section className="rounded-xl border border-border bg-card px-3.5 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">
                Steel DNA
              </h2>
              <p className="mt-1 text-[9.5px] text-muted-foreground">
                Top steels by share.
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Donut
              categories={steelCategories}
              centerValue={`${steelTop?.percent ?? 0}%`}
              centerLabel={steelTop?.name ?? '—'}
            />
            <div className="min-w-0 flex-1 space-y-1.5">
              {steelCategories.map((category, index) => (
                <div
                  key={category.name}
                  className="flex items-center gap-1.5 text-[9.5px]"
                >
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{
                      backgroundColor:
                        CHART_COLORS[index % CHART_COLORS.length],
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {category.name}
                  </span>
                  <span className="tabular-nums text-foreground">
                    {category.count}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card px-3.5 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <div>
            <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">
              Maker mix
            </h2>
            <p className="mt-1 text-[9.5px] text-muted-foreground">
              The top two hold {topTwoShare}% of the collection.
            </p>
          </div>
          <div className="mt-4 space-y-3">
            {brandCategories.map((category, index) => (
              <BarRow
                key={category.name}
                label={category.name}
                count={category.count}
                max={maxBrand}
                color={CHART_COLORS[index % CHART_COLORS.length]}
              />
            ))}
          </div>
          <p className="mt-4 text-[9.5px] text-muted-foreground">
            {topBrands.map((brand) => brand.name).join(' + ')} ={' '}
            <span className="font-medium text-foreground">{topTwoShare}%</span>{' '}
            of the vault.
          </p>
        </section>

        <section className="rounded-xl border border-border bg-card px-3.5 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <div>
            <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">
              Family density
            </h2>
            <p className="mt-1 text-[9.5px] text-muted-foreground">
              One dot = one object.
            </p>
          </div>
          <div className="mt-4 space-y-3">
            {familyRows.map((family, index) => (
              <BarRow
                key={family.name}
                label={family.name}
                count={family.count}
                max={maxFamily}
                color={CHART_COLORS[index % CHART_COLORS.length]}
              />
            ))}
          </div>
        </section>
      </div>

      <section className="mt-3 overflow-hidden rounded-xl bg-[var(--primary)] px-5 py-5 text-white shadow-[0_1px_2px_rgba(0,0,0,0.04)] sm:px-6">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-3xl">
            <h2 className="max-w-2xl text-[26px] font-semibold leading-[1.04] tracking-[-0.045em] sm:text-[30px]">
              A two-maker collection with a three-inch habit.
            </h2>
            <p className="mt-3 max-w-2xl text-[11px] leading-relaxed text-white/75">
              This is not a random accumulation. It is a focused study of a few
              shapes, repeated with intention. The outliers are what keep it
              personal.
            </p>
            <div className="mt-5 flex flex-wrap gap-8">
              <div>
                <div className="text-[22px] font-semibold leading-none tracking-[-0.04em]">
                  {topTwoShare}%
                </div>
                <div className="mt-1 text-[9px] text-white/65">
                  {topBrands.map((brand) => brand.name).join(' + ')}
                </div>
              </div>
              <div>
                <div className="text-[22px] font-semibold leading-none tracking-[-0.04em]">
                  {midBladeShare}%
                </div>
                <div className="mt-1 text-[9px] text-white/65">
                  2.75–3.5 in blades
                </div>
              </div>
              <div>
                <div className="text-[22px] font-semibold leading-none tracking-[-0.04em]">
                  {fixedShare}%
                </div>
                <div className="mt-1 text-[9px] text-white/65">
                  fixed blades
                </div>
              </div>
            </div>
          </div>
          <Link
            href="/collection"
            className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 self-start rounded-full border border-white/30 bg-white/10 px-4 text-[11px] font-medium text-white transition-colors hover:bg-white/20 xl:self-auto"
          >
            Explore the collection
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </Link>
        </div>
      </section>
    </div>
  )
}

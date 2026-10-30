'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useId, useMemo, useState, type ReactNode } from 'react'
import { ArrowUpRight, Plus } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { useKnives } from '@/components/providers/knives-provider'
import {
  createCollectionStats,
  type CategoryStat,
  type MeasurementKey,
} from '@/lib/collection-stats'
import { getImageUrl, type Knife } from '@/lib/data'
import { groupKnifeFamilies } from '@/lib/knife-families'
import {
  buildCatalogueSeries,
  type ModernInsightsRange,
} from '@/lib/modern-insights'
import { cn } from '@/lib/utils'
import styles from './modern-insights.module.css'

const number = new Intl.NumberFormat('en-US')
const RANGES: { value: ModernInsightsRange; label: string }[] = [
  { value: '6m', label: '6 months' },
  { value: '12m', label: '12 months' },
  { value: 'all', label: 'All time' },
]
const MEASUREMENTS: { value: MeasurementKey; label: string }[] = [
  { value: 'bladeLength', label: 'Blade' },
  { value: 'overallLength', label: 'Overall' },
  { value: 'weight', label: 'Weight' },
  { value: 'bladeThickness', label: 'Thickness' },
]
const COLORS = [
  'var(--bv-chart-1)',
  'var(--bv-chart-2)',
  'var(--bv-chart-3)',
  'var(--bv-chart-4)',
  'var(--bv-chart-5)',
  'var(--bv-chart-6)',
]

function Panel({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string
  description: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  const id = useId()
  return (
    <section aria-labelledby={id} className={cn(styles.panel, className)}>
      <div className={styles.panelHeader}>
        <div>
          <h2 id={id}>{title}</h2>
          <p>{description}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function DetailLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className={styles.detailLink}>
      {children}
      <ArrowUpRight size={13} aria-hidden="true" />
    </Link>
  )
}

function Metric({
  label,
  value,
  unit,
  detail,
  href,
}: {
  label: string
  value: string | number
  unit?: string
  detail: string
  href: string
}) {
  return (
    <div role="group" aria-label={label} className={styles.metric}>
      <Link href={href} className={styles.metricLabel}>
        {label}
        <ArrowUpRight size={12} aria-hidden="true" />
      </Link>
      <div className={styles.metricValue}>
        {value}
        {unit && <span>{unit}</span>}
      </div>
      <p>{detail}</p>
    </div>
  )
}

// Stats combine case variants; include each stored spelling in the drilldown.
function categoryHref(
  category: CategoryStat,
  key: 'brand' | 'bladeMaterial',
  knivesById: Map<string, Knife>,
): string {
  const values = new Set<string>()
  for (const id of category.knifeIds) {
    const knife = knivesById.get(id)
    const value = key === 'brand' ? knife?.brand : knife?.specs.bladeMaterial
    if (value?.trim()) values.add(value)
  }
  const params = new URLSearchParams()
  for (const value of values) params.append(key, value)
  return `/collection?${params.toString()}`
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : 'Date not recorded'
}

function formatMeasurement(value: number | undefined): string {
  return value === undefined
    ? '—'
    : value.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

function compactBinLabel(label: string): string {
  return label.replace(/\.0(?=–|″|\s)/g, '').replace(/″|\s(?:oz|mm)/g, '')
}

type BarDatum = {
  key: string
  label: string
  count: number
  description: string
  highlighted: boolean
}

function Bars({
  label,
  data,
  selectedKey,
  onSelect,
  minBarWidth = 0,
}: {
  label: string
  data: BarDatum[]
  selectedKey?: string
  onSelect: (key: string) => void
  minBarWidth?: number
}) {
  const peak = Math.max(1, ...data.map((item) => item.count))
  return (
    <div
      className={styles.chartScroll}
      role="region"
      aria-label={`${label}; scroll to see all ranges`}
      tabIndex={0}
    >
      <div
        role="group"
        aria-label={label}
        className={styles.barChart}
        style={{
          gridTemplateColumns: `repeat(${data.length}, minmax(0, 1fr))`,
          minWidth: minBarWidth
            ? data.length * minBarWidth + (data.length - 1) * 12
            : undefined,
        }}
      >
        <span className={styles.chartGrid} aria-hidden="true" />
        {data.map((item) => (
          <button
            key={item.key}
            type="button"
            className={styles.barButton}
            aria-label={item.description}
            aria-pressed={selectedKey === item.key}
            title={item.description}
            onClick={() => onSelect(item.key)}
          >
            <span className={styles.barPlot} aria-hidden="true">
              <span
                className={cn(
                  styles.barColumn,
                  item.highlighted && styles.barHighlighted,
                )}
                style={{ height: `${(item.count / peak) * 100}%` }}
              >
                <span className={styles.barCount}>
                  {number.format(item.count)}
                </span>
              </span>
            </span>
            <span
              aria-hidden="true"
              className={cn(
                styles.barLabel,
                item.highlighted && styles.barLabelHighlighted,
              )}
            >
              {item.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

export function ModernInsights() {
  const { knives, isLoading } = useKnives()
  const [range, setRange] = useState<ModernInsightsRange>('6m')
  const [selectedMonthKey, setSelectedMonthKey] = useState<string>()
  const [measurementKey, setMeasurementKey] =
    useState<MeasurementKey>('bladeLength')
  const [selectedBinLabel, setSelectedBinLabel] = useState<string>()
  const stats = useMemo(() => createCollectionStats(knives, 'all'), [knives])
  const catalogue = useMemo(
    () => buildCatalogueSeries(knives, range, new Date()),
    [knives, range],
  )
  const families = useMemo(() => groupKnifeFamilies(knives), [knives])
  const knivesById = useMemo(
    () => new Map(knives.map((knife) => [knife.id, knife])),
    [knives],
  )
  const incomplete = new Set(
    stats.missingFields.flatMap((field) => field.knifeIds),
  ).size
  const steelCategories = stats.categories.bladeMaterial
  const steelKnown = steelCategories.reduce((sum, item) => sum + item.count, 0)
  const otherSteel = steelCategories
    .slice(5)
    .reduce((sum, item) => sum + item.count, 0)
  const steelSegments = [
    ...steelCategories.slice(0, 5).map((item, index) => ({
      name: item.name,
      count: item.count,
      color: COLORS[index],
      href: categoryHref(item, 'bladeMaterial', knivesById),
    })),
    ...(otherSteel
      ? [
          {
            name: 'Other steels',
            count: otherSteel,
            color: COLORS[5],
            href: '/insights/blade-steels',
          },
        ]
      : []),
    ...(stats.total > steelKnown
      ? [
          {
            name: 'Not recorded',
            count: stats.total - steelKnown,
            color: 'var(--bv-chart-track)',
            href: '/collection?bladeMaterial=__not_set__',
          },
        ]
      : []),
  ]
  const makers = stats.categories.brand
  const median = stats.measurements.bladeLength.median
  const soldCount = knives.filter((knife) => knife.sold).length
  const currentMonth = catalogue.points.at(-1)!
  const selectedMonth =
    catalogue.points.find((point) => point.monthKey === selectedMonthKey) ??
    currentMonth
  const measurement = stats.measurements[measurementKey]
  const peakBin = measurement.bins.reduce((peak, bin) =>
    bin.count > peak.count ? bin : peak,
  )
  const selectedBin = measurement.bins.find(
    (bin) => bin.label === selectedBinLabel,
  )

  return (
    <div className={styles.root} data-modern-insights>
      {isLoading ? (
        <div
          className={styles.loading}
          role="status"
          aria-label="Loading collection insights"
        >
          <div />
          <div />
          <div />
          <span className="sr-only">Loading collection insights</span>
        </div>
      ) : stats.total === 0 ? (
        <section className={styles.empty}>
          <div className={styles.emptyArt} aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
          <h2>Your collection starts here</h2>
          <p>
            Add a knife to see your makers, materials and measurements take
            shape.
          </p>
          <Link href="/add" className={buttonVariants({ size: 'sm' })}>
            <Plus size={15} /> Add your first knife
          </Link>
        </section>
      ) : (
        <>
          <div className={styles.metrics}>
            <Metric
              label="Catalogued knives"
              value={number.format(stats.total)}
              detail={`${stats.pinnedCount} pinned${soldCount ? ` · ${soldCount} marked sold` : ' in your collection'}`}
              href="/insights/library"
            />
            <Metric
              label="Makers"
              value={makers.length}
              detail={`${number.format(families.length)} model families`}
              href="/insights/makers"
            />
            <Metric
              label="Median blade"
              value={median === undefined ? '—' : median.toFixed(2)}
              unit={median === undefined ? undefined : 'in'}
              detail={`${stats.measurements.bladeLength.knownCount} readable measurements`}
              href="/insights/measurements?tab=bladeLength"
            />
            <Metric
              label="Field coverage"
              value={`${stats.completeness}%`}
              detail={`${incomplete} ${incomplete === 1 ? 'record has' : 'records have'} missing fields`}
              href="/insights/completeness"
            />
          </div>
          <div className={styles.grid}>
            <Panel
              title="Collection additions"
              description="A month-by-month view of your catalogue."
              className={styles.growth}
              action={
                <div
                  className={styles.range}
                  aria-label="Catalogue date range"
                  role="group"
                >
                  {RANGES.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      aria-pressed={range === item.value}
                      onClick={() => {
                        setRange(item.value)
                        setSelectedMonthKey(undefined)
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              }
            >
              <div className={styles.chartSummary}>
                <div>
                  <strong className={styles.chartValue}>
                    +{number.format(catalogue.addedInRange)}
                  </strong>
                  <p>
                    {range === 'all'
                      ? 'added since your catalogue began'
                      : `added in the last ${range === '6m' ? 6 : 12} months`}
                  </p>
                </div>
                <div className={styles.summaryAside}>
                  <strong>
                    {(
                      catalogue.addedInRange / catalogue.points.length
                    ).toLocaleString('en-US', {
                      maximumFractionDigits: 1,
                    })}{' '}
                    per month
                  </strong>
                  <p>average over this period</p>
                </div>
              </div>
              {catalogue.datedCount > 0 ? (
                <>
                  <Bars
                    label="Monthly catalogue additions"
                    data={catalogue.points.map((point) => ({
                      key: point.monthKey,
                      label:
                        catalogue.points.length > 6
                          ? point.label
                          : point.label.split(' ')[0],
                      count: point.added,
                      description: `${point.label}: ${number.format(point.added)} knives added`,
                      highlighted: point.monthKey === currentMonth.monthKey,
                    }))}
                    selectedKey={selectedMonthKey}
                    onSelect={setSelectedMonthKey}
                    minBarWidth={catalogue.points.length > 6 ? 46 : 0}
                  />
                  <div className={styles.chartContext}>
                    <span aria-live="polite">
                      {selectedMonth.label}:{' '}
                      {number.format(selectedMonth.added)} additions
                    </span>
                    <span className={styles.currentMonth}>
                      Current month · in progress
                    </span>
                  </div>
                  <details className={styles.chartData}>
                    <summary>View monthly data</summary>
                    <table>
                      <caption className="sr-only">
                        Monthly additions and cumulative catalogue totals
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Month</th>
                          <th scope="col">Added</th>
                          <th scope="col">Catalogue total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {catalogue.points.map((point) => (
                          <tr key={point.monthKey}>
                            <th scope="row">{point.label}</th>
                            <td>{number.format(point.added)}</td>
                            <td>{number.format(point.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                </>
              ) : (
                <p className={styles.chartEmpty}>
                  No valid catalogue dates to plot yet.
                </p>
              )}
              <div className={styles.panelFoot}>
                <span>
                  {catalogue.excludedCount
                    ? `${catalogue.excludedCount} invalid or future dates excluded.`
                    : 'By date added · includes records marked sold'}
                </span>
                <span>
                  {catalogue.points[0].label} – {currentMonth.label}
                </span>
                <DetailLink href="/insights/recent">View additions</DetailLink>
              </div>
            </Panel>

            <Panel
              title="Catalogue coverage"
              description="A little detail makes a better catalogue."
              className={styles.coverage}
            >
              <div className={styles.coverageSummary}>
                <div className={styles.coverageRing}>
                  <svg viewBox="0 0 100 100" aria-hidden="true">
                    <circle
                      cx="50"
                      cy="50"
                      r="42"
                      className={styles.ringTrack}
                    />
                    <circle
                      cx="50"
                      cy="50"
                      r="42"
                      pathLength="100"
                      strokeDasharray={`${stats.completeness} 100`}
                      className={styles.ringValue}
                    />
                  </svg>
                  <strong>
                    {stats.completeness}
                    <span>%</span>
                  </strong>
                </div>
                <div>
                  <strong>Core details filled</strong>
                  <p>Filled values across 10 core fields.</p>
                </div>
              </div>
              {stats.missingFields.length ? (
                <div className={styles.missingFields}>
                  <span className={styles.eyebrow}>Where to fill the gaps</span>
                  {stats.missingFields.slice(0, 3).map((field) => (
                    <Link
                      key={field.key}
                      href={`/collection?${field.key}=__not_set__`}
                    >
                      <span>{field.label}</span>
                      <span>
                        {field.count} missing{' '}
                        <ArrowUpRight size={12} aria-hidden="true" />
                      </span>
                    </Link>
                  ))}
                </div>
              ) : (
                <p className={styles.complete}>
                  All 10 core fields are filled across your catalogue.
                </p>
              )}
              <div className={styles.panelFoot}>
                <span>Coverage measures presence, not accuracy.</span>
                <DetailLink href="/insights/completeness">
                  Review fields
                </DetailLink>
              </div>
            </Panel>

            <Panel
              title="Maker mix"
              description={`${makers.length} makers across your catalogue.`}
              className={styles.makers}
            >
              {makers.length ? (
                <div className={styles.makerList}>
                  {makers.slice(0, 6).map((maker, index) => (
                    <Link
                      key={maker.name}
                      href={categoryHref(maker, 'brand', knivesById)}
                      className={styles.makerRow}
                    >
                      <span className={styles.makerRank}>
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span className={styles.makerBody}>
                        <span className={styles.makerMeta}>
                          <span>{maker.name}</span>
                          <span>
                            <strong>{maker.count}</strong>
                            <small>{maker.percent}%</small>
                          </span>
                        </span>
                        <span className={styles.makerTrack}>
                          <span
                            style={{
                              width: `${(maker.count / stats.total) * 100}%`,
                            }}
                          />
                        </span>
                      </span>
                    </Link>
                  ))}
                </div>
              ) : (
                <p className={styles.chartEmpty}>No makers recorded yet.</p>
              )}
              <div className={styles.panelFoot}>
                <span>Share of all knives</span>
                <DetailLink href="/insights/makers">All makers</DetailLink>
              </div>
            </Panel>

            <Panel
              title="Measurement distribution"
              description="See the sizes and weights you collect most."
              className={styles.carry}
              action={
                <div
                  className={styles.range}
                  role="group"
                  aria-label="Measurement"
                >
                  {MEASUREMENTS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      aria-pressed={measurementKey === item.value}
                      onClick={() => {
                        setMeasurementKey(item.value)
                        setSelectedBinLabel(undefined)
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              }
            >
              <div className={styles.chartSummary}>
                <div>
                  <strong className={styles.chartValue}>
                    {formatMeasurement(measurement.median)}
                    <small>{measurement.unit}</small>
                  </strong>
                  <p>median {measurement.label.toLowerCase()}</p>
                </div>
                {peakBin.count > 0 && (
                  <div className={styles.summaryAside}>
                    <strong>{peakBin.label}</strong>
                    <p>most common · {number.format(peakBin.count)} knives</p>
                  </div>
                )}
              </div>
              {measurement.knownCount > 0 ? (
                <Bars
                  label={`${measurement.label} distribution`}
                  data={measurement.bins.map((bin) => ({
                    key: bin.label,
                    label: compactBinLabel(bin.label),
                    count: bin.count,
                    description: `${bin.label}: ${number.format(bin.count)} knives, ${Math.round((bin.count / measurement.knownCount) * 100)}% of measured`,
                    highlighted: bin.count === peakBin.count,
                  }))}
                  selectedKey={selectedBinLabel}
                  onSelect={setSelectedBinLabel}
                  minBarWidth={44}
                />
              ) : (
                <div className={styles.chartEmpty}>
                  <p>
                    No readable {measurement.label.toLowerCase()} measurements
                    yet.
                  </p>
                  <DetailLink href="/insights/completeness">
                    Find missing measurements
                  </DetailLink>
                </div>
              )}
              <div className={styles.chartContext}>
                <span>
                  {number.format(measurement.knownCount)} measured ·{' '}
                  {number.format(measurement.missingCount)} missing
                  {measurement.uninterpretableCount > 0 &&
                    ` · ${number.format(measurement.uninterpretableCount)} unreadable`}
                </span>
                <span aria-live="polite">
                  {selectedBin && measurement.knownCount > 0
                    ? `${selectedBin.label} · ${number.format(selectedBin.count)} knives · ${Math.round((selectedBin.count / measurement.knownCount) * 100)}%`
                    : 'Select a range to see its share'}
                </span>
              </div>
              {measurement.knownCount > 0 && (
                <details className={styles.chartData}>
                  <summary>View distribution data</summary>
                  <table>
                    <caption className="sr-only">
                      {measurement.label} distribution. Lower bounds inclusive,
                      upper bounds exclusive.
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Range</th>
                        <th scope="col">Knives</th>
                        <th scope="col">Share of measured</th>
                      </tr>
                    </thead>
                    <tbody>
                      {measurement.bins.map((bin) => (
                        <tr key={bin.label}>
                          <th scope="row">{bin.label}</th>
                          <td>{number.format(bin.count)}</td>
                          <td>
                            {Math.round(
                              (bin.count / measurement.knownCount) * 100,
                            )}
                            %
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
              <div className={styles.panelFoot}>
                <span>
                  Recorded range: {formatMeasurement(measurement.min)}–
                  {formatMeasurement(measurement.max)} {measurement.unit}
                </span>
                <DetailLink
                  href={`/insights/measurements?tab=${measurementKey}`}
                >
                  Explore measurements
                </DetailLink>
              </div>
            </Panel>

            <Panel
              title="Steel mix"
              description="The materials behind your collection."
              className={styles.steels}
              action={
                <span className={styles.sampleBadge}>
                  {steelCategories.length} steels recorded
                </span>
              }
            >
              {steelCategories[0] && (
                <div className={styles.steelLead}>
                  <div>
                    <strong>{steelCategories[0].name}</strong>
                    <span>Leading recorded steel</span>
                  </div>
                  <div>
                    <strong>
                      {steelCategories[0].percent}
                      <small>%</small>
                    </strong>
                    <span>of all knives</span>
                  </div>
                </div>
              )}
              <div className={styles.steelBand} aria-hidden="true">
                {steelSegments.map((item) => (
                  <span
                    key={item.name}
                    style={{ flex: item.count, background: item.color }}
                  />
                ))}
              </div>
              <div className={styles.steelLegend}>
                {steelSegments.map((item) => (
                  <Link key={item.name} href={item.href}>
                    <span
                      className={styles.swatch}
                      style={{ background: item.color }}
                    />
                    <span>{item.name}</span>
                    <strong>{item.count}</strong>
                    <small>
                      {Math.round((item.count / stats.total) * 100)}%
                    </small>
                  </Link>
                ))}
              </div>
              <div className={styles.panelFoot}>
                <span>
                  Every knife included · missing steel shown separately
                </span>
                <DetailLink href="/insights/blade-steels">
                  All steels
                </DetailLink>
              </div>
            </Panel>

            <Panel
              title="Recent additions"
              description="The latest knives in your catalogue."
              className={styles.recent}
            >
              <div className={styles.recentList}>
                {stats.recent.map((knife) => (
                  <Link
                    key={knife.id}
                    href={`/collection/${encodeURIComponent(knife.id)}`}
                    className={styles.recentRow}
                  >
                    <span className={styles.thumbnail}>
                      {knife.images[0] ? (
                        <Image
                          src={getImageUrl(knife.images[0])}
                          alt=""
                          fill
                          sizes="44px"
                          className="object-contain"
                        />
                      ) : (
                        <span aria-hidden="true">—</span>
                      )}
                    </span>
                    <span className={styles.recentIdentity}>
                      <strong>{knife.name}</strong>
                      <span>{knife.brand || 'Maker not recorded'}</span>
                    </span>
                    <time
                      dateTime={
                        Number.isFinite(Date.parse(knife.addedAt))
                          ? knife.addedAt
                          : undefined
                      }
                    >
                      {formatDate(knife.addedAt)}
                    </time>
                  </Link>
                ))}
              </div>
              <div className={styles.panelFoot}>
                <DetailLink href="/insights/recent">All additions</DetailLink>
              </div>
            </Panel>
          </div>
        </>
      )}
    </div>
  )
}

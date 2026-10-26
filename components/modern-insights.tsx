'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useId, useMemo, useState, type ReactNode } from 'react'
import { ArrowUpRight, Plus, Printer } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { InsightsChart } from '@/components/insights-chart'
import { Button, buttonVariants } from '@/components/ui/button'
import { useKnives } from '@/components/providers/knives-provider'
import {
  buildCatalogueOption,
  buildCarryOption,
} from '@/components/modern-insights-charts'
import {
  createCollectionStats,
  type CategoryStat,
} from '@/lib/collection-stats'
import { getImageUrl, type Knife } from '@/lib/data'
import { groupKnifeFamilies } from '@/lib/knife-families'
import {
  buildCatalogueSeries,
  buildCarryPoints,
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

export function ModernInsights() {
  const { knives, isLoading } = useKnives()
  const router = useRouter()
  const [range, setRange] = useState<ModernInsightsRange>('6m')
  const stats = useMemo(() => createCollectionStats(knives, 'all'), [knives])
  const catalogue = useMemo(
    () => buildCatalogueSeries(knives, range, new Date()),
    [knives, range],
  )
  const carry = useMemo(() => buildCarryPoints(knives), [knives])
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

  return (
    <div className={styles.root} data-modern-insights>
      <PageHeader
        title="Collection pulse"
        description="A closer look at what you collect."
        actions={
          <>
            <Link
              href="/collection"
              className={cn(
                buttonVariants({ variant: 'outline', size: 'sm' }),
                styles.headerAction,
              )}
            >
              Open collection <ArrowUpRight size={14} />
            </Link>
            <Button
              variant="outline"
              size="sm"
              className={cn(styles.headerAction, styles.printAction)}
              onClick={() => window.print()}
            >
              <Printer size={14} /> Print overview
            </Button>
          </>
        }
      />
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
              title="Catalogue growth"
              description="Current records, by the date they were added."
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
                      onClick={() => setRange(item.value)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              }
            >
              <div className={styles.growthSummary}>
                <span>
                  <strong>{number.format(catalogue.datedCount)}</strong> dated
                  records · {number.format(catalogue.addedInRange)} added in
                  this range
                </span>
                <span>
                  {catalogue.points[0].label} – {catalogue.points.at(-1)?.label}
                </span>
              </div>
              {catalogue.datedCount > 0 ? (
                <InsightsChart
                  className={styles.growthChart}
                  ariaLabel={`Cumulative catalogue records from ${catalogue.points[0].label} to ${catalogue.points.at(-1)?.label}; ${catalogue.datedCount} dated records`}
                  buildOption={(palette) =>
                    buildCatalogueOption(palette, catalogue.points)
                  }
                />
              ) : (
                <p className={styles.chartEmpty}>
                  No valid catalogue dates to plot yet.
                </p>
              )}
              <div className={styles.panelFoot}>
                <span>
                  {catalogue.excludedCount
                    ? `${catalogue.excludedCount} invalid or future dates excluded.`
                    : 'Includes all catalogued records, including those marked sold.'}
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
              title="Carry profile"
              description="How blade length and weight sit together."
              className={styles.carry}
              action={
                <span className={styles.sampleBadge}>
                  {carry.length} paired measurements
                </span>
              }
            >
              {carry.length ? (
                <InsightsChart
                  className={styles.carryChart}
                  ariaLabel={`Blade length versus weight for ${carry.length} catalogued ${carry.length === 1 ? 'knife' : 'knives'}`}
                  buildOption={(palette) => buildCarryOption(palette, carry)}
                  onChartClick={({ dataIndex }) => {
                    if (dataIndex !== undefined && carry[dataIndex])
                      router.push(
                        `/collection/${encodeURIComponent(carry[dataIndex].id)}`,
                      )
                  }}
                />
              ) : (
                <div className={styles.chartEmpty}>
                  <p>Add blade length and weight to see your carry profile.</p>
                  <DetailLink href="/insights/completeness">
                    Find missing measurements
                  </DetailLink>
                </div>
              )}
              <div className={styles.panelFoot}>
                <span>
                  One dot per knife · inches / ounces
                  {carry.length < stats.total
                    ? ` · ${stats.total - carry.length} without a readable pair`
                    : ''}
                </span>
                <DetailLink href="/insights/measurements?tab=weight">
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

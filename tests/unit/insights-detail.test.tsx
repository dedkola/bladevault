// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActivityDetail } from '@/components/insight-pages/activity-detail'
import { CategoryDetail } from '@/components/insight-pages/category-detail'
import { CompletenessDetail } from '@/components/insight-pages/completeness-detail'
import { InsightDetailShell } from '@/components/insight-pages/insight-detail-shell'
import { LibraryDetail } from '@/components/insight-pages/library-detail'
import { MeasurementDetail } from '@/components/insight-pages/measurement-detail'
import { RecentDetail } from '@/components/insight-pages/recent-detail'
import {
  getHorizontalBarOption,
  getLockTypeOption,
  getMakerOption,
} from '@/components/collection-insights'
import type { InsightsChartPalette } from '@/components/insights-chart'
import type { Knife } from '@/lib/data'
import {
  isInsightCategorySlug,
  isInsightSlug,
  isMeasurementKey,
} from '@/lib/insight-stats'
import { createKnife } from '@/tests/fixtures/knife'

const mockKnives = vi.hoisted(() => ({
  current: [] as Knife[],
  isLoading: false,
}))

vi.mock('@/components/providers/knives-provider', () => ({
  useKnives: () => ({
    knives: mockKnives.current,
    isLoading: mockKnives.isLoading,
  }),
  KnivesProvider: ({ children }: { children: React.ReactNode }) => children,
}))

vi.mock('@/components/insights-chart', () => ({
  InsightsChart: ({ ariaLabel }: { ariaLabel: string }) => (
    <div data-testid="insights-chart" aria-label={ariaLabel} />
  ),
}))

function setKnives(knives: Knife[], isLoading = false) {
  mockKnives.current = knives
  mockKnives.isLoading = isLoading
}

afterEach(cleanup)

const chartPalette: InsightsChartPalette = {
  card: '#fffdf8',
  foreground: '#2f2a20',
  muted: '#6f6751',
  surface: '#f7f1e5',
  line: '#d3c097',
  ringTrack: '#eee6d7',
  gold: '#c89c3d',
  highlightWash: 'rgba(200, 156, 61, 0.14)',
  chartPrimary: '#2e3417',
  chartSecondary: '#79824a',
}

describe('insight detail slug validation', () => {
  it('accepts known insight slugs', () => {
    expect(isInsightSlug('makers')).toBe(true)
    expect(isInsightSlug('measurements')).toBe(true)
    expect(isInsightSlug('recent')).toBe(true)
  })

  it('rejects unknown slugs', () => {
    expect(isInsightSlug('unknown')).toBe(false)
    expect(isInsightSlug('')).toBe(false)
  })

  it('identifies category slugs', () => {
    expect(isInsightCategorySlug('makers')).toBe(true)
    expect(isInsightCategorySlug('designers')).toBe(true)
    expect(isInsightCategorySlug('measurements')).toBe(false)
  })

  it('identifies measurement keys', () => {
    expect(isMeasurementKey('bladeLength')).toBe(true)
    expect(isMeasurementKey('weight')).toBe(true)
    expect(isMeasurementKey('blade')).toBe(false)
  })
})

describe('InsightDetailShell', () => {
  it('renders the back link, eyebrow, title, and children', () => {
    setKnives([createKnife()])
    render(
      <InsightDetailShell eyebrow="Test" title="Test title">
        <div data-testid="child">child content</div>
      </InsightDetailShell>,
    )

    expect(
      screen.getByRole('button', { name: /back to insights/i }),
    ).toHaveAttribute('href', '/')
    expect(screen.getByText('Test')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Test title' }),
    ).toBeInTheDocument()
    expect(screen.getByTestId('child')).toBeInTheDocument()
  })

  it('shows a loading placeholder while knives load', () => {
    setKnives([], true)
    render(
      <InsightDetailShell eyebrow="Test" title="Test title">
        <div>child</div>
      </InsightDetailShell>,
    )

    expect(screen.queryByText('child')).not.toBeInTheDocument()
  })

  it('shows an empty state when there are no knives', () => {
    setKnives([])
    render(
      <InsightDetailShell eyebrow="Test" title="Test title">
        <div>child</div>
      </InsightDetailShell>,
    )

    expect(screen.getByText('No collection data yet')).toBeInTheDocument()
    expect(screen.queryByText('child')).not.toBeInTheDocument()
  })
})

describe('CategoryDetail', () => {
  it('renders compact overview tooltips above cards without executing HTML', () => {
    const categories = [
      {
        name: '<img src=x onerror="window.__bladevaultXss=1">',
        count: 64,
        percent: 38,
        knifeIds: ['knife'],
      },
    ]
    const options = [
      {
        option: getMakerOption(categories, 1, chartPalette),
        expected: `${categories[0].name}: 64 (38%)`,
      },
      {
        option: getLockTypeOption(categories, 1, chartPalette),
        expected: `${categories[0].name}: 64 knives (38%)`,
      },
    ]

    for (const { option, expected } of options) {
      expect(option.tooltip).toMatchObject({
        renderMode: 'html',
        appendTo: '#insights-chart-tooltip-portal',
        confine: false,
      })

      const formatter = (
        option.tooltip as {
          formatter: (params: { dataIndex: number }) => HTMLElement
        }
      ).formatter
      const content = formatter({ dataIndex: 0 })
      expect(content).toBeInstanceOf(HTMLElement)
      expect(content.textContent).toBe(expected)
      expect(content.querySelector('img')).toBeNull()
    }
  })

  it('uses non-HTML tooltips for persisted category names', () => {
    const option = getHorizontalBarOption(
      [
        {
          name: '<img src=x onerror="window.__bladevaultXss=1">',
          count: 1,
          percent: 100,
          knifeIds: ['knife'],
        },
      ],
      chartPalette,
    )

    expect(option.tooltip).toMatchObject({
      renderMode: 'richText',
      confine: true,
    })
    expect(option.tooltip).not.toHaveProperty('appendTo')
    expect(option.tooltip).not.toHaveProperty('extraCssText')

    const formatter = (
      option.tooltip as {
        formatter: (params: Array<{ dataIndex: number }>) => string
      }
    ).formatter
    expect(formatter([{ dataIndex: 0 }])).toBe(
      '<img src=x onerror="window.__bladevaultXss=1">: 1 (100%)',
    )
  })

  it('renders a row for every category', () => {
    setKnives([
      createKnife({ id: 'a', brand: 'Benchmade' }),
      createKnife({ id: 'b', brand: 'Spyderco' }),
      createKnife({ id: 'c', brand: 'Benchmade' }),
    ])
    render(<CategoryDetail categoryKey="brand" title="Makers" />)

    const index = within(screen.getByRole('region', { name: 'All makers' }))
    expect(index.getByRole('link', { name: /benchmade/i })).toHaveAttribute(
      'href',
      '/collection?brand=Benchmade',
    )
    expect(index.getByRole('link', { name: /spyderco/i })).toHaveAttribute(
      'href',
      '/collection?brand=Spyderco',
    )
  })

  it('keeps the full directory available beside the eight leading categories', () => {
    setKnives(
      Array.from({ length: 10 }, (_, index) =>
        createKnife({ id: String(index), brand: `Maker ${index}` }),
      ),
    )
    render(<CategoryDetail categoryKey="brand" title="Makers" />)
    const distribution = within(
      screen.getByRole('region', { name: 'Makers distribution' }),
    )
    const index = within(screen.getByRole('region', { name: 'All makers' }))
    expect(distribution.getAllByRole('link')).toHaveLength(8)
    expect(
      index
        .getAllByRole('link')
        .filter((link) =>
          link.getAttribute('href')?.startsWith('/collection?brand='),
        ),
    ).toHaveLength(10)
  })

  it('uses the whole collection for shares and explains missing categories', () => {
    setKnives([
      createKnife({ id: 'known', bladeStyle: 'Drop Point' }),
      createKnife({ id: 'missing', bladeStyle: '' }),
    ])
    render(<CategoryDetail categoryKey="bladeStyle" title="Blade shapes" />)

    const distribution = within(
      screen.getByRole('region', { name: 'Blade shapes distribution' }),
    )
    expect(
      distribution.getByRole('link', {
        name: 'Drop Point: 1 knife, 50% of collection',
      }),
    ).toHaveAttribute('href', '/collection?bladeStyle=Drop+Point')
    expect(
      screen.getByText(/1 knife has no blade shape recorded/),
    ).toHaveTextContent('Shares include all 2 knives.')
    expect(
      screen.queryByRole('button', { name: 'Show full distribution' }),
    ).not.toBeInTheDocument()
  })

  it('renders a "Not set" row for designers when missing', () => {
    setKnives([
      createKnife({ id: 'a', specs: { ...createKnife().specs, designer: '' } }),
    ])
    render(<CategoryDetail categoryKey="designer" title="Designers" />)

    expect(screen.getByRole('link', { name: /not set/i })).toHaveAttribute(
      'href',
      '/collection?designer=__not_set__',
    )
  })
})

describe('MeasurementDetail', () => {
  it('shows all four distributions and opens the matching records for a populated bin', async () => {
    const user = userEvent.setup()
    setKnives([createKnife()])
    render(<MeasurementDetail />)
    for (const label of [
      'Blade length',
      'Overall length',
      'Weight',
      'Blade thickness',
    ])
      expect(
        screen.getByRole('region', { name: `${label} distribution` }),
      ).toBeInTheDocument()
    const bins = within(
      screen.getByLabelText('Blade length ranges'),
    ).getAllByRole('button')
    expect(bins).toHaveLength(10)
    const populated = bins.find((bin) => !bin.hasAttribute('disabled'))!
    await user.click(populated)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(
      within(screen.getByRole('dialog')).getByRole('link'),
    ).toHaveAttribute('href', '/collection/benchmade-bugout')
  })
  it('highlights the requested measurement while keeping the other distributions visible', () => {
    setKnives([createKnife()])
    render(<MeasurementDetail initialTab="weight" />)
    expect(
      screen.getByRole('region', { name: 'Weight distribution' }),
    ).toHaveClass('id-selected-measurement')
    expect(
      screen.getByRole('region', { name: 'Blade length distribution' }),
    ).toBeInTheDocument()
  })
})

describe('LibraryDetail', () => {
  it('renders total, yearly additions, and pinned count', () => {
    setKnives([
      createKnife({ id: 'a', pinned: true }),
      createKnife({ id: 'b' }),
    ])
    render(<LibraryDetail />)

    for (const [label, value] of [
      ['Total knives', '2'],
      ['Added this year', '2'],
      ['Pinned', '1'],
    ]) {
      expect(
        screen.getByText(label).closest('.id-metric')?.querySelector('dd'),
      ).toHaveTextContent(value)
    }
  })
})

describe('CompletenessDetail', () => {
  it('renders all missing-field rows', () => {
    setKnives([
      createKnife({
        id: 'a',
        specs: { ...createKnife().specs, designer: '' },
      }),
    ])
    render(<CompletenessDetail />)

    expect(
      screen.getByRole('link', { name: /designer missing/i }),
    ).toBeInTheDocument()
  })

  it('shows the populated-fields message when all reviewed fields are present', () => {
    setKnives([
      createKnife({
        id: 'a',
        specs: {
          ...createKnife().specs,
          designer: 'Designer',
          bladeCoating: 'Stonewash',
        },
        handleMaterial: 'G10',
      }),
    ])
    render(<CompletenessDetail />)

    expect(
      screen.getByText('All reviewed fields populated'),
    ).toBeInTheDocument()
  })
})

describe('ActivityDetail', () => {
  it('renders the heatmap and active-day lists', () => {
    setKnives([createKnife({ id: 'a', addedAt: new Date().toISOString() })])
    render(<ActivityDetail />)

    expect(screen.getByText('Last 52 weeks')).toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: 'Active days' }),
    ).toHaveTextContent('1 knife added')
  })
})

describe('RecentDetail', () => {
  it('lists all knives sorted by most recently added', () => {
    setKnives([
      createKnife({ id: 'older', addedAt: '2026-01-01T00:00:00.000Z' }),
      createKnife({ id: 'newer', addedAt: '2026-08-01T00:00:00.000Z' }),
    ])
    render(<RecentDetail />)

    const links = within(
      screen.getByRole('region', { name: 'All additions' }),
    ).getAllByRole('link')
    expect(links[0]).toHaveAttribute('href', '/collection/newer')
    expect(links[1]).toHaveAttribute('href', '/collection/older')
  })
})

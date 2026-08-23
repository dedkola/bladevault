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
  it('renders a row for every category', () => {
    setKnives([
      createKnife({ id: 'a', brand: 'Benchmade' }),
      createKnife({ id: 'b', brand: 'Spyderco' }),
      createKnife({ id: 'c', brand: 'Benchmade' }),
    ])
    render(<CategoryDetail categoryKey="brand" title="Makers" />)

    expect(screen.getByRole('link', { name: /benchmade/i })).toHaveAttribute(
      'href',
      '/collection?brand=Benchmade',
    )
    expect(screen.getByRole('link', { name: /spyderco/i })).toHaveAttribute(
      'href',
      '/collection?brand=Spyderco',
    )
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
  it('renders all four tabs and switches the active measurement', async () => {
    const user = userEvent.setup()
    setKnives([createKnife()])
    render(<MeasurementDetail />)

    expect(screen.getByRole('tablist')).toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(4)
    expect(screen.getByTestId('insights-chart')).toHaveAttribute(
      'aria-label',
      'Blade length distribution',
    )

    await user.click(screen.getByRole('tab', { name: /weight/i }))
    expect(screen.getByTestId('insights-chart')).toHaveAttribute(
      'aria-label',
      'Weight distribution',
    )
  })

  it('respects the initial tab from the query parameter', () => {
    setKnives([createKnife()])
    render(<MeasurementDetail initialTab="weight" />)

    expect(screen.getByTestId('insights-chart')).toHaveAttribute(
      'aria-label',
      'Weight distribution',
    )
  })
})

describe('LibraryDetail', () => {
  it('renders total, yearly additions, and pinned count', () => {
    setKnives([
      createKnife({ id: 'a', pinned: true }),
      createKnife({ id: 'b' }),
    ])
    render(<LibraryDetail />)

    expect(screen.getByText('Total knives').parentElement).toHaveTextContent(
      /Total knives\s*2/,
    )
    expect(screen.getByText('Added this year').parentElement).toHaveTextContent(
      /Added this year\s*2/,
    )
    expect(screen.getByText('Pinned').parentElement).toHaveTextContent(
      /Pinned\s*1/,
    )
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

  it('shows the all-complete message when nothing is missing', () => {
    setKnives([
      createKnife({
        id: 'a',
        specs: { ...createKnife().specs, designer: 'Designer' },
        handleMaterial: 'G10',
      }),
    ])
    render(<CompletenessDetail />)

    expect(screen.getByText('All fields complete')).toBeInTheDocument()
  })
})

describe('ActivityDetail', () => {
  it('renders the heatmap and active-day lists', () => {
    setKnives([createKnife({ id: 'a', addedAt: new Date().toISOString() })])
    render(<ActivityDetail />)

    expect(screen.getByText('Last 52 weeks')).toBeInTheDocument()
    expect(screen.getByText('Added')).toBeInTheDocument()
  })
})

describe('RecentDetail', () => {
  it('lists all knives sorted by most recently added', () => {
    setKnives([
      createKnife({ id: 'older', addedAt: '2026-01-01T00:00:00.000Z' }),
      createKnife({ id: 'newer', addedAt: '2026-08-01T00:00:00.000Z' }),
    ])
    render(<RecentDetail />)

    const links = screen.getAllByRole('link')
    expect(links[0]).toHaveAttribute('href', '/collection/newer')
    expect(links[1]).toHaveAttribute('href', '/collection/older')
  })
})

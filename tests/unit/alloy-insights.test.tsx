// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InsightsPage } from '@/components/insights-page'
import { createKnife } from '@/tests/fixtures/knife'

const preference = vi.hoisted(() => ({
  dimensionUnit: 'in' as 'in' | 'mm' | 'both',
}))

vi.mock('@/components/providers/knives-provider', () => ({
  useKnives: () => ({
    knives: [createKnife()],
    isLoading: false,
    themeStyle: 'alloy',
    dimensionUnit: preference.dimensionUnit,
  }),
}))

afterEach(() => {
  cleanup()
  preference.dimensionUnit = 'in'
})

describe('Alloy Insights', () => {
  it('uses the same dimension preference for the median and chart data', () => {
    preference.dimensionUnit = 'both'
    render(<InsightsPage />)
    expect(
      screen.getByRole('group', { name: 'Median blade' }),
    ).toHaveTextContent('82.296 mm / 3.24 in')
    const chart = screen.getByRole('region', {
      name: 'Measurement distribution',
    })
    expect(chart).toHaveTextContent('82.296 mm / 3.24 in')
    expect(chart).toHaveTextContent('76.2–82.55 mm / 3–3.25 in')
  })

  it('switches the weight chart and data table to metric or dual units', async () => {
    const user = userEvent.setup()
    preference.dimensionUnit = 'mm'
    const { rerender } = render(<InsightsPage />)
    const measurements = screen.getByRole('region', {
      name: /^Measurement distribution$/,
    })
    await user.click(
      within(measurements).getByRole('button', { name: 'Weight' }),
    )
    expect(measurements).toHaveTextContent('52.447 g')
    expect(measurements).not.toHaveTextContent('oz')
    preference.dimensionUnit = 'both'
    rerender(<InsightsPage />)
    expect(measurements).toHaveTextContent('52.447 g / 1.85 oz')
    await user.click(within(measurements).getByText('View distribution data'))
    expect(within(measurements).getByRole('table')).toHaveTextContent('g /')
    expect(within(measurements).getByRole('table')).toHaveTextContent('oz')
  })

  it('keeps interactive measurement charts and accessible data in the Alloy view', async () => {
    const user = userEvent.setup()
    const { container } = render(<InsightsPage />)
    expect(
      screen.getByRole('heading', { level: 1, name: 'Collection Insights' }),
    ).toHaveClass('sr-only')
    expect(screen.queryByText('Know your collection.')).not.toBeInTheDocument()
    expect(container.querySelector('[data-alloy-insights]')).toBeInTheDocument()
    expect(
      screen.getByRole('group', { name: /^Catalogued knives$/ }),
    ).toHaveTextContent('1')

    const measurements = screen.getByRole('region', {
      name: /^Measurement distribution$/,
    })
    await user.click(
      within(measurements).getByRole('button', { name: 'Weight' }),
    )
    expect(measurements).toHaveTextContent('median weight')
    await user.click(within(measurements).getByText('View distribution data'))
    expect(within(measurements).getByRole('table')).toBeVisible()
    expect(
      within(measurements).getByRole('link', { name: 'Explore measurements' }),
    ).toHaveAttribute('href', '/insights/measurements?tab=weight')
  })
})

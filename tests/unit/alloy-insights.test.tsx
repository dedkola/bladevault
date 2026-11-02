// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InsightsPage } from '@/components/insights-page'
import { createKnife } from '@/tests/fixtures/knife'

vi.mock('@/components/providers/knives-provider', () => ({
  useKnives: () => ({
    knives: [createKnife()],
    isLoading: false,
    themeStyle: 'alloy',
  }),
}))

afterEach(cleanup)

describe('Alloy Insights', () => {
  it('keeps interactive measurement charts and accessible data in the Alloy view', async () => {
    const user = userEvent.setup()
    const { container } = render(<InsightsPage />)
    expect(
      screen.getByRole('heading', { level: 1, name: 'Know your collection.' }),
    ).toBeVisible()
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

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { PriceMonitorScope } from '@/lib/settings-shared'

const knives = [
  { id: 'a', brand: 'Spyderco', name: 'Shaman', sold: false, specs: {} },
  { id: 'b', brand: 'Benchmade', name: 'Bugout', sold: false, specs: {} },
  { id: 'c', brand: 'Spyderco', name: 'Para 3', sold: true, specs: {} },
]
const wishlist = [{ knifeId: 'b' }, { knifeId: 'c' }, { knifeId: 'gone' }]

vi.mock('@/components/providers/knives-provider', () => ({
  useKnives: () => ({ knives }),
}))
vi.mock('@/components/providers/wishlist-provider', () => ({
  useWishlist: () => ({ items: wishlist }),
}))

const { MonitorScopeSettings } =
  await import('@/components/price-drops/monitor-scope-settings')

function Harness({
  initial,
  onChange,
}: {
  initial: PriceMonitorScope
  onChange: (scope: PriceMonitorScope) => void
}) {
  const [scope, setScope] = useState(initial)
  return (
    <MonitorScopeSettings
      scope={scope}
      onChange={(next) => {
        onChange(next)
        setScope(next)
      }}
    />
  )
}

const ALL: PriceMonitorScope = { kind: 'all', knifeIds: [] }

afterEach(cleanup)

it('stops monitoring every knife after confirming, and undoes it', async () => {
  const onChange = vi.fn()
  const user = userEvent.setup()
  render(<Harness initial={ALL} onChange={onChange} />)
  expect(screen.getByText('Whole collection')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Stop monitoring all' }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText(/Stop monitoring all 3 knives/)).toBeVisible()
  await user.click(
    within(dialog).getByRole('button', { name: 'Stop monitoring' }),
  )

  expect(onChange).toHaveBeenLastCalledWith({
    kind: 'selected',
    knifeIds: [],
  })
  expect(screen.getByText(/Nothing: monitoring is stopped/)).toBeVisible()
  expect(
    screen.getByRole('button', { name: 'Stop monitoring all' }),
  ).toBeDisabled()

  await user.click(screen.getByRole('button', { name: 'Undo' }))
  expect(onChange).toHaveBeenLastCalledWith(ALL)
})

it('picks knives with search and applies the selection', async () => {
  const onChange = vi.fn()
  const user = userEvent.setup()
  render(<Harness initial={ALL} onChange={onChange} />)

  await user.click(screen.getByRole('button', { name: /Change/ }))
  await user.click(screen.getByRole('radio', { name: 'Selected knives' }))
  await user.type(screen.getByRole('textbox', { name: 'Search knives' }), 'spy')
  const list = screen.getByRole('list', { name: 'Knives' })
  expect(within(list).getAllByRole('listitem')).toHaveLength(2)
  await user.click(screen.getByRole('button', { name: 'Select all shown' }))
  expect(screen.getByText('2 of 3 selected')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Apply' }))

  expect(onChange).toHaveBeenLastCalledWith({
    kind: 'selected',
    knifeIds: ['c', 'a'],
  })
  expect(screen.getByText(/2 selected knives/)).toBeVisible()
})

it('opens on the Wishlist tab and follows the Wishlist', async () => {
  const onChange = vi.fn()
  const user = userEvent.setup()
  render(<Harness initial={ALL} onChange={onChange} />)

  await user.click(screen.getByRole('button', { name: /Change/ }))
  expect(screen.getByRole('radio', { name: 'Wishlist' })).toBeChecked()
  expect(
    screen.queryByRole('radio', { name: 'Compare lists' }),
  ).not.toBeInTheDocument()
  const list = screen.getByRole('list', { name: 'Wishlist knives' })
  expect(within(list).getAllByRole('listitem')).toHaveLength(2)
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onChange).not.toHaveBeenCalled()

  await user.click(screen.getByRole('button', { name: /Change/ }))
  await user.click(screen.getByRole('button', { name: 'Apply' }))
  expect(onChange).toHaveBeenLastCalledWith({ kind: 'wishlist', knifeIds: [] })
  expect(screen.getByText(/Wishlist: 2 knives/)).toBeVisible()

  await user.click(screen.getByRole('button', { name: /Change/ }))
  await user.click(
    screen.getByRole('button', { name: 'Monitor whole collection' }),
  )
  expect(onChange).toHaveBeenLastCalledWith(ALL)
})

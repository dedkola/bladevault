// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopBackgroundSettings } from '@/components/price-drops/desktop-background-settings'

type Desktop = NonNullable<Window['bladevaultDesktop']>

function installBridge(initial: boolean) {
  let current = initial
  const bridge = {
    getBackgroundMode: vi.fn(async () => current),
    setBackgroundMode: vi.fn(async (enabled: boolean) => {
      current = enabled
      return current
    }),
  }
  window.bladevaultDesktop = bridge as unknown as Desktop
  return bridge
}

afterEach(() => {
  cleanup()
  delete window.bladevaultDesktop
})

it('renders nothing outside the desktop app', () => {
  const { container } = render(<DesktopBackgroundSettings />)
  expect(container).toBeEmptyDOMElement()
})

it('renders nothing in a desktop build without the background bridge', () => {
  window.bladevaultDesktop = {} as Desktop
  const { container } = render(<DesktopBackgroundSettings />)
  expect(container).toBeEmptyDOMElement()
})

it('shows the saved choice and saves a change', async () => {
  const bridge = installBridge(false)
  render(<DesktopBackgroundSettings />)

  const toggle = await screen.findByRole('switch', {
    name: 'Keep running in the background',
  })
  expect(toggle).not.toBeChecked()

  await userEvent.click(toggle)

  expect(bridge.setBackgroundMode).toHaveBeenCalledWith(true)
  expect(toggle).toBeChecked()
})

it('reports a failed save and keeps the previous state', async () => {
  const bridge = installBridge(true)
  bridge.setBackgroundMode.mockRejectedValueOnce(new Error('disk full'))
  render(<DesktopBackgroundSettings />)

  const toggle = await screen.findByRole('switch', {
    name: 'Keep running in the background',
  })
  await userEvent.click(toggle)

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Could not save the background setting.',
  )
  expect(toggle).toBeChecked()
})

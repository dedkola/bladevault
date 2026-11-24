// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopNotificationSettings } from '@/components/price-drops/desktop-notification-settings'

type Desktop = NonNullable<Window['bladevaultDesktop']>

function installBridge(initial: { enabled: boolean; supported: boolean }) {
  let status = initial
  const bridge = {
    getPriceNotifications: vi.fn(async () => status),
    setPriceNotifications: vi.fn(async (enabled: boolean) => {
      status = { ...status, enabled }
      return status
    }),
  }
  window.bladevaultDesktop = bridge as unknown as Desktop
  return bridge
}

afterEach(() => {
  cleanup()
  delete window.bladevaultDesktop
})

it('renders nothing without the notification bridge', () => {
  window.bladevaultDesktop = {} as Desktop
  const { container } = render(<DesktopNotificationSettings />)
  expect(container).toBeEmptyDOMElement()
})

it('shows the saved choice and saves a change', async () => {
  const bridge = installBridge({ enabled: false, supported: true })
  render(<DesktopNotificationSettings />)

  const toggle = await screen.findByRole('switch', {
    name: 'Desktop notifications for price drops',
  })
  expect(toggle).not.toBeChecked()
  await userEvent.click(toggle)
  expect(bridge.setPriceNotifications).toHaveBeenCalledWith(true)
  expect(toggle).toBeChecked()
})

it('disables the switch where the system has no notifications', async () => {
  installBridge({ enabled: false, supported: false })
  render(<DesktopNotificationSettings />)
  expect(
    await screen.findByRole('switch', {
      name: 'Desktop notifications for price drops',
    }),
  ).toBeDisabled()
})

it('reports a failed save', async () => {
  const bridge = installBridge({ enabled: true, supported: true })
  bridge.setPriceNotifications.mockRejectedValueOnce(new Error('denied'))
  render(<DesktopNotificationSettings />)

  const toggle = await screen.findByRole('switch', {
    name: 'Desktop notifications for price drops',
  })
  await userEvent.click(toggle)
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Could not save the notification setting.',
  )
  expect(toggle).toBeChecked()
})

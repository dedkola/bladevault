// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopErrorReportingSettings } from '@/components/desktop-error-reporting-settings'

type Desktop = NonNullable<Window['bladevaultDesktop']>

function installBridge(initial: BladeVaultErrorReportingStatus) {
  let current = initial
  const errorReporting = {
    get: vi.fn(async () => current),
    set: vi.fn(async (enabled: boolean, usageMetrics = true) => {
      current = {
        ...current,
        enabled,
        usageMetrics: enabled && usageMetrics,
        restartRequired: true,
      }
      return current
    }),
    restart: vi.fn(async () => {}),
  }
  window.bladevaultDesktop = { errorReporting } as unknown as Desktop
  return errorReporting
}

afterEach(() => {
  cleanup()
  delete window.bladevaultDesktop
})

it('renders nothing outside the desktop app', () => {
  const { container } = render(<DesktopErrorReportingSettings />)
  expect(container).toBeEmptyDOMElement()
})

it('starts unchecked and asks for a restart after opting in', async () => {
  const bridge = installBridge({
    available: true,
    enabled: false,
    usageMetrics: false,
    restartRequired: false,
  })
  render(<DesktopErrorReportingSettings />)

  const toggle = await screen.findByRole('checkbox', {
    name: 'Send error reports',
  })
  expect(toggle).not.toBeChecked()
  expect(screen.queryByText('Restart now')).not.toBeInTheDocument()

  await userEvent.click(toggle)

  expect(bridge.set).toHaveBeenCalledWith(true, true)
  expect(
    await screen.findByText('Your change applies after BladeVault restarts.'),
  ).toBeInTheDocument()

  await userEvent.click(screen.getByRole('button', { name: 'Restart now' }))
  expect(bridge.restart).toHaveBeenCalledTimes(1)
})

it('explains when the build has no error reporting', async () => {
  installBridge({
    available: false,
    enabled: false,
    usageMetrics: false,
    restartRequired: false,
  })
  render(<DesktopErrorReportingSettings />)

  expect(
    await screen.findByText('Not available in this build.'),
  ).toBeInTheDocument()
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
})

it('shows crash reports only and lets usage data be turned on', async () => {
  const bridge = installBridge({
    available: true,
    enabled: true,
    usageMetrics: false,
    restartRequired: false,
  })
  render(<DesktopErrorReportingSettings />)

  const usage = await screen.findByRole('checkbox', {
    name: 'Send anonymous usage data',
  })
  expect(
    screen.getByRole('checkbox', { name: 'Send error reports' }),
  ).toBeChecked()
  expect(usage).not.toBeChecked()

  await userEvent.click(usage)

  expect(bridge.set).toHaveBeenCalledWith(true, true)
  expect(
    await screen.findByRole('checkbox', { name: 'Send anonymous usage data' }),
  ).toBeChecked()
})

it('hides the usage data option while error reports are off', async () => {
  installBridge({
    available: true,
    enabled: false,
    usageMetrics: false,
    restartRequired: false,
  })
  render(<DesktopErrorReportingSettings />)

  await screen.findByRole('checkbox', { name: 'Send error reports' })
  expect(
    screen.queryByRole('checkbox', { name: 'Send anonymous usage data' }),
  ).not.toBeInTheDocument()
})

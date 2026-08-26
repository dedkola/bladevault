import { expect, test } from '@playwright/test'
import { resetVault, seedKnife } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

test('persists the pinned-first setting across reloads', async ({ page }) => {
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Appearance' }).click()

  const checkbox = page.getByRole('checkbox').first()
  await expect(checkbox).toBeChecked()
  await checkbox.click()
  await expect(checkbox).not.toBeChecked()

  await page.reload()
  await page.getByRole('button', { name: 'Appearance' }).click()
  await expect(page.getByRole('checkbox').first()).not.toBeChecked()
})

test('persists and applies the selected time format', async ({
  page,
  request,
}) => {
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Appearance' }).click()

  const timeFormat = page.getByRole('combobox', { name: 'Time format' })
  const timeFormatValue = timeFormat.locator('[data-slot="select-value"]')
  await expect(timeFormatValue).toHaveText('12-hour')
  await timeFormat.click()
  await page.getByRole('option', { name: '24-hour' }).click()
  await expect(timeFormatValue).toHaveText('24-hour')

  await page.reload()
  await page.getByRole('button', { name: 'Appearance' }).click()
  await expect(
    page
      .getByRole('combobox', { name: 'Time format' })
      .locator('[data-slot="select-value"]'),
  ).toHaveText('24-hour')

  await seedKnife(request, { name: 'Time Format Test' })
  await page.goto('/logs')
  await expect(page.locator('[data-log-entry] time').first()).toHaveText(
    /^\d{1,2} [A-Z][a-z]{2} · \d{2}:\d{2}:\d{2}$/,
  )
})

test('controls MCP access and copies the LM Studio configuration', async ({
  context,
  page,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/settings?tab=mcp')

  await expect(page.getByText('MCP', { exact: true })).toBeVisible()
  await expect(page.getByText('Activity', { exact: true })).toBeVisible()
  await expect(
    page.getByText(
      'Allow local AI clients such as LM Studio to access your BladeVault collection.',
    ),
  ).toHaveCount(0)
  await expect(page.getByText('Endpoint', { exact: true })).toHaveCount(0)

  const access = page.getByRole('checkbox', { name: 'Enable MCP access' })
  const writes = page.getByRole('checkbox', {
    name: 'Allow MCP to modify knives',
  })
  await expect(access).toBeChecked()
  await expect(writes).not.toBeChecked()

  await access.click()
  await expect(access).not.toBeChecked()
  await expect(writes).toBeDisabled()
  expect((await page.request.get('/mcp')).status()).toBe(404)

  await page.reload()
  await expect(access).not.toBeChecked()
  await access.click()
  await expect(access).toBeChecked()

  page.once('dialog', (dialog) => dialog.accept())
  await writes.click()
  await expect(writes).toBeChecked()

  await page.getByRole('button', { name: 'Copy config' }).click()
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible()
  const copied = JSON.parse(
    await page.evaluate(() => navigator.clipboard.readText()),
  )
  expect(copied).toMatchObject({
    mcpServers: {
      bladevault: {
        url: 'http://127.0.0.1:3199/mcp',
        headers: {
          Authorization: expect.stringMatching(
            /^Bearer bv_mcp_[A-Za-z0-9_-]{43}$/,
          ),
        },
      },
    },
  })

  const token = copied.mcpServers.bladevault.headers.Authorization.replace(
    'Bearer ',
    '',
  )
  await page.getByRole('button', { name: 'Copy token' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token)

  await page.reload()
  await page.getByRole('button', { name: 'Copy config' }).click()
  const copiedAfterReload = JSON.parse(
    await page.evaluate(() => navigator.clipboard.readText()),
  )
  expect(copiedAfterReload.mcpServers.bladevault.headers.Authorization).toBe(
    `Bearer ${token}`,
  )
})

test('copies MCP configuration when the modern Clipboard API is unavailable', async ({
  page,
}) => {
  await page.goto('/settings?tab=mcp')
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
    document.execCommand = (command) => {
      if (command !== 'copy') return false
      const textarea = document.activeElement
      if (!(textarea instanceof HTMLTextAreaElement)) return false
      window.sessionStorage.setItem('fallbackClipboard', textarea.value)
      return true
    }
  })

  await page.getByRole('button', { name: 'Copy config' }).click()
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible()

  const copied = JSON.parse(
    (await page.evaluate(() =>
      window.sessionStorage.getItem('fallbackClipboard'),
    )) || '{}',
  )
  expect(copied).toMatchObject({
    mcpServers: {
      bladevault: {
        url: 'http://127.0.0.1:3199/mcp',
        headers: {
          Authorization: expect.stringMatching(/^Bearer bv_mcp_/),
        },
      },
    },
  })
})

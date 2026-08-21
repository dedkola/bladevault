import { expect, test } from '@playwright/test'
import { resetVault } from './helpers'

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

test('controls MCP access and copies the LM Studio configuration', async ({
  context,
  page,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/settings?tab=mcp')

  await expect(page.getByText('MCP access', { exact: true })).toBeVisible()
  await expect(page.getByText('Activity', { exact: true })).toBeVisible()

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

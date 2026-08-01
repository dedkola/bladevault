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

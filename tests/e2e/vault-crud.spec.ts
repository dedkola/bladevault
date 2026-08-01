import { expect, test } from '@playwright/test'
import { resetVault } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

test('adds, reloads, edits, and deletes a knife through the UI', async ({
  page,
}) => {
  await page.goto('/add')
  await page.getByRole('tab', { name: 'Manual' }).click()
  await page.getByPlaceholder('e.g. Chris Reeve Knives').fill('Test Maker')
  await page.getByPlaceholder('e.g. Sebenza 31').fill('Test Knife')
  await page.getByPlaceholder('e.g. AEB-L').fill('Magnacut')
  await page.getByRole('button', { name: 'Save Item' }).click()

  await expect(page).toHaveURL(/\/collection$/)
  await expect(page.getByText('Test Knife', { exact: true })).toBeVisible()

  await page.reload()
  await page.locator('a[href="/collection/test-knife"]').click()
  await expect(
    page.getByRole('heading', { name: 'Test Maker Test Knife' }),
  ).toBeVisible()

  await page.getByRole('button', { name: 'Edit' }).click()
  await page.getByPlaceholder('e.g. Sebenza 31').fill('Test Knife Updated')
  await page.getByRole('button', { name: 'Save Changes' }).click()
  await expect(
    page.getByRole('heading', { name: 'Test Maker Test Knife Updated' }),
  ).toBeVisible()

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Delete' }).click()
  await expect(page).toHaveURL(/\/collection$/)
  await expect(
    page.getByText('Your library is empty', { exact: true }),
  ).toBeVisible()
})

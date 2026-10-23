import { expect, test } from '@playwright/test'
import { resetVault, seedKnife } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

test('uses the table-first collection view in the modern theme', async ({
  page,
  request,
}) => {
  await seedKnife(request, { name: 'Modern Table Knife' })
  await request.post('/api/settings', { data: { themeStyle: 'modern' } })

  await page.goto('/collection')

  await expect(page.getByRole('heading', { name: 'All objects' })).toBeVisible()
  await expect(page.locator('[data-modern-collection-table]')).toBeVisible()
  await expect(page.getByText('Modern Table Knife')).toBeVisible()

  await page.getByRole('button', { name: 'Gallery view' }).click()
  await expect(page.locator('[data-modern-collection-table]')).toHaveCount(0)
  await expect(page.locator('[data-collection-grid]')).toBeVisible()

  await page.getByRole('button', { name: 'List view' }).click()
  await expect(page.locator('[data-modern-collection-table]')).toBeVisible()

  await page.locator('[data-modern-collection-table] tbody tr').first().click()
  await expect(page.getByText('Open full page')).toBeVisible()
})

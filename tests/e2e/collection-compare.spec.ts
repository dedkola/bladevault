import { expect, test } from '@playwright/test'
import { resetVault, seedKnife } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

test('keeps newest compare item first and filters matching rows', async ({
  page,
  request,
}) => {
  const first = await seedKnife(request, {
    name: 'First',
    brand: 'Alpha',
    specs: { bladeMaterial: 'S30V', country: 'USA' },
  })
  const second = await seedKnife(request, {
    name: 'Second',
    brand: 'Beta',
    specs: { bladeMaterial: 'Magnacut', country: 'USA' },
  })
  await request.post('/api/compare', { data: { id: first.knife.id } })
  await request.post('/api/compare', { data: { id: second.knife.id } })

  await page.goto('/compare')
  const headers = page.getByRole('columnheader')
  await expect(headers).toHaveCount(3)
  await expect(headers.nth(1)).toContainText('Second')
  await expect(headers.nth(2)).toContainText('First')

  await page.getByText('Differences only', { exact: true }).click()
  await expect(page.locator('tbody tr', { hasText: 'Country' })).toHaveCount(0)
  await expect(
    page.locator('tbody tr', { hasText: 'Blade Material' }),
  ).toHaveCount(1)
})

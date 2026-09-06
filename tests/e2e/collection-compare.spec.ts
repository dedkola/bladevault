import { expect, test } from '@playwright/test'
import { resetVault, seedKnife } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

test('loads more collection and brand results automatically on scroll', async ({
  page,
  request,
}) => {
  for (let index = 1; index <= 25; index += 1) {
    await seedKnife(request, {
      name: `Infinite ${String(index).padStart(2, '0')}`,
      brand: 'Scroll Brand',
    })
  }
  await seedKnife(request, { name: 'Other', brand: 'Other Brand' })

  const collectionGrid = page.locator('[data-collection-grid]')
  await page.goto('/collection')
  await expect(collectionGrid.locator(':scope > *')).toHaveCount(24)
  await expect(page.getByRole('button', { name: /Load more/ })).toHaveCount(0)
  await page.locator('[data-infinite-scroll-sentinel]').scrollIntoViewIfNeeded()
  await expect(collectionGrid.locator(':scope > *')).toHaveCount(26)

  await page.goto('/collection?brand=Scroll%20Brand')
  await expect(collectionGrid.locator(':scope > *')).toHaveCount(24)
  await page.locator('[data-infinite-scroll-sentinel]').scrollIntoViewIfNeeded()
  await expect(collectionGrid.locator(':scope > *')).toHaveCount(25)
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

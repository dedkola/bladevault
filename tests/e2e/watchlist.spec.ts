import { expect, test } from '@playwright/test'
import { resetVault, seedKnife } from './helpers'

// The test server runs with BLADEVAULT_PRICE_MONITOR=off, and these wanted
// knives have no product link, so no store page is ever requested.
test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

test('adds a wanted knife with a target and moves it into the collection when bought', async ({
  page,
  request,
}) => {
  const { knife: owned } = await seedKnife(request, { name: 'Owned Knife' })

  await page.goto('/price-drops')
  await page.getByRole('link', { name: 'Watchlist' }).click()
  await expect(page.getByRole('heading', { name: 'Watchlist' })).toBeVisible()
  await expect(page.getByText('Your watchlist is empty.')).toBeVisible()

  await page.getByRole('button', { name: 'Add wanted knife' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Add a wanted knife' })
  await dialog.getByLabel('Brand').fill('Benchmade')
  await dialog.getByLabel('Name').fill('Bugout')
  await dialog.getByLabel(/Target price/).fill('120')
  await dialog.getByLabel('Currency').fill('USD')
  await dialog.getByRole('button', { name: 'Add to watchlist' }).click()
  await expect(dialog).toBeHidden()

  const row = page.locator('[data-watchlist-row]', { hasText: 'Bugout' })
  await expect(row).toContainText('Benchmade Bugout')
  await expect(row).toContainText('$120.00')
  await expect(row).toContainText('no price yet')
  const detail = page.locator('[data-watchlist-detail]')
  await expect(
    detail.getByRole('heading', { name: 'Benchmade Bugout' }),
  ).toBeVisible()

  // Change the target.
  const target = detail.locator('[data-watchlist-target]')
  await target.getByLabel('Target price').fill('110')
  await target.getByRole('button', { name: 'Save' }).click()
  await expect(row).toContainText('$110.00')

  // It stays out of the collection.
  const knives = (await (await request.get('/api/knives')).json()) as {
    knives: Array<{ id: string; name: string }>
  }
  expect(knives.knives.map((knife) => knife.id)).toEqual([owned.id])

  // I bought it.
  await detail.getByRole('button', { name: 'I bought it' }).click()
  await detail.getByLabel(/What you paid/).fill('115.00 USD')
  await detail.getByRole('button', { name: 'Move to collection' }).click()
  await expect(page).toHaveURL(/\/collection\/[^/?]+$/)
  await expect(page.getByText('Bugout').first()).toBeVisible()

  const after = (await (await request.get('/api/knives')).json()) as {
    knives: Array<{ name: string; specs: { price?: string } }>
  }
  expect(after.knives.map((knife) => knife.name).sort()).toEqual([
    'Bugout',
    'Owned Knife',
  ])
  expect(
    after.knives.find((knife) => knife.name === 'Bugout')?.specs.price,
  ).toBe('115.00 USD')
  const watchlist = (await (await request.get('/api/watchlist')).json()) as {
    watchlist: { items: unknown[] }
  }
  expect(watchlist.watchlist.items).toEqual([])
})

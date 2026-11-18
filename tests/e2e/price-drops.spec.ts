import { expect, test } from '@playwright/test'
import { resetVault, seedKnife } from './helpers'

// The test server runs with BLADEVAULT_PRICE_MONITOR=off and these tests never
// press Check now, so no store page is ever requested.
test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

test('explains how monitoring starts when nothing is monitored', async ({
  page,
}) => {
  await page.goto('/price-drops')
  await expect(page.getByRole('heading', { name: 'Price Drops' })).toBeVisible()
  await expect(page.getByText('No knives are monitored yet.')).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Price Drops' }).first(),
  ).toHaveAttribute('aria-current', 'page')
})

test('shows monitored knives, their sources and the Market tab', async ({
  page,
  request,
}) => {
  const { knife } = await seedKnife(request, {
    sourceUrl: 'https://shop.example/products/bugout',
  })
  // Reading the price watch creates the auto source from the product link.
  await request.get(`/api/knives/${knife.id}/price-watch`)

  await page.goto('/price-drops')
  const monitored = page.locator('[data-price-kpi]').first()
  await expect(monitored).toContainText('Monitored')
  await expect(monitored).toContainText('1')
  await expect(
    page.getByText('No price or stock changes yet.', { exact: false }),
  ).toBeVisible()
  await page.getByRole('tab', { name: 'Recently monitored' }).click()
  await expect(
    page.getByRole('tabpanel').getByText('Nothing has been checked yet.'),
  ).toBeVisible()

  await page.goto(`/collection/${knife.id}?tab=market`)
  const market = page.locator('[data-knife-price-panel="tab"]')
  await expect(market.getByText('Best price now')).toBeVisible()
  await expect(market.getByText('Auto', { exact: true })).toBeVisible()
  await expect(market.getByRole('link', { name: 'shop.example' })).toBeVisible()
  await expect(market.getByText('Not checked yet')).toBeVisible()
})

test('adds a store URL and switches the mode in edit mode', async ({
  page,
  request,
}) => {
  const { knife } = await seedKnife(request, {
    sourceUrl: 'https://shop.example/products/bugout',
  })
  await page.goto(`/collection/${knife.id}?edit=1`)
  const editor = page.locator('[data-price-watch-editor]')
  await expect(editor.getByText('Sources 1 / 10')).toBeVisible()
  await expect(
    editor.getByText('Monitored because a purchase price is stored.'),
  ).toBeVisible()

  await editor
    .getByLabel('Add store URL')
    .fill('https://www.amazon.com/dp/B000000001')
  await editor.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(editor.getByText('Sources 2 / 10')).toBeVisible()
  await expect(editor.getByText('amazon.com', { exact: true })).toBeVisible()

  await editor.getByRole('button', { name: 'Never monitor' }).click()
  await expect(
    editor.getByText('Not monitored.', { exact: false }),
  ).toBeVisible()
})

test('offers schedule and pacing settings', async ({ page }) => {
  await page.goto('/settings?tab=prices')
  await expect(
    page.getByRole('switch', { name: 'Check prices automatically' }),
  ).toBeVisible()
  await expect(
    page.getByRole('radiogroup', { name: 'How often to check prices' }),
  ).toBeVisible()
  await expect(page.getByLabel('Stores checked at the same time')).toHaveValue(
    '3',
  )
})

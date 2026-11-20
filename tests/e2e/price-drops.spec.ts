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
  const status = page.locator('[data-price-status]')
  await expect(status).toContainText('0/1 checked in 24 h')
  await expect(
    status.getByRole('region', { name: 'Needs attention' }),
  ).toBeVisible()
  const table = page.locator('[data-price-table]')
  await expect(table.getByRole('tab', { name: /^All/ })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(table.getByRole('tabpanel')).toContainText('Waiting')
  await page.getByRole('tab', { name: 'Changes' }).click()
  await expect(
    page.getByRole('tabpanel').getByText('No price or stock changes', {
      exact: false,
    }),
  ).toBeVisible()
  await page.getByRole('tab', { name: 'Recently monitored' }).click()
  await expect(
    page.getByRole('tabpanel').getByText('Nothing has been checked yet.'),
  ).toBeVisible()
  await expect(page).toHaveURL(/section=recent/)

  // Search narrows the listings; the tab survives a reload.
  await page.getByRole('tab', { name: /^All/ }).click()
  const search = page.getByLabel('Search monitored knives')
  await search.fill('no such knife')
  await expect(
    page.getByRole('tabpanel').getByText('Nothing here matches', {
      exact: false,
    }),
  ).toBeVisible()
  await search.fill('')
  await expect(
    page.getByRole('columnheader', { name: 'Price now' }),
  ).toHaveAttribute('aria-sort', 'none')
  await page.getByRole('button', { name: 'Price now' }).click()
  await expect(
    page.getByRole('columnheader', { name: 'Price now' }),
  ).toHaveAttribute('aria-sort', 'ascending')
  await page.getByRole('tab', { name: 'Restocked' }).click()
  await page.goto('/price-drops')
  await expect(page.getByRole('tab', { name: 'Restocked' })).toHaveAttribute(
    'aria-selected',
    'true',
  )

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
  await expect(
    page.getByLabel('Minimum pause per store in seconds'),
  ).toHaveValue('60')
  await expect(page.getByText('Stores checked at the same time')).toHaveCount(0)
})

test('offers notification categories and thresholds', async ({
  page,
  request,
}) => {
  await page.goto('/settings?tab=prices')
  const drops = page.getByRole('switch', { name: 'Notify about price drops' })
  const increases = page.getByRole('switch', {
    name: 'Notify about price increases',
  })
  await expect(drops).toBeChecked()
  await expect(increases).not.toBeChecked()
  await expect(
    page.getByRole('switch', { name: 'Notify about back in stock' }),
  ).toBeChecked()
  const percent = page.getByLabel('Minimum price change in percent')
  await expect(percent).toHaveValue('5')

  await percent.fill('7.5')
  await percent.press('Enter')
  await increases.click()
  await expect
    .poll(async () => {
      const response = await request.get('/api/settings')
      const { settings } = (await response.json()) as {
        settings: {
          priceMonitoring: {
            notify: { increase: boolean }
            thresholds: { minPercent: number }
          }
        }
      }
      return settings.priceMonitoring
    })
    .toMatchObject({
      notify: { increase: true },
      thresholds: { minPercent: 7.5 },
    })

  // Settings outlive resetVault; put the defaults back for later specs.
  const restored = await request.post('/api/settings', {
    data: {
      priceMonitoring: {
        notify: { increase: false },
        thresholds: { minPercent: 5 },
      },
    },
  })
  expect(restored.ok()).toBe(true)
})

test('shows a Prices section in the Inbox', async ({ page }) => {
  await page.goto('/inbox?filter=prices')
  await expect(page.getByRole('tab', { name: 'Prices' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(
    page.getByText('No price changes.', { exact: false }),
  ).toBeVisible()
  await expect(
    page.getByText('Settings → Price monitoring', { exact: false }),
  ).toBeVisible()
})

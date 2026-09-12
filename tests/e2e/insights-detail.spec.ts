import { expect, test } from '@playwright/test'
import { resetVault, seedKnife } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

test('navigates from an overview block title to its detail page', async ({
  page,
  request,
}) => {
  await seedKnife(request)
  await page.goto('/')

  await page.getByRole('link', { name: 'Data completeness' }).click()
  await expect(page).toHaveURL(/\/insights\/completeness$/)
  await expect(
    page.getByRole('heading', { name: 'Data completeness' }),
  ).toBeVisible()
})

test('renders persisted category tooltip content without executing HTML', async ({
  page,
  request,
}) => {
  const payload = '<img src=x onerror="window.__bladevaultXss=1">'
  await seedKnife(request, { brand: payload, name: 'Tooltip safety test' })
  await page.goto('/insights/makers')

  const chart = page.getByRole('img', { name: 'Makers distribution' })
  await expect(chart).toBeVisible()
  await page.evaluate(() => {
    ;(window as Window & { __bladevaultXss?: number }).__bladevaultXss = 0
  })

  const bounds = await chart.boundingBox()
  expect(bounds).not.toBeNull()
  await page.mouse.move(
    bounds!.x + bounds!.width * 0.6,
    bounds!.y + bounds!.height * 0.5,
  )

  await expect(page.locator('img[src="x"]')).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { __bladevaultXss?: number }).__bladevaultXss,
      ),
    )
    .toBe(0)
})

test('expands Other steels into categories before opening knives with the keyboard', async ({
  page,
  request,
}) => {
  for (let index = 0; index < 8; index++) {
    await seedKnife(request, {
      name: `Steel sample ${index}`,
      specs: { bladeMaterial: `Steel ${index}`, bladeLength: '3 in' },
    })
  }
  await page.goto('/')
  const data = page
    .getByText('View data', { exact: false })
    .filter({ hasText: 'Blade steels' })
  await data.focus()
  await page.keyboard.press('Enter')
  const other = page
    .getByLabel('Blade steel data', { exact: true })
    .getByRole('button', { name: /Other/ })
  await other.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog')
  await expect(
    dialog.getByRole('heading', { name: 'Other', exact: true }),
  ).toBeVisible()
  await expect(dialog.getByRole('link')).toHaveCount(0)
  const categories = dialog.getByLabel('Other categories').getByRole('button')
  await expect(categories).toHaveCount(3)
  const categoryName = (await categories.first().innerText()).split('\n')[0]
  await categories.first().focus()
  await page.keyboard.press('Enter')
  await expect(
    dialog.getByRole('heading', { name: categoryName, exact: true }),
  ).toBeVisible()
  await expect(dialog.getByRole('link', { name: /Steel sample/ })).toHaveCount(
    1,
  )
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
})

test('offers readable mobile ranges and keyboard-accessible shape counts', async ({
  page,
  request,
}) => {
  await seedKnife(request)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const shape = page
    .getByLabel('Blade shapes data', { exact: true })
    .getByRole('button', { name: /Drop Point.*1.*100%/ })
  await shape.focus()
  await page.keyboard.press('Enter')
  await expect(
    page
      .getByRole('dialog')
      .getByRole('heading', { name: 'Drop Point', exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  const chart = page.getByRole('region', {
    name: 'Blade length chart; scroll to see all ranges',
  })
  await expect(chart).toBeVisible()
  const card = chart.locator('..')
  const summary = card.locator('summary')
  await summary.focus()
  await page.keyboard.press('Enter')
  const bins = card
    .getByLabel('Blade length ranges', { exact: true })
    .getByRole('button')
  await expect(bins).toHaveCount(10)
  await expect(bins.filter({ hasText: '100%' })).toHaveCount(1)
  await expect(bins.first()).toBeDisabled()
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true)
  await page.reload()
  await expect(
    page
      .getByLabel('Blade shapes data', { exact: true })
      .getByRole('button', { name: /Drop Point.*1.*100%/ }),
  ).toBeVisible()
})

test('shows monthly library additions and opens pinned knives', async ({
  page,
  request,
}) => {
  await seedKnife(request, { pinned: true })
  await page.goto('/')
  const months = page
    .getByLabel('Monthly library additions')
    .getByRole('button')
  await expect(months).toHaveCount(6)
  await expect(months.last()).toHaveAccessibleName(/: 1 knives added$/)
  await months.last().click()
  await expect(
    page.getByRole('dialog').getByRole('link', { name: /Benchmade Bugout/ }),
  ).toHaveCount(1)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /1 Pinned/ }).click()
  await expect(
    page.getByRole('dialog').getByRole('heading', { name: 'Pinned knives' }),
  ).toBeVisible()
  await expect(
    page.getByRole('dialog').getByRole('link', { name: /Benchmade Bugout/ }),
  ).toHaveCount(1)
})

test('opens maintenance recency groups and distinguishes unavailable history', async ({
  page,
  request,
}) => {
  const { knife } = await seedKnife(request)
  const response = await request.post(`/api/knives/${knife.id}/maintenance`, {
    data: { type: 'cleaning', occurredAt: new Date().toISOString() },
  })
  expect(response.ok()).toBe(true)
  await page.goto('/')
  const groups = page.getByLabel('Maintenance recency', { exact: true })
  await expect(
    groups.getByRole('button', { name: /Within 30 days.*1.*100%/ }),
  ).toBeVisible()
  await groups.getByRole('button', { name: /Within 30 days/ }).focus()
  await page.keyboard.press('Enter')
  await expect(
    page.getByRole('dialog').getByRole('link', { name: /Benchmade Bugout/ }),
  ).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(
    groups.getByRole('button', { name: /No maintenance recorded/ }),
  ).toBeDisabled()
  await page.route('**/api/activity', (route) =>
    route.fulfill({ status: 500, json: { error: 'unavailable' } }),
  )
  await page.reload()
  await expect(
    page.getByText('Maintenance history unavailable. Reload to try again.'),
  ).toBeVisible()
  await expect(groups).toHaveCount(0)
})

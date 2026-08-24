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

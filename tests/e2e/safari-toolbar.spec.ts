import { expect, test } from '@playwright/test'
import { resetVault, seedKnife } from './helpers'

test('scrolls the document and follows the saved color theme', async ({
  page,
  request,
}) => {
  await resetVault(request)
  for (let index = 0; index < 28; index += 1) {
    await seedKnife(request, { name: `Toolbar scroll ${index}` })
  }

  await page.setViewportSize({ width: 1440, height: 700 })
  await page.goto('/collection')
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    'content',
    '#fcfcfb',
  )

  await page.locator('[data-infinite-scroll-sentinel]').scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  expect(
    await page.getByRole('main').evaluate((element) => element.scrollTop),
  ).toBe(0)

  await page.getByRole('button', { name: 'Toggle color theme' }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    'content',
    '#18150f',
  )
  await page.reload()
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    'content',
    '#18150f',
  )

  await page.setViewportSize({ width: 390, height: 800 })
  await page.locator('[data-infinite-scroll-sentinel]').scrollIntoViewIfNeeded()
  const collectionMenu = await page
    .getByRole('button', { name: 'Open navigation' })
    .boundingBox()
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  expect(collectionMenu).not.toBeNull()
  expect(collectionMenu!.y).toBeLessThan(80)

  await page.goto('/settings')
  await page.setViewportSize({ width: 390, height: 360 })
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight,
      ),
    )
    .toBeGreaterThan(0)
  await page
    .getByRole('button', { name: 'Save Folder' })
    .scrollIntoViewIfNeeded()
  const menu = await page
    .getByRole('button', { name: 'Open navigation' })
    .boundingBox()
  const search = await page
    .getByRole('button', { name: 'Search knives' })
    .boundingBox()
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  expect(menu).not.toBeNull()
  expect(search).not.toBeNull()
  expect(menu!.y).toBeLessThan(80)
  expect(search!.y).toBeLessThan(80)
})

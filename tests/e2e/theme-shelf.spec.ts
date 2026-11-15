import { expect, test } from '@playwright/test'
import { resetVault, seedKnife } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

test('opens a knife from the palette and steps through the focus view', async ({
  page,
  request,
}) => {
  await seedKnife(request, { name: 'Shelf Alpha' })
  await seedKnife(request, { name: 'Shelf Bravo' })
  await request.post('/api/settings', { data: { themeStyle: 'shelf' } })

  await page.goto('/collection')
  await expect(page.locator('[data-shelf-hero]')).toBeVisible()

  await page.keyboard.press('ControlOrMeta+k')
  const input = page.getByRole('combobox')
  await expect(input).toBeFocused()
  await input.fill('Alpha')
  await input.press('Enter')

  const title = page.locator('[data-shelf-focus-title]')
  await expect(title).toHaveText('Shelf Alpha')
  await expect(page).toHaveURL(/[?&]focus=/)

  // Arrow keys on the tabs switch tabs without leaving the knife.
  const overview = page.getByRole('tab', { name: 'Overview' })
  await overview.focus()
  await overview.press('ArrowRight')
  await expect(
    page.getByRole('tab', { name: 'Specifications' }),
  ).toHaveAttribute('aria-selected', 'true')
  await expect(title).toHaveText('Shelf Alpha')

  // Elsewhere in the focus view they step between knives (newest first).
  await page.getByRole('link', { name: 'Full page' }).press('ArrowLeft')
  await expect(title).toHaveText('Shelf Bravo')

  await page.keyboard.press('Escape')
  await expect(title).toHaveCount(0)
  await expect(page).not.toHaveURL(/focus=/)
})

test('keeps light/dark, Settings and the theme switcher on a phone', async ({
  page,
  request,
}) => {
  await seedKnife(request, { name: 'Shelf Phone Knife' })
  await request.post('/api/settings', { data: { themeStyle: 'shelf' } })
  await page.setViewportSize({ width: 390, height: 844 })

  await page.goto('/collection')
  const mast = page.locator('[data-shelf-mast]')
  await expect(
    mast.getByRole('button', { name: 'Switch between light and dark' }),
  ).toBeVisible()
  await expect(mast.getByRole('link', { name: 'Settings' })).toBeVisible()
  await expect(mast.getByRole('link', { name: 'Add knife' })).toBeVisible()
  await expect(
    page.locator('[data-workspace-footer] [data-theme-cycle]'),
  ).toBeVisible()

  const overflow = await page.evaluate(() => {
    const main = document.querySelector('main')
    return {
      page:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      main: main ? main.scrollWidth - main.clientWidth : 0,
    }
  })
  expect(overflow).toEqual({ page: 0, main: 0 })
})

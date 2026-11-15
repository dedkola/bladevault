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

test('filters All knives with the field search bar', async ({
  page,
  request,
}) => {
  await seedKnife(request, { name: 'Shelf S30V Knife' })
  await seedKnife(request, {
    name: 'Shelf M390 Knife',
    specs: {
      weight: '3 oz',
      overallLength: '8 in',
      bladeLength: '3.5 in',
      bladeMaterial: 'M390',
      country: 'USA',
    },
  })
  await request.post('/api/settings', { data: { themeStyle: 'shelf' } })

  await page.goto('/collection?all=1')
  const cards = page.locator('[data-shelf-grid] [data-shelf-card]')
  await expect(cards).toHaveCount(2)

  // "/" jumps to the bar; a field, then one of its values, becomes a chip.
  await page.locator('body').press('/')
  // The placeholder changes once a field is picked, so find the input by place.
  const input = page.locator('[data-collection-chip-filter] input')
  await expect(input).toHaveAttribute(
    'placeholder',
    'Search or filter by brand, steel, lock…',
  )
  await expect(input).toBeFocused()
  await input.fill('blade mat')
  await input.press('Enter')
  await input.fill('M390')
  await input.press('Enter')

  await expect(page).toHaveURL(/bladeMaterial=M390/)
  await expect(cards).toHaveCount(1)
  await expect(cards).toContainText('Shelf M390 Knife')
  await expect(page.locator('[data-collection-chip-filter]')).toContainText(
    /Blade Material:\s*M390/,
  )

  await page.getByRole('button', { name: 'Clear search and filters' }).click()
  await expect(cards).toHaveCount(2)
  await expect(page).not.toHaveURL(/bladeMaterial/)
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
